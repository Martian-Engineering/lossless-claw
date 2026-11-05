import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeExpansionAuthManager, resetDelegatedExpansionGrantsForTests, resolveDelegatedExpansionGrantId } from "../src/expansion-auth.js";
import { runDelegatedExpandQuery } from "../src/tools/lcm-expand-query-delegation.js";
import { resetExpansionDelegationGuardForTests } from "../src/tools/lcm-expansion-recursion-guard.js";
import type { LcmDependencies } from "../src/types.js";

const source = { role: "toolResult", toolCallId: "source", content: [{ type: "text", text: "Source sum_a: the verified synthetic recovery code is ORBIT." }] };
const empty = (id: number) => ({ role: "toolResult", toolCallId: `empty-${id}`, content: [{ type: "text", text: JSON.stringify({ expansionCount: 1, totalTokens: 0, truncated: true }) }] });
const exhausted = [source, empty(1), empty(2), empty(3)];
const reply = (citedIds = ["sum_a"]) => JSON.stringify({ answer: "The recovery code is ORBIT.", citedIds, expandedSummaryCount: 1, totalSourceTokens: 1, truncated: false });

function fixture(messages: unknown[] = exhausted) {
  let active = false;
  let sessionKey = "";
  const complete = vi.fn(async (_params: Parameters<LcmDependencies["complete"]>[0]) => {
    expect(active).toBe(false);
    expect(resolveDelegatedExpansionGrantId(sessionKey)).toBeNull();
    expect(JSON.stringify(_params.messages)).toContain("ORBIT");
    return { content: [{ type: "text", text: reply() }] };
  });
  const callGateway = vi.fn(async ({ method, params }: { method: string; params?: Record<string, unknown> }): Promise<unknown> => {
    if (method === "agent") {
      active = true; sessionKey = String(params?.sessionKey);
      const grant = resolveDelegatedExpansionGrantId(sessionKey)!;
      getRuntimeExpansionAuthManager().consumeTokenBudget(grant, 3916);
      return { runId: "owned-run" };
    }
    if (method === "agent.wait") return { status: "timeout" };
    if (method === "sessions.get") return { messages };
    if (method === "sessions.delete") { active = false; return {}; }
    throw new Error(`Unexpected method ${method}`);
  });
  const deps = {
    config: { expansionModel: "qwen-local/Qwen", expansionProvider: "", enableSummaryThinking: false },
    complete, callGateway,
    resolveModel: (ref: string) => { const [provider, ...model] = ref.split("/"); return { provider, model: model.join("/") }; },
    buildSubagentSystemPrompt: () => "synthetic subagent", agentLaneSubagent: "subagent",
    readLatestAssistantReply: (ms: Array<{ role?: string; content?: string }>) => ms.findLast((m) => m.role === "assistant")?.content,
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as LcmDependencies;
  function run(workMs = 120_000) {
    const now = performance.now();
    return runDelegatedExpandQuery({ deps, callerSessionKey: "agent:test:main", requesterAgentId: "test",
      bucket: { conversationId: 1, summaryIds: ["sum_a"], messageBackedSummaryIds: [] },
      prompt: "What is the recovery code?", maxTokens: 2000, tokenCap: 4000,
      requestId: "synthetic-request", childExpansionDepth: 1, originSessionKey: "agent:test:main",
      deadline: { startedAtMs: now, workDeadlineMs: now + workMs, totalDeadlineMs: now + workMs + 30_000 },
      delegatedWaitTimeoutSeconds: Math.ceil(workMs / 1000),
    });
  }
  return { deps, complete, callGateway, run, sessionKey: () => sessionKey };
}

beforeEach(() => { resetDelegatedExpansionGrantsForTests(); resetExpansionDelegationGuardForTests(); });
afterEach(() => { vi.useRealTimers(); });

describe("delegated query convergence", () => {
  it("keeps a split provider/model override instead of resolving the summary default", async () => {
    const f = fixture();
    f.deps.config.expansionModel = "Qwen";
    f.deps.config.expansionProvider = "qwen-local";
    f.deps.resolveModel = (ref) => ref === "qwen-local/Qwen"
      ? { provider: "qwen-local", model: "Qwen" } : { provider: "other", model: "summary-default" };
    expect(await f.run()).toMatchObject({ status: "success" });
    expect(f.complete).toHaveBeenCalledWith(expect.objectContaining({ provider: "qwen-local", model: "Qwen" }));
  });

  it("cleans up the owned navigator, then synthesizes once under model policy with accurate minimum accounting", async () => {
    const f = fixture();
    const result = await f.run();
    expect(result).toMatchObject({ status: "success", reply: { answer: "The recovery code is ORBIT.", citedIds: ["sum_a"], totalSourceTokens: 3916, truncated: true } });
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(f.complete).toHaveBeenCalledWith(expect.objectContaining({
      provider: "qwen-local", model: "Qwen", maxTokens: 2000, reasoning: "off",
      runtimeModelOverride: expect.objectContaining({ modelRef: "qwen-local/Qwen" }),
      signal: expect.any(AbortSignal), purpose: "lossless-claw delegated recall synthesis",
    }));
    expect(f.complete.mock.calls[0]?.[0]).not.toHaveProperty("tools");
    expect(f.callGateway.mock.calls.filter(([r]) => r.method === "agent")).toHaveLength(1);
    expect(f.callGateway.mock.calls.filter(([r]) => r.method === "sessions.delete")).toHaveLength(1);
    expect(resolveDelegatedExpansionGrantId(f.sessionKey())).toBeNull();
  });

  it("returns explicit insufficient evidence without making an extra model call", async () => {
    const f = fixture([empty(1), empty(2), empty(3)]);
    expect(await f.run()).toMatchObject({ status: "success", reply: { answer: expect.stringContaining("could not be established"), citedIds: [], truncated: true } });
    expect(f.complete).not.toHaveBeenCalled();
  });

  it("does not retry a denied synthesis through another model or navigator", async () => {
    const f = fixture();
    f.complete.mockResolvedValue({ content: [], error: { message: "403 model override not authorized" } } as never);
    expect(await f.run()).toMatchObject({ status: "failed", phase: "synthesize", code: "DELEGATED_EXPANSION_SYNTHESIS_FAILED", cleanup: "complete" });
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(f.callGateway.mock.calls.filter(([r]) => r.method === "agent")).toHaveLength(1);
  });

  it("rejects citations outside the selected bucket", async () => {
    const f = fixture();
    f.complete.mockResolvedValue({ content: [{ type: "text", text: reply(["sum_foreign"]) }] });
    expect(await f.run()).toMatchObject({ status: "failed", phase: "synthesize", code: "DELEGATED_EXPANSION_SYNTHESIS_FAILED" });
  });

  it("does not synthesize when owned child cleanup fails", async () => {
    const f = fixture();
    const original = f.callGateway.getMockImplementation()!;
    f.callGateway.mockImplementation((p) => p.method === "sessions.delete" ? Promise.reject(new Error("cleanup failed")) : original(p));
    expect(await f.run()).toMatchObject({ status: "failed", cleanup: "partial" });
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.callGateway.mock.calls.filter(([r]) => r.method === "sessions.delete")).toHaveLength(1);
  });

  it("aborts a stalled synthesis at the original work deadline", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let signal: AbortSignal | undefined;
    f.complete.mockImplementation((...args: unknown[]) => {
      signal = (args[0] as { signal: AbortSignal }).signal;
      return new Promise(() => {});
    });
    const pending = f.run(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ status: "failed", code: "DELEGATED_EXPANSION_TIMEOUT", cleanup: "complete" });
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a hung cleanup and never starts the second model while the child may run", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const original = f.callGateway.getMockImplementation()!;
    f.callGateway.mockImplementation((p) => p.method === "sessions.delete" ? new Promise(() => {}) : original(p));
    const pending = f.run();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toMatchObject({ status: "failed", cleanup: "partial" });
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.callGateway.mock.calls.filter(([r]) => r.method === "sessions.delete")).toHaveLength(1);
  });

  it("keeps the ordinary terminal reply path without a second completion", async () => {
    const f = fixture();
    const original = f.callGateway.getMockImplementation()!;
    f.callGateway.mockImplementation((p) => {
      if (p.method === "agent.wait") return Promise.resolve({ status: "ok" });
      if (p.method === "sessions.get") return Promise.resolve({ messages: [{ role: "assistant", content: reply() }] });
      return original(p);
    });
    expect(await f.run()).toMatchObject({ status: "success", reply: { truncated: false } });
    expect(f.complete).not.toHaveBeenCalled();
  });
});
