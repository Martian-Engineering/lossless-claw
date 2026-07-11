import { describe, expect, it, vi } from "vitest";
import type { LcmContextEngine } from "../src/engine.js";
import {
  createEngineWithDeps,
  createSessionFilePath,
  makeMessage,
  seedBacklogContext,
} from "./helpers.js";

const WAIT = { timeout: 15_000, interval: 25 };

/**
 * Deterministic fake LLM: every completion returns a numbered marker so
 * canonical content, condensation lineage, and call counts are assertable.
 */
function createFakeComplete() {
  const inputs: string[] = [];
  const complete = vi.fn(async (input: unknown) => {
    inputs.push(JSON.stringify(input));
    return {
      content: [{ type: "text", text: `e2e-summary-${inputs.length}` }],
    };
  });
  return { complete, inputs };
}

function createPendingE2eEngine(complete: ReturnType<typeof createFakeComplete>["complete"]) {
  return createEngineWithDeps(
    {
      freshTailCount: 1,
      leafChunkTokens: 120,
      condensedMinFanout: 2,
      condensedTargetTokens: 1,
      maxSweepIterations: 8,
      proactiveThresholdCompactionMode: "deferred",
      summaryProvider: "anthropic",
      summaryModel: "claude-opus-4-5",
    },
    { complete },
  );
}

async function conversationIdFor(engine: LcmContextEngine, sessionId: string): Promise<number> {
  const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
  expect(conversation).not.toBeNull();
  return conversation!.conversationId;
}

/** Trigger the afterTurn maintenance hooks for the session. */
async function runAfterTurn(
  engine: LcmContextEngine,
  sessionId: string,
  sessionFile: string,
  options: { tokenBudget: number; currentTokenCount: number },
): Promise<void> {
  await engine.afterTurn({
    sessionId,
    sessionFile,
    messages: [makeMessage({ role: "assistant", content: "turn boundary" })],
    prePromptMessageCount: 0,
    tokenBudget: options.tokenBudget,
    currentTokenCount: options.currentTokenCount,
  });
}

/** Wait until the batch has exactly `count` nodes, all ready. */
async function waitForReadyNodes(
  engine: LcmContextEngine,
  conversationId: number,
  count: number,
): Promise<string> {
  let batchId = "";
  await vi.waitFor(async () => {
    const batch = await engine
      .getPendingSummaryStore()
      .getActiveBatchForConversation(conversationId);
    expect(batch).not.toBeNull();
    const nodes = await engine.getPendingSummaryStore().getNodesByBatch(batch!.batchId);
    expect(nodes).toHaveLength(count);
    expect(nodes.every((node) => node.status === "ready")).toBe(true);
    batchId = batch!.batchId;
  }, WAIT);
  return batchId;
}

