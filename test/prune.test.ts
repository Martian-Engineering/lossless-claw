import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { createLcmDatabaseConnection, closeLcmConnection } from "../src/db/connection.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import { parseDuration, pruneConversations } from "../src/prune.js";

function createPruneFixture() {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-prune-"));
  const dbPath = join(tempDir, "lcm.db");
  const db = createLcmDatabaseConnection(dbPath);
  const { fts5Available } = getLcmDbFeatures(db);
  runLcmMigrations(db, { fts5Available });
  const conversationStore = new ConversationStore(db, { fts5Available });
  return { tempDir, dbPath, db, conversationStore };
}

describe("parseDuration", () => {
  it("parses day durations", () => {
    expect(parseDuration("90d")).toBe(90);
    expect(parseDuration("30days")).toBe(30);
    expect(parseDuration("1day")).toBe(1);
  });

  it("parses week durations", () => {
    expect(parseDuration("2w")).toBe(14);
    expect(parseDuration("1week")).toBe(7);
    expect(parseDuration("4weeks")).toBe(28);
  });

  it("parses month durations", () => {
    expect(parseDuration("3m")).toBe(90);
    expect(parseDuration("1month")).toBe(30);
    expect(parseDuration("6months")).toBe(180);
  });

  it("parses year durations", () => {
    expect(parseDuration("1y")).toBe(365);
    expect(parseDuration("2years")).toBe(730);
  });

  it("returns null for invalid input", () => {
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("abc")).toBeNull();
    expect(parseDuration("0d")).toBeNull();
    expect(parseDuration("-5d")).toBeNull();
    expect(parseDuration("90")).toBeNull();
  });

  it("is case insensitive", () => {
    expect(parseDuration("90D")).toBe(90);
    expect(parseDuration("3M")).toBe(90);
    expect(parseDuration("1Y")).toBe(365);
  });
});

