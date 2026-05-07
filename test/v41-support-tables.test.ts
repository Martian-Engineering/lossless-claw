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

type IndexInfo = { name: string };

describe("lcm_extraction_queue (v4.1.1 A3)", () => {
  it("creates the table with expected schema + indexes", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });

    const cols = db.prepare("PRAGMA table_info(lcm_extraction_queue)").all() as ColumnInfo[];
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get("queue_id")?.pk).toBe(1);
    expect(byName.get("queue_id")?.notnull).toBe(1);
    expect(byName.get("leaf_id")?.notnull).toBe(1);
    expect(byName.get("kind")?.notnull).toBe(1);
    expect(byName.get("attempts")?.notnull).toBe(1);
    expect(byName.get("attempts")?.dflt_value).toBe("0");

    const fks = db.prepare("PRAGMA foreign_key_list(lcm_extraction_queue)").all() as Array<{
      from: string;
      table: string;
      on_delete: string;
    }>;
    const leafFk = fks.find((fk) => fk.from === "leaf_id");
    expect(leafFk?.table).toBe("summaries");
    expect(leafFk?.on_delete).toBe("CASCADE");

    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='lcm_extraction_queue'`)
      .all() as IndexInfo[];
    expect(indexes.map((i) => i.name)).toContain("lcm_extraction_queue_pending_idx");
    expect(indexes.map((i) => i.name)).toContain("lcm_extraction_queue_dead_letter_idx");
    db.close();
  });

  it("rejects unknown kinds via CHECK constraint", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    // Need a real summary to satisfy FK
    db.prepare(`INSERT INTO conversations (session_id) VALUES ('s1')`).run();
    db.prepare(
      `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count) VALUES (?, 1, 'leaf', 'x', 1)`,
    ).run("sum_1");

    expect(() =>
      db.prepare(`INSERT INTO lcm_extraction_queue (queue_id, leaf_id, kind) VALUES (?, ?, ?)`).run(
        "q1",
        "sum_1",
        "bogus-kind",
      ),
    ).toThrow();

    // Real kinds work
    db.prepare(`INSERT INTO lcm_extraction_queue (queue_id, leaf_id, kind) VALUES (?, ?, ?)`).run(
      "q2",
      "sum_1",
      "entity",
    );
    db.prepare(`INSERT INTO lcm_extraction_queue (queue_id, leaf_id, kind) VALUES (?, ?, ?)`).run(
      "q3",
      "sum_1",
      "procedure-recheck",
    );

    db.close();
  });
});

describe("lcm_purge_rebuild_queue (v4.1.1 B2)", () => {
  it("creates the table with expected schema + indexes", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });

    const cols = db
      .prepare("PRAGMA table_info(lcm_purge_rebuild_queue)")
      .all() as ColumnInfo[];
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get("queue_id")?.pk).toBe(1);
    expect(byName.get("target_summary_id")?.notnull).toBe(1);
    expect(byName.get("purge_session_id")?.notnull).toBe(1);
    expect(byName.get("reason")?.notnull).toBe(1);

    const fks = db
      .prepare("PRAGMA foreign_key_list(lcm_purge_rebuild_queue)")
      .all() as Array<{ from: string; table: string; on_delete: string }>;
    expect(fks.find((fk) => fk.from === "target_summary_id")?.on_delete).toBe("CASCADE");

    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='lcm_purge_rebuild_queue'`,
      )
      .all() as IndexInfo[];
    expect(indexes.map((i) => i.name)).toContain("lcm_purge_rebuild_queue_pending_idx");
    expect(indexes.map((i) => i.name)).toContain("lcm_purge_rebuild_queue_session_idx");
    db.close();
  });
});

