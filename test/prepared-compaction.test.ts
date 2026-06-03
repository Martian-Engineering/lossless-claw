import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../src/db/migration.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { ContextAssembler } from "../src/assembler.js";
import { CompactionEngine, type CompactionConfig } from "../src/compaction.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { buildMessageIdentityHash } from "../src/store/message-identity.js";
import { SummaryStore } from "../src/store/summary-store.js";

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
