import { afterEach, describe, expect, it, vi } from "vitest";
import type { LcmContextEngine } from "../src/engine.js";
import type { CompactionGuards } from "../src/compaction-guards.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import { estimateSerializedMessagesTokens } from "../src/estimate-tokens.js";
import { cleanupEngineTestState, createEngineWithDeps, createSessionFilePath, makeMessage } from "./helpers.js";

afterEach(cleanupEngineTestState);

const SESSION = "foreground-recovery";
const BUDGET = 22_000;
const SIGNATURE = "synthetic-opaque-signature".repeat(40);

/** Only completion is synthetic; persistence, planning and publication are real. */
function fixture(config: Parameters<typeof createEngineWithDeps>[0] = {}, deps: Parameters<typeof createEngineWithDeps>[1] = {}) {
  const complete = vi.fn(async () => ({ content: [{ type: "text", text: "Foreground summary of observations." }] }));
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  const engine = createEngineWithDeps({
    contextThreshold: 0.65,
    freshTailCount: 4,
    leafChunkTokens: 6_000,
    maxSweepIterations: 12,
    summaryProvider: "anthropic",
    summaryModel: "synthetic-summary",
    ...config,
  }, { complete, log, ...deps });
  return { engine, complete, log };
}

/** Build complete user/tool exchanges with opaque signatures that must survive. */
function turnMessages(turn: number): AgentMessage[] {
  return [
    makeMessage({ role: "user", content: `Inspect observation ${turn}`, timestamp: turn * 4 + 1 }),
    makeMessage({ role: "assistant", timestamp: turn * 4 + 2, content: [
      { type: "thinking", thinking: "Inspect the observation", thinkingSignature: SIGNATURE },
      { type: "toolCall", id: `inspect-${turn}`, name: "inspect", arguments: { turn } },
    ] }),
    makeMessage({ role: "toolResult", toolCallId: `inspect-${turn}`, content: `Observation ${turn} is stable`, timestamp: turn * 4 + 3 }),
    makeMessage({ role: "assistant", content: `Observation ${turn}: ${"synthetic observation. ".repeat(600)}`, timestamp: turn * 4 + 4 }),
  ].map(message => message.role === "assistant" ? {
    ...message, provider: "anthropic", api: "anthropic-messages", model: "synthetic-summary",
  } as AgentMessage : message);
}

/** Commit durable turns without ever delivering the host maintenance callback. */
async function seed(engine: LcmContextEngine, durable = false) {
  const messages: AgentMessage[] = [];
  for (let turn = 0; turn < 6; turn += 1) {
    const next = turnMessages(turn);
    messages.push(...next);
    if (durable) {
      const position = turn * 4;
      const common = { agentId: "main", generation: "synthetic", sessionId: SESSION, sessionKey: `agent:main:${SESSION}`, storePath: "/tmp/synthetic-host.sqlite" };
      await engine.commitTurn({
        sessionId: SESSION,
        sessionKey: common.sessionKey,
        advancementKey: `turn-${turn}`,
        admission: { ...common, activeMessagePosition: position + 1, effectiveParentId: null,
          entryId: `user-${turn}`, logicalTurnId: `turn-${turn}`, rawSeq: position + 1, role: "user" },
        terminal: { ...common, activeMessagePosition: position + 4, effectiveParentId: `user-${turn}`,
          entryId: `answer-${turn}`, rawSeq: position + 4 },
        sessionTarget: common,
        messages: next,
        runtimeContext: { tokenBudget: BUDGET },
      });
    } else {
      for (const message of next) await engine.ingest({ sessionId: SESSION, message });
    }
  }
  const conversation = await engine.getConversationStore().getConversationBySessionId(SESSION);
  return { messages, conversationId: conversation!.conversationId };
}

/** Snapshot messages and parts independently of the canonical context projection. */
async function persisted(engine: LcmContextEngine, conversationId: number) {
  const messages = await engine.getConversationStore().getMessages(conversationId);
  return Promise.all(messages.map(async message => ({
    message, parts: await engine.getConversationStore().getMessageParts(message.messageId),
  })));
}

