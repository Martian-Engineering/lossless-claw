import { afterEach, expect, it, vi } from "vitest";
import { cleanupEngineTestState, createEngineWithDeps } from "./helpers.js";
import type { CompactionGuards } from "../src/compaction-guards.js";

afterEach(cleanupEngineTestState);

it("afterTurn preserves provider retry state when threshold publication cannot advance", async () => {
  const complete = vi.fn();
  const engine = createEngineWithDeps({}, { complete });
  const sessionId = "threshold-publication-no-progress";
  await engine.ingest({ sessionId, message: { role: "user", content: "protected user ".repeat(2000) } });
  const conversationId = (await engine.getConversationStore().getConversationBySessionId(sessionId))!.conversationId;
  const store = engine.getCompactionMaintenanceStore();
  const deadline = new Date(Date.now() + 3600000);
  await store.requestProactiveCompactionDebt({ conversationId, reason: "threshold", tokenBudget: 1000 });
  await store.markProactiveCompactionFinished({ conversationId, keepPending: true,
    failureSummary: "provider unavailable", nextAttemptAfter: deadline });

  // The public after-turn path gives prepared summaries a publication chance
  // at threshold. No ready batch exists and the provider has not been retried.
  for (let turn = 0; turn < 3; turn++) {
    await engine.afterTurn({ sessionId, sessionFile: "", tokenBudget: 1000, currentTokenCount: 9000,
      messages: [], prePromptMessageCount: 0 });
    expect(await store.getConversationCompactionMaintenance(conversationId)).toMatchObject({
      pending: true, running: false, retryAttempts: 1,
      lastFailureSummary: "provider unavailable", nextAttemptAfter: deadline,
    });
  }
  expect(complete).not.toHaveBeenCalled();
  expect(await engine.getConversationStore().getMessages(conversationId)).toHaveLength(1);
});

/** Seed complete turns and optionally prepare summaries through host maintenance. */
async function publicationFixture(prepare: boolean) {
  const complete = vi.fn(async () => ({ content: [{ type: "text", text: "Summary of completed messages." }] }));
  const engine = createEngineWithDeps({ freshTailCount: 2, leafChunkTokens: 1000, maxSweepIterations: 30 }, { complete });
  const sessionId = "ready-publication";
  for (let i = 0; i < 8; i++) {
    await engine.ingest({ sessionId, message: { role: "user", content: `Question ${i}` } });
    await engine.ingest({ sessionId, message: { role: "assistant", content: `Answer ${i} ${"evidence ".repeat(1000)}` } });
  }
  if (prepare) await engine.maintain({ sessionId, sessionFile: "",
    runtimeContext: { allowDeferredCompactionExecution: true, tokenBudget: 100000 } });
  const conversationId = (await engine.getConversationStore().getConversationBySessionId(sessionId))!.conversationId;
  // The real guard is scoped exactly as production compaction; only the
  // starting cooldown is seeded directly, avoiding unnecessary provider work.
  const guards = (engine as unknown as { compactionGuards: CompactionGuards }).compactionGuards;
  const scopeKey = guards.resolveSummarySpendScope({ kind: "compaction", scope: sessionId });
  const deadline = guards.openSummarySpendBackoff({ scopeKey, reason: "poor reduction" });
  return { engine, complete, sessionId, conversationId, guards, scopeKey, deadline };
}

it.each(["force", "manual"])("%s publication preserves generation cooldown without making model calls", async mode => {
  const f = await publicationFixture(true);
  const batch = await f.engine.getPendingSummaryStore().getActiveBatchForConversation(f.conversationId);
  expect(batch).not.toBeNull();
  expect((await f.engine.getPendingSummaryStore().getNodesByBatch(batch!.batchId))
    .some(node => node.status === "ready")).toBe(true);
  const calls = f.complete.mock.calls.length;
  const raw = await f.engine.getConversationStore().getMessages(f.conversationId);
  const result = await f.engine.compact({ sessionId: f.sessionId, sessionFile: "", tokenBudget: 100000,
    ...(mode === "force" ? { force: true } : { runtimeContext: { manualCompaction: true } }) });
  expect(result).toMatchObject({ ok: true, compacted: true, reason: "pending summaries published" });
  expect(f.complete).toHaveBeenCalledTimes(calls);
  expect(f.guards.getSummarySpendBackoffUntil(f.scopeKey)).toEqual(f.deadline);
  expect(result.result.summarySpendBackoffUntil).toBe(f.deadline.toISOString());
  expect(await f.engine.getConversationStore().getMessages(f.conversationId)).toEqual(raw);
});

it.each(["force", "manual"])("%s preparation still clears cooldown when generation is required", async mode => {
  const f = await publicationFixture(false);
  expect(f.complete).not.toHaveBeenCalled();
  const result = await f.engine.compact({ sessionId: f.sessionId, sessionFile: "", tokenBudget: 100000,
    ...(mode === "force" ? { force: true } : { runtimeContext: { manualCompaction: true } }) });
  expect(result.compacted).toBe(true);
  expect(f.complete).toHaveBeenCalled();
  expect(f.guards.getSummarySpendBackoffUntil(f.scopeKey)).toBeNull();
});
