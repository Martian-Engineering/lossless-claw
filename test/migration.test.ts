import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeLcmConnection, getLcmConnection } from "./connection.js";
import { runLcmMigrations } from "./migration.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeLcmConnection();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("runLcmMigrations summary depth backfill", () => {
  it("adds depth and computes condensed depth from summary parent lineage", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-lcm-migration-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "legacy.db");
    const db = getLcmConnection(dbPath);

    db.exec(`
      CREATE TABLE conversations (
        conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE summaries (
        summary_id TEXT PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('leaf', 'condensed')),
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        file_ids TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE summary_parents (
        summary_id TEXT NOT NULL REFERENCES summaries(summary_id) ON DELETE CASCADE,
        parent_summary_id TEXT NOT NULL REFERENCES summaries(summary_id) ON DELETE RESTRICT,
        ordinal INTEGER NOT NULL,
        PRIMARY KEY (summary_id, parent_summary_id)
      );
    `);

    db.prepare(`INSERT INTO conversations (conversation_id, session_id) VALUES (?, ?)`).run(
      1,
      "legacy-session",
    );

    const insertSummaryStmt = db.prepare(
      `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, file_ids)
       VALUES (?, ?, ?, ?, ?, '[]')`,
    );
    insertSummaryStmt.run("sum_leaf_a", 1, "leaf", "leaf-a", 10);
    insertSummaryStmt.run("sum_leaf_b", 1, "leaf", "leaf-b", 10);
    insertSummaryStmt.run("sum_condensed_1", 1, "condensed", "condensed-1", 10);
    insertSummaryStmt.run("sum_condensed_2", 1, "condensed", "condensed-2", 10);
    insertSummaryStmt.run("sum_condensed_orphan", 1, "condensed", "condensed-orphan", 10);

    const linkStmt = db.prepare(
      `INSERT INTO summary_parents (summary_id, parent_summary_id, ordinal)
       VALUES (?, ?, ?)`,
    );
    linkStmt.run("sum_condensed_1", "sum_leaf_a", 0);
    linkStmt.run("sum_condensed_1", "sum_leaf_b", 1);
    linkStmt.run("sum_condensed_2", "sum_condensed_1", 0);

    runLcmMigrations(db);

    const summaryColumns = db.prepare(`PRAGMA table_info(summaries)`).all() as Array<{
      name?: string;
    }>;
    expect(summaryColumns.some((column) => column.name === "depth")).toBe(true);

    const depthRows = db
      .prepare(
        `SELECT summary_id, depth
         FROM summaries
         ORDER BY summary_id`,
      )
      .all() as Array<{ summary_id: string; depth: number }>;
    const depthBySummaryId = new Map(depthRows.map((row) => [row.summary_id, row.depth]));

    expect(depthBySummaryId.get("sum_leaf_a")).toBe(0);
    expect(depthBySummaryId.get("sum_leaf_b")).toBe(0);
    expect(depthBySummaryId.get("sum_condensed_1")).toBe(1);
    expect(depthBySummaryId.get("sum_condensed_2")).toBe(2);
    expect(depthBySummaryId.get("sum_condensed_orphan")).toBe(1);
  });
});
