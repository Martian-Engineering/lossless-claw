import { afterEach, describe, expect, it, vi } from "vitest";
import { PendingCompactionCoordinator } from "../src/pending-summary-coordinator.js";
import type { LcmDependencies } from "../src/types.js";
import { cleanupEngineTestState, createEngineWithDeps, seedBacklogContext } from "./helpers.js";

afterEach(() => {
  cleanupEngineTestState();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const sessionId = "maintain-host-abort";
const tokenBudget = 300;

/** OpenClaw's maintenance yield reason: a plain Error renamed to AbortError. */
function yieldReason(): Error {
  return Object.assign(new Error("Session maintenance yielded to a foreground turn"), {
    name: "AbortError",
  });
}

/** Real SQLite backlog with threshold debt, so maintain() takes the multi-step debt path. */
async function fixture(complete: LcmDependencies["complete"], withDebt = true) {
  const engine = createEngineWithDeps(
    { freshTailCount: 1, leafChunkTokens: 120, maxSweepIterations: 8 },
    { complete },
  );
  await seedBacklogContext(engine, sessionId, [120, 120, 120, 120, 120, 120]);
  const conversationId = (await engine.getConversationStore().getConversationBySessionId(sessionId))!
    .conversationId;
  const debt = engine.getCompactionMaintenanceStore();
  if (withDebt) {
    await debt.requestProactiveCompactionDebt({
      conversationId, reason: "threshold", tokenBudget, currentTokenCount: 720,
    });
  }
  const internal = engine as unknown as {
    maintenanceRequests: Map<string, unknown>;
    withSessionQueue: (...args: unknown[]) => Promise<unknown>;
  };
  return {
    engine,
    conversationId,
    internal,
    maintain: (abortSignal?: AbortSignal) =>
      engine.maintain({
        sessionId,
        sessionFile: "",
        runtimeContext: { allowDeferredCompactionExecution: true, tokenBudget },
        ...(abortSignal ? { abortSignal } : {}),
      }),
    readDebt: () => debt.getConversationCompactionMaintenance(conversationId),
    nodes: async () => {
      const batch = await engine.getPendingSummaryStore().getActiveBatchForConversation(conversationId);
      return batch ? engine.getPendingSummaryStore().getNodesByBatch(batch.batchId) : [];
    },
  };
}

describe("maintain() honors the host abortSignal", () => {
  it("rejects an already-aborted pass without model calls or state changes", async () => {
    const complete = vi.fn(async () => ({ content: [{ type: "text", text: "summary" }] }));
    const f = await fixture(complete);
    const queued = { conversationId: f.conversationId, sessionId, tokenBudget, reason: "threshold" };
    f.internal.maintenanceRequests.set(sessionId, queued);
    const before = await f.readDebt();
    const controller = new AbortController();
    const reason = yieldReason();
    controller.abort(reason);

    await expect(f.maintain(controller.signal)).rejects.toBe(reason);

    expect(complete).not.toHaveBeenCalled();
    expect(await f.readDebt()).toEqual(before);
    expect(f.internal.maintenanceRequests.get(sessionId)).toBe(queued);
    expect(await f.nodes()).toEqual([]);
  });

  it("stops between summarizer steps, keeps prepared work and does not charge a retry", async () => {
    const controller = new AbortController();
    const reason = yieldReason();
    const complete = vi.fn(async () => {
      // A foreground turn arrives while the first node is being summarized.
      controller.abort(reason);
      return { content: [{ type: "text", text: "summary written before the abort" }] };
    });
    const f = await fixture(complete);

    await expect(f.maintain(controller.signal)).rejects.toBe(reason);

    expect(complete).toHaveBeenCalledTimes(1);
    const nodes = await f.nodes();
    expect(nodes.filter((node) => node.status === "ready")).toHaveLength(1);
    expect(nodes.filter((node) => node.status === "planned").length).toBeGreaterThan(0);
    expect(nodes.every((node) => node.leaseOwner === null && node.retryCount === 0)).toBe(true);
    expect(await f.engine.getSummaryStore().getSummariesByConversation(f.conversationId)).toEqual([]);
    expect(await f.readDebt()).toMatchObject({
      pending: true, running: false, retryAttempts: 0, nextAttemptAfter: null, lastFailureSummary: null,
    });

    // The next uncanceled pass resumes: it publishes the node prepared before the abort.
    complete.mockImplementation(async () => ({ content: [{ type: "text", text: "fresh summary" }] }));
    const resumed = await f.maintain(new AbortController().signal);
    expect(resumed.reason).toBe("pending summaries published");
    expect(await f.engine.getSummaryStore().getSummariesByConversation(f.conversationId))
      .toMatchObject([{ content: "summary written before the abort" }]);
  });

  it("keeps the debt's earlier failure and backoff when a pass is canceled", async () => {
    const controller = new AbortController();
    const complete = vi.fn(async () => {
      controller.abort(yieldReason());
      return { content: [{ type: "text", text: "summary" }] };
    });
    const f = await fixture(complete);
    const store = f.engine.getCompactionMaintenanceStore();
    await store.markProactiveCompactionFinished({
      conversationId: f.conversationId, keepPending: true, failureSummary: "earlier provider failure",
    });
    const earlier = (await f.readDebt())!;
    expect(earlier.retryAttempts).toBe(1);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(earlier.nextAttemptAfter!.getTime() + 1);

    await expect(f.maintain(controller.signal)).rejects.toThrow("yielded to a foreground turn");

    expect(complete).toHaveBeenCalledTimes(1);
    expect(await f.readDebt()).toMatchObject({
      pending: true,
      running: false,
      retryAttempts: 1,
      nextAttemptAfter: earlier.nextAttemptAfter,
      lastFailureSummary: "earlier provider failure",
    });
  });

  it("stops below-threshold leaf preparation between steps", async () => {
    const controller = new AbortController();
    const complete = vi.fn(async () => {
      controller.abort(yieldReason());
      return { content: [{ type: "text", text: "summary" }] };
    });
    const f = await fixture(complete, false);

    await expect(f.maintain(controller.signal)).rejects.toThrow("yielded to a foreground turn");

    expect(complete).toHaveBeenCalledTimes(1);
    const nodes = await f.nodes();
    expect(nodes.filter((node) => node.status === "ready")).toHaveLength(1);
    expect(nodes.every((node) => node.leaseOwner === null)).toBe(true);
  });

  it("also stops compact()'s pending-summary steps once the host aborts", async () => {
    const controller = new AbortController();
    const reason = yieldReason();
    const complete = vi.fn(async () => {
      controller.abort(reason);
      return { content: [{ type: "text", text: "summary" }] };
    });
    const f = await fixture(complete, false);

    await expect(
      f.engine.compact({ sessionId, sessionFile: "", tokenBudget, force: true, abortSignal: controller.signal }),
    ).rejects.toBe(reason);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(await f.engine.getSummaryStore().getSummariesByConversation(f.conversationId)).toEqual([]);
  });

  it("does not charge a retry when the host aborts the legacy fallback sweep", async () => {
    // No pending plan: the debt path falls back to the legacy sweep.
    vi.spyOn(PendingCompactionCoordinator.prototype, "runOnce").mockResolvedValue({
      status: "idle", reason: "no pending summary nodes planned",
    } as Awaited<ReturnType<PendingCompactionCoordinator["runOnce"]>>);
    const controller = new AbortController();
    const reason = yieldReason();
    const complete = vi.fn(async () => {
      controller.abort(reason);
      return { content: [{ type: "text", text: "legacy summary" }] };
    });
    const f = await fixture(complete);

    await expect(f.maintain(controller.signal)).rejects.toBe(reason);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(await f.readDebt()).toMatchObject({
      pending: true, running: false, retryAttempts: 0, nextAttemptAfter: null, lastFailureSummary: null,
    });
  });

  it("does not charge a retry when the host cancels a legacy sweep's model call", async () => {
    vi.spyOn(PendingCompactionCoordinator.prototype, "runOnce").mockResolvedValue({
      status: "idle", reason: "no pending summary nodes planned",
    } as Awaited<ReturnType<PendingCompactionCoordinator["runOnce"]>>);
    const controller = new AbortController();
    const reason = yieldReason();
    const complete = vi.fn(async () => {
      controller.abort(reason);
      return {
        content: [],
        error: { kind: "runtime_lifecycle" as const, message: "runtime.llm.complete was aborted by the host" },
      };
    });
    const f = await fixture(complete);

    await expect(f.maintain(controller.signal)).rejects.toThrow();

    expect(complete).toHaveBeenCalledTimes(1);
    expect(await f.readDebt()).toMatchObject({
      pending: true, running: false, retryAttempts: 0, nextAttemptAfter: null, lastFailureSummary: null,
    });
  });

  it("still records a legacy sweep auth failure that coincides with the abort", async () => {
    vi.spyOn(PendingCompactionCoordinator.prototype, "runOnce").mockResolvedValue({
      status: "idle", reason: "no pending summary nodes planned",
    } as Awaited<ReturnType<PendingCompactionCoordinator["runOnce"]>>);
    const controller = new AbortController();
    const complete = vi.fn(async () => {
      controller.abort(yieldReason());
      return { content: [], error: { kind: "provider_auth" as const, message: "401 invalid api key" } };
    });
    const f = await fixture(complete);

    await expect(f.maintain(controller.signal)).rejects.toThrow("yielded to a foreground turn");

    expect((await f.readDebt())?.lastFailureSummary).toMatch(/provider auth failure/);
  });

  it("still records a real auth failure that coincides with the abort", async () => {
    const controller = new AbortController();
    vi.spyOn(PendingCompactionCoordinator.prototype, "runOnce").mockImplementation(async () => {
      controller.abort(yieldReason());
      return {
        status: "failed", batchId: "b", nodeId: "n", failureSummary: "401 unauthorized", authFailure: true,
      } as Awaited<ReturnType<PendingCompactionCoordinator["runOnce"]>>;
    });
    const f = await fixture(vi.fn());

    await expect(f.maintain(controller.signal)).rejects.toThrow("yielded to a foreground turn");

    // Auth failures never back off (the breaker owns them), but they are recorded.
    expect(await f.readDebt()).toMatchObject({
      pending: true, running: false, retryAttempts: 0, lastFailureSummary: "provider auth failure",
    });
  });

  it("does not publish after waiting on a session queue the foreground turn held", async () => {
    const complete = vi.fn(async () => ({ content: [{ type: "text", text: "summary" }] }));
    const f = await fixture(complete);
    const controller = new AbortController();
    const reason = yieldReason();
    const original = f.internal.withSessionQueue.bind(f.engine);
    // The abort lands while the publish step waits for the session queue.
    f.internal.withSessionQueue = (...args: unknown[]) => {
      if ((args[2] as { operationName?: string } | undefined)?.operationName === "pendingSummaryPublish") {
        controller.abort(reason);
      }
      return original(...args);
    };

    await expect(f.maintain(controller.signal)).rejects.toBe(reason);

    expect(complete.mock.calls.length).toBeGreaterThan(0);
    expect(await f.engine.getSummaryStore().getSummariesByConversation(f.conversationId)).toEqual([]);
    expect((await f.nodes()).some((node) => node.status === "ready")).toBe(true);
  });

  it("treats a host-canceled model call as cancellation, not a failure", async () => {
    const controller = new AbortController();
    const reason = yieldReason();
    const complete = vi.fn(async () => {
      controller.abort(reason);
      return {
        content: [],
        error: { kind: "runtime_lifecycle" as const, message: "runtime.llm.complete was aborted by the host" },
      };
    });
    const f = await fixture(complete);

    await expect(f.maintain(controller.signal)).rejects.toBe(reason);

    expect(complete).toHaveBeenCalledTimes(1);
    const nodes = await f.nodes();
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.every((node) => node.leaseOwner === null && node.retryCount === 0)).toBe(true);
    expect(await f.readDebt()).toMatchObject({
      pending: true, running: false, retryAttempts: 0, lastFailureSummary: null,
    });
  });

  it("rejects compact() when the host cancels its in-flight model call", async () => {
    const controller = new AbortController();
    const reason = yieldReason();
    const complete = vi.fn(async () => {
      controller.abort(reason);
      return {
        content: [],
        error: { kind: "runtime_lifecycle" as const, message: "runtime.llm.complete was aborted by the host" },
      };
    });
    const f = await fixture(complete, false);

    await expect(
      f.engine.compact({ sessionId, sessionFile: "", tokenBudget, force: true, abortSignal: controller.signal }),
    ).rejects.toBe(reason);

    expect(complete).toHaveBeenCalledTimes(1);
    const nodes = await f.nodes();
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.every((node) => node.leaseOwner === null && node.retryCount === 0)).toBe(true);
  });

  it("does not restore a queued request once the drain finished", async () => {
    const controller = new AbortController();
    const complete = vi.fn(async () => ({ content: [{ type: "text", text: "summary" }] }));
    const f = await fixture(complete);
    const queued = { conversationId: f.conversationId, sessionId, tokenBudget, reason: "threshold" };
    f.internal.maintenanceRequests.set(sessionId, queued);
    const store = f.engine.getCompactionMaintenanceStore();
    const finish = store.markProactiveCompactionFinished.bind(store);
    // Abort only after the drain has settled the debt.
    vi.spyOn(store, "markProactiveCompactionFinished").mockImplementation(async (input) => {
      await finish(input);
      controller.abort(yieldReason());
    });

    await expect(f.maintain(controller.signal)).rejects.toThrow("yielded to a foreground turn");

    // The finished drain consumed the request; it was not put back.
    expect(f.internal.maintenanceRequests.has(sessionId)).toBe(false);
  });

  it("still charges a real provider failure that coincides with the abort", async () => {
    const controller = new AbortController();
    vi.spyOn(PendingCompactionCoordinator.prototype, "runOnce").mockImplementation(async () => {
      controller.abort(yieldReason());
      return {
        status: "failed", batchId: "b", nodeId: "n", failureSummary: "500 upstream exploded",
      } as Awaited<ReturnType<PendingCompactionCoordinator["runOnce"]>>;
    });
    const f = await fixture(vi.fn());

    await expect(f.maintain(controller.signal)).rejects.toThrow("yielded to a foreground turn");

    const debt = await f.readDebt();
    expect(debt).toMatchObject({ pending: true, running: false, retryAttempts: 1 });
    expect(debt?.lastFailureSummary).toContain("500 upstream exploded");
  });

  it("resets earlier retry state when a publication commits before the abort", async () => {
    const controller = new AbortController();
    const f = await fixture(vi.fn());
    const store = f.engine.getCompactionMaintenanceStore();
    await store.markProactiveCompactionFinished({
      conversationId: f.conversationId, keepPending: true, failureSummary: "earlier provider failure",
    });
    const earlier = (await f.readDebt())!;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(earlier.nextAttemptAfter!.getTime() + 1);
    vi.spyOn(PendingCompactionCoordinator.prototype, "runOnce").mockImplementation(async () => {
      controller.abort(yieldReason());
      return {
        status: "published", batchId: "b", frontierSummaryIds: ["sum_x"], remainingCompactableWork: true,
      } as unknown as Awaited<ReturnType<PendingCompactionCoordinator["runOnce"]>>;
    });

    await expect(f.maintain(controller.signal)).rejects.toThrow("yielded to a foreground turn");

    expect(await f.readDebt()).toMatchObject({
      pending: true, running: false, retryAttempts: 0, lastFailureSummary: null,
    });
  });

  it("does not publish from compact() once the host aborts, even with the session queue held", async () => {
    const complete = vi.fn(async () => ({ content: [{ type: "text", text: "summary" }] }));
    const f = await fixture(complete, false);
    const controller = new AbortController();
    const reason = yieldReason();
    const runOnce = PendingCompactionCoordinator.prototype.runOnce;
    // Let compact() plan and prepare; abort inside the step that would publish,
    // after that step's loop-top check.
    vi.spyOn(PendingCompactionCoordinator.prototype, "runOnce").mockImplementation(async function (
      this: PendingCompactionCoordinator,
      ...args: Parameters<PendingCompactionCoordinator["runOnce"]>
    ) {
      const nodes = await f.nodes();
      if (nodes.length > 0 && nodes.every((node) => node.status === "ready")) controller.abort(reason);
      return runOnce.apply(this, args);
    });

    await expect(
      f.engine.compact({ sessionId, sessionFile: "", tokenBudget, force: true, abortSignal: controller.signal }),
    ).rejects.toBe(reason);

    expect(controller.signal.aborted).toBe(true);
    expect(await f.engine.getSummaryStore().getSummariesByConversation(f.conversationId)).toEqual([]);
  });

  it("runs unchanged when the signal never aborts", async () => {
    const complete = vi.fn(async () => ({ content: [{ type: "text", text: "summary" }] }));
    const withSignal = await fixture(complete);
    const result = await withSignal.maintain(new AbortController().signal);
    expect(result.reason).toBe("pending summaries published");
    expect(complete.mock.calls.length).toBeGreaterThan(1);
  });
});
