import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";

describe("v4.1 conversation session_key backfill (A.09)", () => {
  it("backfills NULL session_keys to 'legacy:conv_<id>' AND writes audit rows", () => {
    const db = new DatabaseSync(":memory:");
    // Pre-populate conversations BEFORE running migrations (simulating
    // existing DB with legacy NULL session_keys)
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
    db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s1', NULL)`).run();
    db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s2', NULL)`).run();
    db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s3', 'agent:main:main')`).run();

    runLcmMigrations(db, { fts5Available: false });

    const rows = db
      .prepare(`SELECT conversation_id, session_key FROM conversations ORDER BY conversation_id`)
      .all() as Array<{ conversation_id: number; session_key: string }>;
    expect(rows[0]).toEqual({ conversation_id: 1, session_key: "legacy:conv_1" });
    expect(rows[1]).toEqual({ conversation_id: 2, session_key: "legacy:conv_2" });
    expect(rows[2]).toEqual({ conversation_id: 3, session_key: "agent:main:main" }); // unchanged

    // Audit rows recorded for the 2 backfilled
    const audits = db
      .prepare(`SELECT conversation_id, original_session_key, new_session_key FROM lcm_session_key_audit ORDER BY conversation_id`)
      .all() as Array<{ conversation_id: number; original_session_key: string | null; new_session_key: string }>;
    expect(audits).toEqual([
      { conversation_id: 1, original_session_key: null, new_session_key: "legacy:conv_1" },
      { conversation_id: 2, original_session_key: null, new_session_key: "legacy:conv_2" },
    ]);
    db.close();
  });

  it("is idempotent — re-running migration does not duplicate audit rows or re-key existing", () => {
    const db = new DatabaseSync(":memory:");
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
    db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s1', NULL)`).run();
    runLcmMigrations(db, { fts5Available: false });

    const auditCountAfterFirstRun = (
      db.prepare(`SELECT COUNT(*) AS n FROM lcm_session_key_audit`).get() as { n: number }
    ).n;

    // Re-run
    runLcmMigrations(db, { fts5Available: false });
    const auditCountAfterSecondRun = (
      db.prepare(`SELECT COUNT(*) AS n FROM lcm_session_key_audit`).get() as { n: number }
    ).n;
    expect(auditCountAfterSecondRun).toBe(auditCountAfterFirstRun);
    db.close();
  });
});

describe("v4.1 summaries session_key backfill (A.09)", () => {
  it("populates summaries.session_key from conversations.session_key via JOIN", () => {
    const db = new DatabaseSync(":memory:");
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
    db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s1', 'agent:main:main')`).run();
    db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s2', NULL)`).run(); // → legacy:conv_2

    runLcmMigrations(db, { fts5Available: false });

    // Now insert some summaries (they'll get session_key='' default from A.02)
    db.prepare(
      `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count) VALUES (?, ?, 'leaf', ?, 1)`,
    ).run("sum_a", 1, "x");
    db.prepare(
      `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count) VALUES (?, ?, 'leaf', ?, 1)`,
    ).run("sum_b", 2, "y");

    // Verify they have session_key='' before re-running migration
    const before = db
      .prepare(`SELECT summary_id, session_key FROM summaries ORDER BY summary_id`)
      .all() as Array<{ summary_id: string; session_key: string }>;
    expect(before[0].session_key).toBe(""); // A.02 default
    expect(before[1].session_key).toBe("");

    // Run migration again — should backfill summaries.session_key from conv
    runLcmMigrations(db, { fts5Available: false });

    const after = db
      .prepare(`SELECT summary_id, session_key FROM summaries ORDER BY summary_id`)
      .all() as Array<{ summary_id: string; session_key: string }>;
    expect(after[0].session_key).toBe("agent:main:main");
    expect(after[1].session_key).toBe("legacy:conv_2");
    db.close();
  });

  it("does NOT overwrite already-set summaries.session_key", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });

    db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s', 'conv-key-A')`).run();
    db.prepare(
      `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key) VALUES (?, ?, 'leaf', ?, 1, ?)`,
    ).run("sum_explicit", 1, "x", "summary-key-A-different-from-conv");

    runLcmMigrations(db, { fts5Available: false });

    const row = db
      .prepare(`SELECT session_key FROM summaries WHERE summary_id = ?`)
      .get("sum_explicit") as { session_key: string };
    // Backfill condition is `WHERE session_key = ''` — the explicit value
    // 'summary-key-A-different-from-conv' is preserved.
    expect(row.session_key).toBe("summary-key-A-different-from-conv");
    db.close();
  });
});

describe("v4.1 lcm_rollups forward-compat (A.09)", () => {
  it("no-op on a fresh upstream install (lcm_rollups table doesn't exist)", () => {
    const db = new DatabaseSync(":memory:");
    expect(() => runLcmMigrations(db, { fts5Available: false })).not.toThrow();
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = 'lcm_rollups'`)
      .all();
    expect(tables.length).toBe(0); // table never created
    db.close();
  });

  it("backfills lcm_rollups.session_key when the fork-side table exists with the column", () => {
    const db = new DatabaseSync(":memory:");
    // Simulate Eva's DB having lcm_rollups (from PR #516 work that's
    // not in upstream src but is on her live DB)
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
      CREATE TABLE lcm_rollups (
        rollup_id TEXT PRIMARY KEY,
        conversation_id INTEGER NOT NULL,
        session_key TEXT NOT NULL DEFAULT '',
        period_kind TEXT NOT NULL,
        period_key TEXT NOT NULL
      )
    `);
    db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s', 'conv-key-A')`).run();
    db.prepare(
      `INSERT INTO lcm_rollups (rollup_id, conversation_id, period_kind, period_key) VALUES (?, ?, ?, ?)`,
    ).run("r1", 1, "day", "2026-04-01");

    runLcmMigrations(db, { fts5Available: false });

    const row = db
      .prepare(`SELECT session_key FROM lcm_rollups WHERE rollup_id = ?`)
      .get("r1") as { session_key: string };
    expect(row.session_key).toBe("conv-key-A");
    db.close();
  });
});
