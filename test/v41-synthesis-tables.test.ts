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
type FkInfo = {
  from: string;
  to: string;
  table: string;
  on_delete: string;
};

function setupDbWithRequiredFixtures(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false });

  // Seed a conversation + summary so FK references work
  db.prepare(`INSERT INTO conversations (session_id) VALUES ('test-session')`).run();
  db.prepare(
    `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count) VALUES (?, 1, 'leaf', 'x', 1)`,
  ).run("sum_a");
  db.prepare(
    `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count) VALUES (?, 1, 'leaf', 'y', 1)`,
  ).run("sum_b");

  // Seed a prompt registry row so cache + audit FKs work
  db.prepare(
    `INSERT INTO lcm_prompt_registry (prompt_id, memory_type, pass_kind, version, template)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("prompt_v1", "episodic-condensed", "single", 1, "Summarize: {input}");

  return db;
}

describe("lcm_prompt_registry (v4.1 §3)", () => {
  it("creates table with memory_type + pass_kind CHECK constraints", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    const cols = db.prepare("PRAGMA table_info(lcm_prompt_registry)").all() as ColumnInfo[];
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get("prompt_id")?.pk).toBe(1);
    expect(byName.get("memory_type")?.notnull).toBe(1);
    expect(byName.get("pass_kind")?.notnull).toBe(1);
    expect(byName.get("template")?.notnull).toBe(1);
    expect(byName.get("active")?.dflt_value).toBe("1");
    expect(byName.get("bundle_version")?.dflt_value).toBe("1");
    db.close();
  });

  it("rejects invalid memory_type values", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    expect(() =>
      db
        .prepare(
          `INSERT INTO lcm_prompt_registry (prompt_id, memory_type, pass_kind, version, template) VALUES (?, ?, ?, ?, ?)`,
        )
        .run("p1", "bogus-type", "single", 1, "x"),
    ).toThrow();
    db.close();
  });

  it("rejects invalid pass_kind values", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    expect(() =>
      db
        .prepare(
          `INSERT INTO lcm_prompt_registry (prompt_id, memory_type, pass_kind, version, template) VALUES (?, ?, ?, ?, ?)`,
        )
        .run("p2", "episodic-leaf", "critique-revise", 1, "x"),
    ).toThrow();
    db.close();
  });

  it("UNIQUE constraint prevents duplicate (memory_type, tier_label, pass_kind, version)", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    db.prepare(
      `INSERT INTO lcm_prompt_registry (prompt_id, memory_type, tier_label, pass_kind, version, template) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("pa", "episodic-condensed", "monthly", "single", 1, "v1");
    expect(() =>
      db
        .prepare(
          `INSERT INTO lcm_prompt_registry (prompt_id, memory_type, tier_label, pass_kind, version, template) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("pb", "episodic-condensed", "monthly", "single", 1, "v1-dup"),
    ).toThrow();
    // Different version is fine
    db.prepare(
      `INSERT INTO lcm_prompt_registry (prompt_id, memory_type, tier_label, pass_kind, version, template) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("pc", "episodic-condensed", "monthly", "single", 2, "v2");
    db.close();
  });
});

