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
    db,
    conversationStore: new ConversationStore(db, { fts5Available }),
    pendingSummaryStore: new PendingSummaryStore(db),
    summaryStore: new SummaryStore(db, { fts5Available }),
  };
}

/** Fast-forward every pending node's retry backoff so claims retry now. */
function clearRetryBackoff(db: DatabaseSync): void {
  db.prepare(
    `UPDATE pending_summary_nodes SET next_attempt_after = '2000-01-01T00:00:00.000Z'`,
  ).run();
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

    const ready = await coordinator.runOnce({
      conversationId: conversation.conversationId,
      publishPolicy: "prepare-only",
    });
    expect(ready).toMatchObject({
      status: "ready",
      reason: "pending summaries ready for publish",
    });
    await expect(summaryStore.getContextItems(conversation.conversationId)).resolves.toHaveLength(
      4,
    );

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

    // Publish promotes every ancestor and drops the heavy pending payloads,
    // keeping only lineage metadata on the promoted rows.
    if (planned.status !== "planned") {
      throw new Error("Expected the initial pending compaction attempt to plan");
    }
    const promotedNodes = await pendingSummaryStore.getNodesByBatch(planned.batchId);
    expect(promotedNodes.length).toBeGreaterThan(0);
    for (const node of promotedNodes) {
      expect(node).toMatchObject({ status: "promoted", content: null });
      expect(node.canonicalSummaryId).toBeTruthy();
    }
  });

  it("prepares leaf source from message parts when stored content is empty", async () => {
    const { conversationStore, pendingSummaryStore, summaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "pending-coordinator-parts-session",
      sessionKey: "agent:main:pending-coordinator-parts",
    });
    const message = await conversationStore.createMessage({
      conversationId: conversation.conversationId,
      seq: 1,
      role: "tool",
      content: "",
      tokenCount: 400,
    });
    await conversationStore.createMessageParts(message.messageId, [
      {
        sessionId: "pending-coordinator-parts-session",
        partType: "tool",
        ordinal: 0,
        textContent: JSON.stringify({
          content: [{ type: "text", text: "Pending message-parts source detail." }],
        }),
        metadata: JSON.stringify({
          originalRole: "toolResult",
          rawType: "function_call_output",
        }),
      },
    ]);
    await summaryStore.appendContextMessage(conversation.conversationId, message.messageId);

    let summarizedSource = "";
    const coordinator = new PendingCompactionCoordinator({
      conversationStore,
      pendingSummaryStore,
      summaryStore,
      model: "test-model",
      leaseOwner: "test-worker",
      config: {
        freshTailCount: 0,
        leafChunkTokens: 1_000,
        condensedMinFanout: 2,
        condensedMinSourceTokens: 1,
        condensedChunkTokens: 100,
      },
      summarize: async (sourceText) => {
        summarizedSource = sourceText;
        return "parts-backed pending summary";
      },
    });

    await expect(
      coordinator.runOnce({
        conversationId: conversation.conversationId,
        sessionKey: "agent:main:pending-coordinator-parts",
      }),
    ).resolves.toMatchObject({ status: "planned", nodeCount: 1 });
    await expect(
      coordinator.runOnce({ conversationId: conversation.conversationId }),
    ).resolves.toMatchObject({ status: "prepared" });
    expect(summarizedSource).toContain("Pending message-parts source detail.");
  });

  it("keeps prepared pending summaries publishable when new tail messages arrive", async () => {
    const { conversationStore, pendingSummaryStore, summaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "pending-coordinator-growing-tail-session",
      sessionKey: "agent:main:pending-coordinator-growing-tail",
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
        tokenCount: 120,
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
        condensedChunkTokens: 400,
      },
      summarize: async (sourceText) => `leaf(${sourceText})`,
    });

    await expect(
      coordinator.runOnce({
        conversationId: conversation.conversationId,
        sessionKey: "agent:main:pending-coordinator-growing-tail",
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
      coordinator.runOnce({
        conversationId: conversation.conversationId,
        publishPolicy: "prepare-only",
      }),
    ).resolves.toMatchObject({
      status: "planned",
    });
    expect(publishLockCount).toBe(0);
    await expect(
      pendingSummaryStore.getActiveBatchForConversation(conversation.conversationId),
    ).resolves.not.toBeNull();
    await expect(
      coordinator.runOnce({
        conversationId: conversation.conversationId,
        publishPolicy: "prepare-only",
      }),
    ).resolves.toMatchObject({ status: "prepared" });
    await expect(
      coordinator.runOnce({
        conversationId: conversation.conversationId,
        publishPolicy: "prepare-only",
      }),
    ).resolves.toMatchObject({ status: "prepared" });
    await expect(
      coordinator.runOnce({
        conversationId: conversation.conversationId,
        publishPolicy: "prepare-only",
      }),
    ).resolves.toMatchObject({
      status: "ready",
      reason: "pending summaries ready for publish",
    });

    await expect(
      coordinator.runOnce({ conversationId: conversation.conversationId }),
    ).resolves.toMatchObject({
      status: "published",
    });
    expect(publishLockCount).toBe(1);
    await expect(
      pendingSummaryStore.getActiveBatchForConversation(conversation.conversationId),
    ).resolves.toBeNull();
    const contextItems = await summaryStore.getContextItems(conversation.conversationId);
    expect(contextItems).toMatchObject([
      { ordinal: 0, itemType: "summary" },
      { ordinal: 1, itemType: "message", messageId: newMessage!.messageId },
    ]);
  });

  it("retries a failed pending preparation in place without discarding the batch", async () => {
    const { db, conversationStore, pendingSummaryStore, summaryStore } = createStores();
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
    if (firstPlan.status !== "planned") {
      throw new Error("Expected the pending compaction attempt to plan");
    }
    await expect(
      coordinator.runOnce({ conversationId: conversation.conversationId }),
    ).resolves.toMatchObject({ status: "failed", failureSummary: "provider timeout" });

    // The transient failure keeps the batch active with the node parked in
    // failed status behind its retry backoff.
    const batchAfterFailure = await pendingSummaryStore.getActiveBatchForConversation(
      conversation.conversationId,
    );
    expect(batchAfterFailure?.batchId).toBe(firstPlan.batchId);
    const failedNodes = await pendingSummaryStore.getNodesByBatch(firstPlan.batchId);
    expect(failedNodes).toHaveLength(1);
    expect(failedNodes[0]).toMatchObject({ status: "failed", retryCount: 1 });
    expect(failedNodes[0]!.nextAttemptAfter!.getTime()).toBeGreaterThan(Date.now());

    // Backoff still active: nothing is claimable yet.
    await expect(
      coordinator.runOnce({ conversationId: conversation.conversationId }),
    ).resolves.toMatchObject({ status: "idle" });

    clearRetryBackoff(db);
    await expect(
      coordinator.runOnce({ conversationId: conversation.conversationId }),
    ).resolves.toMatchObject({ status: "prepared", batchId: firstPlan.batchId });
    await expect(
      coordinator.runOnce({ conversationId: conversation.conversationId }),
    ).resolves.toMatchObject({ status: "published", batchId: firstPlan.batchId });
  });

  it("stales the batch only after pending preparation retries are exhausted", async () => {
    const { db, conversationStore, pendingSummaryStore, summaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "pending-coordinator-exhaust-session",
      sessionKey: "agent:main:pending-coordinator-exhaust",
    });
    const messages = await conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "user",
        content: "exhaust source message",
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
        condensedMinFanout: 2,
        condensedMinSourceTokens: 1,
        condensedChunkTokens: 100,
      },
      summarize: async () => {
        throw new Error("persistent provider failure");
      },
    });

    const plan = await coordinator.runOnce({ conversationId: conversation.conversationId });
    expect(plan).toMatchObject({ status: "planned" });
    if (plan.status !== "planned") {
      throw new Error("Expected the pending compaction attempt to plan");
    }

    // Attempts one and two fail transiently and keep the batch alive.
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await expect(
        coordinator.runOnce({ conversationId: conversation.conversationId }),
      ).resolves.toMatchObject({ status: "failed" });
      await expect(
        pendingSummaryStore.getActiveBatchForConversation(conversation.conversationId),
      ).resolves.toMatchObject({ batchId: plan.batchId });
      clearRetryBackoff(db);
    }

    // The third failure exhausts retries and stales the whole batch.
    await expect(
      coordinator.runOnce({ conversationId: conversation.conversationId }),
    ).resolves.toMatchObject({ status: "failed" });
    await expect(
      pendingSummaryStore.getActiveBatchForConversation(conversation.conversationId),
    ).resolves.toBeNull();
    await expect(pendingSummaryStore.getBatch(plan.batchId)).resolves.toMatchObject({
      status: "stale",
    });

    // The next pass replans a fresh batch for the same projection.
    await expect(
      coordinator.runOnce({ conversationId: conversation.conversationId }),
    ).resolves.toMatchObject({ status: "planned" });
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

  it("preserves mixed canonical and pending child order when condensing", async () => {
    const { conversationStore, pendingSummaryStore, summaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "pending-coordinator-mixed-order-session",
      sessionKey: "agent:main:pending-coordinator-mixed-order",
    });
    await summaryStore.insertSummary({
      summaryId: "sum_order_existing_context",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "existing canonical summary",
      tokenCount: 5,
      sourceMessageTokenCount: 5,
    });
    await summaryStore.appendContextSummary(
      conversation.conversationId,
      "sum_order_existing_context",
    );
    const messages = await conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "user",
        content: "raw message after canonical summary",
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

    const summarizeInputs: Array<{ isCondensed: boolean; sourceText: string }> = [];
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
      summarize: async (sourceText, _aggressive, options) => {
        summarizeInputs.push({
          isCondensed: options?.isCondensed === true,
          sourceText,
        });
        return options?.isCondensed ? `condensed(${sourceText})` : `leaf(${sourceText})`;
      },
    });

    await expect(
      coordinator.runOnce({
        conversationId: conversation.conversationId,
        sessionKey: "agent:main:pending-coordinator-mixed-order",
      }),
    ).resolves.toMatchObject({ status: "planned", nodeCount: 2 });
    await expect(
      coordinator.runOnce({ conversationId: conversation.conversationId }),
    ).resolves.toMatchObject({ status: "prepared" });
    await expect(
      coordinator.runOnce({ conversationId: conversation.conversationId }),
    ).resolves.toMatchObject({ status: "prepared" });
    const published = await coordinator.runOnce({ conversationId: conversation.conversationId });
    expect(published).toMatchObject({ status: "published" });

    const condensedInput = summarizeInputs.find((input) => input.isCondensed);
    expect(condensedInput?.sourceText.indexOf("existing canonical summary")).toBeLessThan(
      condensedInput?.sourceText.indexOf("leaf(") ?? -1,
    );
    const contextItems = await summaryStore.getContextItems(conversation.conversationId);
    const condensedSummaryId = contextItems[0]!.summaryId!;
    await expect(summaryStore.getSummaryParents(condensedSummaryId)).resolves.toMatchObject([
      { summaryId: "sum_order_existing_context" },
      { summaryId: expect.stringMatching(/^sum_/) },
    ]);
  });

  it("extends a ready unpublished batch when the compactable prefix grows", async () => {
    const { conversationStore, pendingSummaryStore, summaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "pending-coordinator-extend-ready-session",
      sessionKey: "agent:main:pending-coordinator-extend-ready",
    });
    const initialMessages = await conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "user",
        content: "first compactable message",
        tokenCount: 10,
      },
      {
        conversationId: conversation.conversationId,
        seq: 2,
        role: "assistant",
        content: "second compactable message",
        tokenCount: 10,
      },
      {
        conversationId: conversation.conversationId,
        seq: 3,
        role: "user",
        content: "initial fresh tail",
        tokenCount: 120,
      },
    ]);
    await summaryStore.appendContextMessages(
      conversation.conversationId,
      initialMessages.map((message) => message.messageId),
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
        sessionKey: "agent:main:pending-coordinator-extend-ready",
        publishPolicy: "prepare-only",
      }),
    ).resolves.toMatchObject({ status: "planned", nodeCount: 1 });
    await expect(
      coordinator.runOnce({
        conversationId: conversation.conversationId,
        publishPolicy: "prepare-only",
      }),
    ).resolves.toMatchObject({ status: "prepared" });
    await expect(
      coordinator.runOnce({
        conversationId: conversation.conversationId,
        publishPolicy: "prepare-only",
      }),
    ).resolves.toMatchObject({ status: "ready" });

    const batchBefore = await pendingSummaryStore.getActiveBatchForConversation(
      conversation.conversationId,
    );
    expect(batchBefore).not.toBeNull();
    const readyNodesBefore = await pendingSummaryStore.getNodesByBatch(batchBefore!.batchId);
    expect(readyNodesBefore).toHaveLength(1);
    expect(readyNodesBefore[0]).toMatchObject({
      status: "ready",
      ordinalStart: 0,
      ordinalEnd: 1,
    });

    const [newTail] = await conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 4,
        role: "assistant",
        content: "new fresh tail moves prior tail into compactable prefix",
        tokenCount: 10,
      },
    ]);
    await summaryStore.appendContextMessage(conversation.conversationId, newTail!.messageId);

    await expect(
      coordinator.runOnce({
        conversationId: conversation.conversationId,
        publishPolicy: "prepare-only",
      }),
    ).resolves.toMatchObject({ status: "planned", nodeCount: 1 });

    const batchAfter = await pendingSummaryStore.getActiveBatchForConversation(
      conversation.conversationId,
    );
    expect(batchAfter?.batchId).toBe(batchBefore!.batchId);
    expect(batchAfter?.compactableEndOrdinal).toBe(2);
    const nodesAfter = await pendingSummaryStore.getNodesByBatch(batchBefore!.batchId);
    expect(nodesAfter).toHaveLength(2);
    expect(nodesAfter).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "ready",
          ordinalStart: 0,
          ordinalEnd: 1,
        }),
        expect.objectContaining({
          status: "planned",
          ordinalStart: 2,
          ordinalEnd: 2,
        }),
      ]),
    );
  });

  it("does not extend a ready batch for suffix growth below the leaf chunk minimum", async () => {
    const { conversationStore, pendingSummaryStore, summaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "pending-coordinator-tiny-suffix-session",
      sessionKey: "agent:main:pending-coordinator-tiny-suffix",
    });
    const initialMessages = await conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "user",
        content: "first compactable message",
        tokenCount: 10,
      },
      {
        conversationId: conversation.conversationId,
        seq: 2,
        role: "assistant",
        content: "second compactable message",
        tokenCount: 10,
      },
      {
        conversationId: conversation.conversationId,
        seq: 3,
        role: "user",
        content: "heartbeat-sized fresh tail",
        tokenCount: 5,
      },
    ]);
    await summaryStore.appendContextMessages(
      conversation.conversationId,
      initialMessages.map((message) => message.messageId),
    );

    let summarizeCalls = 0;
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
      summarize: async (sourceText) => {
        summarizeCalls += 1;
        return `leaf(${sourceText})`;
      },
    });

    await expect(
      coordinator.runOnce({
        conversationId: conversation.conversationId,
        publishPolicy: "prepare-only",
      }),
    ).resolves.toMatchObject({ status: "planned", nodeCount: 1 });
    await expect(
      coordinator.runOnce({
        conversationId: conversation.conversationId,
        publishPolicy: "prepare-only",
      }),
    ).resolves.toMatchObject({ status: "prepared" });
    const batch = await pendingSummaryStore.getActiveBatchForConversation(
      conversation.conversationId,
    );
    expect(batch).not.toBeNull();
    const summarizeCallsWhenReady = summarizeCalls;

    // Two heartbeat-sized exchanges arrive; the previous tail becomes
    // compactable but the suffix stays far below leafChunkTokens.
    const [heartbeatTail] = await conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 4,
        role: "assistant",
        content: "heartbeat reply",
        tokenCount: 5,
      },
    ]);
    await summaryStore.appendContextMessage(conversation.conversationId, heartbeatTail!.messageId);

    // The ready frontier is reported without extending the batch or spending
    // any further summarizer calls.
    await expect(
      coordinator.runOnce({
        conversationId: conversation.conversationId,
        publishPolicy: "prepare-only",
      }),
    ).resolves.toMatchObject({ status: "ready" });
    expect(summarizeCalls).toBe(summarizeCallsWhenReady);

    const batchAfter = await pendingSummaryStore.getActiveBatchForConversation(
      conversation.conversationId,
    );
    expect(batchAfter?.batchId).toBe(batch!.batchId);
    expect(batchAfter?.compactableEndOrdinal).toBe(batch!.compactableEndOrdinal);
    await expect(
      pendingSummaryStore.getNodesByBatch(batch!.batchId),
    ).resolves.toHaveLength(1);
  });

  it("does not rebuild a whole-prefix condensed parent when extending past a ready one", async () => {
    const { conversationStore, pendingSummaryStore, summaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "pending-coordinator-no-rebuild-session",
      sessionKey: "agent:main:pending-coordinator-no-rebuild",
    });
    const initialMessages = await conversationStore.createMessagesBulk(
      ["alpha", "bravo", "charlie", "delta"].map((label, index) => ({
        conversationId: conversation.conversationId,
        seq: index + 1,
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: `${label} compactable message`,
        tokenCount: 8,
      })),
    );
    await summaryStore.appendContextMessages(
      conversation.conversationId,
      initialMessages.map((message) => message.messageId),
    );

    const condensedInputs: string[] = [];
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
        condensedChunkTokens: 400,
      },
      summarize: async (sourceText, _aggressive, options) => {
        if (options?.isCondensed) {
          condensedInputs.push(sourceText);
          return `condensed(${sourceText.length})`;
        }
        return `leaf(${sourceText.slice(0, 24)})`;
      },
    });

    // Initial plan condenses the two 8-token leaves into one depth-1 parent.
    await expect(
      coordinator.runOnce({
        conversationId: conversation.conversationId,
        publishPolicy: "prepare-only",
      }),
    ).resolves.toMatchObject({ status: "planned", nodeCount: 4 });
    let result: { status: string };
    do {
      result = await coordinator.runOnce({
        conversationId: conversation.conversationId,
        publishPolicy: "prepare-only",
      });
    } while (result.status === "prepared");
    expect(result.status).toBe("ready");
    const batch = await pendingSummaryStore.getActiveBatchForConversation(
      conversation.conversationId,
    );
    const readyNodes = await pendingSummaryStore.getNodesByBatch(batch!.batchId);
    const readyCondensed = readyNodes.filter((node) => node.kind === "condensed");
    expect(readyCondensed).toHaveLength(1);
    const wholePrefixEnd = readyCondensed[0]!.ordinalEnd;
    const condensedCallsAfterInitial = condensedInputs.length;

    // One new chunk of growth: enough to extend, not enough new child work to
    // satisfy the condensation fanout on its own.
    const [suffixMessage] = await conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 5,
        role: "user",
        content: "echo suffix message",
        tokenCount: 8,
      },
    ]);
    await summaryStore.appendContextMessage(conversation.conversationId, suffixMessage!.messageId);

    await expect(
      coordinator.runOnce({
        conversationId: conversation.conversationId,
        publishPolicy: "prepare-only",
      }),
    ).resolves.toMatchObject({ status: "planned", nodeCount: 1 });
    do {
      result = await coordinator.runOnce({
        conversationId: conversation.conversationId,
        publishPolicy: "prepare-only",
      });
    } while (result.status === "prepared");
    expect(result.status).toBe("ready");

    // The extension planned only the suffix leaf: no condensed node covering
    // the old prefix was rebuilt and no condensed summarize call was spent.
    const nodesAfterSmallGrowth = await pendingSummaryStore.getNodesByBatch(batch!.batchId);
    const condensedAfterSmallGrowth = nodesAfterSmallGrowth.filter(
      (node) => node.kind === "condensed",
    );
    expect(condensedAfterSmallGrowth).toHaveLength(1);
    expect(condensedAfterSmallGrowth[0]!.ordinalEnd).toBe(wholePrefixEnd);
    expect(condensedInputs.length).toBe(condensedCallsAfterInitial);
  });

  it("condenses extension growth in layers over the existing ready condensed node", async () => {
    const { conversationStore, pendingSummaryStore, summaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "pending-coordinator-layered-session",
      sessionKey: "agent:main:pending-coordinator-layered",
    });
    const initialMessages = await conversationStore.createMessagesBulk(
      ["alpha", "bravo", "charlie", "delta"].map((label, index) => ({
        conversationId: conversation.conversationId,
        seq: index + 1,
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: `${label} compactable message`,
        tokenCount: 8,
      })),
    );
    await summaryStore.appendContextMessages(
      conversation.conversationId,
      initialMessages.map((message) => message.messageId),
    );

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
        condensedChunkTokens: 400,
      },
      summarize: async (sourceText, _aggressive, options) =>
        options?.isCondensed ? `condensed(${sourceText.length})` : `leaf(${sourceText.slice(0, 24)})`,
    });

    await expect(
      coordinator.runOnce({
        conversationId: conversation.conversationId,
        publishPolicy: "prepare-only",
      }),
    ).resolves.toMatchObject({ status: "planned", nodeCount: 4 });
    let result: { status: string };
    do {
      result = await coordinator.runOnce({
        conversationId: conversation.conversationId,
        publishPolicy: "prepare-only",
      });
    } while (result.status === "prepared");
    expect(result.status).toBe("ready");
    const batch = await pendingSummaryStore.getActiveBatchForConversation(
      conversation.conversationId,
    );
    const initialCondensed = (await pendingSummaryStore.getNodesByBatch(batch!.batchId)).find(
      (node) => node.kind === "condensed",
    );
    expect(initialCondensed).toBeDefined();

    // Two chunks of growth: enough new child work to satisfy the fanout.
    const suffixMessages = await conversationStore.createMessagesBulk(
      ["echo", "foxtrot"].map((label, index) => ({
        conversationId: conversation.conversationId,
        seq: 5 + index,
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: `${label} suffix message`,
        tokenCount: 8,
      })),
    );
    for (const message of suffixMessages) {
      await summaryStore.appendContextMessage(conversation.conversationId, message.messageId);
    }

    const extended = await coordinator.runOnce({
      conversationId: conversation.conversationId,
      publishPolicy: "prepare-only",
    });
    expect(extended).toMatchObject({ status: "planned" });

    // The plan grows in layers: a depth-1 parent over the new leaves only, and
    // a depth-2 parent over [existing condensed, new parent] — never a rebuilt
    // depth-1 parent spanning the whole prefix with re-flattened old leaves.
    const nodes = await pendingSummaryStore.getNodesByBatch(batch!.batchId);
    const plannedCondensed = nodes.filter(
      (node) => node.kind === "condensed" && node.status === "planned",
    );
    const suffixParent = plannedCondensed.find((node) => node.depth === 1);
    const layeredParent = plannedCondensed.find((node) => node.depth === 2);
    expect(suffixParent).toBeDefined();
    expect(suffixParent!.ordinalStart).toBeGreaterThan(initialCondensed!.ordinalEnd);
    expect(layeredParent).toBeDefined();
    expect(layeredParent!.ordinalStart).toBe(initialCondensed!.ordinalStart);

    const layeredChildren = await pendingSummaryStore.getNodeChildren(layeredParent!.nodeId);
    expect(layeredChildren).toEqual([
      { childNodeId: initialCondensed!.nodeId, childSummaryId: null },
      { childNodeId: suffixParent!.nodeId, childSummaryId: null },
    ]);

    // Preparation still converges to a ready frontier over the layered DAG.
    do {
      result = await coordinator.runOnce({
        conversationId: conversation.conversationId,
        publishPolicy: "prepare-only",
      });
    } while (result.status === "prepared" || result.status === "planned");
    expect(result.status).toBe("ready");
  });

  it("stales condensed pending summaries when a canonical child changes during tail growth", async () => {
    const { conversationStore, pendingSummaryStore, summaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "pending-coordinator-canonical-child-stale-session",
      sessionKey: "agent:main:pending-coordinator-canonical-child-stale",
    });
    await summaryStore.insertSummary({
      summaryId: "sum_canonical_child_old",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "old canonical child",
      tokenCount: 5,
      sourceMessageTokenCount: 5,
    });
    await summaryStore.insertSummary({
      summaryId: "sum_canonical_child_new",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "new canonical child",
      tokenCount: 5,
      sourceMessageTokenCount: 5,
    });
    await summaryStore.appendContextSummary(
      conversation.conversationId,
      "sum_canonical_child_old",
    );
    const messages = await conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "user",
        content: "raw message after old canonical child",
        tokenCount: 4,
      },
      {
        conversationId: conversation.conversationId,
        seq: 2,
        role: "assistant",
        content: "original fresh tail",
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
        condensedMinFanout: 2,
        condensedMinSourceTokens: 1,
        condensedChunkTokens: 100,
      },
      summarize: async (sourceText, _aggressive, options) =>
        options?.isCondensed ? `condensed(${sourceText})` : `leaf(${sourceText})`,
    });

    await expect(
      coordinator.runOnce({
        conversationId: conversation.conversationId,
        sessionKey: "agent:main:pending-coordinator-canonical-child-stale",
      }),
    ).resolves.toMatchObject({ status: "planned", nodeCount: 2 });
    await expect(
      coordinator.runOnce({ conversationId: conversation.conversationId }),
    ).resolves.toMatchObject({ status: "prepared" });
    await expect(
      coordinator.runOnce({ conversationId: conversation.conversationId }),
    ).resolves.toMatchObject({ status: "prepared" });

    await summaryStore.replaceContextRangeWithSummary({
      conversationId: conversation.conversationId,
      startOrdinal: 0,
      endOrdinal: 0,
      summaryId: "sum_canonical_child_new",
    });
    const [newMessage] = await conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 3,
        role: "user",
        content: "new foreground message",
        tokenCount: 4,
      },
    ]);
    await summaryStore.appendContextMessage(conversation.conversationId, newMessage!.messageId);

    await expect(
      coordinator.runOnce({ conversationId: conversation.conversationId }),
    ).resolves.toMatchObject({
      status: "stale",
      reason: "pending batch source changed before publish",
    });
    await expect(
      pendingSummaryStore.getActiveBatchForConversation(conversation.conversationId),
    ).resolves.toBeNull();
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
