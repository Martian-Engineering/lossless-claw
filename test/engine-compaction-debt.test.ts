import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupEngineTestState, createEngineWithDeps } from "./helpers.js";
import { attachTranscriptEntryMeta } from "../src/transcript.js";
import type { AgentMessage, CompactResult } from "../src/openclaw-bridge.js";
import type { CompactionEngine } from "../src/compaction.js";

afterEach(() => { cleanupEngineTestState(); vi.useRealTimers(); });

const sessionId = "maintenance-debt";
const sessionKey = `agent:main:${sessionId}`;
const sessionTarget = { sessionId, sessionKey, agentId: "main", storePath: "/tmp/debt-host.sqlite" };
const compactParams = { sessionId, sessionKey, sessionFile: "", tokenBudget: 8000 };
type PendingResult = CompactResult & { pending?: boolean };

/** Seed real SQLite debt while substituting only the compaction outcome. */
async function outcomeFixture(result: PendingResult, withDebt = true) {
  const engine = createEngineWithDeps({});
  await engine.ingest({ sessionId, sessionKey, message: { role: "user", content: "Retained message" } });
  const conversationId = (await engine.getConversationStore().getConversationForSession({ sessionId, sessionKey }))!.conversationId;
  const store = engine.getCompactionMaintenanceStore();
  if (withDebt) await store.requestProactiveCompactionDebt({
    conversationId, reason: "threshold", tokenBudget: 8000,
    currentTokenCount: 20000, projectedTokenCount: 22000, rawTokensOutsideTail: 18000,
  });
  const internal = engine as unknown as {
    executePendingCompactionCore: (params: unknown) => Promise<PendingResult>;
    compaction: CompactionEngine;
  };
  const execute = vi.spyOn(internal, "executePendingCompactionCore").mockResolvedValue(result);
  return { engine, store, conversationId, internal, execute,
    read: () => store.getConversationCompactionMaintenance(conversationId) };
}

describe("public compaction debt transitions", () => {
  it.each([
    { result: { ok: true, compacted: true }, pending: false, failure: null },
    { result: { ok: true, compacted: false, reason: "below threshold" }, pending: false, failure: null },
    { result: { ok: false, compacted: false, exhausted: true }, pending: false, failure: null },
    { result: { ok: false, compacted: true, reason: "could not reach target" }, pending: true, failure: "could not reach target" },
    { result: { ok: false, compacted: false }, pending: true, failure: "compaction failed" },
    { result: { ok: true, compacted: true, pending: true }, pending: true, failure: null },
    { result: { ok: true, compacted: false, pending: true }, pending: true, failure: null },
  ])("preserves the caller result and records $result", async ({ result, pending, failure }) => {
    const f = await outcomeFixture(result);
    expect(await f.engine.compact(compactParams)).toEqual(result);
    expect(await f.read()).toMatchObject({ pending, running: false, lastFailureSummary: failure });
    if (!pending) expect(await f.read()).toMatchObject({ retryAttempts: 0, nextAttemptAfter: null });
  });

  it.each([
    { ok: false, compacted: true, reason: "provider auth failure after partial compaction" },
    { ok: false, compacted: false, reason: "provider auth failure" },
    { ok: true, compacted: false, reason: "circuit breaker open" },
  ])("keeps $reason pending without exponential retries", async (result) => {
    const f = await outcomeFixture(result);
    for (let attempt = 0; attempt < 3; attempt++) await f.engine.compact(compactParams);
    expect(await f.read()).toMatchObject({ pending: true, retryAttempts: 0, nextAttemptAfter: null,
      lastFailureSummary: result.reason === "circuit breaker open" ? "summary provider circuit breaker is open" : result.reason });
  });

  it.each([
    { ok: false, compacted: true, reason: "could not reach target" },
    { ok: true, compacted: true },
    { ok: true, compacted: false, pending: true },
  ])("does not create debt for manual result $reason", async result => {
    const f = await outcomeFixture(result, false);
    await f.engine.compact(compactParams);
    expect(await f.read()).toBeNull();
  });

  it("drops stale durable and queued pressure after progress, retaining fresh host observations", async () => {
    const f = await outcomeFixture({ ok: false, compacted: true, reason: "could not reach target" });
    // Queue a real after-turn threshold request with the pre-compaction count.
    await f.engine.afterTurn({ sessionId, sessionKey, sessionFile: "", messages: [], prePromptMessageCount: 0,
      tokenBudget: 8000, currentTokenCount: 20000 });
    await f.engine.compact(compactParams);
    expect(await f.read()).toMatchObject({ pending: true, currentTokenCount: null,
      projectedTokenCount: null, rawTokensOutsideTail: null });
    const deadline = (await f.read())!.nextAttemptAfter!;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(deadline.getTime() + 1);
    await f.engine.maintain({ sessionId, sessionKey, sessionFile: "",
      runtimeContext: { allowDeferredCompactionExecution: true, tokenBudget: 8000 } });
    expect(f.execute.mock.lastCall?.[0]).toMatchObject({ currentTokenCount: undefined });
    vi.setSystemTime((await f.read())!.nextAttemptAfter!.getTime() + 1);
    await f.engine.maintain({ sessionId, sessionKey, sessionFile: "",
      runtimeContext: { allowDeferredCompactionExecution: true, tokenBudget: 8000, currentTokenCount: 12345 } });
    expect(f.execute.mock.lastCall?.[0]).toMatchObject({ currentTokenCount: 12345 });
  });
});