describe("lcm_synthesis_cache (v3.1 A8 + v4.1.1 B4)", () => {
  it("creates table with status CHECK + tier_label CHECK + prompt_id FK", () => {
    const db = setupDbWithRequiredFixtures();
    const cols = db.prepare("PRAGMA table_info(lcm_synthesis_cache)").all() as ColumnInfo[];
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get("cache_id")?.pk).toBe(1);
    expect(byName.get("status")?.dflt_value).toBe("'ready'");
    expect(byName.get("content")?.notnull).toBe(0); // NULL while building
    expect(byName.get("entity_index")?.dflt_value).toBe("'{}'");

    const fks = db.prepare("PRAGMA foreign_key_list(lcm_synthesis_cache)").all() as FkInfo[];
    const promptFk = fks.find((fk) => fk.from === "prompt_id");
    expect(promptFk?.table).toBe("lcm_prompt_registry");

    db.close();
  });

  it("UNIQUE lookup index enables INSERT OR IGNORE single-flight (v4.1.1 B4)", () => {
    const db = setupDbWithRequiredFixtures();
    const insert = db.prepare(`
      INSERT OR IGNORE INTO lcm_synthesis_cache (
        cache_id, session_key, range_start, range_end, leaf_fingerprint,
        model_used, prompt_id, tier_label, source_leaf_ids,
        source_token_count, output_token_count, actual_range_covered, leaf_count_synthesized,
        status, building_started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'building', datetime('now'))
    `);

    // First INSERT wins
    const r1 = insert.run(
      "cache_A",
      "agent:main:main",
      "2026-04-01T00:00:00Z",
      "2026-04-30T23:59:59Z",
      "fp_xyz",
      "voyage-4-large",
      "prompt_v1",
      "custom",
      "[]",
      0,
      0,
      "2026-04-01T00:00:00Z..2026-04-30T23:59:59Z",
      0,
    );
    expect(r1.changes).toBe(1);

    // Second INSERT with same lookup key conflicts → DO NOTHING
    const r2 = insert.run(
      "cache_B", // different cache_id, but same lookup composite
      "agent:main:main",
      "2026-04-01T00:00:00Z",
      "2026-04-30T23:59:59Z",
      "fp_xyz",
      "voyage-4-large",
      "prompt_v1",
      "custom",
      "[]",
      0,
      0,
      "2026-04-01T00:00:00Z..2026-04-30T23:59:59Z",
      0,
    );
    expect(r2.changes).toBe(0); // ON CONFLICT DO NOTHING fired

    // Verify the winner is cache_A
    const winner = db
      .prepare(
        `SELECT cache_id FROM lcm_synthesis_cache
         WHERE session_key = ? AND range_start = ? AND range_end = ?
           AND leaf_fingerprint = ? AND COALESCE(grep_filter, '') = ''`,
      )
      .get(
        "agent:main:main",
        "2026-04-01T00:00:00Z",
        "2026-04-30T23:59:59Z",
        "fp_xyz",
      ) as { cache_id: string };
    expect(winner.cache_id).toBe("cache_A");
    db.close();
  });

  it("rejects invalid status / tier_label values", () => {
    const db = setupDbWithRequiredFixtures();
    expect(() =>
      db
        .prepare(
          `INSERT INTO lcm_synthesis_cache (cache_id, session_key, range_start, range_end, leaf_fingerprint, model_used, prompt_id, tier_label, source_leaf_ids, source_token_count, output_token_count, actual_range_covered, leaf_count_synthesized, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("c1", "sk", "s", "e", "fp", "m", "prompt_v1", "year", "[]", 0, 0, "x", 0, "bogus-status"),
    ).toThrow();

    expect(() =>
      db
        .prepare(
          `INSERT INTO lcm_synthesis_cache (cache_id, session_key, range_start, range_end, leaf_fingerprint, model_used, prompt_id, tier_label, source_leaf_ids, source_token_count, output_token_count, actual_range_covered, leaf_count_synthesized) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("c2", "sk", "s", "e", "fp", "m", "prompt_v1", "monthly", "[]", 0, 0, "x", 0),
    ).toThrow(); // 'monthly' not in CHECK list (only 'year', 'custom', 'filtered')

    db.close();
  });
});

