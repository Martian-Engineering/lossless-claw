import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { getLcmDbFeatures } from "../src/db/features.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { RetrievalEngine } from "../src/retrieval.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";

const itIfFts5 = detectFts5Support() ? it : it.skip;
const itIfTrigram = detectTrigramSupport() ? it : it.skip;

function detectFts5Support(): boolean {
  const db = new DatabaseSync(":memory:");
  try {
    return getLcmDbFeatures(db).fts5Available;
  } finally {
    db.close();
  }
}

function detectTrigramSupport(): boolean {
  const db = new DatabaseSync(":memory:");
  try {
    return getLcmDbFeatures(db).trigramTokenizerAvailable;
  } finally {
    db.close();
  }
}

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

describe("RetrievalEngine sort modes", () => {
  itIfFts5("applies relevance ordering before limit for message search", async () => {
    const { db, conversationStore, summaryStore } = createStores();
    const retrieval = new RetrievalEngine(conversationStore, summaryStore);

    try {
      const conversation = await conversationStore.createConversation({
        sessionId: "relevance-sort-messages",
      });
      const [olderStrongMatch, newerWeakMatch] = await conversationStore.createMessagesBulk([
        {
          conversationId: conversation.conversationId,
          seq: 1,
          role: "user",
          content:
            "database migration plan database migration plan database migration plan with rollback notes",
          tokenCount: 18,
        },
        {
          conversationId: conversation.conversationId,
          seq: 2,
          role: "assistant",
          content: "recent status note about the database migration plan",
          tokenCount: 10,
        },
      ]);

      db.prepare("UPDATE messages SET created_at = ? WHERE message_id = ?").run(
        "2026-01-01T00:00:00.000Z",
        olderStrongMatch.messageId,
      );
      db.prepare("UPDATE messages SET created_at = ? WHERE message_id = ?").run(
        "2026-01-02T00:00:00.000Z",
        newerWeakMatch.messageId,
      );

      const recencyResult = await retrieval.grep({
        query: '"database migration plan"',
        mode: "full_text",
        scope: "messages",
        conversationId: conversation.conversationId,
        limit: 1,
        sort: "recency",
      });
      const relevanceResult = await retrieval.grep({
        query: '"database migration plan"',
        mode: "full_text",
        scope: "messages",
        conversationId: conversation.conversationId,
        limit: 1,
        sort: "relevance",
      });

      expect(recencyResult.messages[0]?.messageId).toBe(newerWeakMatch.messageId);
      expect(relevanceResult.messages[0]?.messageId).toBe(olderStrongMatch.messageId);
    } finally {
      db.close();
    }
  });

  itIfFts5("applies hybrid ordering before limit for summary search", async () => {
    const { db, conversationStore, summaryStore } = createStores();
    const retrieval = new RetrievalEngine(conversationStore, summaryStore);

    try {
      const conversation = await conversationStore.createConversation({
        sessionId: "hybrid-sort-summaries",
      });
      await summaryStore.insertSummary({
        summaryId: "sum_hybrid_old",
        conversationId: conversation.conversationId,
        kind: "leaf",
        depth: 0,
        content:
          "error handling checklist error handling checklist error handling checklist with confirmed fixes",
        tokenCount: 18,
      });
      await summaryStore.insertSummary({
        summaryId: "sum_hybrid_new",
        conversationId: conversation.conversationId,
        kind: "leaf",
        depth: 0,
        content: "recent note mentioning the error handling checklist",
        tokenCount: 9,
      });

      db.prepare("UPDATE summaries SET created_at = ? WHERE summary_id = ?").run(
        "2026-01-01T00:00:00.000Z",
        "sum_hybrid_old",
      );
      db.prepare("UPDATE summaries SET created_at = ? WHERE summary_id = ?").run(
        "2026-01-01T12:00:00.000Z",
        "sum_hybrid_new",
      );

      const recencyResult = await retrieval.grep({
        query: '"error handling checklist"',
        mode: "full_text",
        scope: "summaries",
        conversationId: conversation.conversationId,
        limit: 1,
        sort: "recency",
      });
      const hybridResult = await retrieval.grep({
        query: '"error handling checklist"',
        mode: "full_text",
        scope: "summaries",
        conversationId: conversation.conversationId,
        limit: 1,
        sort: "hybrid",
      });

      expect(recencyResult.summaries[0]?.summaryId).toBe("sum_hybrid_new");
      expect(hybridResult.summaries[0]?.summaryId).toBe("sum_hybrid_old");
    } finally {
      db.close();
    }
  });

  itIfFts5("uses content recency instead of compaction time for summary recency and time filters", async () => {
    const { db, conversationStore, summaryStore } = createStores();
    const retrieval = new RetrievalEngine(conversationStore, summaryStore);

    try {
      const conversation = await conversationStore.createConversation({
        sessionId: "summary-content-recency",
      });
      await summaryStore.insertSummary({
        summaryId: "sum_old_content_recent_compaction",
        conversationId: conversation.conversationId,
        kind: "leaf",
        depth: 0,
        content: "pagedrop launch notes pagedrop launch notes legacy request",
        tokenCount: 12,
        latestAt: new Date("2026-01-01T00:00:00.000Z"),
      });
      await summaryStore.insertSummary({
        summaryId: "sum_recent_content_older_compaction",
        conversationId: conversation.conversationId,
        kind: "leaf",
        depth: 0,
        content: "pagedrop launch notes current request details",
        tokenCount: 10,
        latestAt: new Date("2026-01-09T00:00:00.000Z"),
      });

      db.prepare("UPDATE summaries SET created_at = ? WHERE summary_id = ?").run(
        "2026-01-10T00:00:00.000Z",
        "sum_old_content_recent_compaction",
      );
      db.prepare("UPDATE summaries SET created_at = ? WHERE summary_id = ?").run(
        "2026-01-05T00:00:00.000Z",
        "sum_recent_content_older_compaction",
      );

      const recencyResult = await retrieval.grep({
        query: '"pagedrop launch notes"',
        mode: "full_text",
        scope: "summaries",
        conversationId: conversation.conversationId,
        limit: 2,
        sort: "recency",
      });
      const filteredResult = await retrieval.grep({
        query: '"pagedrop launch notes"',
        mode: "full_text",
        scope: "summaries",
        conversationId: conversation.conversationId,
        since: new Date("2026-01-05T00:00:00.000Z"),
        limit: 2,
        sort: "recency",
      });

      expect(recencyResult.summaries.map((summary) => summary.summaryId)).toEqual([
        "sum_recent_content_older_compaction",
        "sum_old_content_recent_compaction",
      ]);
      expect(recencyResult.summaries[0]?.createdAt.toISOString()).toBe("2026-01-09T00:00:00.000Z");
      expect(filteredResult.summaries.map((summary) => summary.summaryId)).toEqual([
        "sum_recent_content_older_compaction",
      ]);
    } finally {
      db.close();
    }
  });

  itIfTrigram("applies recency ordering to CJK trigram summary search", async () => {
    const { db, conversationStore, summaryStore } = createStores();

    try {
      const conversation = await conversationStore.createConversation({
        sessionId: "summary-cjk-content-recency",
      });
      await summaryStore.insertSummary({
        summaryId: "sum_cjk_old_content_recent_compaction",
        conversationId: conversation.conversationId,
        kind: "leaf",
        depth: 0,
        content: "端到端测试结果 端到端测试结果 端到端测试结果 旧记录",
        tokenCount: 12,
        latestAt: new Date("2026-01-01T00:00:00.000Z"),
      });
      await summaryStore.insertSummary({
        summaryId: "sum_cjk_recent_content_older_compaction",
        conversationId: conversation.conversationId,
        kind: "leaf",
        depth: 0,
        content: "最近的端到端测试结果",
        tokenCount: 6,
        latestAt: new Date("2026-01-09T00:00:00.000Z"),
      });

      db.prepare("UPDATE summaries SET created_at = ? WHERE summary_id = ?").run(
        "2026-01-10T00:00:00.000Z",
        "sum_cjk_old_content_recent_compaction",
      );
      db.prepare("UPDATE summaries SET created_at = ? WHERE summary_id = ?").run(
        "2026-01-05T00:00:00.000Z",
        "sum_cjk_recent_content_older_compaction",
      );

      const result = await summaryStore.searchSummaries({
        query: "端到端测试结果",
        mode: "full_text",
        conversationId: conversation.conversationId,
        limit: 2,
        sort: "recency",
      });

      expect(result.map((summary) => summary.summaryId)).toEqual([
        "sum_cjk_recent_content_older_compaction",
        "sum_cjk_old_content_recent_compaction",
      ]);
      expect(result[0]?.createdAt.toISOString()).toBe("2026-01-09T00:00:00.000Z");
    } finally {
      db.close();
    }
  });
});
