import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../src/db/migration.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";

function createStores() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const { fts5Available } = getLcmDbFeatures(db);
  runLcmMigrations(db, { fts5Available });
  return {
    conversationStore: new ConversationStore(db, { fts5Available }),
    summaryStore: new SummaryStore(db, { fts5Available }),
  };
}

describe("SummaryStore shallow-tree helpers", () => {
  it("returns conversation max depth and leaf links for message hits", async () => {
    const { conversationStore, summaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "summary-store-links",
      title: "Summary store links",
    });
    const [firstMessage, secondMessage, tailMessage] = await conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "user",
        content: "first raw fact",
        tokenCount: 4,
      },
      {
        conversationId: conversation.conversationId,
        seq: 2,
        role: "assistant",
        content: "second raw fact",
        tokenCount: 4,
      },
      {
        conversationId: conversation.conversationId,
        seq: 3,
        role: "user",
        content: "fresh tail fact",
        tokenCount: 4,
      },
    ]);

    await summaryStore.insertSummary({
      summaryId: "sum_leaf_a",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "leaf A",
      tokenCount: 5,
    });
    await summaryStore.insertSummary({
      summaryId: "sum_leaf_b",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "leaf B",
      tokenCount: 5,
    });
    await summaryStore.insertSummary({
      summaryId: "sum_root",
      conversationId: conversation.conversationId,
      kind: "condensed",
      depth: 2,
      content: "root summary",
      tokenCount: 6,
    });

    await summaryStore.linkSummaryToMessages("sum_leaf_a", [firstMessage.messageId]);
    await summaryStore.linkSummaryToMessages("sum_leaf_b", [secondMessage.messageId]);

    await expect(
      summaryStore.getConversationMaxSummaryDepth(conversation.conversationId),
    ).resolves.toBe(2);

    await expect(
      summaryStore.getLeafSummaryLinksForMessageIds(conversation.conversationId, [
        tailMessage.messageId,
        secondMessage.messageId,
        firstMessage.messageId,
      ]),
    ).resolves.toEqual([
      {
        messageId: secondMessage.messageId,
        summaryId: "sum_leaf_b",
      },
      {
        messageId: firstMessage.messageId,
        summaryId: "sum_leaf_a",
      },
    ]);
  });
});