describe("lcm_voyage_rate_state (v4.1.1 B3)", () => {
  it("creates the table with seeded 'embed' and 'rerank' rows", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });

    const buckets = db
      .prepare(`SELECT bucket FROM lcm_voyage_rate_state ORDER BY bucket`)
      .all() as Array<{ bucket: string }>;
    expect(buckets.map((b) => b.bucket)).toEqual(["embed", "rerank"]);
  });

  it("rejects unknown buckets via CHECK constraint", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    expect(() =>
      db
        .prepare(`INSERT INTO lcm_voyage_rate_state (bucket) VALUES (?)`)
        .run("totally-bogus-bucket"),
    ).toThrow();
    db.close();
  });

  it("supports the brief-tx update pattern (UPDATE counters then COMMIT before HTTP call)", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });

    // Pattern from v4.1.1 B3: BEGIN IMMEDIATE → SELECT → UPDATE → COMMIT → make HTTP call
    db.exec("BEGIN IMMEDIATE");
    const before = db
      .prepare("SELECT tokens_consumed_window FROM lcm_voyage_rate_state WHERE bucket = ?")
      .get("embed") as { tokens_consumed_window: number };
    expect(before.tokens_consumed_window).toBe(0);
    db.prepare(
      `UPDATE lcm_voyage_rate_state SET tokens_consumed_window = tokens_consumed_window + ?, requests_consumed_window = requests_consumed_window + 1 WHERE bucket = ?`,
    ).run(50_000, "embed");
    db.exec("COMMIT");

    const after = db
      .prepare("SELECT * FROM lcm_voyage_rate_state WHERE bucket = ?")
      .get("embed") as { tokens_consumed_window: number; requests_consumed_window: number };
    expect(after.tokens_consumed_window).toBe(50_000);
    expect(after.requests_consumed_window).toBe(1);

    db.close();
  });

  it("idempotent seed (running migration twice does not duplicate rows)", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    runLcmMigrations(db, { fts5Available: false });
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM lcm_voyage_rate_state`)
      .get() as { n: number };
    expect(count.n).toBe(2); // still just 'embed' + 'rerank'
    db.close();
  });
});

describe("lcm_session_key_audit (v4.1.1 §C reversibility log)", () => {
  it("creates the audit table with FK + index", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    const cols = db.prepare("PRAGMA table_info(lcm_session_key_audit)").all() as ColumnInfo[];
    const byName = new Map(cols.map((c) => [c.name, c]));

    expect(byName.get("audit_id")?.pk).toBe(1);
    expect(byName.get("conversation_id")?.notnull).toBe(1);
    expect(byName.get("new_session_key")?.notnull).toBe(1);
    expect(byName.get("reason")?.notnull).toBe(1);
    expect(byName.get("applied_at")?.notnull).toBe(1);
    expect(byName.get("applied_by")?.notnull).toBe(1);
    expect(byName.get("original_session_key")?.notnull).toBe(0); // nullable; legacy convs had NULL

    const fks = db
      .prepare("PRAGMA foreign_key_list(lcm_session_key_audit)")
      .all() as Array<{ from: string; table: string; on_delete: string }>;
    expect(fks.find((fk) => fk.from === "conversation_id")?.on_delete).toBe("CASCADE");

    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='lcm_session_key_audit'`,
      )
      .all() as IndexInfo[];
    expect(indexes.map((i) => i.name)).toContain("lcm_session_key_audit_conv_idx");
    db.close();
  });

  it("supports recording a re-key with NULL original_session_key (legacy conv case)", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });

    db.prepare(`INSERT INTO conversations (session_id) VALUES ('s1')`).run();

    db.prepare(
      `INSERT INTO lcm_session_key_audit (audit_id, conversation_id, original_session_key, new_session_key, reason)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      "audit_1",
      1,
      null, // legacy conv had NULL session_key
      "agent:main:main",
      "v4.1 cleanup: legacy leaf-bearing conv re-keyed to true main thread",
    );

    const row = db
      .prepare("SELECT * FROM lcm_session_key_audit WHERE audit_id = ?")
      .get("audit_1") as {
      original_session_key: string | null;
      new_session_key: string;
      reason: string;
    };
    expect(row.original_session_key).toBeNull();
    expect(row.new_session_key).toBe("agent:main:main");
    expect(row.reason).toContain("legacy leaf-bearing");

    db.close();
  });
});
