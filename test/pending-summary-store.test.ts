import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { getLcmDbFeatures } from "../src/db/features.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { PendingSummaryStore } from "../src/store/pending-summary-store.js";
import { SummaryStore } from "../src/store/summary-store.js";

function createStores() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const { fts5Available } = getLcmDbFeatures(db);
  runLcmMigrations(db, { fts5Available });
  return {
    db,
    conversationStore: new ConversationStore(db, { fts5Available }),
    pendingSummaryStore: new PendingSummaryStore(db),
    summaryStore: new SummaryStore(db, { fts5Available }),
  };
}

describe("PendingSummaryStore", () => {
  it("persists pending batches and nodes without making summaries canonical", async () => {
    const { conversationStore, pendingSummaryStore, summaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "pending-summary-session",
      sessionKey: "agent:main:pending-summary",
    });
    const [firstMessage, secondMessage] = await conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "user",
        content: "first source message",
        tokenCount: 4,
        identityHash: "hash:first",
        transcriptEntryId: "entry:first",
      },
      {
        conversationId: conversation.conversationId,
        seq: 2,
        role: "assistant",
        content: "second source message",
        tokenCount: 4,
        identityHash: "hash:second",
        transcriptEntryId: "entry:second",
      },
    ]);

    await pendingSummaryStore.createBatch({
      batchId: "batch_pending_a",
      conversationId: conversation.conversationId,
      sessionKey: "agent:main:pending-summary",
      sessionTargetJson: JSON.stringify({ sessionId: "pending-summary-session" }),
      sourceProjectionFingerprint: "projection:v1",
      compactableStartOrdinal: 0,
      compactableEndOrdinal: 1,
      plannedFreshTailStartOrdinal: 2,
      promptVersion: "leaf:v1",
      model: "test-model",
    });

    await pendingSummaryStore.insertNode({
      nodeId: "node_leaf_a",
      batchId: "batch_pending_a",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      status: "ready",
      ordinalStart: 0,
      ordinalEnd: 1,
      sourceFingerprint: "source:first-second",
      sourceContextHash: "context:first-second",
      content: "pending summary over two source messages",
      tokenCount: 7,
      promptVersion: "leaf:v1",
      model: "test-model",
    });
    await pendingSummaryStore.linkNodeToMessages("node_leaf_a", [
      {
        messageId: firstMessage.messageId,
        transcriptEntryId: "entry:first",
        identityHash: "hash:first",
      },
      {
        messageId: secondMessage.messageId,
        transcriptEntryId: "entry:second",
        identityHash: "hash:second",
      },
    ]);

    await expect(pendingSummaryStore.getBatch("batch_pending_a")).resolves.toMatchObject({
      batchId: "batch_pending_a",
      status: "planning",
      sourceProjectionFingerprint: "projection:v1",
    });
    await expect(pendingSummaryStore.getNode("node_leaf_a")).resolves.toMatchObject({
      nodeId: "node_leaf_a",
      status: "ready",
      content: "pending summary over two source messages",
      tokenCount: 7,
    });
    await expect(pendingSummaryStore.getNodeMessages("node_leaf_a")).resolves.toEqual([
      {
        messageId: firstMessage.messageId,
        transcriptEntryId: "entry:first",
        identityHash: "hash:first",
      },
      {
        messageId: secondMessage.messageId,
        transcriptEntryId: "entry:second",
        identityHash: "hash:second",
      },
    ]);

    await expect(summaryStore.getSummary("node_leaf_a")).resolves.toBeNull();
    await expect(
      summaryStore.searchSummaries({
        conversationId: conversation.conversationId,
        query: "pending summary",
        mode: "regex",
        limit: 10,
      }),
    ).resolves.toEqual([]);
  });

  it("claims planned nodes with leases and records promotion ids", async () => {
    const { conversationStore, pendingSummaryStore, summaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "pending-summary-claim-session",
      sessionKey: "agent:main:pending-summary-claim",
    });

    await pendingSummaryStore.createBatch({
      batchId: "batch_claim_a",
      conversationId: conversation.conversationId,
      sourceProjectionFingerprint: "projection:v1",
      compactableStartOrdinal: 0,
      compactableEndOrdinal: 0,
      promptVersion: "leaf:v1",
      model: "test-model",
    });
    await pendingSummaryStore.insertNode({
      nodeId: "node_claim_a",
      batchId: "batch_claim_a",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      status: "planned",
      ordinalStart: 0,
      ordinalEnd: 0,
      sourceFingerprint: "source:claim",
      promptVersion: "leaf:v1",
      model: "test-model",
    });

    await expect(
      pendingSummaryStore.claimNextPlannedNode({
        conversationId: conversation.conversationId,
        leaseOwner: "worker-a",
        leaseExpiresAt: new Date("2026-06-30T12:05:00.000Z"),
        now: new Date("2026-06-30T12:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      nodeId: "node_claim_a",
      status: "running",
      leaseOwner: "worker-a",
      leaseExpiresAt: new Date("2026-06-30T12:05:00.000Z"),
    });

    await expect(
      pendingSummaryStore.claimNextPlannedNode({
        conversationId: conversation.conversationId,
        leaseOwner: "worker-b",
        leaseExpiresAt: new Date("2026-06-30T12:06:00.000Z"),
        now: new Date("2026-06-30T12:01:00.000Z"),
      }),
    ).resolves.toBeNull();
    await expect(
      pendingSummaryStore.claimNextPlannedNode({
        conversationId: conversation.conversationId,
        leaseOwner: "worker-b",
        leaseExpiresAt: new Date("2026-06-30T12:11:00.000Z"),
        now: new Date("2026-06-30T12:06:00.000Z"),
      }),
    ).resolves.toMatchObject({
      nodeId: "node_claim_a",
      status: "running",
      leaseOwner: "worker-b",
      leaseExpiresAt: new Date("2026-06-30T12:11:00.000Z"),
    });

    await pendingSummaryStore.markNodeReady({
      nodeId: "node_claim_a",
      content: "ready pending summary",
      tokenCount: 5,
    });
    await summaryStore.insertSummary({
      summaryId: "sum_canonical_a",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "canonical summary",
      tokenCount: 5,
    });
    await pendingSummaryStore.markNodePromoted({
      nodeId: "node_claim_a",
      canonicalSummaryId: "sum_canonical_a",
      promotedAt: new Date("2026-06-30T12:02:00.000Z"),
    });

    await expect(pendingSummaryStore.getNode("node_claim_a")).resolves.toMatchObject({
      status: "promoted",
      canonicalSummaryId: "sum_canonical_a",
      leaseOwner: null,
      leaseExpiresAt: null,
      promotedAt: new Date("2026-06-30T12:02:00.000Z"),
    });
  });
});