describe("lcm_cache_leaf_refs (v3.1 A3 inverse index)", () => {
  it("creates table with composite PK + cascade both directions", () => {
    const db = setupDbWithRequiredFixtures();
    const cols = db.prepare("PRAGMA table_info(lcm_cache_leaf_refs)").all() as ColumnInfo[];
    expect(cols.find((c) => c.name === "cache_id")?.pk).toBe(1);
    expect(cols.find((c) => c.name === "leaf_summary_id")?.pk).toBe(2);

    const fks = db.prepare("PRAGMA foreign_key_list(lcm_cache_leaf_refs)").all() as FkInfo[];
    expect(fks.find((fk) => fk.from === "cache_id")?.on_delete).toBe("CASCADE");
    expect(fks.find((fk) => fk.from === "leaf_summary_id")?.on_delete).toBe("CASCADE");
    db.close();
  });

  it("CASCADE on leaf delete removes refs (cleans up after leaf is purged)", () => {
    const db = setupDbWithRequiredFixtures();
    // Build a cache row + ref
    db.prepare(
      `INSERT INTO lcm_synthesis_cache (cache_id, session_key, range_start, range_end, leaf_fingerprint, model_used, prompt_id, tier_label, source_leaf_ids, source_token_count, output_token_count, actual_range_covered, leaf_count_synthesized) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("c1", "sk", "s", "e", "fp", "m", "prompt_v1", "custom", "[]", 0, 0, "x", 0);
    db.prepare(`INSERT INTO lcm_cache_leaf_refs (cache_id, leaf_summary_id) VALUES (?, ?)`).run(
      "c1",
      "sum_a",
    );

    // Delete the leaf — ref should cascade
    db.prepare(`DELETE FROM summaries WHERE summary_id = ?`).run("sum_a");
    const refs = db
      .prepare(`SELECT COUNT(*) AS n FROM lcm_cache_leaf_refs WHERE cache_id = 'c1'`)
      .get() as { n: number };
    expect(refs.n).toBe(0);
    db.close();
  });

  it("CASCADE on cache delete removes refs", () => {
    const db = setupDbWithRequiredFixtures();
    db.prepare(
      `INSERT INTO lcm_synthesis_cache (cache_id, session_key, range_start, range_end, leaf_fingerprint, model_used, prompt_id, tier_label, source_leaf_ids, source_token_count, output_token_count, actual_range_covered, leaf_count_synthesized) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("c2", "sk", "s", "e", "fp2", "m", "prompt_v1", "custom", "[]", 0, 0, "x", 0);
    db.prepare(`INSERT INTO lcm_cache_leaf_refs (cache_id, leaf_summary_id) VALUES (?, ?)`).run(
      "c2",
      "sum_b",
    );

    db.prepare(`DELETE FROM lcm_synthesis_cache WHERE cache_id = ?`).run("c2");
    const refs = db
      .prepare(`SELECT COUNT(*) AS n FROM lcm_cache_leaf_refs WHERE leaf_summary_id = 'sum_b'`)
      .get() as { n: number };
    expect(refs.n).toBe(0);
    db.close();
  });
});

describe("lcm_synthesis_audit (v4.1.1 B1)", () => {
  it("pass_output is NULLable so audit row can be inserted before LLM call returns", () => {
    const db = setupDbWithRequiredFixtures();
    const cols = db.prepare("PRAGMA table_info(lcm_synthesis_audit)").all() as ColumnInfo[];
    const passOutput = cols.find((c) => c.name === "pass_output");
    expect(passOutput?.notnull).toBe(0);

    const status = cols.find((c) => c.name === "status");
    expect(status?.notnull).toBe(1);
    expect(status?.dflt_value).toBe("'started'");
    db.close();
  });

  it("CHECK constraint requires either target_summary_id OR target_cache_id", () => {
    const db = setupDbWithRequiredFixtures();
    expect(() =>
      db
        .prepare(
          `INSERT INTO lcm_synthesis_audit (audit_id, pass_session_id, prompt_id, pass_kind, pass_input_truncated, model_used) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("a1", "sess1", "prompt_v1", "single", "input", "voyage-4-large"),
    ).toThrow(); // both target columns NULL

    // With target_summary_id: works
    db.prepare(
      `INSERT INTO lcm_synthesis_audit (audit_id, pass_session_id, target_summary_id, prompt_id, pass_kind, pass_input_truncated, model_used) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("a2", "sess1", "sum_a", "prompt_v1", "single", "input", "voyage-4-large");

    db.close();
  });

  it("supports the started → completed pattern (insert with NULL pass_output, update on LLM return)", () => {
    const db = setupDbWithRequiredFixtures();

    // Step 1: insert audit row with status='started', pass_output NULL
    db.prepare(
      `INSERT INTO lcm_synthesis_audit (audit_id, pass_session_id, target_summary_id, prompt_id, pass_kind, pass_input_truncated, model_used) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("a3", "sess2", "sum_a", "prompt_v1", "single", "input", "voyage-4-large");

    // Step 2: LLM call happens OUTSIDE transaction (per §0 invariant 1)
    // Step 3: UPDATE on success
    db.prepare(
      `UPDATE lcm_synthesis_audit SET pass_output = ?, status = 'completed', latency_ms = ? WHERE audit_id = ?`,
    ).run("the resulting summary text", 1234, "a3");

    const row = db
      .prepare(`SELECT status, pass_output, latency_ms FROM lcm_synthesis_audit WHERE audit_id = ?`)
      .get("a3") as { status: string; pass_output: string; latency_ms: number };
    expect(row.status).toBe("completed");
    expect(row.pass_output).toBe("the resulting summary text");
    expect(row.latency_ms).toBe(1234);
    db.close();
  });

  it("started-GC index supports the v4.1.1 B1 1-hour orphan cleanup query", () => {
    const db = setupDbWithRequiredFixtures();
    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='lcm_synthesis_audit'`,
      )
      .all() as IndexInfo[];
    expect(indexes.map((i) => i.name)).toContain("lcm_synthesis_audit_started_gc_idx");
    db.close();
  });
});
