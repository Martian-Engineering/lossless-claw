import { afterEach, describe, expect, it, vi } from "vitest";
import type { LcmContextEngine } from "../src/engine.js";
import {
  DEFAULT_FRESH_TAIL_MIN_MESSAGES,
  resolveFreshTailTokenCap,
} from "../src/fresh-tail.js";
import { resolvePendingFreshTailOrdinal } from "../src/pending-summary-planner.js";
import { cleanupEngineTestState, createEngineWithDeps } from "./helpers.js";

afterEach(cleanupEngineTestState);

/** Forty alternating user/assistant rows of 1,000 tokens each: well inside a 64-message tail. */
const BACKLOG = Array.from({ length: 40 }, () => 1_000);

function createEngine(overrides: Parameters<typeof createEngineWithDeps>[0] = {}) {
  const complete = vi.fn(async () => ({ content: [{ type: "text", text: "Default cap summary." }] }));
  const engine = createEngineWithDeps({
    freshTailCount: 64,
    leafChunkTokens: 4_000,
    proactiveThresholdCompactionMode: "deferred",
    summaryProvider: "anthropic",
    summaryModel: "claude-opus-4-5",
    ...overrides,
  }, { complete });
  return { engine, complete };
}

/** Persist alternating user/assistant rows whose content matches their token counts. */
async function seedBacklog(engine: LcmContextEngine, sessionId: string): Promise<void> {
  const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
    sessionKey: undefined,
  });
  const messages = await engine.getConversationStore().createMessagesBulk(
    BACKLOG.map((tokenCount, index) => ({
      conversationId: conversation.conversationId,
      seq: index,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `turn ${index} ${"filler word ".repeat(330)}`,
      tokenCount,
      skipReplayTimestampFloodGuard: true,
    })),
  );
  await engine.getSummaryStore().appendContextMessages(
    conversation.conversationId,
    messages.map((message) => message.messageId),
  );
  await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
    conversationId: conversation.conversationId,
    reason: "threshold",
    tokenBudget: 40_000,
    currentTokenCount: 40_000,
  });
}

async function conversationIdFor(engine: LcmContextEngine, sessionId: string): Promise<number> {
  const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
  return conversation!.conversationId;
}

describe("resolveFreshTailTokenCap", () => {
  it("caps an unconfigured tail at a quarter of the budget with a message floor", () => {
    expect(resolveFreshTailTokenCap(undefined, 272_000)).toEqual({
      maxTokens: 68_000,
      minMessages: DEFAULT_FRESH_TAIL_MIN_MESSAGES,
    });
  });

  it("keeps an explicit cap and its single-message floor", () => {
    expect(resolveFreshTailTokenCap(12_000, 272_000)).toEqual({ maxTokens: 12_000, minMessages: 1 });
    expect(resolveFreshTailTokenCap(0, 272_000)).toEqual({ maxTokens: 0, minMessages: 1 });
  });

  it.each([undefined, 0, -5, Number.NaN, Number.MAX_SAFE_INTEGER])(
    "stays count-only without a usable budget (%s)",
    (budget) => {
      expect(resolveFreshTailTokenCap(undefined, budget)).toEqual({ minMessages: 1 });
    },
  );
});

describe("pending fresh tail with a message floor", () => {
  it("keeps the minimum message count before applying the token cap", () => {
    const items = Array.from({ length: 12 }, (_, ordinal) => ({
      ordinal,
      itemType: "message" as const,
      tokenCount: 1_000,
      sourceFingerprint: `fp-${ordinal}`,
      messageId: ordinal + 1,
      role: ordinal % 2 === 0 ? "user" as const : "assistant" as const,
    }));
    expect(resolvePendingFreshTailOrdinal({ items, freshTailCount: 64, freshTailMaxTokens: 2_000 })).toBe(10);
    expect(resolvePendingFreshTailOrdinal({
      items, freshTailCount: 64, freshTailMaxTokens: 2_000, freshTailMinMessages: 8,
    })).toBe(4);
  });
});

describe("default fresh-tail cap", () => {
  it("lets deferred compaction plan history that a count-only tail would protect", async () => {
    const { engine, complete } = createEngine();
    const sessionId = "default-fresh-tail-cap-pending";
    await seedBacklog(engine, sessionId);
    const conversationId = await conversationIdFor(engine, sessionId);

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
      tokenBudget: 40_000,
      currentTokenCount: 40_000,
      reason: "threshold",
    });

    expect(complete.mock.calls.length).toBeGreaterThan(0);
    const contextItems = await engine.getSummaryStore().getContextItems(conversationId);
    const newest = contextItems.slice(-DEFAULT_FRESH_TAIL_MIN_MESSAGES);
    expect(newest.every((item) => item.itemType === "message")).toBe(true);
  });

  it("does not change an explicitly configured tail", async () => {
    const { engine, complete } = createEngine({ freshTailMaxTokens: 100_000 });
    const sessionId = "explicit-fresh-tail-cap-pending";
    await seedBacklog(engine, sessionId);
    const conversationId = await conversationIdFor(engine, sessionId);
    const privateEngine = engine as unknown as {
      drainDeferredCompactionDebtIfIdle: (params: Record<string, unknown>) => Promise<void>;
    };
    await privateEngine.drainDeferredCompactionDebtIfIdle({
      conversationId,
      sessionId,
      queueKey: sessionId,
      tokenBudget: 40_000,
      currentTokenCount: 40_000,
      reason: "threshold",
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it("lets assembly evict inside a count-only tail to fit the budget", async () => {
    const { engine } = createEngine();
    const sessionId = "default-fresh-tail-cap-assembly";
    await seedBacklog(engine, sessionId);
    const conversationId = await conversationIdFor(engine, sessionId);
    const assembler = (engine as unknown as {
      assembler: { assemble: (input: Record<string, unknown>) => Promise<{ estimatedTokens: number; messages: unknown[] }> };
    }).assembler;

    const assembled = await assembler.assemble({ conversationId, tokenBudget: 20_000, freshTailCount: 64 });

    expect(assembled.estimatedTokens).toBeLessThanOrEqual(20_000);
    expect(assembled.messages.length).toBeGreaterThanOrEqual(DEFAULT_FRESH_TAIL_MIN_MESSAGES);
    expect(assembled.messages.length).toBeLessThan(BACKLOG.length);
  });
});
