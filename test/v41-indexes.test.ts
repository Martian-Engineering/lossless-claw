import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";

type IndexInfo = { name: string; tbl_name: string; sql: string };

function getIndexNames(db: DatabaseSync, tableName: string): string[] {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = ?`)
    .all(tableName) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

describe("v4.1 summaries indexes (A.08)", () => {
  it("creates session_key + kind + latest_at index for retrieval", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    expect(getIndexNames(db, "summaries")).toContain("summaries_session_key_kind_latest_idx");
    db.close();
  });

  it("creates partial suppressed_at index (small footprint, fast filter)", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    const sql = db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type='index' AND name = 'summaries_suppressed_idx'`,
      )
      .get() as { sql: string };
    expect(sql.sql).toContain("WHERE suppressed_at IS NOT NULL");
    db.close();
  });

  it("creates partial contains_suppressed_leaves index for idle-rebuild candidate scan", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    const sql = db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type='index' AND name = 'summaries_contains_suppressed_idx'`,
      )
      .get() as { sql: string };
    expect(sql.sql).toContain("contains_suppressed_leaves = 1");
    expect(sql.sql).toContain("superseded_by IS NULL");
    db.close();
  });

  it("creates messages.suppressed_at partial index", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    expect(getIndexNames(db, "messages")).toContain("messages_suppressed_idx");
    db.close();
  });

  it("creates conversations.session_key index for v4.1 read patterns", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    expect(getIndexNames(db, "conversations")).toContain("conversations_session_key_v41_idx");
    db.close();
  });

  // Note: EXPLAIN QUERY PLAN testing was attempted here but removed — SQLite's
  // optimizer correctly picks full-table scan over index for tiny test
  // datasets (3 rows). Verifying actual index USE requires production-scale
  // data; verifying index PRESENCE is what these unit tests cover. End-to-end
  // verification on Eva's live DB copy in A.09's run-script handles the rest.

  it("is idempotent — re-running migration does not fail on existing indexes", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    expect(() => runLcmMigrations(db, { fts5Available: false })).not.toThrow();
    db.close();
  });
});
