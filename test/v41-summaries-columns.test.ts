import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";

type ColumnInfo = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

describe("v4.1 summaries column additions (v3.1 A1/A3 + v4.1.1 A2)", () => {
  it("adds session_key with NOT NULL DEFAULT '' (v3.1 A1)", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    const cols = db.prepare("PRAGMA table_info(summaries)").all() as ColumnInfo[];
    const sk = cols.find((c) => c.name === "session_key");
    expect(sk).toBeDefined();
    expect(sk?.notnull).toBe(1);
    expect(sk?.dflt_value).toBe("''");
    db.close();
  });

  it("adds suppressed_at as nullable TEXT (v3.1 A3)", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    const cols = db.prepare("PRAGMA table_info(summaries)").all() as ColumnInfo[];
    const sa = cols.find((c) => c.name === "suppressed_at");
    expect(sa).toBeDefined();
    expect(sa?.notnull).toBe(0);
    db.close();
  });

  it("adds entity_index as nullable TEXT (v3.1)", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    const cols = db.prepare("PRAGMA table_info(summaries)").all() as ColumnInfo[];
    const ei = cols.find((c) => c.name === "entity_index");
    expect(ei).toBeDefined();
    expect(ei?.notnull).toBe(0);
    db.close();
  });

  it("adds contains_suppressed_leaves with NOT NULL DEFAULT 0 (v3.1 A3)", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    const cols = db.prepare("PRAGMA table_info(summaries)").all() as ColumnInfo[];
    const csl = cols.find((c) => c.name === "contains_suppressed_leaves");
    expect(csl).toBeDefined();
    expect(csl?.notnull).toBe(1);
    expect(csl?.dflt_value).toBe("0");
    db.close();
  });

  it("adds suppress_reason as nullable TEXT (v4.1.1 A2)", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    const cols = db.prepare("PRAGMA table_info(summaries)").all() as ColumnInfo[];
    const sr = cols.find((c) => c.name === "suppress_reason");
    expect(sr).toBeDefined();
    expect(sr?.notnull).toBe(0);
    db.close();
  });

  it("adds superseded_by as FK to summaries(summary_id) ON DELETE SET NULL (v4.1.1 A2/A4)", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    const cols = db.prepare("PRAGMA table_info(summaries)").all() as ColumnInfo[];
    const sb = cols.find((c) => c.name === "superseded_by");
    expect(sb).toBeDefined();
    expect(sb?.notnull).toBe(0); // nullable per SQLite ADD COLUMN+FK rule

    // Verify the FK is actually declared
    const fks = db.prepare("PRAGMA foreign_key_list(summaries)").all() as Array<{
      from: string;
      to: string;
      table: string;
      on_delete: string;
    }>;
    const sbFk = fks.find((fk) => fk.from === "superseded_by");
    expect(sbFk).toBeDefined();
    expect(sbFk?.table).toBe("summaries");
    expect(sbFk?.to).toBe("summary_id");
    expect(sbFk?.on_delete).toBe("SET NULL");
    db.close();
  });

  it("adds leaf_summarizer_cap_was as nullable INTEGER (v4.1)", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    const cols = db.prepare("PRAGMA table_info(summaries)").all() as ColumnInfo[];
    const lcw = cols.find((c) => c.name === "leaf_summarizer_cap_was");
    expect(lcw).toBeDefined();
    expect(lcw?.notnull).toBe(0);
    db.close();
  });

  it("is idempotent — running migrations twice does not fail", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    expect(() => runLcmMigrations(db, { fts5Available: false })).not.toThrow();
    db.close();
  });

  // Forward-compat upgrade test (against a partial pre-existing schema) is
  // deferred to Group A.10 — that step covers the full live-DB-shaped
  // verification including all v3-era tables and indexes that the migration
  // assumes are present.
});

describe("messages.suppressed_at column (v3.1 A3 extension)", () => {
  it("adds suppressed_at to messages table", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    const cols = db.prepare("PRAGMA table_info(messages)").all() as ColumnInfo[];
    const sa = cols.find((c) => c.name === "suppressed_at");
    expect(sa).toBeDefined();
    expect(sa?.notnull).toBe(0);
    db.close();
  });
});

describe("lcm_feature_flags table (v4.1.1 A8 — clean new table)", () => {
  it("creates lcm_feature_flags with (flag PK, value NOT NULL, updated_at NOT NULL)", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    const cols = db.prepare("PRAGMA table_info(lcm_feature_flags)").all() as ColumnInfo[];
    const byName = new Map(cols.map((c) => [c.name, c]));

    expect(byName.get("flag")?.pk).toBe(1);
    expect(byName.get("flag")?.notnull).toBe(1); // PRIMARY KEY → NOT NULL
    expect(byName.get("value")?.notnull).toBe(1);
    expect(byName.get("updated_at")?.notnull).toBe(1);
    db.close();
  });

  it("supports basic feature-flag pattern (set + read)", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });

    db.prepare(
      `INSERT INTO lcm_feature_flags (flag, value) VALUES (?, ?)`,
    ).run("v4_section_1_enabled", "true");

    const row = db
      .prepare(`SELECT value FROM lcm_feature_flags WHERE flag = ?`)
      .get("v4_section_1_enabled") as { value: string } | undefined;
    expect(row?.value).toBe("true");

    // Update flips value
    db.prepare(
      `UPDATE lcm_feature_flags SET value = ?, updated_at = datetime('now') WHERE flag = ?`,
    ).run("false", "v4_section_1_enabled");
    const row2 = db
      .prepare(`SELECT value FROM lcm_feature_flags WHERE flag = ?`)
      .get("v4_section_1_enabled") as { value: string } | undefined;
    expect(row2?.value).toBe("false");

    db.close();
  });

  it("does NOT collide with Eva's legacy lcm_migration_flags table (separate concern)", () => {
    const db = new DatabaseSync(":memory:");
    // Pre-create the legacy table (simulating Eva's live DB shape)
    db.exec(`
      CREATE TABLE lcm_migration_flags (
        flag TEXT PRIMARY KEY,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.prepare(`INSERT INTO lcm_migration_flags (flag) VALUES (?)`).run(
      "tool-call-columns-backfilled-v1",
    );

    runLcmMigrations(db, { fts5Available: false });

    // Both tables should coexist
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('lcm_migration_flags', 'lcm_feature_flags')`,
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name).sort()).toEqual([
      "lcm_feature_flags",
      "lcm_migration_flags",
    ]);

    // Legacy table content untouched
    const legacy = db
      .prepare(`SELECT flag FROM lcm_migration_flags`)
      .all() as Array<{ flag: string }>;
    expect(legacy.map((r) => r.flag)).toContain("tool-call-columns-backfilled-v1");
    db.close();
  });
});
