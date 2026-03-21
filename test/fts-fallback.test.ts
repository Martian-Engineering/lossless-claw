import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLcmConnection, closeLcmConnection } from "../src/db/connection.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";

const tempDirs: string[] = [];
const itIfFts5 = detectFts5Support() ? it : it.skip;

function detectFts5Support(): boolean {
  const db = new DatabaseSync(":memory:");
  try {
    return getLcmDbFeatures(db).fts5Available;
  } finally {
    db.close();
  }
}

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

  itIfFts5("uses LIKE search for CJK queries even when FTS5 is available", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-cjk-fts-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "cjk.db");
    const db = getLcmConnection(dbPath);

    runLcmMigrations(db, { fts5Available: true });

    const conversationStore = new ConversationStore(db, { fts5Available: true });
    const summaryStore = new SummaryStore(db, { fts5Available: true });

    const conversation = await conversationStore.createConversation({
      sessionId: "cjk-session",
      title: "CJK search",
    });

    await conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "user",
        content: "这里讨论飞书播客和团队协作。",
        tokenCount: 10,
      },
      {
        conversationId: conversation.conversationId,
        seq: 2,
        role: "assistant",
        content: "英文内容 should not block 中文搜索。",
        tokenCount: 10,
      },
    ]);

    await summaryStore.insertSummary({
      summaryId: "sum_cjk",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "总结提到飞书播客和跨语言检索。",
      tokenCount: 12,
    });

    const messageResults = await conversationStore.searchMessages({
      query: "飞书播客",
      mode: "full_text",
      conversationId: conversation.conversationId,
      limit: 10,
    });
    expect(messageResults).toHaveLength(1);
    expect(messageResults[0]?.snippet).toContain("飞书播客");

    const summaryResults = await summaryStore.searchSummaries({
      query: "飞书播客",
      mode: "full_text",
      conversationId: conversation.conversationId,
      limit: 10,
    });
    expect(summaryResults).toHaveLength(1);
    expect(summaryResults[0]?.summaryId).toBe("sum_cjk");
  });

  it("bypasses FTS MATCH for CJK queries when full_text mode is requested", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-cjk-routing-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "routing.db");
    const db = getLcmConnection(dbPath);

    runLcmMigrations(db, { fts5Available: false });

    const conversationStore = new ConversationStore(db, { fts5Available: true });
    const summaryStore = new SummaryStore(db, { fts5Available: true });

    const messageLikeResult = [
      {
        messageId: 1,
        conversationId: 2,
        role: "user" as const,
        snippet: "飞书播客",
        createdAt: new Date("2026-03-21T00:00:00.000Z"),
        rank: 0,
      },
    ];
    const summaryLikeResult = [
      {
        summaryId: "sum_cjk",
        conversationId: 2,
        kind: "leaf" as const,
        snippet: "飞书播客",
        createdAt: new Date("2026-03-21T00:00:00.000Z"),
        rank: 0,
      },
    ];

    const messageFtsSpy = vi
      .spyOn(conversationStore as unknown as { searchFullText: (...args: unknown[]) => unknown[] }, "searchFullText")
      .mockReturnValue(messageLikeResult);
    const messageLikeSpy = vi
      .spyOn(conversationStore as unknown as { searchLike: (...args: unknown[]) => unknown[] }, "searchLike")
      .mockReturnValue(messageLikeResult);
    const summaryFtsSpy = vi
      .spyOn(summaryStore as unknown as { searchFullText: (...args: unknown[]) => unknown[] }, "searchFullText")
      .mockReturnValue(summaryLikeResult);
    const summaryLikeSpy = vi
      .spyOn(summaryStore as unknown as { searchLike: (...args: unknown[]) => unknown[] }, "searchLike")
      .mockReturnValue(summaryLikeResult);

    await expect(
      conversationStore.searchMessages({
        query: "飞书播客",
        mode: "full_text",
        conversationId: 2,
        limit: 10,
      }),
    ).resolves.toEqual(messageLikeResult);
    await expect(
      summaryStore.searchSummaries({
        query: "飞书播客",
        mode: "full_text",
        conversationId: 2,
        limit: 10,
      }),
    ).resolves.toEqual(summaryLikeResult);

    expect(messageLikeSpy).toHaveBeenCalledOnce();
    expect(summaryLikeSpy).toHaveBeenCalledOnce();
    expect(messageFtsSpy).not.toHaveBeenCalled();
    expect(summaryFtsSpy).not.toHaveBeenCalled();
  });
});
