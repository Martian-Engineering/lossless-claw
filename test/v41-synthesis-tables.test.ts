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
  runLcmMigrations(db, { fts5Available: false, seedDefaultPrompts: false });

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
    runLcmMigrations(db, { fts5Available: false, seedDefaultPrompts: false });
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
    runLcmMigrations(db, { fts5Available: false, seedDefaultPrompts: false });
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
    runLcmMigrations(db, { fts5Available: false, seedDefaultPrompts: false });
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
    runLcmMigrations(db, { fts5Available: false, seedDefaultPrompts: false });
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

    // Final.review.3 fix (Loop 4 Bug 4.4): the cache CHECK constraint was
    // widened to include all dispatch tiers ('daily', 'weekly', 'monthly',
    // 'yearly', 'year', 'custom', 'filtered'). 'monthly' is now ACCEPTED.
    // Verify with 'bogus-tier' instead, which is still rejected.
    expect(() =>
      db
        .prepare(
          `INSERT INTO lcm_synthesis_cache (cache_id, session_key, range_start, range_end, leaf_fingerprint, model_used, prompt_id, tier_label, source_leaf_ids, source_token_count, output_token_count, actual_range_covered, leaf_count_synthesized) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("c2", "sk", "s", "e", "fp", "m", "prompt_v1", "bogus-tier", "[]", 0, 0, "x", 0),
    ).toThrow();

    // 'monthly' should now succeed (post-widen fix); verify it was a real change.
    expect(() =>
      db
        .prepare(
          `INSERT INTO lcm_synthesis_cache (cache_id, session_key, range_start, range_end, leaf_fingerprint, model_used, prompt_id, tier_label, source_leaf_ids, source_token_count, output_token_count, actual_range_covered, leaf_count_synthesized) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("c3", "sk", "s2", "e2", "fp2", "m", "prompt_v1", "monthly", "[]", 0, 0, "x", 0),
    ).not.toThrow();

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

// Wave-2 Auditor #8 fix F1: regression test for the migration's
// DELETE-before-DROP cleanup of orphan audit rows. The Wave-1 commit
// added the cleanup; this test pins the behavior so a future refactor
// doesn't silently regress it.
//
// Strategy: run runLcmMigrations once (gets fully-migrated schema with
// new wide CHECK), seed audit rows referencing real cache_ids, then
// directly invoke the same DELETE that the migration runs and verify
// it cleans the right rows. This is a unit test of the cleanup SQL,
// not a full migration upgrade simulation (the upgrade path is
// covered by v41-pre-existing-schema-migration.test.ts).
describe("v4.1.3 widenLcmSynthesisCacheTierCheck — orphan-cleanup SQL", () => {
  it("DELETE FROM lcm_synthesis_audit WHERE target_cache_id IS NOT NULL prunes only orphan-pointing rows", () => {
    const db = setupDbWithRequiredFixtures();
    // Pre-condition: count audit rows with target_cache_id set vs NULL
    // (the fixture seeds none; we'll seed both kinds).

    // Need a real cache_id to FK against
    db.prepare(
      `INSERT INTO lcm_synthesis_cache
         (cache_id, session_key, range_start, range_end, leaf_fingerprint,
          content, model_used, prompt_id, tier_label, source_leaf_ids,
          source_token_count, output_token_count, actual_range_covered,
          leaf_count_synthesized)
       VALUES ('cache_for_orphan_test', 'agent:main:main', '2026-01-01', '2026-01-31',
         'fp1', null, 'm1', 'prompt_v1', 'year', '["sum_a"]', 100, 50, '...', 1)`,
    ).run();

    // Seed: 2 audit rows pointing at the cache (will be the "orphans"
    // after the eventual DROP), 1 row pointing at a summary instead
    // (must be PRESERVED).
    db.prepare(
      `INSERT INTO lcm_synthesis_audit
         (audit_id, pass_session_id, target_cache_id, prompt_id, pass_kind,
          pass_input_truncated, status, model_used)
       VALUES ('audit_cache_1', 'pass_1', 'cache_for_orphan_test', 'prompt_v1',
         'single', '...', 'completed', 'm1')`,
    ).run();
    db.prepare(
      `INSERT INTO lcm_synthesis_audit
         (audit_id, pass_session_id, target_cache_id, prompt_id, pass_kind,
          pass_input_truncated, status, model_used)
       VALUES ('audit_cache_2', 'pass_2', 'cache_for_orphan_test', 'prompt_v1',
         'single', '...', 'completed', 'm1')`,
    ).run();
    db.prepare(
      `INSERT INTO lcm_synthesis_audit
         (audit_id, pass_session_id, target_summary_id, prompt_id, pass_kind,
          pass_input_truncated, status, model_used)
       VALUES ('audit_summary', 'pass_3', 'sum_a', 'prompt_v1',
         'single', '...', 'completed', 'm1')`,
    ).run();

    const beforeCacheTargeted = db
      .prepare(`SELECT COUNT(*) AS n FROM lcm_synthesis_audit WHERE target_cache_id IS NOT NULL`)
      .get() as { n: number };
    const beforeSummaryTargeted = db
      .prepare(`SELECT COUNT(*) AS n FROM lcm_synthesis_audit WHERE target_summary_id IS NOT NULL`)
      .get() as { n: number };
    expect(beforeCacheTargeted.n).toBe(2);
    expect(beforeSummaryTargeted.n).toBeGreaterThanOrEqual(1);

    // Apply the same DELETE the migration runs.
    db.exec(`DELETE FROM lcm_synthesis_audit WHERE target_cache_id IS NOT NULL`);

    const afterCacheTargeted = db
      .prepare(`SELECT COUNT(*) AS n FROM lcm_synthesis_audit WHERE target_cache_id IS NOT NULL`)
      .get() as { n: number };
    const afterSummaryTargeted = db
      .prepare(`SELECT COUNT(*) AS n FROM lcm_synthesis_audit WHERE target_summary_id IS NOT NULL`)
      .get() as { n: number };
    expect(afterCacheTargeted.n).toBe(0);
    expect(afterSummaryTargeted.n).toBe(beforeSummaryTargeted.n);

    db.close();
  });

  it("re-running runLcmMigrations on already-widened DB is a no-op (idempotent)", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false, seedDefaultPrompts: false });
    const before = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='lcm_synthesis_cache'`)
      .get() as { sql: string };
    runLcmMigrations(db, { fts5Available: false, seedDefaultPrompts: false });
    const after = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='lcm_synthesis_cache'`)
      .get() as { sql: string };
    expect(after.sql).toBe(before.sql);
    db.close();
  });

  it("schema includes the wide CHECK including 'monthly' on first migration", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false, seedDefaultPrompts: false });
    const sql = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='lcm_synthesis_cache'`)
      .get() as { sql: string };
    expect(sql.sql).toMatch(/'monthly'|"monthly"/);
    expect(sql.sql).toMatch(/'weekly'|"weekly"/);
    expect(sql.sql).toMatch(/'daily'|"daily"/);
    db.close();
  });
});
