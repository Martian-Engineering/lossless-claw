import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { getLcmDbFeatures } from "../src/db/features.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { PendingCompactionCoordinator } from "../src/pending-summary-coordinator.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { PendingSummaryStore } from "../src/store/pending-summary-store.js";
import { SummaryStore } from "../src/store/summary-store.js";

function createStores() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const { fts5Available } = getLcmDbFeatures(db);
  runLcmMigrations(db, { fts5Available });
  return {
    conversationStore: new ConversationStore(db, { fts5Available }),
    pendingSummaryStore: new PendingSummaryStore(db),
    summaryStore: new SummaryStore(db, { fts5Available }),
  };
}

describe("PendingCompactionCoordinator", () => {
  it("prepares hidden leaves and condensation before publishing one canonical swap", async () => {
    const { conversationStore, pendingSummaryStore, summaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "pending-coordinator-session",
      sessionKey: "agent:main:pending-coordinator",
    });
    const messages = await conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "user",
        content: "one two three four",
        tokenCount: 4,
      },
      {
        conversationId: conversation.conversationId,
        seq: 2,
        role: "assistant",
        content: "five six seven eight",
        tokenCount: 4,
      },
      {
        conversationId: conversation.conversationId,
        seq: 3,
        role: "user",
        content: "nine ten eleven twelve",
        tokenCount: 4,
      },
      {
        conversationId: conversation.conversationId,
        seq: 4,
        role: "assistant",
        content: "fresh tail stays raw",
        tokenCount: 4,
      },
    ]);
    await summaryStore.appendContextMessages(
      conversation.conversationId,
      messages.map((message) => message.messageId),
    );

    const summarizeInputs: string[] = [];
    const coordinator = new PendingCompactionCoordinator({
      conversationStore,
      pendingSummaryStore,
      summaryStore,
      model: "test-model",
      leaseOwner: "test-worker",
      config: {
        freshTailCount: 1,
        leafChunkTokens: 8,
        condensedMinFanout: 2,
        condensedMinSourceTokens: 1,
        condensedChunkTokens: 100,
      },
      summarize: async (sourceText, _aggressive, options) => {
        summarizeInputs.push(sourceText);
        return options?.isCondensed ? `condensed(${sourceText})` : `leaf(${sourceText})`;
      },
    });

    const planned = await coordinator.runOnce({
      conversationId: conversation.conversationId,
      sessionKey: "agent:main:pending-coordinator",
    });
    expect(planned).toMatchObject({ status: "planned", nodeCount: 3 });
    await expect(summaryStore.getContextItems(conversation.conversationId)).resolves.toMatchObject([
      { ordinal: 0, itemType: "message", messageId: messages[0]!.messageId },
      { ordinal: 1, itemType: "message", messageId: messages[1]!.messageId },
      { ordinal: 2, itemType: "message", messageId: messages[2]!.messageId },
      { ordinal: 3, itemType: "message", messageId: messages[3]!.messageId },
    ]);

    await expect(
      coordinator.runOnce({ conversationId: conversation.conversationId }),
    ).resolves.toMatchObject({ status: "prepared" });
    await expect(
      coordinator.runOnce({ conversationId: conversation.conversationId }),
    ).resolves.toMatchObject({ status: "prepared" });
    await expect(
      coordinator.runOnce({ conversationId: conversation.conversationId }),
    ).resolves.toMatchObject({ status: "prepared" });
    expect(summarizeInputs[2]).toContain("leaf(");

    const published = await coordinator.runOnce({ conversationId: conversation.conversationId });
    expect(published).toMatchObject({ status: "published" });
    const contextItems = await summaryStore.getContextItems(conversation.conversationId);
    expect(contextItems).toMatchObject([
      { ordinal: 0, itemType: "summary" },
      { ordinal: 1, itemType: "message", messageId: messages[3]!.messageId },
    ]);

    const summaryId = contextItems[0]!.summaryId!;
    const summary = await summaryStore.getSummary(summaryId);
    expect(summary).toMatchObject({
      kind: "condensed",
      depth: 1,
    });
    expect(summary?.content).toContain("condensed(");
    await expect(summaryStore.getSummaryParents(summaryId)).resolves.toHaveLength(2);
  });

  it("revalidates the source projection under the publish lock", async () => {
    const { conversationStore, pendingSummaryStore, summaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "pending-coordinator-stale-session",
      sessionKey: "agent:main:pending-coordinator-stale",
    });
    const messages = await conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "user",
        content: "old source message one",
        tokenCount: 4,
      },
      {
        conversationId: conversation.conversationId,
        seq: 2,
        role: "assistant",
        content: "old source message two",
        tokenCount: 4,
      },
      {
        conversationId: conversation.conversationId,
        seq: 3,
        role: "assistant",
        content: "fresh tail message",
        tokenCount: 4,
      },
    ]);
    await summaryStore.appendContextMessages(
      conversation.conversationId,
      messages.map((message) => message.messageId),
    );

    let publishLockCount = 0;
    const coordinator = new PendingCompactionCoordinator({
      conversationStore,
      pendingSummaryStore,
      summaryStore,
      model: "test-model",
      leaseOwner: "test-worker",
      withPublishLock: async (operation) => {
        publishLockCount += 1;
        return operation();
      },
      config: {
        freshTailCount: 1,
        leafChunkTokens: 100,
        condensedMinFanout: 2,
        condensedMinSourceTokens: 1,
        condensedChunkTokens: 100,
      },
      summarize: async (sourceText) => `leaf(${sourceText})`,
    });

    await expect(
      coordinator.runOnce({
        conversationId: conversation.conversationId,
        sessionKey: "agent:main:pending-coordinator-stale",
      }),
    ).resolves.toMatchObject({ status: "planned", nodeCount: 1 });
    await expect(
      coordinator.runOnce({ conversationId: conversation.conversationId }),
    ).resolves.toMatchObject({ status: "prepared" });

    const [newMessage] = await conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 4,
        role: "user",
        content: "new foreground message before publish",
        tokenCount: 5,
      },
    ]);
    await summaryStore.appendContextMessages(conversation.conversationId, [
      newMessage!.messageId,
    ]);

    await expect(
      coordinator.runOnce({ conversationId: conversation.conversationId }),
    ).resolves.toMatchObject({
      status: "stale",
      reason: "source projection fingerprint changed before publish",
    });
    expect(publishLockCount).toBe(1);
    await expect(
      pendingSummaryStore.getActiveBatchForConversation(conversation.conversationId),
    ).resolves.toBeNull();
    await expect(summaryStore.getContextItems(conversation.conversationId)).resolves.toHaveLength(
      4,
    );
  });

  it("replans the same projection after a failed pending preparation", async () => {
    const { conversationStore, pendingSummaryStore, summaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "pending-coordinator-retry-session",
      sessionKey: "agent:main:pending-coordinator-retry",
    });
    const messages = await conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "user",
        content: "retry source message one",
        tokenCount: 4,
      },
      {
        conversationId: conversation.conversationId,
        seq: 2,
        role: "assistant",
        content: "retry source message two",
        tokenCount: 4,
      },
      {
        conversationId: conversation.conversationId,
        seq: 3,
        role: "assistant",
        content: "fresh tail message",
        tokenCount: 4,
      },
    ]);
    await summaryStore.appendContextMessages(
      conversation.conversationId,
      messages.map((message) => message.messageId),
    );

    let shouldFail = true;
    const coordinator = new PendingCompactionCoordinator({
      conversationStore,
      pendingSummaryStore,
      summaryStore,
      model: "test-model",
      leaseOwner: "test-worker",
      config: {
        freshTailCount: 1,
        leafChunkTokens: 100,
        condensedMinFanout: 2,
        condensedMinSourceTokens: 1,
        condensedChunkTokens: 100,
      },
      summarize: async () => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error("provider timeout");
        }
        return "retry pending summary";
      },
    });

    const firstPlan = await coordinator.runOnce({
      conversationId: conversation.conversationId,
      sessionKey: "agent:main:pending-coordinator-retry",
    });
    expect(firstPlan).toMatchObject({ status: "planned" });
    await expect(
      coordinator.runOnce({ conversationId: conversation.conversationId }),
    ).resolves.toMatchObject({ status: "failed", failureSummary: "provider timeout" });

    const secondPlan = await coordinator.runOnce({
      conversationId: conversation.conversationId,
      sessionKey: "agent:main:pending-coordinator-retry",
    });
    expect(secondPlan).toMatchObject({ status: "planned" });
    if (firstPlan.status !== "planned" || secondPlan.status !== "planned") {
      throw new Error("Expected both pending compaction attempts to plan");
    }
    expect(secondPlan.batchId).not.toBe(firstPlan.batchId);
    await expect(
      coordinator.runOnce({ conversationId: conversation.conversationId }),
    ).resolves.toMatchObject({ status: "prepared" });
    await expect(
      coordinator.runOnce({ conversationId: conversation.conversationId }),
    ).resolves.toMatchObject({ status: "published" });
  });

  it("publishes a mixed canonical and pending frontier", async () => {
    const { conversationStore, pendingSummaryStore, summaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "pending-coordinator-mixed-frontier-session",
      sessionKey: "agent:main:pending-coordinator-mixed-frontier",
    });
    await summaryStore.insertSummary({
      summaryId: "sum_existing_context",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "existing canonical summary",
      tokenCount: 5,
    });
    await summaryStore.appendContextSummary(conversation.conversationId, "sum_existing_context");
    const messages = await conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "user",
        content: "raw message beside canonical summary",
        tokenCount: 4,
      },
      {
        conversationId: conversation.conversationId,
        seq: 2,
        role: "assistant",
        content: "fresh tail message",
        tokenCount: 4,
      },
    ]);
    await summaryStore.appendContextMessages(
      conversation.conversationId,
      messages.map((message) => message.messageId),
    );

    const coordinator = new PendingCompactionCoordinator({
      conversationStore,
      pendingSummaryStore,
      summaryStore,
      model: "test-model",
      leaseOwner: "test-worker",
      config: {
        freshTailCount: 1,
        leafChunkTokens: 100,
        condensedMinFanout: 99,
        condensedMinSourceTokens: 1,
        condensedChunkTokens: 100,
      },
      summarize: async (sourceText) => `leaf(${sourceText})`,
    });

    await expect(
      coordinator.runOnce({
        conversationId: conversation.conversationId,
        sessionKey: "agent:main:pending-coordinator-mixed-frontier",
      }),
    ).resolves.toMatchObject({ status: "planned", nodeCount: 1 });
    await expect(
      coordinator.runOnce({ conversationId: conversation.conversationId }),
    ).resolves.toMatchObject({ status: "prepared" });
    const published = await coordinator.runOnce({ conversationId: conversation.conversationId });
    expect(published).toMatchObject({
      status: "published",
      frontierSummaryIds: ["sum_existing_context", expect.stringMatching(/^sum_/)],
    });

    const contextItems = await summaryStore.getContextItems(conversation.conversationId);
    expect(contextItems).toMatchObject([
      { ordinal: 0, itemType: "summary", summaryId: "sum_existing_context" },
      { ordinal: 1, itemType: "summary" },
      { ordinal: 2, itemType: "message", messageId: messages[1]!.messageId },
    ]);
  });

  it("does not claim a condensed parent before pending children are ready", async () => {
    const { conversationStore, pendingSummaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "pending-coordinator-claim-session",
    });

    await pendingSummaryStore.createBatch({
      batchId: "batch_dependency_order",
      conversationId: conversation.conversationId,
      sourceProjectionFingerprint: "projection",
      compactableStartOrdinal: 0,
      compactableEndOrdinal: 2,
      promptVersion: "pending:v1",
      model: "test-model",
    });
    await pendingSummaryStore.insertNode({
      nodeId: "leaf_first",
      batchId: "batch_dependency_order",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      ordinalStart: 0,
      ordinalEnd: 1,
      sourceFingerprint: "leaf:first",
      promptVersion: "pending:v1",
      model: "test-model",
    });
    await pendingSummaryStore.insertNode({
      nodeId: "leaf_second",
      batchId: "batch_dependency_order",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      ordinalStart: 2,
      ordinalEnd: 2,
      sourceFingerprint: "leaf:second",
      promptVersion: "pending:v1",
      model: "test-model",
    });
    await pendingSummaryStore.insertNode({
      nodeId: "condensed_parent",
      batchId: "batch_dependency_order",
      conversationId: conversation.conversationId,
      kind: "condensed",
      depth: 1,
      ordinalStart: 0,
      ordinalEnd: 2,
      sourceFingerprint: "parent",
      promptVersion: "pending:v1",
      model: "test-model",
    });
    await pendingSummaryStore.linkNodeToChildren("condensed_parent", [
      { childNodeId: "leaf_first" },
      { childNodeId: "leaf_second" },
    ]);

    const firstClaim = await pendingSummaryStore.claimNextPlannedNode({
      conversationId: conversation.conversationId,
      leaseOwner: "worker",
      leaseExpiresAt: new Date("2026-06-30T12:05:00.000Z"),
      now: new Date("2026-06-30T12:00:00.000Z"),
    });
    expect(firstClaim).toMatchObject({ nodeId: "leaf_first" });
    await pendingSummaryStore.markNodeReady({
      nodeId: "leaf_first",
      leaseOwner: "worker",
      leaseExpiresAt: firstClaim!.leaseExpiresAt!,
      content: "first ready",
      tokenCount: 2,
    });

    await expect(
      pendingSummaryStore.claimNextPlannedNode({
        conversationId: conversation.conversationId,
        leaseOwner: "worker",
        leaseExpiresAt: new Date("2026-06-30T12:06:00.000Z"),
        now: new Date("2026-06-30T12:01:00.000Z"),
      }),
    ).resolves.toMatchObject({ nodeId: "leaf_second" });
  });
});
