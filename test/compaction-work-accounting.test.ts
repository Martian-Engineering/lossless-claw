import { afterEach, describe, expect, it, vi } from "vitest";
import type { LcmConfig } from "../src/db/config.js";
import type { CompactionEngine } from "../src/compaction.js";
import type { CompactionGuards } from "../src/compaction-guards.js";
import type { CompactionTelemetryRecorder } from "../src/compaction-telemetry.js";
import type { LcmContextEngine } from "../src/engine.js";
import type { CompactResult, ContextEngineRuntimeSettings } from "../src/openclaw-bridge.js";
import { LcmProviderAuthError, LcmRuntimeLifecycleError, LcmRuntimeLlmPolicyError, LcmRuntimeLlmUnavailableError, LcmSummarySpendLimitError } from "../src/summarize.js";
import {
  cleanupEngineTestState,
  createEngineWithConfig,
  createEngineWithDeps,
  seedBacklogContext,
} from "./helpers.js";

afterEach(cleanupEngineTestState);

const runtimeSettings: ContextEngineRuntimeSettings = {
  schemaVersion: 1,
  executionHost: { id: "openclaw-embedded", label: "OpenClaw" },
};

/** Access the accounting boundary without changing candidate selection or pending publication. */
function accountingInternals(engine: LcmContextEngine) {
  return engine as unknown as {
    compaction: CompactionEngine;
    compactionGuards: CompactionGuards;
    telemetryRecorder: CompactionTelemetryRecorder;
    executeCompactionCore: (
      params: Parameters<LcmContextEngine["compact"]>[0] & { conversationId: number },
    ) => Promise<CompactResult>;
  };
}

/** Seed multiple eligible chunks followed by a protected user-led tail. */
async function seedRecovery(maxSweepIterations = 12, overrides: Partial<LcmConfig> = {}) {
  const engine = createEngineWithConfig({
    freshTailCount: 2,
    leafChunkTokens: 500,
    maxSweepIterations,
    ...overrides,
  });
  const sessionId = "accounting-recovery";
  await seedBacklogContext(engine, sessionId, Array(10).fill(500));
  const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
  const internals = accountingInternals(engine);
  return {
    engine, sessionId, conversationId: conversation!.conversationId,
    compaction: internals.compaction,
    compactionGuards: internals.compactionGuards,
    executeCompactionCore: internals.executeCompactionCore.bind(engine),
  };
}

/** Construct an auth failure that compaction must not disguise as successful work. */
function authError() {
  return new LcmProviderAuthError({
    provider: "test",
    model: "summary",
    failure: { statusCode: 401, message: "Unauthorized", missingModelRequestScope: false },
  });
}

