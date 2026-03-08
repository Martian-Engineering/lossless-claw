import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getLcmConnection, closeLcmConnection } from "../src/db/connection.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeLcmConnection();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("FTS fallback", () => {
  it("persists and searches messages and summaries without FTS5", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-no-fts-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "fallback.db");
    const db = getLcmConnection(dbPath);

    runLcmMigrations(db, { fts5Available: false });

    const conversationStore = new ConversationStore(db, { fts5Available: false });
    const summaryStore = new SummaryStore(db, { fts5Available: false });

    const conversation = await conversationStore.createConversation({
      sessionId: "fallback-session",
      title: "Fallback search",
    });

    const [userMessage, assistantMessage] = await conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "user",
        content: "We should use a database migration fallback when fts support is missing.",
        tokenCount: 16,
      },
      {
        conversationId: conversation.conversationId,
        seq: 2,
        role: "assistant",
        content: "Agreed. Keep full_text mode working via LIKE search.",
        tokenCount: 10,
      },
    ]);

    expect(userMessage.messageId).toBeGreaterThan(0);
    expect(assistantMessage.messageId).toBeGreaterThan(0);

    const summary = await summaryStore.insertSummary({
      summaryId: "sum_fallback",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Database migration fallback keeps search usable without fts support.",
      tokenCount: 12,
    });

    expect(summary.summaryId).toBe("sum_fallback");

    const messageResults = await conversationStore.searchMessages({
      query: "database migration",
      mode: "full_text",
      conversationId: conversation.conversationId,
      limit: 10,
    });
    expect(messageResults).toHaveLength(1);
    expect(messageResults[0]?.snippet.toLowerCase()).toContain("database migration");

    const summaryResults = await summaryStore.searchSummaries({
      query: "search usable",
      mode: "full_text",
      conversationId: conversation.conversationId,
      limit: 10,
    });
    expect(summaryResults).toHaveLength(1);
    expect(summaryResults[0]?.summaryId).toBe("sum_fallback");

    const deleted = await conversationStore.deleteMessages([assistantMessage.messageId]);
    expect(deleted).toBe(1);

    const ftsTables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts%'")
      .all() as Array<{ name: string }>;
    expect(ftsTables).toEqual([]);
  });
});
