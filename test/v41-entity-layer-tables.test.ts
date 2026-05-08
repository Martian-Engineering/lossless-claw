import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";

type ColumnInfo = { name: string; notnull: number; pk: number; dflt_value: string | null };
type FkInfo = { from: string; table: string; on_delete: string };
type IndexInfo = { name: string };

function setupDb(): { db: DatabaseSync; sumA: string; sumB: string } {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false });
  db.prepare(`INSERT INTO conversations (session_id) VALUES ('s')`).run();
  db.prepare(
    `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count) VALUES (?, 1, 'leaf', 'x', 1)`,
  ).run("sum_a");
  db.prepare(
    `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count) VALUES (?, 1, 'leaf', 'y', 1)`,
  ).run("sum_b");
  return { db, sumA: "sum_a", sumB: "sum_b" };
}

describe("lcm_entity_type_registry (v4.1 §7.2 + v4.1.1 §C)", () => {
  it("creates table with type_name PK + occurrence_count default 1", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    const cols = db.prepare("PRAGMA table_info(lcm_entity_type_registry)").all() as ColumnInfo[];
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get("type_name")?.pk).toBe(1);
    expect(byName.get("occurrence_count")?.dflt_value).toBe("1");
    db.close();
  });

  it("supports freeform Eva-domain types (no CHECK constraint)", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    const insert = db.prepare(`INSERT INTO lcm_entity_type_registry (type_name) VALUES (?)`);
    insert.run("session_key");
    insert.run("config_flag");
    insert.run("R-agent-id");
    insert.run("error_code");
    insert.run("pr");
    const types = db
      .prepare(`SELECT type_name FROM lcm_entity_type_registry ORDER BY type_name`)
      .all() as Array<{ type_name: string }>;
    expect(types.length).toBe(5);
    db.close();
  });
});

describe("lcm_entities (v4.1 §7.2 + v4.1.1 B4/B5/B6)", () => {
  it("creates table with simplified schema (alternate_surfaces JSON, no separate aliases table)", () => {
    const { db } = setupDb();
    const cols = db.prepare("PRAGMA table_info(lcm_entities)").all() as ColumnInfo[];
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get("entity_id")?.pk).toBe(1);
    expect(byName.get("canonical_text")?.notnull).toBe(1);
    expect(byName.get("entity_type")?.notnull).toBe(1);
    expect(byName.get("alternate_surfaces")).toBeDefined();
    db.close();
  });

  it("UNIQUE index on (session_key, canonical_text COLLATE NOCASE) enables case-insensitive single-flight (v4.1.1 B4)", () => {
    const { db } = setupDb();
    const insert = db.prepare(
      `INSERT OR IGNORE INTO lcm_entities (entity_id, session_key, canonical_text, entity_type, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
    );
    expect(insert.run("e1", "agent:main:main", "openclaw-gateway", "tool").changes).toBe(1);
    // Same canonical text different case → CONFLICT (NOCASE collation)
    expect(insert.run("e2", "agent:main:main", "OpenClaw-Gateway", "tool").changes).toBe(0);
    // Same canonical text different session → no conflict (different session_key)
    expect(insert.run("e3", "agent:other", "openclaw-gateway", "tool").changes).toBe(1);
    db.close();
  });

  it("supports ON DELETE SET NULL on first_seen_in_summary_id when source leaf deleted", () => {
    const { db, sumA } = setupDb();
    db.prepare(
      `INSERT INTO lcm_entities (entity_id, session_key, canonical_text, entity_type, first_seen_at, last_seen_at, first_seen_in_summary_id) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), ?)`,
    ).run("e1", "s", "x", "concept", sumA);

    db.prepare(`DELETE FROM summaries WHERE summary_id = ?`).run(sumA);
    const row = db
      .prepare(`SELECT first_seen_in_summary_id FROM lcm_entities WHERE entity_id = ?`)
      .get("e1") as { first_seen_in_summary_id: string | null };
    expect(row.first_seen_in_summary_id).toBeNull(); // SET NULL fired
    db.close();
  });
});

describe("lcm_entity_mentions (v4.1 §7.2)", () => {
  it("creates table with cascade-delete on both entity_id and summary_id", () => {
    const { db } = setupDb();
    const fks = db
      .prepare(`PRAGMA foreign_key_list(lcm_entity_mentions)`)
      .all() as FkInfo[];
    expect(fks.find((fk) => fk.from === "entity_id")?.on_delete).toBe("CASCADE");
    expect(fks.find((fk) => fk.from === "summary_id")?.on_delete).toBe("CASCADE");
    db.close();
  });

  it("deletes mentions when leaf is deleted (cascade — basis for v4.1.1 §C suppression cascade)", () => {
    const { db, sumA } = setupDb();
    db.prepare(
      `INSERT INTO lcm_entities (entity_id, session_key, canonical_text, entity_type, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`,
    ).run("e1", "s", "gateway", "tool");
    db.prepare(
      `INSERT INTO lcm_entity_mentions (mention_id, entity_id, summary_id, surface_form, mentioned_at) VALUES (?, ?, ?, ?, datetime('now'))`,
    ).run("m1", "e1", sumA, "the gateway");

    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM lcm_entity_mentions WHERE entity_id = ?`).get("e1") as {
        n: number;
      }).n,
    ).toBe(1);

    db.prepare(`DELETE FROM summaries WHERE summary_id = ?`).run(sumA);
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM lcm_entity_mentions WHERE entity_id = ?`).get("e1") as {
        n: number;
      }).n,
    ).toBe(0);
    db.close();
  });
});

// lcm_procedures tests REMOVED in first-principles pass (2026-05-06).
// Schema + tests preserved in deferred-features draft PR (#616).

// lcm_intentions tests REMOVED in first-principles pass (2026-05-06).
// Schema + tests preserved in deferred-features draft PR (#616).
