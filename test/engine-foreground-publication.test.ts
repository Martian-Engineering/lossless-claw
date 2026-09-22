import { afterEach, expect, it, vi } from "vitest";
import { PendingCompactionCoordinator } from "../src/pending-summary-coordinator.js";
import { LcmContextEngine } from "../src/engine.js";
import { closeLcmConnection, createLcmDatabaseConnection } from "../src/db/connection.js";
import type { CompactionGuards } from "../src/compaction-guards.js";
import {
  cleanupEngineTestState, createEngineWithDeps, createSessionFilePath,
  makeMessage, seedBacklogContext, getEngineConfig, createTestDeps,
} from "./helpers.js";

afterEach(cleanupEngineTestState);

async function fixture(leaves = 15) {
  const complete = vi.fn(async () => ({ content: [{ type: "text", text: "short background summary" }] }));
  const engine = createEngineWithDeps({
    freshTailCount: 1, leafChunkTokens: 120, maxSweepIterations: 12,
    summaryProvider: "anthropic", summaryModel: "claude-opus-4-5",
  }, { complete });
  const sessionId = "foreground-publication";
  const sessionFile = createSessionFilePath(sessionId);
  await seedBacklogContext(engine, sessionId, Array(leaves).fill(120));
  await engine.ingest({ sessionId, message: makeMessage({ role: "user", content: "fresh tail" }) });
  const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
  const conversationId = conversation!.conversationId;
  const coordinator = new PendingCompactionCoordinator({
    conversationStore: engine.getConversationStore(), summaryStore: engine.getSummaryStore(),
    pendingSummaryStore: engine.getPendingSummaryStore(),
    summarize: async () => "prepared summary", model: "fixture", leaseOwner: "fixture",
    config: { freshTailCount: 1, leafChunkTokens: 120, condensedMinFanout: 99,
      condensedMinSourceTokens: 1, condensedChunkTokens: 120 },
  });
  const debt = () => engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
    conversationId, reason: "threshold", tokenBudget: 300, currentTokenCount: leaves * 120,
  });
  const assemble = () => engine.assemble({ sessionId, tokenBudget: 300,
    messages: [makeMessage({ role: "user", content: "current turn" })] });
  return { engine, complete, sessionId, sessionFile, conversationId, coordinator, debt, assemble };
}

it.each([false, true])("over-budget assembly never prepares summaries (existing batch %s)", async (planned) => {
  const f = await fixture();
  if (planned) await f.coordinator.runOnce({ conversationId: f.conversationId, publishPolicy: "prepare-only" });
  await f.debt();
  const before = await f.engine.getSummaryStore().getContextItems(f.conversationId);
  const result = await f.assemble();
  expect(f.complete).not.toHaveBeenCalled();
  expect(result.messages.map(message => message.content)).toContain("current turn");
  expect(result.estimatedTokens).toBeLessThanOrEqual(300);
  expect(await f.engine.getSummaryStore().getContextItems(f.conversationId)).toEqual(before);
  expect((await f.engine.getCompactionMaintenanceStore().getConversationCompactionMaintenance(f.conversationId))?.pending).toBe(true);
  // More work than one maintenance pass: durable pending work must survive
  // the foreground fallback and converge over subsequent host-owned passes.
  for (let i = 0; i < 5; i++) {
    await f.engine.maintain({ sessionId: f.sessionId, sessionFile: f.sessionFile,
      runtimeContext: { allowDeferredCompactionExecution: true, tokenBudget: 300 } });
  }
  expect(f.complete).toHaveBeenCalled();
  expect((await f.engine.getSummaryStore().getSummariesByConversation(f.conversationId)).length).toBeGreaterThan(0);
  expect(await f.engine.getConversationStore().getMessageCount(f.conversationId)).toBe(16);
});

it("publishes an already-ready batch without a completion call or history loss", async () => {
  const f = await fixture(3);
  for (let i = 0; i < 4; i++) await f.coordinator.runOnce({ conversationId: f.conversationId, publishPolicy: "prepare-only" });
  const batch = await f.engine.getPendingSummaryStore().getActiveBatchForConversation(f.conversationId);
  expect((await f.engine.getPendingSummaryStore().getNodesByBatch(batch!.batchId)).every(node => node.status === "ready")).toBe(true);
  await f.debt();
  await f.assemble();
  expect(f.complete).not.toHaveBeenCalled();
  expect((await f.engine.getSummaryStore().getSummariesByConversation(f.conversationId)).length).toBeGreaterThan(0);
  expect(await f.engine.getConversationStore().getMessageCount(f.conversationId)).toBe(4);
});

