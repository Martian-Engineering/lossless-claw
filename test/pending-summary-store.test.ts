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

  it("keeps pending-summary source messages out of deletion cleanup", async () => {
    const { conversationStore, pendingSummaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "pending-summary-delete-session",
      sessionKey: "agent:main:pending-summary-delete",
    });
    const message = await conversationStore.createMessage({
      conversationId: conversation.conversationId,
      seq: 1,
      role: "user",
      content: "pending source must remain",
      tokenCount: 4,
    });
    await pendingSummaryStore.createBatch({
      batchId: "batch_delete_guard",
      conversationId: conversation.conversationId,
      sourceProjectionFingerprint: "projection:delete-guard",
      compactableStartOrdinal: 0,
      compactableEndOrdinal: 0,
      promptVersion: "leaf:v1",
      model: "test-model",
    });
    await pendingSummaryStore.insertNode({
      nodeId: "node_delete_guard",
      batchId: "batch_delete_guard",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      status: "planned",
      ordinalStart: 0,
      ordinalEnd: 0,
      sourceFingerprint: "source:delete-guard",
      promptVersion: "leaf:v1",
      model: "test-model",
    });
    await pendingSummaryStore.linkNodeToMessages("node_delete_guard", [
      { messageId: message.messageId },
    ]);

    await expect(conversationStore.deleteMessages([message.messageId])).resolves.toBe(0);
    await expect(conversationStore.getMessageById(message.messageId)).resolves.toMatchObject({
      messageId: message.messageId,
    });
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

    const firstClaim = await pendingSummaryStore.claimNextPlannedNode({
      conversationId: conversation.conversationId,
      leaseOwner: "worker-a",
      leaseExpiresAt: new Date("2026-06-30T12:05:00.000Z"),
      now: new Date("2026-06-30T12:00:00.000Z"),
    });
    expect(firstClaim).toMatchObject({
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
        leaseOwner: "worker-a",
        leaseExpiresAt: new Date("2026-06-30T12:11:00.000Z"),
        now: new Date("2026-06-30T12:06:00.000Z"),
      }),
    ).resolves.toMatchObject({
      nodeId: "node_claim_a",
      status: "running",
      leaseOwner: "worker-a",
      leaseExpiresAt: new Date("2026-06-30T12:11:00.000Z"),
    });

    await expect(
      pendingSummaryStore.markNodeReady({
        nodeId: "node_claim_a",
        leaseOwner: "worker-a",
        leaseExpiresAt: firstClaim!.leaseExpiresAt!,
        content: "obsolete ready pending summary",
        tokenCount: 5,
      }),
    ).resolves.toBe(false);
    await expect(pendingSummaryStore.getNode("node_claim_a")).resolves.toMatchObject({
      status: "running",
      leaseOwner: "worker-a",
      content: null,
    });

    await expect(
      pendingSummaryStore.markNodeReady({
        nodeId: "node_claim_a",
        leaseOwner: "worker-a",
        leaseExpiresAt: new Date("2026-06-30T12:11:00.000Z"),
        content: "ready pending summary",
        tokenCount: 5,
      }),
    ).resolves.toBe(true);
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

  it("prunes superseded condensed nodes, clears promoted payloads, and expires finished batches", async () => {
    const { db, conversationStore, pendingSummaryStore, summaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "pending-summary-gc-session",
      sessionKey: "agent:main:pending-summary-gc",
    });
    await pendingSummaryStore.createBatch({
      batchId: "batch_gc_a",
      conversationId: conversation.conversationId,
      sourceProjectionFingerprint: "projection:v1",
      compactableStartOrdinal: 0,
      compactableEndOrdinal: 9,
      promptVersion: "leaf:v1",
      model: "test-model",
    });
    const insertCondensed = (nodeId: string, ordinalEnd: number, status: string) =>
      pendingSummaryStore
        .insertNode({
          nodeId,
          batchId: "batch_gc_a",
          conversationId: conversation.conversationId,
          kind: "condensed",
          depth: 1,
          status: "planned",
          ordinalStart: 0,
          ordinalEnd,
          sourceFingerprint: `source:${nodeId}`,
          promptVersion: "leaf:v1",
          model: "test-model",
        })
        .then(() =>
          db
            .prepare(
              `UPDATE pending_summary_nodes SET status = ?, content = 'payload' WHERE node_id = ?`,
            )
            .run(status, nodeId),
        );

    // Three same-depth, same-start condensed nodes: two superseded by the
    // widest, one of them protected by a live parent reference.
    await insertCondensed("node_gc_narrow", 3, "ready");
    await insertCondensed("node_gc_referenced", 5, "ready");
    await insertCondensed("node_gc_wide", 9, "ready");
    await pendingSummaryStore.insertNode({
      nodeId: "node_gc_parent",
      batchId: "batch_gc_a",
      conversationId: conversation.conversationId,
      kind: "condensed",
      depth: 2,
      status: "planned",
      ordinalStart: 0,
      ordinalEnd: 9,
      sourceFingerprint: "source:parent",
      promptVersion: "leaf:v1",
      model: "test-model",
    });
    await pendingSummaryStore.linkNodeToChildren("node_gc_parent", [
      { childNodeId: "node_gc_referenced" },
    ]);

    await expect(pendingSummaryStore.pruneSupersededNodes("batch_gc_a")).resolves.toBe(1);
    await expect(pendingSummaryStore.getNode("node_gc_narrow")).resolves.toBeNull();
    await expect(pendingSummaryStore.getNode("node_gc_referenced")).resolves.not.toBeNull();
    await expect(pendingSummaryStore.getNode("node_gc_wide")).resolves.not.toBeNull();

    // Promoted payloads are dropped while lineage metadata survives.
    await summaryStore.insertSummary({
      summaryId: "sum_gc_wide",
      conversationId: conversation.conversationId,
      kind: "condensed",
      depth: 1,
      content: "canonical gc summary",
      tokenCount: 5,
    });
    db.prepare(
      `UPDATE pending_summary_nodes
       SET status = 'promoted', canonical_summary_id = 'sum_gc_wide'
       WHERE node_id = 'node_gc_wide'`,
    ).run();
    await expect(pendingSummaryStore.clearPromotedPayloads("batch_gc_a")).resolves.toBe(1);
    await expect(pendingSummaryStore.getNode("node_gc_wide")).resolves.toMatchObject({
      status: "promoted",
      canonicalSummaryId: "sum_gc_wide",
      content: null,
    });
    await expect(pendingSummaryStore.getNode("node_gc_referenced")).resolves.toMatchObject({
      content: "payload",
    });

    // Finished batches past retention are deleted with their nodes; active
    // and recently finished batches survive.
    await pendingSummaryStore.createBatch({
      batchId: "batch_gc_active",
      conversationId: conversation.conversationId,
      sourceProjectionFingerprint: "projection:v2",
      compactableStartOrdinal: 0,
      compactableEndOrdinal: 1,
      promptVersion: "leaf:v1",
      model: "test-model",
    });
    db.prepare(
      `UPDATE pending_compaction_batches
       SET status = 'published', updated_at = '2026-06-01 00:00:00'
       WHERE batch_id = 'batch_gc_a'`,
    ).run();
    await expect(
      pendingSummaryStore.deleteFinishedBatches({
        conversationId: conversation.conversationId,
        olderThan: new Date("2026-06-08T00:00:00.000Z"),
      }),
    ).resolves.toBe(1);
    await expect(pendingSummaryStore.getBatch("batch_gc_a")).resolves.toBeNull();
    await expect(pendingSummaryStore.getNode("node_gc_wide")).resolves.toBeNull();
    await expect(pendingSummaryStore.getBatch("batch_gc_active")).resolves.not.toBeNull();
  });

  it("reclaims failed nodes after their backoff and stops at the retry cap", async () => {
    const { conversationStore, pendingSummaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "pending-summary-retry-session",
      sessionKey: "agent:main:pending-summary-retry",
    });
    await pendingSummaryStore.createBatch({
      batchId: "batch_retry_a",
      conversationId: conversation.conversationId,
      sourceProjectionFingerprint: "projection:v1",
      compactableStartOrdinal: 0,
      compactableEndOrdinal: 0,
      promptVersion: "leaf:v1",
      model: "test-model",
    });
    await pendingSummaryStore.insertNode({
      nodeId: "node_retry_a",
      batchId: "batch_retry_a",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      status: "planned",
      ordinalStart: 0,
      ordinalEnd: 0,
      sourceFingerprint: "source:retry",
      promptVersion: "leaf:v1",
      model: "test-model",
    });

    const claimAt = (now: Date, leaseMinutes: number) =>
      pendingSummaryStore.claimNextPlannedNode({
        conversationId: conversation.conversationId,
        leaseOwner: "worker-a",
        leaseExpiresAt: new Date(now.getTime() + leaseMinutes * 60_000),
        now,
      });

    // First failure: retry_count 1 with a 60s backoff stamp.
    const firstClaim = await claimAt(new Date("2026-06-30T12:00:00.000Z"), 5);
    await expect(
      pendingSummaryStore.markNodeFailed({
        nodeId: "node_retry_a",
        leaseOwner: "worker-a",
        leaseExpiresAt: firstClaim!.leaseExpiresAt!,
        failureSummary: "transient failure",
        now: new Date("2026-06-30T12:00:30.000Z"),
      }),
    ).resolves.toBe(true);
    await expect(pendingSummaryStore.getNode("node_retry_a")).resolves.toMatchObject({
      status: "failed",
      retryCount: 1,
      nextAttemptAfter: new Date("2026-06-30T12:01:30.000Z"),
    });

    // Inside the backoff window the node is not claimable; after it, it is.
    await expect(claimAt(new Date("2026-06-30T12:01:00.000Z"), 5)).resolves.toBeNull();
    const retryClaim = await claimAt(new Date("2026-06-30T12:02:00.000Z"), 5);
    expect(retryClaim).toMatchObject({ nodeId: "node_retry_a", status: "running", retryCount: 1 });

    // Success resets the retry bookkeeping.
    await expect(
      pendingSummaryStore.markNodeReady({
        nodeId: "node_retry_a",
        leaseOwner: "worker-a",
        leaseExpiresAt: retryClaim!.leaseExpiresAt!,
        content: "recovered pending summary",
        tokenCount: 5,
      }),
    ).resolves.toBe(true);
    await expect(pendingSummaryStore.getNode("node_retry_a")).resolves.toMatchObject({
      status: "ready",
      retryCount: 0,
      nextAttemptAfter: null,
    });

    // A node at the retry cap is never claimable, even after its backoff.
    await pendingSummaryStore.insertNode({
      nodeId: "node_retry_capped",
      batchId: "batch_retry_a",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      status: "planned",
      ordinalStart: 1,
      ordinalEnd: 1,
      sourceFingerprint: "source:capped",
      promptVersion: "leaf:v1",
      model: "test-model",
    });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const attemptNow = new Date(Date.parse("2026-06-30T13:00:00.000Z") + attempt * 3_600_000);
      const claim = await claimAt(attemptNow, 5);
      expect(claim).toMatchObject({ nodeId: "node_retry_capped" });
      await pendingSummaryStore.markNodeFailed({
        nodeId: "node_retry_capped",
        leaseOwner: "worker-a",
        leaseExpiresAt: claim!.leaseExpiresAt!,
        failureSummary: `attempt ${attempt} failed`,
        now: attemptNow,
      });
    }
    await expect(pendingSummaryStore.getNode("node_retry_capped")).resolves.toMatchObject({
      status: "failed",
      retryCount: 3,
    });
    await expect(claimAt(new Date("2026-07-01T12:00:00.000Z"), 5)).resolves.toBeNull();
  });

  it("does not claim nodes from stale batches", async () => {
    const { conversationStore, pendingSummaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "pending-summary-stale-claim-session",
    });

    await pendingSummaryStore.createBatch({
      batchId: "batch_stale_claim",
      conversationId: conversation.conversationId,
      sourceProjectionFingerprint: "projection:v1",
      compactableStartOrdinal: 0,
      compactableEndOrdinal: 0,
      promptVersion: "leaf:v1",
      model: "test-model",
    });
    await pendingSummaryStore.insertNode({
      nodeId: "node_stale_claim",
      batchId: "batch_stale_claim",
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

    await pendingSummaryStore.markBatchStale({
      batchId: "batch_stale_claim",
      failureSummary: "source projection changed",
    });

    await expect(pendingSummaryStore.getNode("node_stale_claim")).resolves.toMatchObject({
      status: "stale",
      leaseOwner: null,
      leaseExpiresAt: null,
      failureSummary: "source projection changed",
    });
    await expect(
      pendingSummaryStore.claimNextPlannedNode({
        conversationId: conversation.conversationId,
        leaseOwner: "worker-a",
        leaseExpiresAt: new Date("2026-06-30T12:05:00.000Z"),
        now: new Date("2026-06-30T12:00:00.000Z"),
      }),
    ).resolves.toBeNull();
  });
});