describe("compactUntilUnder committed work", () => {
  it.each([10, 30_000])("does not infer work from observed/stored mismatch (stored %i)", async (storedTokens) => {
    const engine = createEngineWithConfig({ freshTailCount: 12 });
    await seedBacklogContext(engine, "protected", [storedTokens]);
    const conversation = await engine.getConversationStore().getConversationBySessionId("protected");
    const summarize = vi.fn(async () => "summary");
    const result = await accountingInternals(engine).compaction.compactUntilUnder({
      conversationId: conversation!.conversationId,
      tokenBudget: 24_000,
      targetTokens: 16_800,
      currentTokens: 66_000,
      summarize,
    });
    expect(result).toEqual({ success: storedTokens < 16_800, rounds: 1, finalTokens: storedTokens, actionTaken: false });
    expect(summarize).not.toHaveBeenCalled();
  });

  it("returns no work when already below target without a sweep", async () => {
    const { compaction, conversationId } = await seedRecovery();
    const summarize = vi.fn(async () => "summary");
    expect(await compaction.compactUntilUnder({ conversationId, tokenBudget: 10_000, summarize }))
      .toMatchObject({ success: true, rounds: 0, actionTaken: false, finalTokens: 5_000 });
    expect(summarize).not.toHaveBeenCalled();
  });

  it("retains earlier work when a later round has no eligible candidate", async () => {
    const { compaction, conversationId } = await seedRecovery();
    const result = await compaction.compactUntilUnder({
      conversationId, tokenBudget: 100, summarize: async () => "S",
    });
    expect(result).toMatchObject({ success: false, rounds: 2, actionTaken: true });
    expect(result.finalTokens).toBeLessThan(5_000);
  });

  it.each([1, 12])("preserves partial commits across failures (sweep limit %i)", async (maxSweepIterations) => {
    // A limit of one fails in the next round; twelve fails within the first sweep.
    const { engine, compaction, conversationId } = await seedRecovery(maxSweepIterations);
    const error = new Error("summary transport failed");
    const summarize = vi.fn(async (): Promise<string> => { throw error; }).mockResolvedValueOnce("S");
    const result = await compaction.compactUntilUnder({ conversationId, tokenBudget: 100, summarize });
    expect(result).toMatchObject({ success: false, actionTaken: true, error, rounds: maxSweepIterations === 1 ? 2 : 1 });
    expect(result.finalTokens).toBe(await engine.getSummaryStore().getContextTokenCount(conversationId));
    expect(result.finalTokens).toBeLessThan(5_000);
    expect(await engine.getConversationStore().getMessages(conversationId)).toHaveLength(10);
  });

  it.each([false, true])("preserves the correct work flag on auth failure (prior work %s)", async (partial) => {
    const { engine, compaction, conversationId } = await seedRecovery(1);
    const summarize = vi.fn(async (): Promise<string> => { throw authError(); });
    if (partial) summarize.mockResolvedValueOnce("S");
    const result = await compaction.compactUntilUnder({ conversationId, tokenBudget: 100, summarize });
    expect(result).toMatchObject({ success: false, actionTaken: partial, authFailure: true, rounds: partial ? 2 : 1 });
    expect(result.finalTokens).toBe(await engine.getSummaryStore().getContextTokenCount(conversationId));
  });

  it("does not report a pass whose storage transaction rolls back", async () => {
    const { engine, compaction, conversationId } = await seedRecovery();
    const summaryStore = engine.getSummaryStore();
    const before = await summaryStore.getContextItems(conversationId);
    const error = new Error("context replacement failed");
    vi.spyOn(summaryStore, "replaceContextRangeWithSummary").mockRejectedValueOnce(error);
    const summarize = vi.fn(async () => "S");
    const result = await compaction.compactUntilUnder({ conversationId, tokenBudget: 100, summarize });
    expect(summarize).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ actionTaken: false, success: false, error, finalTokens: 5_000 });
    expect(await summaryStore.getContextItems(conversationId)).toEqual(before);
    expect(await engine.getConversationStore().getMessages(conversationId)).toHaveLength(10);
  });

  it("reports an error before any commit without inventing work from live tokens", async () => {
    const { compaction, conversationId } = await seedRecovery();
    const error = new Error("first summary failed");
    const result = await compaction.compactUntilUnder({
      conversationId, tokenBudget: 100, currentTokens: 66_000,
      summarize: async () => { throw error; },
    });
    expect(result).toEqual({ success: false, actionTaken: false, rounds: 1, finalTokens: 5_000, error });
  });
});