/** Exercise the host's prompt-separate assembly contract. */
function assemble(engine: LcmContextEngine, messages: AgentMessage[], tokenBudget = BUDGET) {
  return engine.assemble({ sessionId: SESSION, messages, tokenBudget, prompt: "Next observation", availableTools: new Set(["inspect"]) });
}

/** Prepare a complete hidden batch using the real host maintenance entry point. */
async function prepare(engine: LcmContextEngine) {
  const sessionFile = createSessionFilePath(SESSION);
  await engine.afterTurn({ sessionId: SESSION, sessionFile, messages: [], prePromptMessageCount: 0, tokenBudget: 100_000 });
  await engine.maintain({ sessionId: SESSION, sessionFile, runtimeContext: { allowDeferredCompactionExecution: true, tokenBudget: 100_000 } });
}

describe("foreground compaction before pressure eviction", () => {
  it("recovers missing maintenance before trimming, preserving history, lineage and the subsequent prefix", async () => {
    const { engine, complete, log } = fixture();
    const { messages, conversationId } = await seed(engine, true);
    expect(complete).not.toHaveBeenCalled();
    const original = structuredClone(messages);
    const before = await persisted(engine, conversationId);
    const tokensBefore = await engine.getSummaryStore().getContextTokenCount(conversationId);
    const live = [makeMessage({ role: "user", content: "[Retry after the previous model attempt failed or timed out]\nUnpersisted current input" })];
    const epochBefore = (await assemble(engine, messages, 100_000)).contextProjection?.epoch;
    const output = await assemble(engine, live);
    expect(complete.mock.calls.length).toBeGreaterThan(0);
    const tokensAfter = await engine.getSummaryStore().getContextTokenCount(conversationId);
    expect(tokensAfter).toBeLessThan(tokensBefore);
    expect(output.estimatedTokens).toBeLessThan(BUDGET * 0.65);
    expect(JSON.stringify(output.messages)).toContain("Foreground summary");
    expect(JSON.stringify(output.messages)).toContain("Unpersisted current input");
    expect(JSON.stringify(output.messages)).toContain(SIGNATURE);
    expect(output.contextProjection?.epoch).not.toBe(epochBefore);
    expect(messages).toEqual(original);
    expect(await persisted(engine, conversationId)).toEqual(before);
    const summaries = await engine.getSummaryStore().getSummariesByConversation(conversationId);
    const linked = (await Promise.all(summaries.map(summary => engine.getSummaryStore().getSummaryMessages(summary.summaryId)))).flat();
    const context = await engine.getSummaryStore().getContextItems(conversationId);
    const retainedIds = new Set(context.map(item => item.messageId));
    const replacedIds = before.map(entry => entry.message.messageId).filter(messageId => !retainedIds.has(messageId));
    expect(new Set(linked)).toEqual(new Set(replacedIds));
    expect(log.warn.mock.calls.flat().join("\n")).not.toMatch(/degraded live fallback|serialized budget clamp/);

    // Regrowth below threshold must append without another prefix rewrite.
    const callCount = complete.mock.calls.length;
    const canonical = await assemble(engine, messages);
    for (let turn = 0; turn < 2; turn += 1) {
      const message = makeMessage({ role: "user", content: `Small following turn ${turn}` });
      await engine.ingest({ sessionId: SESSION, message });
      const later = await assemble(engine, [message]);
      expect(later.messages.slice(0, canonical.messages.length)).toEqual(canonical.messages);
      expect(later.contextProjection?.epoch).toBe(output.contextProjection?.epoch);
    }
    expect(complete).toHaveBeenCalledTimes(callCount);
  });

  it("retains published context after reaching a target above the degraded trigger", async () => {
    const { engine, complete, log } = fixture({ contextThreshold: 0.85, freshTailCount: 20, leafChunkTokens: 3_000 });
    const { messages, conversationId } = await seed(engine, true);
    const before = await persisted(engine, conversationId);
    const tokensBefore = await engine.getSummaryStore().getContextTokenCount(conversationId);
    const budget = 24_000;
    const output = await assemble(engine, messages, budget);
    const tokensAfter = await engine.getSummaryStore().getContextTokenCount(conversationId);
    expect(tokensAfter).toBeLessThan(tokensBefore);
    expect(estimateSerializedMessagesTokens(output.messages)).toBeGreaterThan(budget * 0.75);
    expect(estimateSerializedMessagesTokens(output.messages)).toBeLessThan(budget * 0.85);
    expect(JSON.stringify(output.messages)).toContain("Foreground summary");
    expect(await persisted(engine, conversationId)).toEqual(before);
    expect(await engine.getCompactionMaintenanceStore().getConversationCompactionMaintenance(conversationId))
      .toMatchObject({ pending: false, running: false });
    expect(log.info.mock.calls.flat().join("\n")).toContain("reduced=true reachedTarget=true pending=false");
    expect(log.warn.mock.calls.flat().join("\n")).not.toMatch(/degraded live fallback|serialized budget clamp/);

    const calls = complete.mock.calls.length;
    for (let turn = 0; turn < 2; turn += 1) {
      const message = makeMessage({ role: "user", content: `Small following turn ${turn}` });
      await engine.ingest({ sessionId: SESSION, message });
      const later = await assemble(engine, [message], budget);
      expect(later.messages.slice(0, output.messages.length)).toEqual(output.messages);
      expect(later.contextProjection?.epoch).toBe(output.contextProjection?.epoch);
    }
    expect(complete).toHaveBeenCalledTimes(calls);
  });

  it("publishes a complete ready batch during debt cooldown with zero new calls", async () => {
    const { engine, complete } = fixture();
    const { messages, conversationId } = await seed(engine);
    await prepare(engine);
    const calls = complete.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    expect(await engine.getSummaryStore().getSummariesByConversation(conversationId)).toHaveLength(0);
    const guards = (engine as unknown as { compactionGuards: CompactionGuards }).compactionGuards;
    guards.openSummarySpendBackoff({ scopeKey: guards.resolveSummarySpendScope({ kind: "compaction", scope: SESSION }), reason: "test cooldown" });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({ conversationId, reason: "threshold", tokenBudget: BUDGET });
    await engine.getCompactionMaintenanceStore().markProactiveCompactionFinished({
      conversationId, keepPending: true, failureSummary: "summary spend backoff open", nextAttemptAfter: new Date(Date.now() + 60_000),
    });
    const output = await assemble(engine, messages);
    expect(JSON.stringify(output.messages)).toContain("Foreground summary");
    expect(complete).toHaveBeenCalledTimes(calls);
    expect(output.estimatedTokens).toBeLessThan(BUDGET * 0.65);
    expect((await engine.getCompactionMaintenanceStore().getConversationCompactionMaintenance(conversationId))?.running).toBe(false);
  });

  it("respects the real generation spend guard and retains incomplete work", async () => {
    const { engine, complete, log } = fixture({ summaryMaxCallsPerWindow: 1, summaryCallWindowMs: 600_000, summarySpendBackoffMs: 600_000 });
    const { messages, conversationId } = await seed(engine);
    const before = await persisted(engine, conversationId);
    await assemble(engine, messages);
    expect(complete).toHaveBeenCalledTimes(1);
    const debt = await engine.getCompactionMaintenanceStore().getConversationCompactionMaintenance(conversationId);
    expect(debt?.pending).toBe(true);
    expect(debt?.nextAttemptAfter!.getTime()).toBeGreaterThan(Date.now());
    await assemble(engine, messages);
    expect(complete).toHaveBeenCalledTimes(1);
    const afterCooldownAttempt = await engine.getCompactionMaintenanceStore().getConversationCompactionMaintenance(conversationId);
    expect(afterCooldownAttempt?.retryAttempts).toBe(debt?.retryAttempts);
    expect(afterCooldownAttempt?.nextAttemptAfter).toEqual(debt?.nextAttemptAfter);
    expect(await persisted(engine, conversationId)).toEqual(before);
    expect(log.info.mock.calls.flat().join("\n")).toContain("reduced=false reachedTarget=false");
  });

  it("bounds summarizer failure and falls back without reporting recovery", async () => {
    const { engine, complete, log } = fixture();
    const { messages, conversationId } = await seed(engine);
    const before = await persisted(engine, conversationId);
    const summarize = vi.fn(async () => { throw new Error("synthetic provider unavailable"); });
    const params = { sessionId: SESSION, messages, tokenBudget: BUDGET, runtimeContext: { summarize } };
    const output = await engine.assemble(params);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
    expect(output.messages.length).toBeGreaterThan(0);
    expect(await persisted(engine, conversationId)).toEqual(before);
    expect(await engine.getSummaryStore().getSummariesByConversation(conversationId)).toHaveLength(0);
    expect(log.info.mock.calls.flat().join("\n")).toContain("reduced=false reachedTarget=false");
    expect(log.info.mock.calls.flat().join("\n")).toContain("reason=synthetic provider unavailable");
    await engine.assemble(params);
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it("reports protected-tail exhaustion without generating or altering tool exchanges", async () => {
    const { engine, complete, log } = fixture({ freshTailCount: 64 });
    const { messages, conversationId } = await seed(engine);
    const before = await persisted(engine, conversationId);
    const output = await assemble(engine, messages);
    expect(complete).not.toHaveBeenCalled();
    expect(await persisted(engine, conversationId)).toEqual(before);
    expect(log.info.mock.calls.flat().join("\n")).toContain("reason=no compactable context outside fresh tail");
    expect(log.info.mock.calls.flat().join("\n")).toContain("reduced=false reachedTarget=false");
    expect(JSON.stringify(output.messages)).toContain(SIGNATURE);
    const calls = output.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
      .filter(block => block.type === "toolCall").map(block => block.id);
    const results = output.messages.filter(message => message.role === "toolResult").map(message => Reflect.get(message, "toolCallId"));
    expect(results).toEqual(calls);
  });

  it("keeps unavailable summarizers and step-limited preparation explicit and bounded", async () => {
    const unavailable = fixture({ summaryProvider: "", summaryModel: "" }, {
      resolveModel: () => { throw new Error("no configured summarizer"); },
    });
    const first = await seed(unavailable.engine);
    await assemble(unavailable.engine, first.messages);
    expect(unavailable.complete).not.toHaveBeenCalled();
    expect(unavailable.log.info.mock.calls.flat().join("\n")).toContain("reason=pending summary model unavailable");

    const bounded = fixture({ maxSweepIterations: 2 });
    const second = await seed(bounded.engine);
    await assemble(bounded.engine, second.messages);
    expect(bounded.complete).toHaveBeenCalledTimes(1);
    expect(await bounded.engine.getSummaryStore().getSummariesByConversation(second.conversationId)).toHaveLength(0);
    expect(bounded.log.info.mock.calls.flat().join("\n")).toContain("reason=pending summary work remains");
    expect((await bounded.engine.getCompactionMaintenanceStore().getConversationCompactionMaintenance(second.conversationId))?.pending).toBe(true);
  });

  it("keeps the current user admission and complete tool exchange outside compaction", async () => {
    const { engine } = fixture({ freshTailCount: 1 });
    const { conversationId } = await seed(engine);
    const current = turnMessages(6);
    for (const message of current) await engine.ingest({ sessionId: SESSION, message });
    const before = await persisted(engine, conversationId);
    const currentIds = before.slice(-current.length).map(entry => entry.message.messageId);
    const output = await assemble(engine, current);
    const context = await engine.getSummaryStore().getContextItems(conversationId);
    expect(context.filter(item => item.itemType === "message").map(item => item.messageId)).toEqual(currentIds);
    expect(JSON.stringify(output.messages)).toContain("Inspect observation 6");
    expect(JSON.stringify(output.messages)).toContain("inspect-6");
    expect(JSON.stringify(output.messages)).toContain(SIGNATURE);
    expect(await persisted(engine, conversationId)).toEqual(before);
  });

  it("detects serialized-only pressure without preexisting debt", async () => {
    const { engine, complete } = fixture();
    const { messages, conversationId } = await seed(engine);
    const stored = await engine.getSummaryStore().getContextTokenCount(conversationId);
    const unbounded = await assemble(engine, messages, 100_000);
    const serialized = estimateSerializedMessagesTokens(unbounded.messages);
    expect(serialized).toBeGreaterThan(stored);
    const budget = Math.ceil((stored + serialized) / 2 / 0.9);
    expect(stored).toBeLessThan(budget * 0.9);
    expect(serialized).toBeGreaterThan(budget * 0.9);
    expect(await engine.getCompactionMaintenanceStore().getConversationCompactionMaintenance(conversationId)).toBeNull();
    const output = await assemble(engine, messages, budget);
    expect(complete.mock.calls.length).toBeGreaterThan(0);
    expect(JSON.stringify(output.messages)).toContain("Foreground summary");
    expect(output.estimatedTokens).toBeLessThan(budget * 0.65);
  });

  it("preserves an unpersisted ordinary live tail when publication changes raw coverage", async () => {
    const { engine, log } = fixture();
    const { messages, conversationId } = await seed(engine);
    const before = await persisted(engine, conversationId);
    const current = turnMessages(6);
    current[0] = makeMessage({ role: "user", content: "Ordinary unpersisted admission" });
    const live = [...messages, ...current];
    const output = await assemble(engine, live);
    expect(JSON.stringify(output.messages)).toContain("Ordinary unpersisted admission");
    expect(output.messages.slice(-current.length)).toEqual(current);
    expect(await persisted(engine, conversationId)).toEqual(before);
    expect(JSON.stringify(output.messages)).toContain("Foreground summary");
    expect(output.estimatedTokens).toBeLessThan(BUDGET * 0.65);
    expect(log.warn.mock.calls.flat().join("\n")).not.toMatch(/degraded live fallback|serialized budget clamp/);
  });

  it("retains debt when publication reduces canonical context but the protected tail exceeds target", async () => {
    const { engine, complete, log } = fixture({ freshTailCount: 16 });
    const { messages, conversationId } = await seed(engine);
    const before = await engine.getSummaryStore().getContextTokenCount(conversationId);
    await assemble(engine, messages);
    const after = await engine.getSummaryStore().getContextTokenCount(conversationId);
    expect(complete.mock.calls.length).toBeGreaterThan(0);
    expect(after).toBeLessThan(before);
    expect(after).toBeGreaterThan(BUDGET * 0.65);
    expect((await engine.getCompactionMaintenanceStore().getConversationCompactionMaintenance(conversationId))?.pending).toBe(true);
    expect(log.info.mock.calls.flat().join("\n")).toContain("reduced=true reachedTarget=false pending=true");
  });

  it("uses live fallback for ambiguous same-length raw coverage", async () => {
    const { engine } = fixture();
    const { messages, conversationId } = await seed(engine);
    const before = await persisted(engine, conversationId);
    const live = messages.slice();
    live[live.length - 1] = makeMessage({ role: "user", content: "Different unpersisted current input" });
    const output = await assemble(engine, live);
    expect(JSON.stringify(output.messages)).toContain("Different unpersisted current input");
    expect(JSON.stringify(output.messages)).not.toContain("Foreground summary");
    expect(await persisted(engine, conversationId)).toEqual(before);
  });

  it("keeps the existing raw live fallback unchanged below pressure", async () => {
    const { engine, complete } = fixture();
    const { messages } = await seed(engine);
    const live = [...messages, makeMessage({ role: "user", content: "Unpersisted next input" })];
    live[0] = { ...live[0], idempotencyKey: "original-live-replay", timestamp: 42 } as AgentMessage;
    const output = await assemble(engine, live, 100_000);
    expect(output.messages).toEqual(live);
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([false, true])("finishes only foreground-owned debt during ready publication (background debt owner: %s)", async backgroundOwnsDebt => {
    const { engine, complete, log } = fixture({ contextThreshold: 0.85, freshTailCount: 20, leafChunkTokens: 3_000 });
    const { messages, conversationId } = await seed(engine);
    const before = await persisted(engine, conversationId);
    const store = engine.getPendingSummaryStore();
    const markNodeReady = store.markNodeReady.bind(store);
    let release!: () => void;
    let ready!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { ready = resolve; });
    // Pause after the real SQLite write makes the complete frontier visible,
    // before the preparation drain can release its in-memory ownership.
    vi.spyOn(store, "markNodeReady").mockImplementation(async input => {
      const saved = await markNodeReady(input);
      const batch = await store.getActiveBatchForConversation(conversationId);
      const nodes = batch ? await store.getNodesByBatch(batch.batchId) : [];
      if (saved && nodes.length > 0 && nodes.every(node => node.status === "ready")) {
        ready();
        await gate;
      }
      return saved;
    });
    if (backgroundOwnsDebt) {
      await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
        conversationId, reason: "threshold", tokenBudget: 24_000,
      });
    }
    const maintenance = backgroundOwnsDebt ? engine.maintain({
      sessionId: SESSION, sessionFile: createSessionFilePath(SESSION),
      runtimeContext: { allowDeferredCompactionExecution: true, tokenBudget: 24_000 },
    }) : prepare(engine);
    try {
      await entered;
      const debtBefore = await engine.getCompactionMaintenanceStore().getConversationCompactionMaintenance(conversationId);
      if (backgroundOwnsDebt) expect(debtBefore).toMatchObject({ running: true });
      else expect(debtBefore).toBeNull();
      const calls = complete.mock.calls.length;
      const output = await assemble(engine, messages, 24_000);
      expect(JSON.stringify(output.messages)).toContain("Foreground summary");
      expect(output.estimatedTokens).toBeLessThan(24_000 * 0.85);
      expect(complete).toHaveBeenCalledTimes(calls);
      expect(log.info.mock.calls.flat().join("\n")).toContain("reduced=true reachedTarget=true pending=false");
      const debtAfter = await engine.getCompactionMaintenanceStore().getConversationCompactionMaintenance(conversationId);
      if (backgroundOwnsDebt) expect(debtAfter).toEqual(debtBefore);
      else expect(debtAfter).toMatchObject({ pending: false, running: false, lastFinishedAt: expect.any(Date) });
    } finally {
      release();
      await maintenance;
    }
    if (!backgroundOwnsDebt) {
      expect(await engine.getCompactionMaintenanceStore().getConversationCompactionMaintenance(conversationId))
        .toMatchObject({ pending: false, running: false });
    }
    expect(await persisted(engine, conversationId)).toEqual(before);
  });

  it("does not duplicate generation or deadlock behind active background maintenance", async () => {
    const { engine, complete, log } = fixture();
    const { messages, conversationId } = await seed(engine);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    complete.mockImplementation(async () => {
      started();
      await gate;
      return { content: [{ type: "text", text: "Foreground summary of observations." }] };
    });
    const maintenance = prepare(engine);
    try {
      await entered;
      await assemble(engine, messages);
      expect(complete).toHaveBeenCalledTimes(1);
      expect(log.info.mock.calls.flat().join("\n")).toContain("reason=background maintenance active");
      expect((await engine.getCompactionMaintenanceStore().getConversationCompactionMaintenance(conversationId))?.pending).toBe(true);
    } finally {
      release();
      await maintenance;
    }
    const calls = complete.mock.calls.length;
    const output = await assemble(engine, messages);
    expect(JSON.stringify(output.messages)).toContain("Foreground summary");
    expect(complete).toHaveBeenCalledTimes(calls);
  });
});
