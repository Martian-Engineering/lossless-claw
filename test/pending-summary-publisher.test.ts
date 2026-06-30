import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { getLcmDbFeatures } from "../src/db/features.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { PendingSummaryPublisher } from "../src/pending-summary-publisher.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { PendingSummaryStore } from "../src/store/pending-summary-store.js";
import { SummaryStore } from "../src/store/summary-store.js";

function createStores() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const { fts5Available } = getLcmDbFeatures(db);
  runLcmMigrations(db, { fts5Available });
  const pendingSummaryStore = new PendingSummaryStore(db);
  const summaryStore = new SummaryStore(db, { fts5Available });
  return {
    db,
    conversationStore: new ConversationStore(db, { fts5Available }),
    pendingSummaryStore,
    publisher: new PendingSummaryPublisher({
      pendingSummaryStore,
      summaryStore,
      canonicalSummaryIdForNode: (node) => `sum_${node.nodeId}`,
    }),
    summaryStore,
  };
}

describe("PendingSummaryPublisher", () => {
  it("canonicalizes pending ancestors and swaps the frontier atomically", async () => {
    const { conversationStore, pendingSummaryStore, publisher, summaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "pending-publish-session",
      sessionKey: "agent:main:pending-publish",
    });
    const messages = await conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "user",
        content: "raw fact one",
        tokenCount: 4,
        identityHash: "hash:one",
        transcriptEntryId: "entry:one",
      },
      {
        conversationId: conversation.conversationId,
        seq: 2,
        role: "assistant",
        content: "raw fact two",
        tokenCount: 4,
        identityHash: "hash:two",
        transcriptEntryId: "entry:two",
      },
      {
        conversationId: conversation.conversationId,
        seq: 3,
        role: "user",
        content: "raw fact three",
        tokenCount: 4,
        identityHash: "hash:three",
        transcriptEntryId: "entry:three",
      },
      {
        conversationId: conversation.conversationId,
        seq: 4,
        role: "assistant",
        content: "fresh tail",
        tokenCount: 3,
        identityHash: "hash:tail",
        transcriptEntryId: "entry:tail",
      },
    ]);
    await summaryStore.appendContextMessages(
      conversation.conversationId,
      messages.map((message) => message.messageId),
    );

    await pendingSummaryStore.createBatch({
      batchId: "batch_publish_a",
      conversationId: conversation.conversationId,
      sessionKey: "agent:main:pending-publish",
      sourceProjectionFingerprint: "projection:v1",
      compactableStartOrdinal: 0,
      compactableEndOrdinal: 2,
      plannedFreshTailStartOrdinal: 3,
      promptVersion: "pending:v1",
      model: "test-model",
    });
    await pendingSummaryStore.insertNode({
      nodeId: "leaf_a",
      batchId: "batch_publish_a",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      status: "ready",
      ordinalStart: 0,
      ordinalEnd: 1,
      sourceFingerprint: "source:one-two",
      content: "leaf summary one two",
      tokenCount: 5,
      promptVersion: "pending:v1",
      model: "test-model",
    });
    await pendingSummaryStore.insertNode({
      nodeId: "leaf_b",
      batchId: "batch_publish_a",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      status: "ready",
      ordinalStart: 2,
      ordinalEnd: 2,
      sourceFingerprint: "source:three",
      content: "leaf summary three",
      tokenCount: 4,
      promptVersion: "pending:v1",
      model: "test-model",
    });
    await pendingSummaryStore.insertNode({
      nodeId: "condensed_root",
      batchId: "batch_publish_a",
      conversationId: conversation.conversationId,
      kind: "condensed",
      depth: 1,
      status: "ready",
      ordinalStart: 0,
      ordinalEnd: 2,
      sourceFingerprint: "source:one-two-three",
      content: "condensed summary one two three",
      tokenCount: 6,
      promptVersion: "pending:v1",
      model: "test-model",
    });
    await pendingSummaryStore.linkNodeToMessages("leaf_a", [
      {
        messageId: messages[0]!.messageId,
        transcriptEntryId: "entry:one",
        identityHash: "hash:one",
      },
      {
        messageId: messages[1]!.messageId,
        transcriptEntryId: "entry:two",
        identityHash: "hash:two",
      },
    ]);
    await pendingSummaryStore.linkNodeToMessages("leaf_b", [
      {
        messageId: messages[2]!.messageId,
        transcriptEntryId: "entry:three",
        identityHash: "hash:three",
      },
    ]);
    await pendingSummaryStore.linkNodeToChildren("condensed_root", [
      { childNodeId: "leaf_a" },
      { childNodeId: "leaf_b" },
    ]);

    await expect(
      publisher.publishReadyFrontier({
        batchId: "batch_publish_a",
        frontierNodeIds: ["condensed_root"],
        publishedAt: new Date("2026-06-30T12:30:00.000Z"),
      }),
    ).resolves.toEqual({
      batchId: "batch_publish_a",
      canonicalSummaryIds: ["sum_leaf_a", "sum_leaf_b", "sum_condensed_root"],
      frontierSummaryIds: ["sum_condensed_root"],
    });

    await expect(summaryStore.getSummary("sum_leaf_a")).resolves.toMatchObject({
      kind: "leaf",
      content: "leaf summary one two",
    });
    await expect(summaryStore.getSummary("sum_condensed_root")).resolves.toMatchObject({
      kind: "condensed",
      depth: 1,
      content: "condensed summary one two three",
    });
    await expect(summaryStore.getSummaryMessages("sum_leaf_a")).resolves.toEqual([
      messages[0]!.messageId,
      messages[1]!.messageId,
    ]);
    await expect(summaryStore.getSummaryParents("sum_condensed_root")).resolves.toMatchObject([
      { summaryId: "sum_leaf_a" },
      { summaryId: "sum_leaf_b" },
    ]);
    await expect(summaryStore.getContextItems(conversation.conversationId)).resolves.toMatchObject([
      {
        ordinal: 0,
        itemType: "summary",
        summaryId: "sum_condensed_root",
      },
      {
        ordinal: 1,
        itemType: "message",
        messageId: messages[3]!.messageId,
      },
    ]);
    await expect(pendingSummaryStore.getBatch("batch_publish_a")).resolves.toMatchObject({
      status: "published",
      publishedAt: new Date("2026-06-30T12:30:00.000Z"),
    });
    await expect(pendingSummaryStore.getNode("condensed_root")).resolves.toMatchObject({
      status: "promoted",
      canonicalSummaryId: "sum_condensed_root",
    });

    await expect(
      publisher.publishReadyFrontier({
        batchId: "batch_publish_a",
        frontierNodeIds: ["condensed_root"],
      }),
    ).resolves.toEqual({
      batchId: "batch_publish_a",
      canonicalSummaryIds: ["sum_leaf_a", "sum_leaf_b", "sum_condensed_root"],
      frontierSummaryIds: ["sum_condensed_root"],
    });
    await expect(summaryStore.getContextItems(conversation.conversationId)).resolves.toMatchObject([
      {
        ordinal: 0,
        itemType: "summary",
        summaryId: "sum_condensed_root",
      },
      {
        ordinal: 1,
        itemType: "message",
        messageId: messages[3]!.messageId,
      },
    ]);
  });

  it("marks stale batches without canonical summary writes", async () => {
    const { conversationStore, pendingSummaryStore, publisher, summaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "pending-publish-stale-session",
      sessionKey: "agent:main:pending-publish-stale",
    });

    await pendingSummaryStore.createBatch({
      batchId: "batch_stale_a",
      conversationId: conversation.conversationId,
      sessionKey: "agent:main:pending-publish-stale",
      sourceProjectionFingerprint: "projection:v1",
      compactableStartOrdinal: 0,
      compactableEndOrdinal: 0,
      promptVersion: "pending:v1",
      model: "test-model",
    });
    await pendingSummaryStore.insertNode({
      nodeId: "leaf_stale_a",
      batchId: "batch_stale_a",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      status: "ready",
      ordinalStart: 0,
      ordinalEnd: 0,
      sourceFingerprint: "source:stale",
      content: "stale pending content",
      tokenCount: 3,
      promptVersion: "pending:v1",
      model: "test-model",
    });

    await expect(
      publisher.publishReadyFrontier({
        batchId: "batch_stale_a",
        frontierNodeIds: ["leaf_stale_a"],
        expectedSourceProjectionFingerprint: "projection:v2",
      }),
    ).rejects.toThrow(/stale/);
    await expect(pendingSummaryStore.getBatch("batch_stale_a")).resolves.toMatchObject({
      status: "stale",
      failureSummary: "source projection fingerprint changed before publish",
    });
    await expect(summaryStore.getSummary("sum_leaf_stale_a")).resolves.toBeNull();
  });
});
