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
    db,
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

  it("uses content recency for fallback summary search ordering and time filters", async () => {
    const { db, conversationStore, summaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "summary-store-search-time",
      title: "Summary search time",
    });

    await summaryStore.insertSummary({
      summaryId: "sum_regex_old_content_recent_compaction",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "pagedrop regression historical request",
      tokenCount: 5,
      latestAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await summaryStore.insertSummary({
      summaryId: "sum_regex_recent_content_older_compaction",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "pagedrop regression recent request",
      tokenCount: 5,
      latestAt: new Date("2026-01-09T00:00:00.000Z"),
    });

    db.prepare("UPDATE summaries SET created_at = ? WHERE summary_id = ?").run(
      "2026-01-10T00:00:00.000Z",
      "sum_regex_old_content_recent_compaction",
    );
    db.prepare("UPDATE summaries SET created_at = ? WHERE summary_id = ?").run(
      "2026-01-05T00:00:00.000Z",
      "sum_regex_recent_content_older_compaction",
    );

    await expect(
      summaryStore.searchSummaries({
        conversationId: conversation.conversationId,
        query: "pagedrop regression",
        mode: "regex",
        limit: 10,
      }),
    ).resolves.toMatchObject([
      {
        summaryId: "sum_regex_recent_content_older_compaction",
        createdAt: new Date("2026-01-09T00:00:00.000Z"),
      },
      {
        summaryId: "sum_regex_old_content_recent_compaction",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);

    await expect(
      summaryStore.searchSummaries({
        conversationId: conversation.conversationId,
        query: "pagedrop regression",
        mode: "regex",
        since: new Date("2026-01-05T00:00:00.000Z"),
        limit: 10,
      }),
    ).resolves.toMatchObject([
      {
        summaryId: "sum_regex_recent_content_older_compaction",
      },
    ]);
  });
});