it("recovers incomplete durable work after engine restart without preparing in assemble", async () => {
  const f = await fixture();
  await f.coordinator.runOnce({ conversationId: f.conversationId, publishPolicy: "prepare-only" });
  await f.coordinator.runOnce({ conversationId: f.conversationId, publishPolicy: "prepare-only" });
  await f.debt();
  const config = getEngineConfig(f.engine);
  closeLcmConnection(config.databasePath);
  const engine = new LcmContextEngine(createTestDeps(config, { complete: f.complete }), createLcmDatabaseConnection(config.databasePath));
  await engine.assemble({ sessionId: f.sessionId, tokenBudget: 300,
    messages: [makeMessage({ role: "user", content: "after restart" })] });
  expect(f.complete).not.toHaveBeenCalled();
  for (let i = 0; i < 5; i++) await engine.maintain({ sessionId: f.sessionId, sessionFile: f.sessionFile,
    runtimeContext: { allowDeferredCompactionExecution: true, tokenBudget: 300 } });
  expect(f.complete).toHaveBeenCalled();
  expect((await engine.getSummaryStore().getSummariesByConversation(f.conversationId)).length).toBeGreaterThan(0);
  expect(await engine.getConversationStore().getMessageCount(f.conversationId)).toBe(16);
});

it("rejects invalidated ready sources without regenerating or publishing them", async () => {
  const f = await fixture(3);
  for (let i = 0; i < 4; i++) await f.coordinator.runOnce({ conversationId: f.conversationId, publishPolicy: "prepare-only" });
  const db = createLcmDatabaseConnection(getEngineConfig(f.engine).databasePath);
  db.prepare("UPDATE messages SET content = ? WHERE conversation_id = ? AND seq = 0").run("changed source truth", f.conversationId);
  await f.debt();
  const before = await f.engine.getSummaryStore().getContextItems(f.conversationId);
  await f.assemble();
  expect(f.complete).not.toHaveBeenCalled();
  expect(await f.engine.getSummaryStore().getSummariesByConversation(f.conversationId)).toHaveLength(0);
  expect(await f.engine.getSummaryStore().getContextItems(f.conversationId)).toEqual(before);
  expect((await f.engine.getCompactionMaintenanceStore().getConversationCompactionMaintenance(f.conversationId))?.pending).toBe(true);
});

it("does not clear model-spend backoff during forced foreground publication", async () => {
  const f = await fixture();
  const guards = (f.engine as unknown as { compactionGuards: CompactionGuards }).compactionGuards;
  const scopeKey = guards.resolveSummarySpendScope({ kind: "compaction", scope: f.sessionId });
  const until = guards.openSummarySpendBackoff({ scopeKey, reason: "test spend cap" });
  await f.debt();
  await f.assemble();
  expect(f.complete).not.toHaveBeenCalled();
  expect(guards.getSummarySpendBackoffUntil(scopeKey)).toEqual(until);
});

it("preserves provider retry state when forced publication makes no progress", async () => {
  const f = await fixture();
  await f.debt();
  const store = f.engine.getCompactionMaintenanceStore();
  await store.markProactiveCompactionFinished({ conversationId: f.conversationId,
    failureSummary: "provider timeout", keepPending: true });
  const before = await store.getConversationCompactionMaintenance(f.conversationId);
  await f.assemble();
  const after = await store.getConversationCompactionMaintenance(f.conversationId);
  expect(after).toMatchObject({ pending: true, running: false,
    retryAttempts: before!.retryAttempts, nextAttemptAfter: before!.nextAttemptAfter,
    lastFailureSummary: before!.lastFailureSummary });
  await f.engine.maintain({ sessionId: f.sessionId, sessionFile: f.sessionFile,
    runtimeContext: { allowDeferredCompactionExecution: true, tokenBudget: 300 } });
  expect(f.complete).not.toHaveBeenCalled();
});

it("leaves no-candidate retirement to admitted maintenance", async () => {
  const f = await fixture(0);
  await f.engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
    conversationId: f.conversationId, reason: "threshold", tokenBudget: 1, currentTokenCount: 100,
  });
  await f.engine.assemble({ sessionId: f.sessionId, tokenBudget: 1,
    messages: [makeMessage({ role: "user", content: "current turn" })] });
  expect((await f.engine.getCompactionMaintenanceStore().getConversationCompactionMaintenance(f.conversationId))?.pending).toBe(true);
  await f.engine.maintain({ sessionId: f.sessionId, sessionFile: f.sessionFile,
    runtimeContext: { allowDeferredCompactionExecution: true, tokenBudget: 1 } });
  expect((await f.engine.getCompactionMaintenanceStore().getConversationCompactionMaintenance(f.conversationId))?.pending).toBe(false);
  expect(await f.engine.getConversationStore().getMessageCount(f.conversationId)).toBe(1);
});
