import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";

/**
 * v4.1 B.fix — Gap 2: lcm_prompt_registry NULL tier_label deduplication.
 *
 * The original UNIQUE(memory_type, tier_label, pass_kind, version) constraint
 * admits multiple rows where tier_label IS NULL because SQLite treats NULLs
 * as distinct in UNIQUE. The synthesis spec wants singletons-per-version, so
 * a follow-up migration step adds a COALESCE-based UNIQUE INDEX that catches
 * NULL collisions. Same pattern is used for lcm_synthesis_cache_lookup_uniq.
 */
describe("lcm_prompt_registry NULL-safe UNIQUE index (v4.1 B.fix Gap 2)", () => {
  const insertRegistryRow = (
    db: DatabaseSync,
    args: {
      prompt_id: string;
      memory_type: string;
      tier_label: string | null;
      pass_kind: string;
      version: number;
    },
  ): void => {
    db.prepare(
      `INSERT INTO lcm_prompt_registry
         (prompt_id, memory_type, tier_label, pass_kind, version, template)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      args.prompt_id,
      args.memory_type,
      args.tier_label,
      args.pass_kind,
      args.version,
      "tmpl-body",
    );
  };

  it("creates the lcm_prompt_registry_uniq_lookup index", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false, seedDefaultPrompts: false });

    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type='index' AND tbl_name='lcm_prompt_registry'`,
      )
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain("lcm_prompt_registry_uniq_lookup");
    db.close();
  });

  it("rejects a second row with the same memory_type + NULL tier_label + pass_kind + version", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false, seedDefaultPrompts: false });

    insertRegistryRow(db, {
      prompt_id: "p_1",
      memory_type: "episodic-leaf",
      tier_label: null,
      pass_kind: "single",
      version: 1,
    });

    expect(() =>
      insertRegistryRow(db, {
        prompt_id: "p_2",
        memory_type: "episodic-leaf",
        tier_label: null,
        pass_kind: "single",
        version: 1,
      }),
    ).toThrow(/UNIQUE/i);
    db.close();
  });

  it("allows two NULL-tier_label rows that differ only in version", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false, seedDefaultPrompts: false });

    insertRegistryRow(db, {
      prompt_id: "p_1",
      memory_type: "episodic-leaf",
      tier_label: null,
      pass_kind: "single",
      version: 1,
    });
    insertRegistryRow(db, {
      prompt_id: "p_2",
      memory_type: "episodic-leaf",
      tier_label: null,
      pass_kind: "single",
      version: 2,
    });

    const count = (
      db.prepare(`SELECT COUNT(*) AS n FROM lcm_prompt_registry`).get() as { n: number }
    ).n;
    expect(count).toBe(2);
    db.close();
  });

  it("treats NULL and 'monthly' as distinct (different tier_label values)", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false, seedDefaultPrompts: false });

    insertRegistryRow(db, {
      prompt_id: "p_null",
      memory_type: "episodic-leaf",
      tier_label: null,
      pass_kind: "single",
      version: 1,
    });
    insertRegistryRow(db, {
      prompt_id: "p_monthly",
      memory_type: "episodic-leaf",
      tier_label: "monthly",
      pass_kind: "single",
      version: 1,
    });

    const count = (
      db.prepare(`SELECT COUNT(*) AS n FROM lcm_prompt_registry`).get() as { n: number }
    ).n;
    expect(count).toBe(2);
    db.close();
  });

  it("the original UNIQUE constraint still catches non-NULL collisions", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false, seedDefaultPrompts: false });

    insertRegistryRow(db, {
      prompt_id: "p_1",
      memory_type: "episodic-leaf",
      tier_label: "monthly",
      pass_kind: "single",
      version: 1,
    });

    expect(() =>
      insertRegistryRow(db, {
        prompt_id: "p_2",
        memory_type: "episodic-leaf",
        tier_label: "monthly",
        pass_kind: "single",
        version: 1,
      }),
    ).toThrow(/UNIQUE/i);
    db.close();
  });

  it("is idempotent — running migrations twice does not fail", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false, seedDefaultPrompts: false });
    expect(() => runLcmMigrations(db, { fts5Available: false, seedDefaultPrompts: false })).not.toThrow();
    db.close();
  });
});
