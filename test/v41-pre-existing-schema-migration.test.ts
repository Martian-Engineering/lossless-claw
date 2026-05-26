import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";

/**
 * v4.1 B.fix — Gap 9: live-DB-shape regression test.
 *
 * All other v41-*.test.ts files start from a fresh `:memory:` and run the
 * full migration on an empty DB. This test instead seeds the upstream
 * pre-v4.1 schema by hand (conversations + summaries + messages with rows
 * but NO lcm_* tables yet) and runs the v4.1 migration against it. This
 * is the shape Eva's live DB had at the start of the v4.1 rollout.
 *
 * If this test ever fails, that's a SIGNAL — investigate before "fixing"
 * the test. The migration IS being live-DB-verified after each commit;
 * if a fresh-:memory:-with-pre-existing-data run breaks, something is
 * wrong with assumptions baked into the migration steps.
 */

/** v4.1 tables that the migration is expected to create. */
const EXPECTED_V41_TABLES = [
  "lcm_worker_lock",
  "lcm_extraction_queue",
  "lcm_session_key_audit",
  "lcm_prompt_registry",
  "lcm_synthesis_cache",
  "lcm_cache_leaf_refs",
  "lcm_synthesis_audit",
  "lcm_eval_query_set",
  "lcm_eval_query",
  "lcm_eval_run",
  "lcm_eval_drift",
  "lcm_entity_type_registry",
  "lcm_entities",
  "lcm_entity_mentions",
  "lcm_embedding_profile",
  "lcm_embedding_meta",
  "lcm_feature_flags",
] as const;

function seedUpstreamPreV41Schema(db: DatabaseSync): void {
  // Upstream pre-v4.1 baseline shape (the schema Eva's live DB had right
  // before v4.1 column additions). This must match the CREATE TABLE
  // statements at the top of runLcmMigrations — those are themselves
  // CREATE TABLE IF NOT EXISTS, so the migration accepts any DB whose
  // baseline matches this shape and proceeds to layer v4.1 changes onto it.
  db.exec(`
    CREATE TABLE conversations (
      conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      session_key TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      archived_at TEXT,
      title TEXT,
      bootstrapped_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    CREATE TABLE messages (
      message_id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      identity_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (conversation_id, seq)
    )
  `);
  db.exec(`
    CREATE TABLE summaries (
      summary_id TEXT PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('leaf', 'condensed')),
      depth INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      earliest_at TEXT,
      latest_at TEXT,
      descendant_count INTEGER NOT NULL DEFAULT 0,
      descendant_token_count INTEGER NOT NULL DEFAULT 0,
      source_message_token_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      file_ids TEXT NOT NULL DEFAULT '[]'
    )
  `);
}