describe("pruneConversations", () => {
  const tempDirs = new Set<string>();
  const dbPaths = new Set<string>();

  afterEach(() => {
    for (const dbPath of dbPaths) {
      closeLcmConnection(dbPath);
    }
    dbPaths.clear();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  function seedConversation(
    fixture: ReturnType<typeof createPruneFixture>,
    opts: { sessionId: string; sessionKey?: string; messageCreatedAt: string; conversationCreatedAt?: string },
  ) {
    const convCreatedAt = opts.conversationCreatedAt ?? opts.messageCreatedAt;
    // Insert conversation directly for precise timestamp control.
    fixture.db
      .prepare(
        `INSERT INTO conversations (session_id, session_key, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(opts.sessionId, opts.sessionKey ?? null, convCreatedAt, convCreatedAt);

    const convRow = fixture.db
      .prepare(`SELECT conversation_id FROM conversations WHERE session_id = ? ORDER BY conversation_id DESC LIMIT 1`)
      .get(opts.sessionId) as { conversation_id: number };

    fixture.db
      .prepare(
        `INSERT INTO messages (conversation_id, seq, role, content, token_count, created_at)
         VALUES (?, 1, 'user', 'hello', 5, ?)`,
      )
      .run(convRow.conversation_id, opts.messageCreatedAt);

    return convRow.conversation_id;
  }

  async function seedConversationWithSummary(
    fixture: ReturnType<typeof createPruneFixture>,
    opts: { sessionId: string; messageCreatedAt: string },
  ) {
    const conversationId = seedConversation(fixture, opts);
    const summaryStore = new SummaryStore(fixture.db, {
      fts5Available: getLcmDbFeatures(fixture.db).fts5Available,
    });
    const messageRow = fixture.db
      .prepare(`SELECT message_id FROM messages WHERE conversation_id = ? LIMIT 1`)
      .get(conversationId) as { message_id: number };

    await summaryStore.insertSummary({
      summaryId: `summary-${conversationId}`,
      conversationId,
      kind: "leaf",
      depth: 0,
      content: "prunable summary",
      tokenCount: 7,
      fileIds: [],
      earliestAt: new Date(opts.messageCreatedAt.replace(" ", "T") + "Z"),
      latestAt: new Date(opts.messageCreatedAt.replace(" ", "T") + "Z"),
      descendantCount: 1,
      descendantTokenCount: 5,
      sourceMessageTokenCount: 5,
      model: "test",
    });
    await summaryStore.linkSummaryToMessages(`summary-${conversationId}`, [messageRow.message_id]);
    fixture.db
      .prepare(
        `INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id)
         VALUES (?, 1, 'summary', ?)`,
      )
      .run(conversationId, `summary-${conversationId}`);
    return conversationId;
  }

  it("returns empty candidates when no conversations exist", () => {
    const fixture = createPruneFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const result = pruneConversations(fixture.db, {
      before: "90d",
      now: "2025-06-01T00:00:00.000Z",
    });

    expect(result.candidates).toHaveLength(0);
    expect(result.deleted).toBe(0);
    expect(result.vacuumed).toBe(false);
  });

  it("identifies old conversations as candidates in dry-run mode", () => {
    const fixture = createPruneFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    // Old conversation - 120 days ago
    seedConversation(fixture, {
      sessionId: "old-session",
      sessionKey: "old-key",
      messageCreatedAt: "2025-02-01T00:00:00.000Z",
    });

    // Recent conversation - 10 days ago
    seedConversation(fixture, {
      sessionId: "new-session",
      sessionKey: "new-key",
      messageCreatedAt: "2025-05-22T00:00:00.000Z",
    });

    const result = pruneConversations(fixture.db, {
      before: "90d",
      now: "2025-06-01T00:00:00.000Z",
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.sessionKey).toBe("old-key");
    expect(result.candidates[0]!.messageCount).toBe(1);
    // Dry-run: nothing deleted
    expect(result.deleted).toBe(0);

    // Verify conversation still exists
    const remaining = fixture.db
      .prepare(`SELECT COUNT(*) AS cnt FROM conversations`)
      .get() as { cnt: number };
    expect(remaining.cnt).toBe(2);
  });

  it("compares SQLite and ISO timestamps chronologically instead of lexically", () => {
    const fixture = createPruneFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    // SQLite defaults to "YYYY-MM-DD HH:MM:SS". This timestamp is newer than
    // the cutoff even though it sorts before an ISO string lexically.
    seedConversation(fixture, {
      sessionId: "same-day-sqlite-format",
      sessionKey: "same-day-sqlite-format",
      messageCreatedAt: "2025-03-03 23:59:59",
    });

    const result = pruneConversations(fixture.db, {
      before: "90d",
      now: "2025-06-01T00:00:00.000Z",
    });

    expect(result.candidates).toHaveLength(0);
  });

  it("deletes conversations when confirm is true", () => {
    const fixture = createPruneFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    seedConversation(fixture, {
      sessionId: "old-session",
      sessionKey: "old-key",
      messageCreatedAt: "2025-02-01T00:00:00.000Z",
    });

    seedConversation(fixture, {
      sessionId: "new-session",
      sessionKey: "new-key",
      messageCreatedAt: "2025-05-22T00:00:00.000Z",
    });

    const result = pruneConversations(fixture.db, {
      before: "90d",
      confirm: true,
      now: "2025-06-01T00:00:00.000Z",
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.deleted).toBe(1);

    // Verify cascade: conversation and its messages are gone
    const remaining = fixture.db
      .prepare(`SELECT COUNT(*) AS cnt FROM conversations`)
      .get() as { cnt: number };
    expect(remaining.cnt).toBe(1);

    const messages = fixture.db
      .prepare(`SELECT COUNT(*) AS cnt FROM messages`)
      .get() as { cnt: number };
    expect(messages.cnt).toBe(1);
  });

  it("deletes eligible conversations across multiple batches", () => {
    const fixture = createPruneFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    for (let index = 0; index < 5; index += 1) {
      seedConversation(fixture, {
        sessionId: `old-batch-${index}`,
        sessionKey: `old-batch-${index}`,
        messageCreatedAt: `2025-02-0${index + 1}T00:00:00.000Z`,
      });
    }

    const result = pruneConversations(fixture.db, {
      before: "90d",
      confirm: true,
      batchSize: 2,
      now: "2025-06-01T00:00:00.000Z",
    });

    expect(result.deleted).toBe(5);
    expect(result.candidates).toHaveLength(5);
    expect(
      fixture.db.prepare(`SELECT COUNT(*) AS cnt FROM conversations`).get() as { cnt: number },
    ).toEqual({ cnt: 0 });
  });

  it("can stop after a bounded number of batches", () => {
    const fixture = createPruneFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    for (let index = 0; index < 5; index += 1) {
      seedConversation(fixture, {
        sessionId: `old-cap-${index}`,
        sessionKey: `old-cap-${index}`,
        messageCreatedAt: `2025-02-1${index}T00:00:00.000Z`,
      });
    }

    const result = pruneConversations(fixture.db, {
      before: "90d",
      confirm: true,
      batchSize: 2,
      maxBatches: 1,
      now: "2025-06-01T00:00:00.000Z",
    });

    expect(result.deleted).toBe(2);
    expect(result.candidates).toHaveLength(2);
    expect(
      fixture.db.prepare(`SELECT COUNT(*) AS cnt FROM conversations`).get() as { cnt: number },
    ).toEqual({ cnt: 3 });
  });

  it("deletes conversations with summary lineage and context items", async () => {
    const fixture = createPruneFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const conversationId = await seedConversationWithSummary(fixture, {
      sessionId: "old-with-summary",
      messageCreatedAt: "2025-02-01 00:00:00",
    });

    const result = pruneConversations(fixture.db, {
      before: "90d",
      confirm: true,
      now: "2025-06-01T00:00:00.000Z",
    });

    expect(result.deleted).toBe(1);
    expect(
      fixture.db
        .prepare(`SELECT COUNT(*) AS cnt FROM conversations WHERE conversation_id = ?`)
        .get(conversationId) as { cnt: number },
    ).toEqual({ cnt: 0 });
    expect(
      fixture.db
        .prepare(`SELECT COUNT(*) AS cnt FROM summaries WHERE conversation_id = ?`)
        .get(conversationId) as { cnt: number },
    ).toEqual({ cnt: 0 });
    expect(
      fixture.db
        .prepare(`SELECT COUNT(*) AS cnt FROM summary_messages`)
        .get() as { cnt: number },
    ).toEqual({ cnt: 0 });
    expect(
      fixture.db
        .prepare(`SELECT COUNT(*) AS cnt FROM context_items WHERE conversation_id = ?`)
        .get(conversationId) as { cnt: number },
    ).toEqual({ cnt: 0 });
  });

  it("deletes retained conversation context that points at pruned summaries", async () => {
    const fixture = createPruneFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const prunedConversationId = await seedConversationWithSummary(fixture, {
      sessionId: "old-with-exported-summary",
      messageCreatedAt: "2025-02-01 00:00:00",
    });
    const retainedConversationId = seedConversation(fixture, {
      sessionId: "recent-consumer",
      messageCreatedAt: "2025-05-25T00:00:00.000Z",
    });
    const summaryStore = new SummaryStore(fixture.db, {
      fts5Available: getLcmDbFeatures(fixture.db).fts5Available,
    });
    await summaryStore.appendContextSummary(retainedConversationId, `summary-${prunedConversationId}`);

    const result = pruneConversations(fixture.db, {
      before: "90d",
      confirm: true,
      batchSize: 10,
      now: "2025-06-01T00:00:00.000Z",
    });

    expect(result.deleted).toBe(1);
    expect(
      fixture.db
        .prepare(`SELECT COUNT(*) AS cnt FROM conversations WHERE conversation_id = ?`)
        .get(retainedConversationId) as { cnt: number },
    ).toEqual({ cnt: 1 });
    expect(
      fixture.db
        .prepare(`SELECT COUNT(*) AS cnt FROM context_items WHERE conversation_id = ?`)
        .get(retainedConversationId) as { cnt: number },
    ).toEqual({ cnt: 0 });
  });

  it("runs VACUUM when vacuum option is set", () => {
    const fixture = createPruneFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    seedConversation(fixture, {
      sessionId: "old-session",
      messageCreatedAt: "2025-02-01T00:00:00.000Z",
    });

    const result = pruneConversations(fixture.db, {
      before: "90d",
      confirm: true,
      vacuum: true,
      now: "2025-06-01T00:00:00.000Z",
    });

    expect(result.deleted).toBe(1);
    expect(result.vacuumed).toBe(true);
    expect(
      fixture.db.prepare(`PRAGMA wal_checkpoint(PASSIVE)`).get() as {
        busy: number;
        log: number;
        checkpointed: number;
      },
    ).toEqual({
      busy: 0,
      log: 0,
      checkpointed: 0,
    });
  });

  it("treats conversations with no messages as candidates based on created_at", () => {
    const fixture = createPruneFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    // Insert a conversation with no messages, old created_at
    fixture.db
      .prepare(
        `INSERT INTO conversations (session_id, created_at, updated_at)
         VALUES (?, ?, ?)`,
      )
      .run("empty-old", "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");

    const result = pruneConversations(fixture.db, {
      before: "90d",
      now: "2025-06-01T00:00:00.000Z",
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.messageCount).toBe(0);
  });

  it("throws on invalid duration", () => {
    const fixture = createPruneFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    expect(() =>
      pruneConversations(fixture.db, { before: "invalid" }),
    ).toThrow(/Invalid duration/);
  });

  it("includes cutoffDate in result", () => {
    const fixture = createPruneFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const result = pruneConversations(fixture.db, {
      before: "90d",
      now: "2025-06-01T00:00:00.000Z",
    });

    // 90 days before June 1 is March 3
    expect(result.cutoffDate).toContain("2025-03-03");
  });
});
