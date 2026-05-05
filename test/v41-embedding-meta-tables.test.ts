import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";

type ColumnInfo = { name: string; notnull: number; pk: number; dflt_value: string | null };
type FkInfo = { from: string; table: string; on_delete: string };

describe("lcm_embedding_profile (v4.1 §1)", () => {
  it("creates table with model_name PK + active default 1", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    const cols = db.prepare("PRAGMA table_info(lcm_embedding_profile)").all() as ColumnInfo[];
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get("model_name")?.pk).toBe(1);
    expect(byName.get("dim")?.notnull).toBe(1);
    expect(byName.get("active")?.dflt_value).toBe("1");
    db.close();
  });

  it("supports registering voyage-4-large + future model in parallel for cutover", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    const ins = db.prepare(
      `INSERT INTO lcm_embedding_profile (model_name, dim, active) VALUES (?, ?, ?)`,
    );
    ins.run("voyage-4-large", 1024, 1);
    ins.run("voyage-5-large", 1536, 0); // not yet active
    const rows = db
      .prepare(`SELECT model_name, dim, active FROM lcm_embedding_profile ORDER BY model_name`)
      .all() as Array<{ model_name: string; dim: number; active: number }>;
    expect(rows).toEqual([
      { model_name: "voyage-4-large", dim: 1024, active: 1 },
      { model_name: "voyage-5-large", dim: 1536, active: 0 },
    ]);
    db.close();
  });
});

describe("lcm_embedding_meta (v4.1 §1)", () => {
  it("creates table with composite PK enabling parallel-rows during cutover", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    const cols = db.prepare("PRAGMA table_info(lcm_embedding_meta)").all() as ColumnInfo[];
    const byName = new Map(cols.map((c) => [c.name, c]));
    // PK is composite (embedded_id, embedded_kind, embedding_model)
    expect(byName.get("embedded_id")?.pk).toBe(1);
    expect(byName.get("embedded_kind")?.pk).toBe(2);
    expect(byName.get("embedding_model")?.pk).toBe(3);
    db.close();
  });

  it("FK to lcm_embedding_profile prevents orphan model references", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    expect(() =>
      db
        .prepare(
          `INSERT INTO lcm_embedding_meta (embedded_id, embedded_kind, embedding_model, source_token_count) VALUES (?, ?, ?, ?)`,
        )
        .run("e1", "summary", "voyage-99-bogus", 100),
    ).toThrow();

    db.prepare(`INSERT INTO lcm_embedding_profile (model_name, dim) VALUES (?, ?)`).run(
      "voyage-4-large",
      1024,
    );
    db.prepare(
      `INSERT INTO lcm_embedding_meta (embedded_id, embedded_kind, embedding_model, source_token_count) VALUES (?, ?, ?, ?)`,
    ).run("e1", "summary", "voyage-4-large", 100);
    db.close();
  });

  it("CHECK constraint enforces embedded_kind enum", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    db.prepare(`INSERT INTO lcm_embedding_profile (model_name, dim) VALUES (?, ?)`).run(
      "voyage-4-large",
      1024,
    );
    expect(() =>
      db
        .prepare(
          `INSERT INTO lcm_embedding_meta (embedded_id, embedded_kind, embedding_model, source_token_count) VALUES (?, ?, ?, ?)`,
        )
        .run("x", "bogus-kind", "voyage-4-large", 100),
    ).toThrow();

    // Valid kinds
    for (const kind of ["summary", "entity", "theme"]) {
      db.prepare(
        `INSERT INTO lcm_embedding_meta (embedded_id, embedded_kind, embedding_model, source_token_count) VALUES (?, ?, ?, ?)`,
      ).run(`x_${kind}`, kind, "voyage-4-large", 100);
    }
    db.close();
  });

  it("composite PK allows same summary embedded under multiple models (cutover scenario)", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    const insProfile = db.prepare(
      `INSERT INTO lcm_embedding_profile (model_name, dim) VALUES (?, ?)`,
    );
    insProfile.run("voyage-4-large", 1024);
    insProfile.run("voyage-5-large", 1536);

    const insMeta = db.prepare(
      `INSERT INTO lcm_embedding_meta (embedded_id, embedded_kind, embedding_model, source_token_count) VALUES (?, ?, ?, ?)`,
    );
    insMeta.run("sum_a", "summary", "voyage-4-large", 100);
    insMeta.run("sum_a", "summary", "voyage-5-large", 100); // same id, different model — allowed

    const rows = db
      .prepare(`SELECT embedding_model FROM lcm_embedding_meta WHERE embedded_id = ?`)
      .all("sum_a") as Array<{ embedding_model: string }>;
    expect(rows.length).toBe(2);
    db.close();
  });
});
