import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";

type ColumnInfo = {
  name: string;
  notnull: number;
  pk: number;
  dflt_value: string | null;
};
type FkInfo = { from: string; table: string; on_delete: string };

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false });
  return db;
}

describe("lcm_eval_query_set (v4.1 §11)", () => {
  it("creates table with PK and required columns", () => {
    const db = setupDb();
    const cols = db.prepare("PRAGMA table_info(lcm_eval_query_set)").all() as ColumnInfo[];
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get("query_set_id")?.pk).toBe(1);
    expect(byName.get("version")?.notnull).toBe(1);
    db.close();
  });

  it("supports inserting a baseline query set ('eva-baseline-v2')", () => {
    const db = setupDb();
    db.prepare(
      `INSERT INTO lcm_eval_query_set (query_set_id, version, description) VALUES (?, ?, ?)`,
    ).run("eva-baseline-v2", 1, "100-query stratified eval set");
    const row = db
      .prepare("SELECT * FROM lcm_eval_query_set WHERE query_set_id = ?")
      .get("eva-baseline-v2") as { description: string };
    expect(row.description).toContain("stratified");
    db.close();
  });
});

describe("lcm_eval_query (v4.1 §11)", () => {
  it("rejects invalid stratum values via CHECK", () => {
    const db = setupDb();
    db.prepare(
      `INSERT INTO lcm_eval_query_set (query_set_id, version) VALUES (?, ?)`,
    ).run("test", 1);
    expect(() =>
      db
        .prepare(
          `INSERT INTO lcm_eval_query (query_id, query_set_id, query_text, stratum, expected_topics, rubric) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("q1", "test", "what?", "bogus-stratum", "[]", "{}"),
    ).toThrow();
    db.close();
  });

  it("supports the 3 valid strata + must_not_regress flag", () => {
    const db = setupDb();
    db.prepare(
      `INSERT INTO lcm_eval_query_set (query_set_id, version) VALUES (?, ?)`,
    ).run("eva-baseline-v2", 1);

    const insert = db.prepare(
      `INSERT INTO lcm_eval_query (query_id, query_set_id, query_text, stratum, expected_topics, must_not_regress, rubric) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run("q1", "eva-baseline-v2", "What did we decide about gbrain bridge?", "fts-easy", "[]", 1, "{}");
    insert.run("q2", "eva-baseline-v2", "Tell me about context collapsing", "paraphrastic", "[]", 0, "{}");
    insert.run("q3", "eva-baseline-v2", "What were April blockers?", "fts-medium", "[]", 0, "{}");

    const counts = db
      .prepare(`SELECT stratum, COUNT(*) AS n FROM lcm_eval_query GROUP BY stratum ORDER BY stratum`)
      .all() as Array<{ stratum: string; n: number }>;
    expect(counts).toEqual([
      { stratum: "fts-easy", n: 1 },
      { stratum: "fts-medium", n: 1 },
      { stratum: "paraphrastic", n: 1 },
    ]);

    const must = db
      .prepare(`SELECT COUNT(*) AS n FROM lcm_eval_query WHERE must_not_regress = 1`)
      .get() as { n: number };
    expect(must.n).toBe(1);
    db.close();
  });

  it("CASCADE on query_set delete removes queries", () => {
    const db = setupDb();
    db.prepare(`INSERT INTO lcm_eval_query_set (query_set_id, version) VALUES (?, ?)`).run("x", 1);
    db.prepare(
      `INSERT INTO lcm_eval_query (query_id, query_set_id, query_text, stratum, expected_topics, rubric) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("q1", "x", "?", "fts-easy", "[]", "{}");
    db.prepare(`DELETE FROM lcm_eval_query_set WHERE query_set_id = 'x'`).run();
    const remaining = db
      .prepare(`SELECT COUNT(*) AS n FROM lcm_eval_query WHERE query_set_id = 'x'`)
      .get() as { n: number };
    expect(remaining.n).toBe(0);
    db.close();
  });
});

describe("lcm_eval_run (v4.1 §11)", () => {
  it("rejects invalid trigger values", () => {
    const db = setupDb();
    db.prepare(`INSERT INTO lcm_eval_query_set (query_set_id, version) VALUES (?, ?)`).run("s", 1);
    expect(() =>
      db
        .prepare(
          `INSERT INTO lcm_eval_run (run_id, query_set_id, prompt_bundle_version, retrieval_recall_score, synthesis_quality_score, per_query_scores, judge_models, trigger) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("r1", "s", 1, 0.8, 8.5, "[]", "[]", "bogus-trigger"),
    ).toThrow();
    db.close();
  });

  it("supports recording a run with both recall + quality metrics (separate per v4.1.1)", () => {
    const db = setupDb();
    db.prepare(`INSERT INTO lcm_eval_query_set (query_set_id, version) VALUES (?, ?)`).run("s", 1);
    db.prepare(
      `INSERT INTO lcm_eval_run (run_id, query_set_id, prompt_bundle_version, retrieval_recall_score, synthesis_quality_score, per_query_scores, judge_models, noise_floor_sd, trigger) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "r1",
      "s",
      1,
      0.78,
      8.4,
      JSON.stringify({ q1: 9, q2: 8, q3: 7 }),
      JSON.stringify(["gpt-5.5", "claude-sonnet-X", "voyage-judge"]),
      0.5,
      "ci",
    );
    const row = db
      .prepare(`SELECT retrieval_recall_score, synthesis_quality_score, noise_floor_sd FROM lcm_eval_run WHERE run_id = ?`)
      .get("r1") as {
      retrieval_recall_score: number;
      synthesis_quality_score: number;
      noise_floor_sd: number;
    };
    expect(row.retrieval_recall_score).toBeCloseTo(0.78);
    expect(row.synthesis_quality_score).toBeCloseTo(8.4);
    expect(row.noise_floor_sd).toBeCloseTo(0.5);
    db.close();
  });
});

describe("lcm_eval_drift (v4.1 §11.5)", () => {
  it("creates table for cumulative-regression drift index", () => {
    const db = setupDb();
    const cols = db.prepare("PRAGMA table_info(lcm_eval_drift)").all() as ColumnInfo[];
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get("drift_id")?.pk).toBe(1);
    expect(byName.get("cumulative_delta")?.notnull).toBe(1);
    expect(byName.get("window_runs")?.notnull).toBe(1);

    const fks = db.prepare("PRAGMA foreign_key_list(lcm_eval_drift)").all() as FkInfo[];
    expect(fks.find((fk) => fk.from === "query_set_id")?.on_delete).toBe("CASCADE");
    db.close();
  });
});