describe("engine compaction work and spend accounting", () => {
  it.each([10, 30_000])("does not signal recovery or spend for a protected no-op (stored %i)", async (storedTokens) => {
    const complete = vi.fn(async () => ({ content: [{ type: "text", text: "summary" }] }));
    const engine = createEngineWithDeps({ freshTailCount: 12, freshTailMaxTokens: 8_000, contextThreshold: 0.7 }, { complete });
    await seedBacklogContext(engine, "protected", [storedTokens]);
    const { compactionGuards, telemetryRecorder } = accountingInternals(engine);
    const backoff = vi.spyOn(compactionGuards, "openSummarySpendBackoff");
    const success = vi.spyOn(compactionGuards, "recordCompactionSuccess");
    const telemetry = vi.spyOn(telemetryRecorder, "markLeafCompactionTelemetrySuccess");
    const result = await engine.compact({
      sessionId: "protected", sessionFile: "/tmp/accounting.jsonl", tokenBudget: 24_000,
      currentTokenCount: 66_000, compactionTarget: "budget", force: true, runtimeSettings,
    });
    expect(result).toMatchObject({ ok: storedTokens < 16_800, compacted: false, reason: "no compaction progress" });
    expect(complete).not.toHaveBeenCalled();
    expect(backoff).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    expect(telemetry).not.toHaveBeenCalled();
  });

  it.each(["auth", "error", "spend"] as const)("reports committed work followed by %s failure", async (failure) => {
    const { engine, executeCompactionCore, conversationId, sessionId } = await seedRecovery();
    const summarize = vi.fn(async (): Promise<string> => {
      if (failure === "auth") throw authError();
      if (failure === "spend") throw new LcmSummarySpendLimitError({ scopeKey: sessionId, backoffUntil: new Date(Date.now() + 60_000) });
      throw new Error("summary transport failed");
    }).mockResolvedValueOnce("S");
    const result = await executeCompactionCore.call(engine, {
      conversationId, sessionId, sessionFile: "/tmp/accounting.jsonl", tokenBudget: 100,
      compactionTarget: "budget", force: true, runtimeSettings, legacyParams: { summarize },
    });
    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(true);
    expect(result.reason).toBe(failure === "auth" ? "provider auth failure after partial compaction" : failure === "spend" ? "summary spend backoff open" : "compaction failed after partial progress");
    expect(result.result?.tokensAfter).toBe(await engine.getSummaryStore().getContextTokenCount(conversationId));
    expect(result.result?.tokensAfter).toBeLessThan(result.result!.tokensBefore);
  });

  it.each([
    new LcmRuntimeLifecycleError("host ended"),
    new LcmRuntimeLlmUnavailableError("host capability unavailable"),
    new LcmRuntimeLlmPolicyError({ provider: "test", model: "summary", modelRef: "test/summary", configField: "summaryModel", message: "override denied" }),
  ])("keeps host failures fatal after partial progress: $name", async (error) => {
    const { engine, executeCompactionCore, conversationId, sessionId } = await seedRecovery();
    const summarize = vi.fn(async (): Promise<string> => { throw error; }).mockResolvedValueOnce("S");
    await expect(executeCompactionCore({
      conversationId, sessionId, sessionFile: "/tmp/accounting.jsonl", tokenBudget: 100,
      force: true, legacyParams: { summarize },
    })).rejects.toBe(error);
    expect(await engine.getSummaryStore().getContextTokenCount(conversationId)).toBeLessThan(5_000);
    expect(await engine.getConversationStore().getMessages(conversationId)).toHaveLength(10);
  });

  it("opens poor-reduction backoff for a real summarizer attempt even without committed work", async () => {
    const { engine, compaction, compactionGuards, executeCompactionCore, conversationId, sessionId } = await seedRecovery();
    const summarize = vi.fn(async () => "unused summary");
    // Isolate result conversion: spending and committed work are independent signals.
    vi.spyOn(compaction, "compactUntilUnder").mockImplementation(async (input) => {
      await input.summarize("eligible source");
      return { success: false, actionTaken: false, rounds: 1, finalTokens: 5_000 };
    });
    const backoff = vi.spyOn(compactionGuards, "openSummarySpendBackoff");
    const result = await executeCompactionCore.call(engine, {
      conversationId, sessionId, sessionFile: "/tmp/accounting.jsonl", tokenBudget: 100,
      force: true, legacyParams: { summarize },
    });
    expect(summarize).toHaveBeenCalledOnce();
    expect(result.compacted).toBe(false);
    expect(backoff).toHaveBeenCalledOnce();
  });

  it("does not treat deterministic fallback work as model spend", async () => {
    const engine = createEngineWithDeps({ freshTailCount: 2 }, {
      resolveModel: () => { throw new Error("no configured summary model"); },
    });
    await seedBacklogContext(engine, "fallback", Array(10).fill(500));
    const conversation = await engine.getConversationStore().getConversationBySessionId("fallback");
    const { compaction, compactionGuards, executeCompactionCore } = accountingInternals(engine);
    vi.spyOn(compaction, "compactUntilUnder").mockImplementation(async (input) => {
      await input.summarize("local fallback source");
      return { success: false, actionTaken: true, rounds: 1, finalTokens: 4_900 };
    });
    const backoff = vi.spyOn(compactionGuards, "openSummarySpendBackoff");
    const result = await executeCompactionCore.call(engine, {
      conversationId: conversation!.conversationId, sessionId: "fallback",
      sessionFile: "/tmp/accounting.jsonl", tokenBudget: 100, force: true,
    });
    expect(result).toMatchObject({ ok: false, compacted: true });
    expect(backoff).not.toHaveBeenCalled();
  });

  it("observes failed allowed calls but excludes subsequent spend-guard rejections", async () => {
    const { compactionGuards } = await seedRecovery(12, { summaryMaxCallsPerWindow: 1 });
    const error = new Error("provider connection failed");
    const summarize = vi.fn(async (): Promise<string> => { throw error; });
    const onAttempt = vi.fn();
    const guarded = compactionGuards.guardCustomSummarize({ scopeKey: "failed-call", summarize, onAttempt });
    await expect(guarded("source")).rejects.toBe(error);
    expect(onAttempt).toHaveBeenCalledOnce();
    await expect(guarded("source")).rejects.toBeInstanceOf(LcmSummarySpendLimitError);
    expect(summarize).toHaveBeenCalledOnce();
    expect(onAttempt).toHaveBeenCalledOnce();
  });

  it("does not count guard rejections as attempts or replace their existing backoff", async () => {
    const { engine, compactionGuards, conversationId, sessionId, executeCompactionCore } = await seedRecovery(12, { summaryMaxCallsPerWindow: 1 });
    const summarize = vi.fn(async () => "S");
    const backoff = vi.spyOn(compactionGuards, "openSummarySpendBackoff");
    // Allow one call, then let the real spend guard stop the second pass.
    const result = await executeCompactionCore.call(engine, {
      conversationId, sessionId, sessionFile: "/tmp/accounting.jsonl", tokenBudget: 100,
      force: true, legacyParams: { summarize },
    });
    expect(summarize).toHaveBeenCalledOnce();
    expect(backoff).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: false, compacted: true, reason: "summary spend backoff open" });
  });
});
