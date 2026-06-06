import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../src/db/migration.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { ContextAssembler } from "../src/assembler.js";
import { CompactionEngine, type CompactionConfig } from "../src/compaction.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { buildMessageIdentityHash } from "../src/store/message-identity.js";
import { SummaryStore } from "../src/store/summary-store.js";
import type { LcmSummarizeOptions } from "../src/summarize.js";

type CapturedSummarizeCall = {
  text: string;
  options?: LcmSummarizeOptions;
};

function createStores() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const { fts5Available } = getLcmDbFeatures(db);
  runLcmMigrations(db, { fts5Available });
  const conversationStore = new ConversationStore(db, { fts5Available });
  const summaryStore = new SummaryStore(db, { fts5Available });
  return { db, conversationStore, summaryStore };
}

function createCompactionConfig(overrides: Partial<CompactionConfig> = {}): CompactionConfig {
  return {
    contextThreshold: 0.5,
    freshTailCount: 1,
    leafMinFanout: 2,
    condensedMinFanout: 4,
    condensedMinFanoutHard: 2,
    sweepMaxDepth: 0,
    leafChunkTokens: 1_000,
    leafTargetTokens: 120,
    condensedTargetTokens: 180,
    maxRounds: 3,
    maxSweepIterations: 8,
    sweepDeadlineMs: 30_000,
    compactUntilUnderDeadlineMs: 60_000,
    timezone: "UTC",
    summaryMaxOverageFactor: 3,
    stripInjectedContextTags: [],
    ...overrides,
  };
}

async function seedRawConversation() {
  const stores = createStores();
  const conversation = await stores.conversationStore.createConversation({
    sessionId: "prepared-compaction",
    title: "Prepared compaction",
  });
  const messages = await stores.conversationStore.createMessagesBulk([
    {
      conversationId: conversation.conversationId,
      seq: 1,
      role: "user",
      content: "old source alpha",
      tokenCount: 20,
    },
    {
      conversationId: conversation.conversationId,
      seq: 2,
      role: "assistant",
      content: "old source beta",
      tokenCount: 20,
    },
    {
      conversationId: conversation.conversationId,
      seq: 3,
      role: "user",
      content: "fresh tail gamma",
      tokenCount: 20,
    },
  ]);
  await stores.summaryStore.appendContextMessages(
    conversation.conversationId,
    messages.map((message) => message.messageId),
  );
  return { ...stores, conversation, messages };
}

async function createReadyPendingBatch(
  fixture: Awaited<ReturnType<typeof seedRawConversation>>,
  opts?: { summaryId?: string; content?: string },
) {
  const [first, second] = fixture.messages;
  if (!first || !second) {
    throw new Error("missing fixture messages");
  }
  const batch = await fixture.summaryStore.createCompactionBatch({
    batchId: "cb_test_ready",
    conversationId: fixture.conversation.conversationId,
    sourceMinSeq: first.seq,
    sourceMaxSeq: second.seq,
    reason: "test",
  });
  await fixture.summaryStore.insertPendingCompactionSummary({
    batchId: batch.batchId,
    summaryId: opts?.summaryId ?? "sum_prepared_test",
    ordinal: 0,
    conversationId: fixture.conversation.conversationId,
    kind: "leaf",
    depth: 0,
    content: opts?.content ?? "prepared invisible summary",
    tokenCount: 5,
    sourceMessageTokenCount: first.tokenCount + second.tokenCount,
    sourceStartSeq: first.seq,
    sourceEndSeq: second.seq,
    sourceMessageIds: [first.messageId, second.messageId],
    sourceIdentityHashes: [
      buildMessageIdentityHash(first.role, first.content),
      buildMessageIdentityHash(second.role, second.content),
    ],
  });
  await fixture.summaryStore.markCompactionBatchReady(batch.batchId);
  return batch;
}