/** Exercise real publication with a bounded deadline and a synthetic provider. */
async function partialRecovery(withDebt: boolean) {
  vi.useFakeTimers({ toFake: ["Date"] });
  const messages: AgentMessage[] = [{ role: "user", content: "Read files" }];
  for (let i = 0; i < 12; i++) {
    messages.push({ role: "assistant", content: [{ type: "toolCall", id: `c${i}`, name: "read", arguments: { path: `file${i}` } }] } as AgentMessage);
    messages.push({ role: "toolResult", toolCallId: `c${i}`, toolName: "read", content: [{ type: "text", text: `File ${i}: ${"evidence ".repeat(500)}` }] } as AgentMessage);
  }
  const entries = messages.map((message, i) => ({ entryId: `e${i}`, parentId: i ? `e${i - 1}` : null,
    seq: i + 1, role: message.role, message, createdAt: new Date(1789730000000 + i).toISOString() }));
  let stopAtDeadline = true;
  const complete = vi.fn(async () => {
    if (stopAtDeadline) vi.setSystemTime(Date.now() + 360000);
    return { content: [{ type: "text", text: "Summary of file evidence" }] };
  });
  const engine = createEngineWithDeps({ freshTailCount: 4, freshTailMaxTokens: 2500, leafChunkTokens: 3000,
    bootstrapMaxTokens: 1000, maxAssemblyTokenBudget: 8000, contextThreshold: 0.7, largeFileTokenThreshold: 1000000 },
  { complete, readVisibleSessionTranscriptMessageEntries: async () => entries });
  // An anchored prefix lets overflow reconcile the host transcript without
  // treating the already stored initiating user as another message.
  await engine.ingest({ sessionId, sessionKey, message: attachTranscriptEntryMeta(entries[0]!.message,
    { entryId: entries[0]!.entryId, parentId: null, timestamp: entries[0]!.createdAt }) });
  const conversationId = (await engine.getConversationStore().getConversationForSession({ sessionId, sessionKey }))!.conversationId;
  const store = engine.getCompactionMaintenanceStore();
  const laterDeadline = new Date(Date.now() + 3600000);
  if (withDebt) {
    await store.requestProactiveCompactionDebt({ conversationId, reason: "threshold", tokenBudget: 8000, currentTokenCount: 18000 });
    await store.markProactiveCompactionFinished({ conversationId, keepPending: true,
      failureSummary: "previous ordinary failure", nextAttemptAfter: laterDeadline });
  }
  const run = () => engine.compact({ ...compactParams, sessionTarget, compactionTarget: "budget", force: true,
    runtimeSettings: { schemaVersion: 1, executionHost: { id: "openclaw-embedded", label: "OpenClaw" } } });
  return { engine, store, conversationId, entries, complete, laterDeadline, run,
    resume: () => { stopAtDeadline = false; } };
}

it.each([true, false])("retains real partial progress and resumes reduced storage (existing debt=%s)", async withDebt => {
  const f = await partialRecovery(withDebt);
  const result = await f.run();
  expect(result).toMatchObject({ ok: false, compacted: true, reason: "could not reach target" });
  expect(result.result.tokensAfter).toBeLessThan(result.result.tokensBefore);
  expect(result.result.tokensAfter).toBeGreaterThan(result.result.details.targetTokens);
  expect(f.complete).toHaveBeenCalledTimes(1);
  expect(await f.engine.getSummaryStore().getSummariesByConversation(f.conversationId)).toHaveLength(1);
  const raw = await f.engine.getConversationStore().getMessages(f.conversationId);
  expect(raw).toHaveLength(f.entries.length);
  const debt = await f.store.getConversationCompactionMaintenance(f.conversationId);
  if (withDebt) expect(debt).toMatchObject({ pending: true, retryAttempts: 2,
    nextAttemptAfter: f.laterDeadline, lastFailureSummary: "could not reach target", currentTokenCount: null });
  else expect(debt).toBeNull();

  f.resume();
  const next = await f.run();
  expect(next.ok).toBe(true);
  expect(next.result.tokensBefore).toBe(result.result.tokensAfter);
  expect(await f.engine.getConversationStore().getMessages(f.conversationId)).toEqual(raw);
  const finished = await f.store.getConversationCompactionMaintenance(f.conversationId);
  if (withDebt) expect(finished).toMatchObject({ pending: false, retryAttempts: 0, nextAttemptAfter: null });
  else expect(finished).toBeNull();
});