describe("pending summary compaction engine e2e (mocked LLM)", () => {
  it(
    "preserves threshold debt when publication finds no active batch",
    async () => {
      const { complete } = createFakeComplete();
      const engine = createPendingE2eEngine(complete);
      const sessionId = "pending-e2e-threshold-without-batch";
      const sessionFile = createSessionFilePath(sessionId);

      await seedBacklogContext(engine, sessionId, [120, 120, 120]);
      await engine.ingest({
        sessionId,
        message: makeMessage({ role: "assistant", content: "fresh tail" }),
      });
      const conversationId = await conversationIdFor(engine, sessionId);
      await expect(
        engine.getPendingSummaryStore().getActiveBatchForConversation(conversationId),
      ).resolves.toBeNull();

      // Threshold handling synchronously queues publication-ready-only, while
      // the general deferred drain is scheduled for a later idle callback.
      await runAfterTurn(engine, sessionId, sessionFile, {
        tokenBudget: 600,
        currentTokenCount: 500,
      });
      await engine.ingest({
        sessionId,
        message: makeMessage({ role: "user", content: "queued after threshold publication" }),
      });

      // The bounded publication pass cannot create a batch or call the model.
      // It retains threshold debt so the already-scheduled general drain still
      // has authority to perform model-backed planning and preparation later.
      expect(complete).not.toHaveBeenCalled();
      const maintenanceAfterPublication = await engine
        .getCompactionMaintenanceStore()
        .getConversationCompactionMaintenance(conversationId);
      expect(maintenanceAfterPublication?.pending).toBe(true);

      const privateEngine = engine as unknown as {
        drainDeferredCompactionDebtIfIdle: (params: {
          conversationId: number;
          sessionId: string;
          queueKey: string;
          tokenBudget: number;
          currentTokenCount: number;
          reason: string;
        }) => Promise<void>;
      };
      await privateEngine.drainDeferredCompactionDebtIfIdle({
        conversationId,
        sessionId,
        queueKey: sessionId,
        tokenBudget: 600,
        currentTokenCount: 500,
        reason: "threshold",
      });

      // The general drain may leave an active batch, publish it, or retain debt
      // when pressure remains. A model call proves that the retained debt gave
      // this normal preparation path authority to advance work.
      expect(complete.mock.calls.length).toBeGreaterThan(0);
    },
    30_000,
  );

  it(
    "prepares hidden work through real drains, publishes on threshold debt, and assembles the summaries",
    async () => {
      const { complete, inputs } = createFakeComplete();
      const engine = createPendingE2eEngine(complete);
      const sessionId = "pending-e2e-background-loop";
      const sessionFile = createSessionFilePath(sessionId);

      // Backlog of three leaf-sized messages plus a small fresh-tail turn.
      await seedBacklogContext(engine, sessionId, [120, 120, 120]);
      await engine.ingest({
        sessionId,
        message: makeMessage({ role: "assistant", content: "fresh tail turn one" }),
      });

      // Far below threshold, the afterTurn leaf trigger schedules a real
      // prepare-only drain (no spies, no scheduler mocks).
      await runAfterTurn(engine, sessionId, sessionFile, {
        tokenBudget: 10_000,
        currentTokenCount: 300,
      });
      const conversationId = await conversationIdFor(engine, sessionId);

      // The 120-token backlog meets leafChunkTokens=120 exactly, producing
      // three leaves; wait for the background drain to prepare all of them.
      const batchId = await waitForReadyNodes(engine, conversationId, 3);
      expect(complete.mock.calls.length).toBe(3);

      // Preparation stayed hidden: no canonical summaries, raw context intact,
      // and prepare pressure did not record threshold debt (AN 0002 test 9).
      await expect(
        engine.getSummaryStore().getSummariesByConversation(conversationId),
      ).resolves.toHaveLength(0);
      const contextBeforePublish = await engine.getSummaryStore().getContextItems(conversationId);
      expect(contextBeforePublish.every((item) => item.itemType === "message")).toBe(true);
      const maintenance = await engine
        .getCompactionMaintenanceStore()
        .getConversationCompactionMaintenance(conversationId);
      expect(maintenance?.pending ?? false).toBe(false);

      // A large turn lands and a later turn moves it out of the fresh tail:
      // the suffix crosses leafChunkTokens, so the batch extends. Extension
      // re-enters ready leaves with their actual summary token counts, which
      // is where condensation happens at engine level.
      await engine.ingest({
        sessionId,
        message: makeMessage({ role: "user", content: `big turn ${"payload ".repeat(90)}` }),
      });
      await engine.ingest({
        sessionId,
        message: makeMessage({ role: "assistant", content: "fresh tail turn three" }),
      });
      await runAfterTurn(engine, sessionId, sessionFile, {
        tokenBudget: 10_000,
        currentTokenCount: 500,
      });

      // Extension plans suffix leaves plus a condensed parent over the ready
      // prefix; wait until the batch has no unprepared work left.
      await vi.waitFor(async () => {
        const nodes = await engine.getPendingSummaryStore().getNodesByBatch(batchId);
        expect(nodes.length).toBeGreaterThan(3);
        expect(nodes.every((node) => node.status === "ready")).toBe(true);
        expect(nodes.some((node) => node.kind === "condensed")).toBe(true);
      }, WAIT);

      // Condensation lineage: the condensed completion consumed hidden leaf
      // summaries (the fake outputs), not raw message text.
      expect(inputs.some((input) => input.includes("e2e-summary-"))).toBe(true);

      // Still nothing canonical before a compaction event.
      await expect(
        engine.getSummaryStore().getSummariesByConversation(conversationId),
      ).resolves.toHaveLength(0);

      // Crossing the proactive threshold records deferred debt, and the debt
      // publication opportunity takes a fixed queue position. The immediately
      // following foreground ingest therefore cannot starve promotion.
      const completionCountBeforePublish = complete.mock.calls.length;
      await runAfterTurn(engine, sessionId, sessionFile, {
        tokenBudget: 600,
        currentTokenCount: 300,
      });
      await engine.ingest({
        sessionId,
        message: makeMessage({ role: "user", content: "next foreground operation" }),
      });
      const thresholdBatch = await engine.getPendingSummaryStore().getBatch(batchId);
      expect(thresholdBatch?.status).toBe("published");
      expect(complete.mock.calls).toHaveLength(completionCountBeforePublish);

      // Promotion recorded canonical ids and dropped hidden payloads.
      // (Remaining compactable work may replan a follow-up batch afterwards,
      // so assert against the published batch, not global quiescence.)
      const publishedNodes = await engine.getPendingSummaryStore().getNodesByBatch(batchId);
      const promoted = publishedNodes.filter((node) => node.status === "promoted");
      expect(promoted.length).toBeGreaterThan(0);
      expect(promoted.some((node) => node.kind === "condensed")).toBe(true);
      for (const node of promoted) {
        expect(node.canonicalSummaryId).toBeTruthy();
        expect(node.content).toBeNull();
      }

      const summaries = await engine.getSummaryStore().getSummariesByConversation(conversationId);
      expect(summaries.length).toBeGreaterThan(0);
      expect(summaries.every((summary) => summary.content.startsWith("e2e-summary-"))).toBe(true);
      await vi.waitFor(async () => {
        const contextItems = await engine.getSummaryStore().getContextItems(conversationId);
        expect(contextItems.some((item) => item.itemType === "summary")).toBe(true);
      }, WAIT);

      // The assembled prompt surfaces the published summaries.
      const assembled = await engine.assemble({
        sessionId,
        messages: [makeMessage({ role: "user", content: "live tail message" })],
        tokenBudget: 10_000,
      });
      expect(JSON.stringify(assembled.messages)).toContain("e2e-summary-");
    },
    30_000,
  );

  it(
    "manual compact() promotes an already-prepared frontier without extra LLM calls",
    async () => {
      const { complete } = createFakeComplete();
      const engine = createPendingE2eEngine(complete);
      const sessionId = "pending-e2e-manual-promotion";
      const sessionFile = createSessionFilePath(sessionId);

      await seedBacklogContext(engine, sessionId, [120, 120, 120]);
      await engine.ingest({
        sessionId,
        message: makeMessage({ role: "assistant", content: "fresh tail turn" }),
      });
      await runAfterTurn(engine, sessionId, sessionFile, {
        tokenBudget: 10_000,
        currentTokenCount: 300,
      });
      const conversationId = await conversationIdFor(engine, sessionId);
      const batchId = await waitForReadyNodes(engine, conversationId, 3);
      const preparedCalls = complete.mock.calls.length;

      // Manual compaction is a compaction event: it must publish the prepared
      // frontier immediately, below threshold, with zero further LLM spend.
      const result = await engine.compact({
        sessionId,
        sessionFile,
        tokenBudget: 10_000,
        currentTokenCount: 300,
      });
      expect(result).toMatchObject({
        ok: true,
        compacted: true,
        reason: "pending summaries published",
      });
      expect(complete.mock.calls.length).toBe(preparedCalls);

      await expect(engine.getPendingSummaryStore().getBatch(batchId)).resolves.toMatchObject({
        status: "published",
      });
      const contextItems = await engine.getSummaryStore().getContextItems(conversationId);
      expect(contextItems.filter((item) => item.itemType === "summary")).toHaveLength(3);
      expect(contextItems[contextItems.length - 1]?.itemType).toBe("message");
      const nodes = await engine.getPendingSummaryStore().getNodesByBatch(batchId);
      expect(nodes.every((node) => node.status === "promoted" && node.content === null)).toBe(
        true,
      );
    },
    30_000,
  );
});