describe("prepared compaction batches", () => {
  it("keeps pending summaries invisible to assembly, search, and transcript GC before publish", async () => {
    const fixture = await seedRawConversation();
    await createReadyPendingBatch(fixture, { content: "prepared hidden needle" });

    await expect(fixture.summaryStore.getSummary("sum_prepared_test")).resolves.toBeNull();
    await expect(
      fixture.summaryStore.searchSummaries({
        conversationId: fixture.conversation.conversationId,
        query: "hidden needle",
        mode: "regex",
      }),
    ).resolves.toEqual([]);
    await expect(
      fixture.summaryStore.listTranscriptGcCandidates(fixture.conversation.conversationId),
    ).resolves.toEqual([]);

    const assembler = new ContextAssembler(fixture.conversationStore, fixture.summaryStore, "UTC");
    const assembled = await assembler.assemble({
      conversationId: fixture.conversation.conversationId,
      tokenBudget: 10_000,
      freshTailCount: 1,
    });
    expect(assembled.stats.summaryCount).toBe(0);
    expect(assembled.stats.rawMessageCount).toBe(3);
  });

  it("publishes a valid prepared batch atomically into canonical context", async () => {
    const fixture = await seedRawConversation();
    await createReadyPendingBatch(fixture);

    const result = await fixture.summaryStore.publishLatestReadyCompactionBatch({
      conversationId: fixture.conversation.conversationId,
      maxSourceOrdinalExclusive: 2,
    });

    expect(result).toMatchObject({
      published: true,
      summaryIds: ["sum_prepared_test"],
      tokensRemoved: 40,
      tokensAdded: 5,
      partial: false,
    });
    await expect(fixture.summaryStore.getSummary("sum_prepared_test")).resolves.toMatchObject({
      summaryId: "sum_prepared_test",
      content: "prepared invisible summary",
    });
    await expect(fixture.summaryStore.getSummaryMessages("sum_prepared_test")).resolves.toEqual([
      fixture.messages[0]!.messageId,
      fixture.messages[1]!.messageId,
    ]);
    await expect(
      fixture.summaryStore.getContextItems(fixture.conversation.conversationId),
    ).resolves.toMatchObject([
      { ordinal: 0, itemType: "summary", summaryId: "sum_prepared_test" },
      { ordinal: 1, itemType: "message", messageId: fixture.messages[2]!.messageId },
    ]);
  });

  it("does not republish an already activated batch on retry", async () => {
    const fixture = await seedRawConversation();
    await createReadyPendingBatch(fixture);

    await expect(
      fixture.summaryStore.publishLatestReadyCompactionBatch({
        conversationId: fixture.conversation.conversationId,
        maxSourceOrdinalExclusive: 2,
      }),
    ).resolves.toMatchObject({
      published: true,
      summaryIds: ["sum_prepared_test"],
    });

    await expect(
      fixture.summaryStore.publishLatestReadyCompactionBatch({
        conversationId: fixture.conversation.conversationId,
        maxSourceOrdinalExclusive: 2,
      }),
    ).resolves.toMatchObject({
      published: false,
      reason: "no ready prepared batch",
    });
    await expect(
      fixture.summaryStore.getContextItems(fixture.conversation.conversationId),
    ).resolves.toMatchObject([
      { ordinal: 0, itemType: "summary", summaryId: "sum_prepared_test" },
      { ordinal: 1, itemType: "message", messageId: fixture.messages[2]!.messageId },
    ]);
  });

  it("detects stale prepared coverage and leaves active context unchanged", async () => {
    const fixture = await seedRawConversation();
    await createReadyPendingBatch(fixture);
    fixture.db
      .prepare(`UPDATE messages SET content = ? WHERE message_id = ?`)
      .run("old source beta edited", fixture.messages[1]!.messageId);

    const result = await fixture.summaryStore.publishLatestReadyCompactionBatch({
      conversationId: fixture.conversation.conversationId,
      maxSourceOrdinalExclusive: 2,
    });

    expect(result).toMatchObject({
      published: false,
      reason: "source message identity changed",
    });
    await expect(fixture.summaryStore.getSummary("sum_prepared_test")).resolves.toBeNull();
    await expect(
      fixture.summaryStore.getContextItems(fixture.conversation.conversationId),
    ).resolves.toMatchObject([
      { ordinal: 0, itemType: "message", messageId: fixture.messages[0]!.messageId },
      { ordinal: 1, itemType: "message", messageId: fixture.messages[1]!.messageId },
      { ordinal: 2, itemType: "message", messageId: fixture.messages[2]!.messageId },
    ]);
    const batch = await fixture.summaryStore.getLatestReadyCompactionBatch(
      fixture.conversation.conversationId,
    );
    expect(batch).toBeNull();
  });

  it("detects deleted prepared source messages before publishing", async () => {
    const fixture = await seedRawConversation();
    await createReadyPendingBatch(fixture);

    await expect(
      fixture.conversationStore.deleteMessages([fixture.messages[1]!.messageId]),
    ).resolves.toBe(1);

    const result = await fixture.summaryStore.publishLatestReadyCompactionBatch({
      conversationId: fixture.conversation.conversationId,
      maxSourceOrdinalExclusive: 2,
    });

    expect(result).toMatchObject({
      published: false,
      reason: "source message is no longer active raw context",
    });
    await expect(fixture.summaryStore.getSummary("sum_prepared_test")).resolves.toBeNull();
    const contextItems = await fixture.summaryStore.getContextItems(
      fixture.conversation.conversationId,
    );
    expect(contextItems.map((item) => item.messageId)).toEqual([
      fixture.messages[0]!.messageId,
      fixture.messages[2]!.messageId,
    ]);
    const batch = await fixture.summaryStore.getLatestReadyCompactionBatch(
      fixture.conversation.conversationId,
    );
    expect(batch).toBeNull();
  });

  it("detects prepared source messages removed from active raw context", async () => {
    const fixture = await seedRawConversation();
    await createReadyPendingBatch(fixture);
    fixture.db
      .prepare(
        `DELETE FROM context_items
         WHERE conversation_id = ?
           AND item_type = 'message'
           AND message_id = ?`,
      )
      .run(fixture.conversation.conversationId, fixture.messages[1]!.messageId);

    const result = await fixture.summaryStore.publishLatestReadyCompactionBatch({
      conversationId: fixture.conversation.conversationId,
      maxSourceOrdinalExclusive: 2,
    });

    expect(result).toMatchObject({
      published: false,
      reason: "source message is no longer active raw context",
    });
    await expect(fixture.summaryStore.getSummary("sum_prepared_test")).resolves.toBeNull();
    await expect(
      fixture.conversationStore.getMessageById(fixture.messages[1]!.messageId),
    ).resolves.toMatchObject({
      messageId: fixture.messages[1]!.messageId,
      content: "old source beta",
    });
    const batch = await fixture.summaryStore.getLatestReadyCompactionBatch(
      fixture.conversation.conversationId,
    );
    expect(batch).toBeNull();
  });

  it("detects imported raw messages before prepared coverage and leaves active context unchanged", async () => {
    const fixture = await seedRawConversation();
    await createReadyPendingBatch(fixture);
    const [imported] = await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: fixture.conversation.conversationId,
        seq: 0,
        role: "system",
        content: "late imported missing preface",
        tokenCount: 8,
        skipReplayTimestampFloodGuard: true,
      },
    ]);
    if (!imported) {
      throw new Error("missing imported fixture message");
    }

    fixture.db.exec("BEGIN");
    try {
      fixture.db
        .prepare(
          `UPDATE context_items
           SET ordinal = -(ordinal + 100)
           WHERE conversation_id = ?`,
        )
        .run(fixture.conversation.conversationId);
      fixture.db
        .prepare(
          `UPDATE context_items
           SET ordinal = -ordinal - 99
           WHERE conversation_id = ?`,
        )
        .run(fixture.conversation.conversationId);
      fixture.db
        .prepare(
          `INSERT INTO context_items (conversation_id, ordinal, item_type, message_id)
           VALUES (?, 0, 'message', ?)`,
        )
        .run(fixture.conversation.conversationId, imported.messageId);
      fixture.db.exec("COMMIT");
    } catch (err) {
      fixture.db.exec("ROLLBACK");
      throw err;
    }

    const result = await fixture.summaryStore.publishLatestReadyCompactionBatch({
      conversationId: fixture.conversation.conversationId,
      maxSourceOrdinalExclusive: 3,
    });

    expect(result).toMatchObject({
      published: false,
      reason: "active raw message appeared before prepared source coverage",
    });
    await expect(fixture.summaryStore.getSummary("sum_prepared_test")).resolves.toBeNull();
    await expect(
      fixture.summaryStore.getContextItems(fixture.conversation.conversationId),
    ).resolves.toMatchObject([
      { ordinal: 0, itemType: "message", messageId: imported.messageId },
      { ordinal: 1, itemType: "message", messageId: fixture.messages[0]!.messageId },
      { ordinal: 2, itemType: "message", messageId: fixture.messages[1]!.messageId },
      { ordinal: 3, itemType: "message", messageId: fixture.messages[2]!.messageId },
    ]);
    const batch = await fixture.summaryStore.getLatestReadyCompactionBatch(
      fixture.conversation.conversationId,
    );
    expect(batch).toBeNull();
  });

  it("invalidates ready batches for lifecycle hooks before they can publish", async () => {
    const fixture = await seedRawConversation();
    await createReadyPendingBatch(fixture);

    await expect(
      fixture.summaryStore.invalidatePendingCompactionBatches(
        fixture.conversation.conversationId,
        "test lifecycle",
      ),
    ).resolves.toBe(1);
    await expect(
      fixture.summaryStore.publishLatestReadyCompactionBatch({
        conversationId: fixture.conversation.conversationId,
        maxSourceOrdinalExclusive: 2,
      }),
    ).resolves.toMatchObject({
      published: false,
      reason: "no ready prepared batch",
    });
    await expect(fixture.summaryStore.getSummary("sum_prepared_test")).resolves.toBeNull();
  });

  it("uses a ready prepared batch during threshold compaction without another summarizer call", async () => {
    const fixture = await seedRawConversation();
    const compaction = new CompactionEngine(
      fixture.conversationStore,
      fixture.summaryStore,
      createCompactionConfig(),
    );
    const prepareSummarize = vi.fn(async () => "prepared compaction summary");
    const prepared = await compaction.preparePendingLeafBatch({
      conversationId: fixture.conversation.conversationId,
      summarize: prepareSummarize,
      summaryModel: "test",
    });
    expect(prepared.prepared).toBe(true);
    expect(prepared.summaryCount).toBe(1);
    expect(prepareSummarize).toHaveBeenCalledTimes(1);

    const publishOnlySummarize = vi.fn(async () => {
      throw new Error("foreground summarizer should not run");
    });
    const compacted = await compaction.compact({
      conversationId: fixture.conversation.conversationId,
      tokenBudget: 60,
      summarize: publishOnlySummarize,
      hardTrigger: false,
    });

    expect(compacted.actionTaken).toBe(true);
    expect(compacted.createdSummaryId).toEqual(expect.stringMatching(/^sum_pre_/));
    expect(publishOnlySummarize).not.toHaveBeenCalled();
    await expect(
      fixture.summaryStore.getContextItems(fixture.conversation.conversationId),
    ).resolves.toMatchObject([
      { ordinal: 0, itemType: "summary" },
      { ordinal: 1, itemType: "message", messageId: fixture.messages[2]!.messageId },
    ]);
  });

  it("prepares hidden condensed summaries to arbitrary depth before publishing", async () => {
    const fixture = createStores();
    const conversation = await fixture.conversationStore.createConversation({
      sessionId: "prepared-compaction-hidden-depth",
      title: "Prepared compaction hidden depth",
    });
    const messages = await fixture.conversationStore.createMessagesBulk(
      Array.from({ length: 9 }, (_, index) => ({
        conversationId: conversation.conversationId,
        seq: index + 1,
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: `prepared hidden depth source ${index + 1}`,
        tokenCount: 8,
      })),
    );
    await fixture.summaryStore.appendContextMessages(
      conversation.conversationId,
      messages.map((message) => message.messageId),
    );
    const compaction = new CompactionEngine(
      fixture.conversationStore,
      fixture.summaryStore,
      createCompactionConfig({
        leafChunkTokens: 8,
        leafMinFanout: 2,
        condensedMinFanout: 2,
        condensedMinFanoutHard: 2,
        condensedTargetTokens: 1,
        maxSweepIterations: 20,
        summaryMaxOverageFactor: 100,
      }),
    );
    const calls: CapturedSummarizeCall[] = [];
    const summarize = vi.fn(
      async (text: string, _aggressive?: boolean, options?: LcmSummarizeOptions) => {
        calls.push({ text, options });
        return "ssssssssssssssss";
      },
    );

    const prepared = await compaction.preparePendingLeafBatch({
      conversationId: conversation.conversationId,
      summarize,
      summaryModel: "test",
      maxSummaries: 8,
    });

    expect(prepared.prepared).toBe(true);
    expect(prepared.summaryCount).toBe(15);
    expect(summarize).toHaveBeenCalledTimes(15);
    expect(
      calls
        .filter((call) => call.options?.isCondensed)
        .map((call) => call.options?.depth),
    ).toEqual([1, 1, 1, 1, 2, 2, 3]);
    await expect(fixture.summaryStore.getSummariesByConversation(conversation.conversationId))
      .resolves.toHaveLength(0);

    const batch = await fixture.summaryStore.getLatestReadyCompactionBatch(
      conversation.conversationId,
    );
    expect(batch).not.toBeNull();
    const pendingRows = await fixture.summaryStore.getCompactionBatchSummaries(batch!.batchId);
    const depthCounts = pendingRows.reduce<Record<number, number>>((counts, summary) => {
      counts[summary.depth] = (counts[summary.depth] ?? 0) + 1;
      return counts;
    }, {});
    expect(depthCounts).toEqual({ 0: 8, 1: 4, 2: 2, 3: 1 });
    const root = pendingRows.find((summary) => summary.depth === 3);
    expect(root).toMatchObject({
      kind: "condensed",
      sourceMessageIds: messages.slice(0, 8).map((message) => message.messageId),
      sourceStartSeq: 1,
      sourceEndSeq: 8,
    });
    expect(root?.previousSummaryIds).toHaveLength(2);

    const publishOnlySummarize = vi.fn(async () => {
      throw new Error("foreground summarizer should not run");
    });
    const compacted = await compaction.compact({
      conversationId: conversation.conversationId,
      tokenBudget: 64,
      summarize: publishOnlySummarize,
      hardTrigger: false,
    });

    expect(compacted.actionTaken).toBe(true);
    expect(compacted.createdSummaryId).toBe(root?.summaryId);
    expect(publishOnlySummarize).not.toHaveBeenCalled();
    await expect(
      fixture.summaryStore.getContextItems(conversation.conversationId),
    ).resolves.toMatchObject([
      { ordinal: 0, itemType: "summary", summaryId: root?.summaryId },
      { ordinal: 1, itemType: "message", messageId: messages[8]!.messageId },
    ]);
    await expect(fixture.summaryStore.getSummariesByConversation(conversation.conversationId))
      .resolves.toHaveLength(15);
    await expect(fixture.summaryStore.getSummary(root!.summaryId)).resolves.toMatchObject({
      kind: "condensed",
      depth: 3,
    });
    const depth2Parents = await fixture.summaryStore.getSummaryParents(root!.summaryId);
    expect(depth2Parents).toHaveLength(2);
    expect(depth2Parents.map((summary) => summary.depth)).toEqual([2, 2]);
    const depth1Parents = (
      await Promise.all(
        depth2Parents.map((summary) => fixture.summaryStore.getSummaryParents(summary.summaryId)),
      )
    ).flat();
    expect(depth1Parents).toHaveLength(4);
    expect(depth1Parents.map((summary) => summary.depth)).toEqual([1, 1, 1, 1]);
    const leafParents = (
      await Promise.all(
        depth1Parents.map((summary) => fixture.summaryStore.getSummaryParents(summary.summaryId)),
      )
    ).flat();
    expect(leafParents).toHaveLength(8);
    expect(leafParents.map((summary) => summary.depth)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    await expect(fixture.summaryStore.getSummaryMessageSeqRange(root!.summaryId)).resolves
      .toMatchObject({
        minSeq: 1,
        maxSeq: 8,
      });
  });

  it("publishes a prepared prefix and foreground-compacts the remaining raw leaf", async () => {
    const fixture = createStores();
    const conversation = await fixture.conversationStore.createConversation({
      sessionId: "prepared-compaction-partial-publish",
      title: "Prepared compaction partial publish",
    });
    const messages = await fixture.conversationStore.createMessagesBulk(
      Array.from({ length: 5 }, (_, index) => ({
        conversationId: conversation.conversationId,
        seq: index + 1,
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: `source message ${index + 1}`,
        tokenCount: 20,
      })),
    );
    await fixture.summaryStore.appendContextMessages(
      conversation.conversationId,
      messages.map((message) => message.messageId),
    );
    const compaction = new CompactionEngine(
      fixture.conversationStore,
      fixture.summaryStore,
      createCompactionConfig({ leafChunkTokens: 40 }),
    );
    const prepareSummarize = vi.fn(async () => "prepared partial summary");
    const prepared = await compaction.preparePendingLeafBatch({
      conversationId: conversation.conversationId,
      summarize: prepareSummarize,
      summaryModel: "test",
      maxSummaries: 1,
    });
    expect(prepared.prepared).toBe(true);
    expect(prepared.summaryCount).toBe(1);
    expect(prepareSummarize).toHaveBeenCalledTimes(1);

    const foregroundCalls: CapturedSummarizeCall[] = [];
    const foregroundSummarize = vi.fn(
      async (text: string, _aggressive?: boolean, options?: LcmSummarizeOptions) => {
        foregroundCalls.push({ text, options });
        return "inline remainder summary";
      },
    );
    const compacted = await compaction.compact({
      conversationId: conversation.conversationId,
      tokenBudget: 80,
      summarize: foregroundSummarize,
      hardTrigger: false,
    });

    expect(compacted.actionTaken).toBe(true);
    expect(compacted.createdSummaryId).toEqual(expect.stringMatching(/^sum_/));
    expect(compacted.createdSummaryId).not.toEqual(expect.stringMatching(/^sum_pre_/));
    expect(foregroundSummarize).toHaveBeenCalledTimes(1);
    expect(foregroundCalls[0]?.text).toContain("source message 3");
    expect(foregroundCalls[0]?.text).toContain("source message 4");
    expect(foregroundCalls[0]?.text).not.toContain("source message 5");
    expect(foregroundCalls[0]?.options?.previousSummary).toBe("prepared partial summary");
    await expect(
      fixture.summaryStore.getContextItems(conversation.conversationId),
    ).resolves.toMatchObject([
      { ordinal: 0, itemType: "summary" },
      { ordinal: 1, itemType: "summary" },
      { ordinal: 2, itemType: "message", messageId: messages[4]!.messageId },
    ]);
  });

  it("stops at the prepared leaf boundary instead of condensing in the same sweep", async () => {
    const fixture = createStores();
    const conversation = await fixture.conversationStore.createConversation({
      sessionId: "prepared-compaction-depth-boundary",
      title: "Prepared compaction depth boundary",
    });
    const messages = await fixture.conversationStore.createMessagesBulk(
      Array.from({ length: 5 }, (_, index) => ({
        conversationId: conversation.conversationId,
        seq: index + 1,
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: `depth boundary source ${index + 1}`,
        tokenCount: 20,
      })),
    );
    await fixture.summaryStore.appendContextMessages(
      conversation.conversationId,
      messages.map((message) => message.messageId),
    );
    const compaction = new CompactionEngine(
      fixture.conversationStore,
      fixture.summaryStore,
      createCompactionConfig({
        leafChunkTokens: 40,
        maxSweepIterations: 2,
        condensedMinFanout: 2,
        condensedMinFanoutHard: 2,
        summaryPrefixTargetTokens: 1,
      }),
    );
    const prepareSummarize = vi
      .fn()
      .mockResolvedValueOnce("prepared depth summary one")
      .mockResolvedValueOnce("prepared depth summary two");
    const prepared = await compaction.preparePendingLeafBatch({
      conversationId: conversation.conversationId,
      summarize: prepareSummarize,
      summaryModel: "test",
    });
    expect(prepared.prepared).toBe(true);
    expect(prepared.summaryCount).toBe(2);
    expect(prepareSummarize).toHaveBeenCalledTimes(2);

    const foregroundSummarize = vi.fn(async () => {
      throw new Error("foreground summarizer should not condense prepared summaries");
    });
    const compacted = await compaction.compact({
      conversationId: conversation.conversationId,
      tokenBudget: 40,
      summarize: foregroundSummarize,
      hardTrigger: false,
    });

    expect(compacted.actionTaken).toBe(true);
    expect(foregroundSummarize).not.toHaveBeenCalled();
    const contextItems = await fixture.summaryStore.getContextItems(conversation.conversationId);
    const activeSummaryIds = contextItems
      .map((item) => item.summaryId)
      .filter((summaryId): summaryId is string => typeof summaryId === "string");
    expect(activeSummaryIds).toHaveLength(2);
    const activeSummaries = await Promise.all(
      activeSummaryIds.map((summaryId) => fixture.summaryStore.getSummary(summaryId)),
    );
    expect(activeSummaries.map((summary) => summary?.depth)).toEqual([0, 0]);
    expect(contextItems).toMatchObject([
      { ordinal: 0, itemType: "summary" },
      { ordinal: 1, itemType: "summary" },
      { ordinal: 2, itemType: "message", messageId: messages[4]!.messageId },
    ]);
  });

  it("does not inject prior canonical summary context into the first prepared leaf prompt", async () => {
    const fixture = createStores();
    const conversation = await fixture.conversationStore.createConversation({
      sessionId: "prepared-compaction-prior-summary-context",
      title: "Prepared compaction prior summary context",
    });
    await fixture.summaryStore.insertSummary({
      summaryId: "sum_prior_context",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "prior canonical summary context",
      tokenCount: 10,
    });
    await fixture.summaryStore.appendContextSummary(
      conversation.conversationId,
      "sum_prior_context",
    );
    const messages = await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "user",
        content: "old source alpha",
        tokenCount: 20,
      },
      {
        conversationId: conversation.conversationId,
        seq: 2,
        role: "assistant",
        content: "old source beta",
        tokenCount: 20,
      },
      {
        conversationId: conversation.conversationId,
        seq: 3,
        role: "user",
        content: "fresh tail gamma",
        tokenCount: 20,
      },
    ]);
    await fixture.summaryStore.appendContextMessages(
      conversation.conversationId,
      messages.map((message) => message.messageId),
    );
    const compaction = new CompactionEngine(
      fixture.conversationStore,
      fixture.summaryStore,
      createCompactionConfig(),
    );
    const calls: CapturedSummarizeCall[] = [];
    const summarize = vi.fn(
      async (text: string, _aggressive?: boolean, options?: LcmSummarizeOptions) => {
        calls.push({ text, options });
        return "prepared summary without prior context";
      },
    );

    const prepared = await compaction.preparePendingLeafBatch({
      conversationId: conversation.conversationId,
      summarize,
      summaryModel: "test",
    });

    expect(prepared.prepared).toBe(true);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(calls[0]?.text).toContain("old source alpha");
    expect(calls[0]?.text).toContain("old source beta");
    expect(calls[0]?.text).not.toContain("fresh tail gamma");
    expect(calls[0]?.options).toMatchObject({ isCondensed: false });
    expect(calls[0]?.options?.previousSummary).toBeUndefined();
  });

  it("uses prior prepared leaf content for later prepared leaf prompts", async () => {
    const fixture = createStores();
    const conversation = await fixture.conversationStore.createConversation({
      sessionId: "prepared-compaction-prepared-continuity",
      title: "Prepared compaction prepared continuity",
    });
    const messages = await fixture.conversationStore.createMessagesBulk(
      Array.from({ length: 5 }, (_, index) => ({
        conversationId: conversation.conversationId,
        seq: index + 1,
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: `prepared continuity source ${index + 1}`,
        tokenCount: 20,
      })),
    );
    await fixture.summaryStore.appendContextMessages(
      conversation.conversationId,
      messages.map((message) => message.messageId),
    );
    const compaction = new CompactionEngine(
      fixture.conversationStore,
      fixture.summaryStore,
      createCompactionConfig({ leafChunkTokens: 40 }),
    );
    const calls: CapturedSummarizeCall[] = [];
    const summarize = vi
      .fn()
      .mockImplementationOnce(
        async (text: string, _aggressive?: boolean, options?: LcmSummarizeOptions) => {
          calls.push({ text, options });
          return "first prepared continuity summary";
        },
      )
      .mockImplementationOnce(
        async (text: string, _aggressive?: boolean, options?: LcmSummarizeOptions) => {
          calls.push({ text, options });
          return "second prepared continuity summary";
        },
      );

    const prepared = await compaction.preparePendingLeafBatch({
      conversationId: conversation.conversationId,
      summarize,
      summaryModel: "test",
    });

    expect(prepared.prepared).toBe(true);
    expect(prepared.summaryCount).toBe(2);
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(calls[0]?.options?.previousSummary).toBeUndefined();
    expect(calls[0]?.options).toMatchObject({ isCondensed: false });
    expect(calls[1]?.options?.previousSummary).toBe("first prepared continuity summary");
    expect(calls[1]?.options).toMatchObject({ isCondensed: false });
    expect(calls[1]?.text).toContain("prepared continuity source 3");
    expect(calls[1]?.text).toContain("prepared continuity source 4");
    expect(calls[1]?.text).not.toContain("prepared continuity source 5");
  });

  it("falls back to inline leaf summarization when no prepared batch exists", async () => {
    const fixture = await seedRawConversation();
    const compaction = new CompactionEngine(
      fixture.conversationStore,
      fixture.summaryStore,
      createCompactionConfig(),
    );
    const summarize = vi.fn(async () => "inline fallback summary");

    const compacted = await compaction.compact({
      conversationId: fixture.conversation.conversationId,
      tokenBudget: 60,
      summarize,
      hardTrigger: false,
    });

    expect(compacted.actionTaken).toBe(true);
    expect(compacted.createdSummaryId).toEqual(expect.stringMatching(/^sum_/));
    expect(compacted.createdSummaryId).not.toEqual(expect.stringMatching(/^sum_pre_/));
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it("marks prepared batches failed when preparation throws after durable creation", async () => {
    const fixture = createStores();
    const conversation = await fixture.conversationStore.createConversation({
      sessionId: "prepared-compaction-throws",
      title: "Prepared compaction throws",
    });
    const messages = await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "user",
        content: "old source alpha",
        tokenCount: 20,
      },
      {
        conversationId: conversation.conversationId,
        seq: 2,
        role: "assistant",
        content: "old source beta",
        tokenCount: 20,
      },
      {
        conversationId: conversation.conversationId,
        seq: 3,
        role: "user",
        content: "fresh tail gamma",
        tokenCount: 20,
      },
    ]);
    await fixture.summaryStore.appendContextMessages(
      conversation.conversationId,
      messages.map((message) => message.messageId),
    );
    const compaction = new CompactionEngine(
      fixture.conversationStore,
      fixture.summaryStore,
      createCompactionConfig({ leafChunkTokens: 20 }),
    );
    const summarize = vi
      .fn()
      .mockResolvedValueOnce("prepared first summary")
      .mockRejectedValueOnce(new Error("provider failed during background prep"));

    await expect(
      compaction.preparePendingLeafBatch({
        conversationId: conversation.conversationId,
        summarize,
        summaryModel: "test",
      }),
    ).rejects.toThrow("provider failed during background prep");

    const batch = fixture.db
      .prepare(
        `SELECT batch_id, status, error
         FROM compaction_batches
         WHERE conversation_id = ?`,
      )
      .get(conversation.conversationId) as
      | { batch_id: string; status: string; error: string | null }
      | undefined;
    expect(batch).toMatchObject({
      status: "failed",
      error: "provider failed during background prep",
    });
    if (!batch) {
      throw new Error("missing prepared compaction batch");
    }
    const summaryRows = fixture.db
      .prepare(
        `SELECT status
         FROM compaction_batch_summaries
         WHERE batch_id = ?`,
      )
      .all(batch.batch_id) as Array<{ status: string }>;
    expect(summaryRows).toEqual([{ status: "failed" }]);
  });
});