function listTableNames(db: DatabaseSync): Set<string> {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
    .all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

describe("v4.1 migration against a partially pre-existing schema (B.fix Gap 9)", () => {
  it("runs end-to-end without throwing and produces the expected DB shape", () => {
    const db = new DatabaseSync(":memory:");
    seedUpstreamPreV41Schema(db);

    // 3 conversations: 2 with NULL session_key (should be backfilled), 1 set.
    db.prepare(
      `INSERT INTO conversations (session_id, session_key) VALUES (?, NULL)`,
    ).run("s_null_a");
    db.prepare(
      `INSERT INTO conversations (session_id, session_key) VALUES (?, NULL)`,
    ).run("s_null_b");
    db.prepare(
      `INSERT INTO conversations (session_id, session_key) VALUES (?, ?)`,
    ).run("s_set", "agent:main:main");

    // Summaries pointing into the conversations.
    db.prepare(
      `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count) VALUES (?, ?, ?, ?, ?)`,
    ).run("sum_a", 1, "leaf", "x", 1);
    db.prepare(
      `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count) VALUES (?, ?, ?, ?, ?)`,
    ).run("sum_b", 2, "leaf", "y", 1);
    db.prepare(
      `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count) VALUES (?, ?, ?, ?, ?)`,
    ).run("sum_c", 3, "leaf", "z", 1);

    // Run the v4.1 migration — must not throw.
    expect(() => runLcmMigrations(db, { fts5Available: false })).not.toThrow();

    // ── Conversations: NULL session_keys were backfilled to legacy:conv_<id>
    const convs = db
      .prepare(
        `SELECT conversation_id, session_key FROM conversations ORDER BY conversation_id`,
      )
      .all() as Array<{ conversation_id: number; session_key: string }>;
    for (const c of convs) {
      expect(c.session_key).not.toBeNull();
      expect(typeof c.session_key).toBe("string");
      expect(c.session_key.length).toBeGreaterThan(0);
    }
    expect(convs[0].session_key).toBe("legacy:conv_1");
    expect(convs[1].session_key).toBe("legacy:conv_2");
    expect(convs[2].session_key).toBe("agent:main:main");

    // ── Audit rows for the NULL-backfilled conversations
    const audits = db
      .prepare(
        `SELECT conversation_id, original_session_key, new_session_key
         FROM lcm_session_key_audit ORDER BY conversation_id`,
      )
      .all() as Array<{
      conversation_id: number;
      original_session_key: string | null;
      new_session_key: string;
    }>;
    expect(audits).toEqual([
      { conversation_id: 1, original_session_key: null, new_session_key: "legacy:conv_1" },
      { conversation_id: 2, original_session_key: null, new_session_key: "legacy:conv_2" },
    ]);

    // ── Summaries.session_key populated via the JOIN backfill
    const sums = db
      .prepare(`SELECT summary_id, session_key FROM summaries ORDER BY summary_id`)
      .all() as Array<{ summary_id: string; session_key: string }>;
    for (const s of sums) {
      expect(typeof s.session_key).toBe("string");
      expect(s.session_key.length).toBeGreaterThan(0);
    }
    expect(sums.find((s) => s.summary_id === "sum_a")?.session_key).toBe("legacy:conv_1");
    expect(sums.find((s) => s.summary_id === "sum_b")?.session_key).toBe("legacy:conv_2");
    expect(sums.find((s) => s.summary_id === "sum_c")?.session_key).toBe("agent:main:main");

    // ── All v4.1 tables present in sqlite_master
    const tables = listTableNames(db);
    for (const expected of EXPECTED_V41_TABLES) {
      expect(tables.has(expected), `table ${expected} should exist after migration`).toBe(true);
    }

    // ── Gap 2 fix is in place: lcm_prompt_registry_uniq_lookup index exists
    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type='index' AND tbl_name='lcm_prompt_registry'`,
      )
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain("lcm_prompt_registry_uniq_lookup");

    db.close();
  });

  it("re-running migration is idempotent (no row count changes, no errors)", () => {
    const db = new DatabaseSync(":memory:");
    seedUpstreamPreV41Schema(db);

    db.prepare(
      `INSERT INTO conversations (session_id, session_key) VALUES (?, NULL)`,
    ).run("s_null_a");
    db.prepare(
      `INSERT INTO conversations (session_id, session_key) VALUES (?, ?)`,
    ).run("s_set", "agent:main:main");
    db.prepare(
      `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count) VALUES (?, ?, ?, ?, ?)`,
    ).run("sum_a", 1, "leaf", "x", 1);
    db.prepare(
      `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count) VALUES (?, ?, ?, ?, ?)`,
    ).run("sum_b", 2, "leaf", "y", 1);

    runLcmMigrations(db, { fts5Available: false });

    // Snapshot the row counts of every user-visible table after first run
    const tableNames = [...listTableNames(db)].filter((n) => !n.startsWith("sqlite_"));
    const countsAfterFirst = new Map<string, number>();
    for (const t of tableNames) {
      const n = (
        db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }
      ).n;
      countsAfterFirst.set(t, n);
    }

    // Re-run migration — must not throw and must not change row counts
    expect(() => runLcmMigrations(db, { fts5Available: false })).not.toThrow();

    for (const t of tableNames) {
      const n = (
        db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }
      ).n;
      expect(n, `table ${t} row count should be stable across re-runs`).toBe(
        countsAfterFirst.get(t),
      );
    }

    db.close();
  });
});
