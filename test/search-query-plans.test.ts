import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeLcmConnection, getLcmConnection } from "../src/db/connection.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { ConversationStore, type MessageSearchInput } from "../src/store/conversation-store.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  closeLcmConnection();
});

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function seedDatabase(messageCount: number): Promise<{
  db: DatabaseSync;
  dbPath: string;
  fts5Available: boolean;
  conversationId: number;
}> {
  const dbPath = join(makeTempDir("lossless-claw-search-"), "lcm.db");
  const db = getLcmConnection(dbPath);
  const { fts5Available } = getLcmDbFeatures(db);
  runLcmMigrations(db, { fts5Available });
  const store = new ConversationStore(db, { fts5Available });
  const conversation = await store.createConversation({ sessionId: "search-session" });
  const base = Date.parse("2026-11-01T00:00:00Z");
  await store.createMessagesBulk(
    Array.from({ length: messageCount }, (_, index) => ({
      conversationId: conversation.conversationId,
      seq: index + 1,
      role: "tool" as const,
      content: index === 0
        ? "needle-oldest gateway stall evidence"
        : `routine gateway output ${index} ${"x".repeat(64)}`,
      tokenCount: 20,
      createdAt: new Date(base + index * 60_000),
    })),
  );
  return { db, dbPath, fts5Available, conversationId: conversation.conversationId };
}

/** Capture every SELECT a search prepares so its query plan can be checked. */
async function captureSelects(db: DatabaseSync, run: () => Promise<unknown>): Promise<string[]> {
  const statements: string[] = [];
  const originalPrepare = db.prepare.bind(db);
  (db as { prepare: DatabaseSync["prepare"] }).prepare = ((sql: string) => {
    if (/^\s*(WITH|SELECT)\b/i.test(sql)) {
      statements.push(sql);
    }
    return originalPrepare(sql);
  }) as DatabaseSync["prepare"];
  try {
    await run();
  } finally {
    (db as { prepare: DatabaseSync["prepare"] }).prepare = originalPrepare;
  }
  return statements;
}

function planFor(db: DatabaseSync, sql: string): string[] {
  const params = (sql.match(/\?/g) ?? []).map(() => 1);
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map(
    (row) => row.detail,
  );
}

describe("message search query plans", () => {
  const inputs: Array<[string, Omit<MessageSearchInput, "query"> & { query: string }]> = [
    ["regex across all conversations", { query: "needle-\\w+", mode: "regex" }],
    ["substring fallback (CJK) across all conversations", { query: "网关 gateway", mode: "full_text" }],
    ["full_text across all conversations", { query: "gateway", mode: "full_text" }],
    ["full_text relevance across all conversations", { query: "gateway", mode: "full_text", sort: "relevance" }],
  ];

  for (const [label, input] of inputs) {
    it(`never scans or sorts the messages table for ${label}`, async () => {
      const { db, fts5Available } = await seedDatabase(30);
      if (input.mode === "full_text" && input.query === "gateway" && !fts5Available) {
        return;
      }
      const store = new ConversationStore(db, { fts5Available });
      const statements = await captureSelects(db, () => store.searchMessages(input));
      const messageStatements = statements.filter((sql) => /\b(FROM|JOIN) messages\b/.test(sql));
      expect(messageStatements.length).toBeGreaterThan(0);
      for (const sql of messageStatements) {
        const plan = planFor(db, sql).join("\n");
        // No full table scan: rows are reached through an index.
        expect(plan, sql).not.toMatch(/^SCAN (messages|m)\b(?! USING)/m);
        // created_at sits after content in each row, so only an explicit
        // page of ids may be read back from the table itself.
        if (/USING INTEGER PRIMARY KEY/.test(plan)) {
          expect(sql).toMatch(/message_id IN \(\?/);
        }
        // Recency order comes from the created_at indexes, not a sort.
        if (!/\bORDER BY\b[^)]*\brank\b/.test(sql)) {
          expect(plan, sql).not.toMatch(/TEMP B-TREE FOR ORDER BY/);
        }
      }
    });
  }
});
