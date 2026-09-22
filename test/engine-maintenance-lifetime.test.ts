import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupEngineTestState, createEngineWithDeps, createSessionFilePath, makeMessage, seedBacklogContext } from "./helpers.js";

afterEach(cleanupEngineTestState);

it.each([10_000, 300])("owns delayed summary work in maintenance, not the completed turn (budget %i)", async (tokenBudget) => {
  const owner = new AsyncLocalStorage<{ open: boolean; name: string }>();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const foregroundComplete = vi.fn(async () => { throw new Error("expired foreground capability"); });
  const backgroundComplete = vi.fn(async () => {
    expect(owner.getStore()).toMatchObject({ open: true, name: "maintenance" });
    await gate;
    expect(owner.getStore()).toMatchObject({ open: true, name: "maintenance" });
    return { text: "owned summary", provider: "anthropic", model: "claude-opus-4-5", agentId: "main" };
  });
  const complete = vi.fn(async (input) => {
    // Simulate the bridge's selection of the call-bound host capability.
    expect(input.runtimeLlmComplete).toBe(backgroundComplete);
    const result = await input.runtimeLlmComplete(input);
    return { content: [{ type: "text", text: result.text }] };
  });
  const engine = createEngineWithDeps({
    freshTailCount: 1, leafChunkTokens: 120, maxSweepIterations: 8,
    summaryProvider: "anthropic", summaryModel: "claude-opus-4-5",
  }, { complete });
  const sessionId = `maintenance-owner-${tokenBudget}`;
  const sessionFile = createSessionFilePath(sessionId);
  await seedBacklogContext(engine, sessionId, [120, 120, 120]);
  await engine.ingest({ sessionId, message: makeMessage({ role: "user", content: "fresh tail" }) });
  const foreground = { open: true, name: "foreground" };
  await owner.run(foreground, () => engine.afterTurn({
    sessionId, sessionFile, messages: [], prePromptMessageCount: 0, tokenBudget,
    runtimeContext: { llm: { complete: foregroundComplete } },
  }));
  foreground.open = false;
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(complete).not.toHaveBeenCalled();
  await engine.maintain({ sessionId, sessionFile, runtimeContext: { allowDeferredCompactionExecution: false } });
  expect(complete).not.toHaveBeenCalled();

  const background = { open: true, name: "maintenance" };
  let settled = false;
  const maintenance = owner.run(background, () => engine.maintain({
    sessionId, sessionFile,
    runtimeContext: { allowDeferredCompactionExecution: true, tokenBudget, llm: { complete: backgroundComplete } },
  })).finally(() => { settled = true; background.open = false; });
  try {
    await vi.waitFor(() => expect(backgroundComplete).toHaveBeenCalled());
    expect(settled).toBe(false);
    await engine.ingest({ sessionId, message: makeMessage({ role: "assistant", content: "ingestion stays available" }) });
  } finally {
    release();
    await maintenance;
  }
  expect(foregroundComplete).not.toHaveBeenCalled();
  const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
  const summaries = await engine.getSummaryStore().getSummariesByConversation(conversation!.conversationId);
  if (tokenBudget === 10_000) {
    expect(summaries).toHaveLength(0);
    const batch = await engine.getPendingSummaryStore().getActiveBatchForConversation(conversation!.conversationId);
    const nodes = await engine.getPendingSummaryStore().getNodesByBatch(batch!.batchId);
    expect(nodes.filter(node => node.status === "ready").length).toBeGreaterThan(0);
  } else {
    expect(summaries.length).toBeGreaterThan(0);
  }
});
