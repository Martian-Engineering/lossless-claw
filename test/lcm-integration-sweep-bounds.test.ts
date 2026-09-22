// LCM integration: compactFullSweep and compactUntilUnder bounds.
// Split from the former monolithic test/lcm-integration.test.ts.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { CompactionEngine, type CompactionConfig } from "../src/compaction.js";
import { detectDoctorMarker } from "../src/plugin/lcm-doctor-shared.js";
import {
  createMockConversationStore,
  createMockSummaryStore,
  estimateTokens,
  CONV_ID,
  ingestMessages,
  wireStores,
  defaultCompactionConfig,
} from "./integration-helpers.js";

describe("LCM integration: compactFullSweep bounds", () => {
  let convStore: ReturnType<typeof createMockConversationStore>;
  let sumStore: ReturnType<typeof createMockSummaryStore>;

  beforeEach(() => {
    convStore = createMockConversationStore();
    sumStore = createMockSummaryStore();
    wireStores(convStore, sumStore);
  });

  // Config that produces many leaf passes: a small leaf chunk size means each
  // pass only consumes a few raw messages, so a long conversation drives one
  // leaf pass per chunk. Without a bound this loop is effectively unbounded.
  const manyPassConfig = (overrides: Partial<CompactionConfig>): CompactionConfig => ({
    ...defaultCompactionConfig,
    freshTailCount: 2,
    leafChunkTokens: 60,
    leafMinFanout: 1,
    ...overrides,
  });

  // ~12 tokens each; 60 messages outside a 2-message fresh tail, ~3 messages
  // per 60-token chunk => an unbounded sweep would run well over a dozen
  // passes.
  const seedManyMessages = async (): Promise<void> => {
    await ingestMessages(convStore, sumStore, 60, {
      contentFn: (i) => `Turn ${i}: ${"w".repeat(40)}`,
      tokenCountFn: (_i, content) => estimateTokens(content),
    });
  };

  it("stops cleanly at the iteration cap with a consistent partial result", async () => {
    const engine = new CompactionEngine(
      convStore as any,
      sumStore as any,
      manyPassConfig({ maxSweepIterations: 3 }),
    );
    await seedManyMessages();

    const summarize = vi.fn(async (text: string) => `S(${text.length})`);

    const result = await engine.compact({
      conversationId: CONV_ID,
      tokenBudget: 10_000,
      summarize,
      force: true,
    });

    // The cap is a hard ceiling on summarizer passes within the sweep.
    expect(summarize).toHaveBeenCalledTimes(3);
    // A capped sweep still returns the consistent partial result built so far.
    expect(result.actionTaken).toBe(true);
    expect(result.createdSummaryId).toBeDefined();
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
    // Context still contains the un-swept remainder as raw messages.
    const contextItems = await sumStore.getContextItems(CONV_ID);
    expect(contextItems.some((ci) => ci.itemType === "message")).toBe(true);
    expect(contextItems.some((ci) => ci.itemType === "summary")).toBe(true);
  });

  it("runs more passes when the iteration cap is raised (cap is the limiting factor)", async () => {
    const lowCapEngine = new CompactionEngine(
      convStore as any,
      sumStore as any,
      manyPassConfig({ maxSweepIterations: 2 }),
    );
    await seedManyMessages();
    const lowCapSummarize = vi.fn(async (text: string) => `S(${text.length})`);
    await lowCapEngine.compact({
      conversationId: CONV_ID,
      tokenBudget: 10_000,
      summarize: lowCapSummarize,
      force: true,
    });

    // Fresh stores for the high-cap run so the two are independent.
    const convStore2 = createMockConversationStore();
    const sumStore2 = createMockSummaryStore();
    wireStores(convStore2, sumStore2);
    await ingestMessages(convStore2, sumStore2, 60, {
      contentFn: (i) => `Turn ${i}: ${"w".repeat(40)}`,
      tokenCountFn: (_i, content) => estimateTokens(content),
    });
    const highCapEngine = new CompactionEngine(
      convStore2 as any,
      sumStore2 as any,
      manyPassConfig({ maxSweepIterations: 50 }),
    );
    const highCapSummarize = vi.fn(async (text: string) => `S(${text.length})`);
    await highCapEngine.compact({
      conversationId: CONV_ID,
      tokenBudget: 10_000,
      summarize: highCapSummarize,
      force: true,
    });

    // The low cap genuinely limits the sweep: it stops at exactly the cap,
    // while the high-cap run is free to make more passes.
    expect(lowCapSummarize).toHaveBeenCalledTimes(2);
    expect(highCapSummarize.mock.calls.length).toBeGreaterThan(2);
  });

  it("stops cleanly when the wall-clock deadline is exceeded", async () => {
    const engine = new CompactionEngine(
      convStore as any,
      sumStore as any,
      // Large iteration cap so the deadline — not the cap — is what stops it.
      manyPassConfig({ maxSweepIterations: 1000, sweepDeadlineMs: 40 }),
    );
    await seedManyMessages();

    // Each summarizer call sleeps ~25ms; after ~2 passes the 40ms budget is
    // spent and the sweep must stop before starting another pass.
    const summarize = vi.fn(async (text: string) => {
      await new Promise((r) => setTimeout(r, 25));
      return `S(${text.length})`;
    });

    const result = await engine.compact({
      conversationId: CONV_ID,
      tokenBudget: 10_000,
      summarize,
      force: true,
    });

    // Far fewer passes than the iteration cap or an unbounded sweep would do.
    expect(summarize.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(summarize.mock.calls.length).toBeLessThan(10);
    expect(result.actionTaken).toBe(true);
    expect(result.tokensAfter).toBeLessThanOrEqual(result.tokensBefore);
  });

  it("does not start a leaf summarizer pass when selection consumes the deadline", async () => {
    const engine = new CompactionEngine(
      convStore as any,
      sumStore as any,
      manyPassConfig({ maxSweepIterations: 1000, sweepDeadlineMs: 1 }),
    );
    await seedManyMessages();

    const selectOldestLeafChunk = (engine as any).selectOldestLeafChunk.bind(engine);
    vi.spyOn(engine as any, "selectOldestLeafChunk").mockImplementation(async (...args: unknown[]) => {
      await new Promise((r) => setTimeout(r, 10));
      return selectOldestLeafChunk(...args);
    });
    const summarize = vi.fn(async (text: string) => `S(${text.length})`);

    const result = await engine.compact({
      conversationId: CONV_ID,
      tokenBudget: 10_000,
      summarize,
      force: true,
    });

    expect(summarize).not.toHaveBeenCalled();
    expect(result.actionTaken).toBe(false);
    expect(result.tokensAfter).toBe(result.tokensBefore);
  });

  it("does not start a condensed summarizer pass when candidate selection consumes the deadline", async () => {
    const engine = new CompactionEngine(
      convStore as any,
      sumStore as any,
      manyPassConfig({
        maxSweepIterations: 1000,
        sweepDeadlineMs: 1,
        summaryPrefixTargetTokens: 1,
      }),
    );
    await convStore.createConversation({ sessionId: "deadline-condensed-selection" });
    for (const [summaryId, content] of [
      ["sum_deadline_a", "Depth zero summary A"],
      ["sum_deadline_b", "Depth zero summary B"],
      ["sum_deadline_c", "Depth zero summary C"],
    ] as const) {
      await sumStore.insertSummary({
        summaryId,
        conversationId: CONV_ID,
        kind: "leaf",
        depth: 0,
        content,
        tokenCount: 80,
      });
      await sumStore.appendContextSummary(CONV_ID, summaryId);
    }

    const selectCandidate = (engine as any).selectShallowestCondensationCandidate.bind(engine);
    vi.spyOn(engine as any, "selectShallowestCondensationCandidate").mockImplementation(
      async (...args: unknown[]) => {
        await new Promise((r) => setTimeout(r, 10));
        return selectCandidate(...args);
      },
    );
    const summarize = vi.fn(async (text: string) => `S(${text.length})`);

    const result = await engine.compact({
      conversationId: CONV_ID,
      tokenBudget: 10_000,
      summarize,
      force: true,
    });

    expect(summarize).not.toHaveBeenCalled();
    expect(result.actionTaken).toBe(false);
    expect(result.tokensAfter).toBe(result.tokensBefore);
  });

  it("a bounded sweep returns within a small multiple of the deadline", async () => {
    const sweepDeadlineMs = 60;
    const engine = new CompactionEngine(
      convStore as any,
      sumStore as any,
      manyPassConfig({ maxSweepIterations: 1000, sweepDeadlineMs }),
    );
    await seedManyMessages();

    const summarize = vi.fn(async (text: string) => {
      await new Promise((r) => setTimeout(r, 20));
      return `S(${text.length})`;
    });

    const startedAt = Date.now();
    await engine.compact({
      conversationId: CONV_ID,
      tokenBudget: 10_000,
      summarize,
      force: true,
    });
    const elapsed = Date.now() - startedAt;

    // The deadline bounds total sweep time: it may overrun by at most one
    // in-flight pass, never the tens of minutes an unbounded sweep could take.
    expect(elapsed).toBeLessThan(sweepDeadlineMs * 6);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Test Suite: compactUntilUnder bounds
// ═════════════════════════════════════════════════════════════════════════════

describe("LCM integration: compactUntilUnder bounds", () => {
  let convStore: ReturnType<typeof createMockConversationStore>;
  let sumStore: ReturnType<typeof createMockSummaryStore>;

  beforeEach(() => {
    convStore = createMockConversationStore();
    sumStore = createMockSummaryStore();
    wireStores(convStore, sumStore);
  });

  // Config that drives many sweep rounds: a small leaf chunk plus a low
  // per-sweep iteration cap means each compactFullSweep makes only partial
  // progress, so compactUntilUnder keeps issuing rounds. `sweepDeadlineMs` is
  // left large on purpose so the *operation* deadline — not the per-sweep
  // deadline — is what must stop the loop.
  const multiRoundConfig = (overrides: Partial<CompactionConfig>): CompactionConfig => ({
    ...defaultCompactionConfig,
    freshTailCount: 2,
    leafChunkTokens: 60,
    leafMinFanout: 1,
    maxSweepIterations: 2,
    sweepDeadlineMs: 100_000,
    ...overrides,
  });

  // ~60 messages of ~12 tokens each outside a 2-message fresh tail: far more
  // raw chunks than a single 2-iteration sweep can summarize, so reaching a
  // tight target needs many rounds.
  const seedManyMessages = async (): Promise<void> => {
    await ingestMessages(convStore, sumStore, 60, {
      contentFn: (i) => `Turn ${i}: ${"w".repeat(40)}`,
      tokenCountFn: (_i, content) => estimateTokens(content),
    });
  };

  it("stops at the operation deadline instead of running maxRounds x sweepDeadlineMs", async () => {
    const compactUntilUnderDeadlineMs = 80;
    const engine = new CompactionEngine(
      convStore as any,
      sumStore as any,
      // maxRounds 10 x sweepDeadlineMs 100000 => a 1000s worst case absent an
      // operation-wide bound. The operation deadline must cap it far below that.
      multiRoundConfig({ maxRounds: 10, compactUntilUnderDeadlineMs }),
    );
    await seedManyMessages();

    // Each summarizer call sleeps ~20ms; a few passes spend the 80ms budget.
    const summarize = vi.fn(async (text: string) => {
      await new Promise((r) => setTimeout(r, 20));
      return `S(${text.length})`;
    });

    const startedAt = Date.now();
    const result = await engine.compactUntilUnder({
      conversationId: CONV_ID,
      tokenBudget: 10_000,
      // Target far below the seeded ~720 tokens so a single sweep cannot reach it.
      targetTokens: 50,
      summarize,
    });
    const elapsed = Date.now() - startedAt;

    // The operation deadline is shared into each round's sweep and checked
    // before the next round: total time may overrun by at most one clamped
    // sweep, never maxRounds x sweepDeadlineMs.
    expect(elapsed).toBeLessThan(compactUntilUnderDeadlineMs * 8);
    expect(elapsed).toBeLessThan(5_000);
    // It stopped on the deadline, not by reaching the (unreachable) target.
    expect(result.success).toBe(false);
    expect(result.actionTaken).toBe(true);
    expect(result.rounds).toBeGreaterThanOrEqual(1);
    expect(result.rounds).toBeLessThan(10);
  });

  it("returns a consistent partial result when the operation deadline is hit", async () => {
    const engine = new CompactionEngine(
      convStore as any,
      sumStore as any,
      multiRoundConfig({ maxRounds: 10, compactUntilUnderDeadlineMs: 80 }),
    );
    await seedManyMessages();

    const summarize = vi.fn(async (text: string) => {
      await new Promise((r) => setTimeout(r, 20));
      return `S(${text.length})`;
    });

    const result = await engine.compactUntilUnder({
      conversationId: CONV_ID,
      tokenBudget: 10_000,
      targetTokens: 50,
      summarize,
    });

    // finalTokens is the real post-compaction context size: progress was made
    // (below the seeded total) but the target was not reached.
    const liveTokens = await sumStore.getContextTokenCount(CONV_ID);
    expect(result.actionTaken).toBe(true);
    expect(result.finalTokens).toBe(liveTokens);
    expect(result.finalTokens).toBeGreaterThan(50);
    // Context is internally consistent: the swept prefix is now summaries and
    // the un-swept remainder is still raw messages.
    const contextItems = await sumStore.getContextItems(CONV_ID);
    expect(contextItems.some((ci) => ci.itemType === "summary")).toBe(true);
    expect(contextItems.some((ci) => ci.itemType === "message")).toBe(true);
  });

  it("a generous operation deadline does not cut a legitimate multi-round run short", async () => {
    const engine = new CompactionEngine(
      convStore as any,
      sumStore as any,
      // Deadline comfortably above what a fast multi-round compaction needs.
      multiRoundConfig({ maxRounds: 10, compactUntilUnderDeadlineMs: 60_000 }),
    );
    await seedManyMessages();

    // Fast summarizer: rounds complete well within the operation deadline.
    const summarize = vi.fn(async (text: string) => `S(${text.length})`);

    const result = await engine.compactUntilUnder({
      conversationId: CONV_ID,
      tokenBudget: 10_000,
      targetTokens: 300,
      summarize,
    });

    // The deadline did not interfere: multiple rounds ran and drove context
    // under the target.
    expect(result.rounds).toBeGreaterThan(1);
    expect(result.success).toBe(true);
    expect(result.finalTokens).toBeLessThanOrEqual(300);
  });

  it("bounds unlimited-depth fallback-marker compaction while preserving repair lineage", async () => {
    const maxRounds = 3;
    const maxSweepIterations = 10;
    const engine = new CompactionEngine(
      convStore as any,
      sumStore as any,
      multiRoundConfig({
        freshTailCount: 2,
        leafChunkTokens: 100,
        leafMinFanout: 2,
        condensedMinFanout: 2,
        condensedMinFanoutHard: 2,
        condensedTargetTokens: 30,
        summaryPrefixTargetTokens: 1,
        incrementalMaxDepth: -1,
        maxRounds,
        maxSweepIterations,
        compactUntilUnderDeadlineMs: 1_000,
      }),
    );
    await ingestMessages(convStore, sumStore, 8, {
      contentFn: (i) => `Provider stress turn ${i}: ${"x".repeat(80)}`,
      tokenCountFn: () => 80,
    });

    const fallbackSummary = "[LCM fallback summary; truncated for context management]\nrepairable fallback";
    const summarize = vi.fn(async () => fallbackSummary);

    const result = await engine.compactUntilUnder({
      conversationId: CONV_ID,
      tokenBudget: 1_000,
      targetTokens: 1,
      summarize,
    });

    expect(result.success).toBe(false);
    expect(result.actionTaken).toBe(true);
    expect(result.rounds).toBeLessThanOrEqual(maxRounds);
    expect(summarize.mock.calls.length).toBeGreaterThan(0);
    expect(summarize.mock.calls.length).toBeLessThanOrEqual(maxRounds * maxSweepIterations);
    expect(Number.isFinite(result.finalTokens)).toBe(true);

    const summaries = sumStore._summaries;
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.some((summary) => summary.kind === "condensed")).toBe(true);
    expect(summaries.every((summary) => Number.isFinite(summary.tokenCount))).toBe(true);
    expect(summaries.every((summary) => detectDoctorMarker(summary.content) !== null)).toBe(true);

    const contextItems = await sumStore.getContextItems(CONV_ID);
    expect(contextItems.length).toBeGreaterThan(1);
    expect(
      contextItems
        .filter((item) => item.itemType === "message")
        .map((item) => item.messageId),
    ).toEqual(convStore._messages.slice(-2).map((message) => message.messageId));

    const summaryIds = new Set(summaries.map((summary) => summary.summaryId));
    expect(
      sumStore._summaryParents.every(
        (edge) => summaryIds.has(edge.summaryId) && summaryIds.has(edge.parentSummaryId),
      ),
    ).toBe(true);

    const collectSourceMessageIds = (summaryId: string, seen = new Set<string>()): Set<number> => {
      if (seen.has(summaryId)) {
        return new Set();
      }
      seen.add(summaryId);

      const messageIds = new Set(
        sumStore._summaryMessages
          .filter((edge) => edge.summaryId === summaryId)
          .map((edge) => edge.messageId),
      );
      for (const edge of sumStore._summaryParents.filter((parent) => parent.summaryId === summaryId)) {
        for (const messageId of collectSourceMessageIds(edge.parentSummaryId, seen)) {
          messageIds.add(messageId);
        }
      }
      return messageIds;
    };

    const coveredMessageIds = new Set<number>();
    for (const item of contextItems) {
      if (item.itemType === "message" && item.messageId != null) {
        coveredMessageIds.add(item.messageId);
      }
      if (item.itemType === "summary" && item.summaryId != null) {
        for (const messageId of collectSourceMessageIds(item.summaryId)) {
          coveredMessageIds.add(messageId);
        }
      }
    }
    expect([...coveredMessageIds].toSorted((a, b) => a - b)).toEqual(
      convStore._messages.map((message) => message.messageId),
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Test Suite: Retrieval
// ═════════════════════════════════════════════════════════════════════════════

