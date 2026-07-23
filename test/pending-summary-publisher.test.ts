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
  const conversationStore = new ConversationStore(db, { fts5Available });
  const pendingSummaryStore = new PendingSummaryStore(db);
  const summaryStore = new SummaryStore(db, { fts5Available });
  return {
    db,
    conversationStore,
    pendingSummaryStore,
    publisher: new PendingSummaryPublisher({
      conversationStore,
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
      descendantCount: 0,
      descendantTokenCount: 0,
      sourceMessageTokenCount: 8,
    });
    await expect(summaryStore.getSummary("sum_condensed_root")).resolves.toMatchObject({
      kind: "condensed",
      depth: 1,
      content: "condensed summary one two three",
      descendantCount: 2,
      descendantTokenCount: 9,
      sourceMessageTokenCount: 12,
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

  it("reuses an existing canonical summary row and relinks lineage without duplication", async () => {
    const { db, conversationStore, pendingSummaryStore, publisher, summaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "pending-publish-relink-session",
      sessionKey: "agent:main:pending-publish-relink",
    });
    const messages = await conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "user",
        content: "relink fact one",
        tokenCount: 4,
      },
      {
        conversationId: conversation.conversationId,
        seq: 2,
        role: "assistant",
        content: "relink fact two",
        tokenCount: 4,
      },
      {
        conversationId: conversation.conversationId,
        seq: 3,
        role: "user",
        content: "fresh tail",
        tokenCount: 3,
      },
    ]);
    await summaryStore.appendContextMessages(
      conversation.conversationId,
      messages.map((message) => message.messageId),
    );

    await pendingSummaryStore.createBatch({
      batchId: "batch_relink_a",
      conversationId: conversation.conversationId,
      sourceProjectionFingerprint: "projection:v1",
      compactableStartOrdinal: 0,
      compactableEndOrdinal: 1,
      promptVersion: "pending:v1",
      model: "test-model",
    });
    await pendingSummaryStore.insertNode({
      nodeId: "relink_leaf",
      batchId: "batch_relink_a",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      status: "ready",
      ordinalStart: 0,
      ordinalEnd: 0,
      sourceFingerprint: "source:relink-one",
      content: "pending leaf content that must NOT overwrite the existing row",
      tokenCount: 5,
      promptVersion: "pending:v1",
      model: "test-model",
    });
    await pendingSummaryStore.insertNode({
      nodeId: "relink_leaf_b",
      batchId: "batch_relink_a",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      status: "ready",
      ordinalStart: 1,
      ordinalEnd: 1,
      sourceFingerprint: "source:relink-two",
      content: "leaf summary two",
      tokenCount: 4,
      promptVersion: "pending:v1",
      model: "test-model",
    });
    await pendingSummaryStore.insertNode({
      nodeId: "relink_root",
      batchId: "batch_relink_a",
      conversationId: conversation.conversationId,
      kind: "condensed",
      depth: 1,
      status: "ready",
      ordinalStart: 0,
      ordinalEnd: 1,
      sourceFingerprint: "source:relink-root",
      content: "condensed relink summary",
      tokenCount: 6,
      promptVersion: "pending:v1",
      model: "test-model",
    });
    await pendingSummaryStore.linkNodeToMessages("relink_leaf", [
      { messageId: messages[0]!.messageId },
    ]);
    await pendingSummaryStore.linkNodeToMessages("relink_leaf_b", [
      { messageId: messages[1]!.messageId },
    ]);
    await pendingSummaryStore.linkNodeToChildren("relink_root", [
      { childNodeId: "relink_leaf" },
      { childNodeId: "relink_leaf_b" },
    ]);

    // A canonical row already exists under the id the publisher derives for
    // relink_leaf (crash-retry shape: insert survived, promotion state did
    // not). It is even already linked to its message — both the insert and the
    // link must be skipped/idempotent, not duplicated or overwritten.
    await summaryStore.insertSummary({
      summaryId: "sum_relink_leaf",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "pre-existing canonical content",
      tokenCount: 5,
    });
    await summaryStore.linkSummaryToMessages("sum_relink_leaf", [messages[0]!.messageId]);

    const result = await publisher.publishReadyFrontier({
      batchId: "batch_relink_a",
      frontierNodeIds: ["relink_root"],
    });
    expect(result.frontierSummaryIds).toEqual(["sum_relink_root"]);
    expect(result.canonicalSummaryIds).toEqual([
      "sum_relink_leaf",
      "sum_relink_leaf_b",
      "sum_relink_root",
    ]);

    // The existing row was reused: single row, original content preserved.
    const leafRowCount = db
      .prepare(`SELECT COUNT(*) AS count FROM summaries WHERE summary_id = 'sum_relink_leaf'`)
      .get() as { count: number };
    expect(leafRowCount.count).toBe(1);
    await expect(summaryStore.getSummary("sum_relink_leaf")).resolves.toMatchObject({
      content: "pre-existing canonical content",
    });

    // Lineage is complete and not duplicated.
    const messageLinks = db
      .prepare(
        `SELECT COUNT(*) AS count FROM summary_messages WHERE summary_id = 'sum_relink_leaf'`,
      )
      .get() as { count: number };
    expect(messageLinks.count).toBe(1);
    await expect(summaryStore.getSummaryParents("sum_relink_root")).resolves.toHaveLength(2);

    // Publish outcome matches the fresh-insert path: frontier swapped in,
    // nodes promoted with their canonical ids.
    await expect(summaryStore.getContextItems(conversation.conversationId)).resolves.toMatchObject([
      { ordinal: 0, itemType: "summary", summaryId: "sum_relink_root" },
      { ordinal: 1, itemType: "message", messageId: messages[2]!.messageId },
    ]);
    await expect(pendingSummaryStore.getNode("relink_leaf")).resolves.toMatchObject({
      status: "promoted",
      canonicalSummaryId: "sum_relink_leaf",
    });
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
