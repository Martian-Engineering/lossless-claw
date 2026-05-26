import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import {
  runQualityEval,
  type JudgeCall,
  type JudgeEntry,
} from "../src/eval/judge.js";
import {
  registerQuerySet,
  type QueryRecord,
  type QuerySetIdentity,
} from "../src/eval/query-set.js";
import {
  runRecallEval,
  type RecallSearchAdapter,
} from "../src/eval/recall.js";
import { computeDrift, recordEvalRun } from "../src/eval/run.js";

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false });
  return db;
}

const SAMPLE_QUERIES: QueryRecord[] = [
  {
    queryId: "q1",
    queryText: "what's at rank 1",
    stratum: "fts-easy",
    expectedSummaryIds: ["a"],
  },
  {
    queryId: "q2",
    queryText: "two-expected query",
    stratum: "fts-medium",
    expectedSummaryIds: ["b", "c"],
  },
  {
    queryId: "q3",
    queryText: "no expected",
    stratum: "paraphrastic",
    referenceSummary: "ref text",
  },
];

const IDENTITY: QuerySetIdentity = { name: "drift-test", version: 1 };

function adapter(byId: Record<string, string[]>): RecallSearchAdapter {
  return {
    async search(q) {
      return byId[q.queryId] ?? [];
    },
  };
}

function constJudge(score: number | null, reason = "ok"): JudgeCall {
  return {
    async judge() {
      return { score, reason };
    },
  };
}

describe("eval/run — recordEvalRun", () => {
  it("records a recall-only run", async () => {
    const db = setupDb();
    registerQuerySet(db, IDENTITY, SAMPLE_QUERIES);

    const recallReport = await runRecallEval(
      SAMPLE_QUERIES,
      adapter({ q1: ["a"], q2: ["b", "c"], q3: [] }),
    );
    const runId = recordEvalRun(db, {
      querySetIdentity: IDENTITY,
      mode: "fts_only",
      recallReport,
    });
    expect(runId).toMatch(/^evalrun_/);

    const row = db
      .prepare(`SELECT * FROM lcm_eval_run WHERE run_id = ?`)
      .get(runId) as Record<string, unknown>;
    expect(row.query_set_id).toBe("drift-test@v1");
    expect(row.trigger).toBe("manual");
    expect(row.prompt_bundle_version).toBe(1);
    expect(typeof row.retrieval_recall_score).toBe("number");
    expect(row.synthesis_quality_score).toBe(0);
    expect(row.judge_models).toBe("[]"); // no quality judges → empty array
    expect(row.noise_floor_sd).toBeNull();

    const env = JSON.parse(row.per_query_scores as string);
    expect(env.v).toBe(1);
    expect(env.mode).toBe("fts_only");
    expect(env.hasRecall).toBe(true);
    expect(env.hasQuality).toBe(false);
    // q1, q2, q3 all have RR recorded.
    expect(Object.keys(env.perQuery).sort()).toEqual(["q1", "q2", "q3"]);
    expect(env.perQuery.q1.recallRR).toBe(1.0);
  });

  it("records a quality-only run with judge models populated", async () => {
    const db = setupDb();
    registerQuerySet(db, IDENTITY, SAMPLE_QUERIES);

    const candidates = new Map<string, string>([
      ["q1", "candidate 1"],
      ["q2", "candidate 2"],
    ]);
    const judges: JudgeEntry[] = [
      { judgeId: "claude", call: constJudge(5) },
      { judgeId: "gpt", call: constJudge(4) },
    ];
    const qualityReport = await runQualityEval(
      SAMPLE_QUERIES,
      candidates,
      judges,
    );
    const runId = recordEvalRun(db, {
      querySetIdentity: IDENTITY,
      mode: "hybrid",
      qualityReport,
      notes: "after prompt v3 rollout",
      trigger: "prompt-update",
      promptBundleVersion: 7,
      noiseFloorSd: 0.15,
    });

    const row = db
      .prepare(`SELECT * FROM lcm_eval_run WHERE run_id = ?`)
      .get(runId) as Record<string, unknown>;
    expect(row.trigger).toBe("prompt-update");
    expect(row.prompt_bundle_version).toBe(7);
    expect(row.noise_floor_sd).toBe(0.15);
    expect(row.synthesis_quality_score).toBeCloseTo(4.5, 5);
    expect(row.retrieval_recall_score).toBe(0);
    expect(JSON.parse(row.judge_models as string)).toEqual(["claude", "gpt"]);

    const env = JSON.parse(row.per_query_scores as string);
    expect(env.notes).toBe("after prompt v3 rollout");
    expect(env.hasQuality).toBe(true);
    expect(env.perQuery.q1.qualityScore).toBe(4.5);
    expect(env.perQuery.q3).toBeUndefined(); // no candidate for q3
  });

  it("respects caller-provided runId", () => {
    const db = setupDb();
    registerQuerySet(db, IDENTITY, SAMPLE_QUERIES);
    const id = recordEvalRun(db, {
      runId: "my-fixed-id-1",
      querySetIdentity: IDENTITY,
      mode: "fts_only",
    });
    expect(id).toBe("my-fixed-id-1");
  });

  it("rejects records pointing at unregistered query sets", () => {
    const db = setupDb();
    expect(() =>
      recordEvalRun(db, {
        querySetIdentity: { name: "nope", version: 1 },
        mode: "fts_only",
      }),
    ).toThrow(/unregistered query set/);
  });
});

describe("eval/run — computeDrift", () => {
  it("returns zeroes when there's no prior run", async () => {
    const db = setupDb();
    registerQuerySet(db, IDENTITY, SAMPLE_QUERIES);
    const recallReport = await runRecallEval(
      SAMPLE_QUERIES,
      adapter({ q1: ["a"], q2: ["b", "c"] }),
    );
    const runId = recordEvalRun(db, {
      querySetIdentity: IDENTITY,
      mode: "fts_only",
      recallReport,
    });
    const drift = computeDrift(db, runId);
    expect(drift.priorRunId).toBeNull();
    expect(drift.drifted).toBe(0);
    expect(drift.improved).toBe(0);
    expect(drift.regressed).toBe(0);
    expect(drift.cumulativeDelta).toBe(0);
    expect(drift.details).toEqual([]);
    // No drift row should be written for the no-prior case.
    const driftCount = db
      .prepare(`SELECT COUNT(*) as n FROM lcm_eval_drift`)
      .get() as { n: number };
    expect(driftCount.n).toBe(0);
  });

  it("computes per-query deltas vs prior run with same mode", async () => {
    const db = setupDb();
    registerQuerySet(db, IDENTITY, SAMPLE_QUERIES);

    // Run 1: q1 RR=1.0, q2 RR=0.5
    const prior = await runRecallEval(
      SAMPLE_QUERIES,
      adapter({ q1: ["a"], q2: ["x", "b", "c"] }),
    );
    const priorId = recordEvalRun(db, {
      querySetIdentity: IDENTITY,
      mode: "fts_only",
      recallReport: prior,
    });

    // Run 2: q1 RR=0.5 (regressed), q2 RR=1.0 (improved)
    const current = await runRecallEval(
      SAMPLE_QUERIES,
      adapter({ q1: ["x", "a"], q2: ["b", "c"] }),
    );
    const currentId = recordEvalRun(db, {
      querySetIdentity: IDENTITY,
      mode: "fts_only",
      recallReport: current,
    });

    const drift = computeDrift(db, currentId);
    expect(drift.priorRunId).toBe(priorId);
    expect(drift.details.length).toBeGreaterThanOrEqual(2);

    const q1d = drift.details.find((d) => d.queryId === "q1")!;
    expect(q1d.priorScore).toBe(1.0);
    expect(q1d.currentScore).toBe(0.5);
    expect(q1d.delta).toBe(-0.5);

    const q2d = drift.details.find((d) => d.queryId === "q2")!;
    expect(q2d.priorScore).toBe(0.5);
    expect(q2d.currentScore).toBe(1.0);
    expect(q2d.delta).toBe(0.5);

    expect(drift.cumulativeDelta).toBeCloseTo(0, 5); // -0.5 + 0.5
    // Without noise floor, any non-zero delta counts as drift.
    expect(drift.drifted).toBe(2);
    expect(drift.improved).toBe(1);
    expect(drift.regressed).toBe(1);

    // Aggregate row should have been persisted.
    const driftRow = db
      .prepare(`SELECT * FROM lcm_eval_drift ORDER BY computed_at DESC LIMIT 1`)
      .get() as Record<string, unknown>;
    expect(driftRow.cumulative_delta).toBeCloseTo(0, 5);
    expect(driftRow.window_runs).toBe(2);
  });

  it("ignores prior runs with a DIFFERENT mode", async () => {
    const db = setupDb();
    registerQuerySet(db, IDENTITY, SAMPLE_QUERIES);

    const r = await runRecallEval(
      SAMPLE_QUERIES,
      adapter({ q1: ["a"], q2: ["b", "c"] }),
    );

    // Prior run with mode='hybrid' — should NOT match a current 'fts_only' run.
    recordEvalRun(db, {
      querySetIdentity: IDENTITY,
      mode: "hybrid",
      recallReport: r,
    });
    const currentId = recordEvalRun(db, {
      querySetIdentity: IDENTITY,
      mode: "fts_only",
      recallReport: r,
    });
    const drift = computeDrift(db, currentId);
    expect(drift.priorRunId).toBeNull();
    expect(drift.drifted).toBe(0);
  });

  it("uses 2× noise_floor_sd as drift threshold when present", async () => {
    const db = setupDb();
    registerQuerySet(db, IDENTITY, SAMPLE_QUERIES);

    const prior = await runRecallEval(
      SAMPLE_QUERIES,
      adapter({ q1: ["a"], q2: ["b", "c"] }),
    );
    recordEvalRun(db, {
      querySetIdentity: IDENTITY,
      mode: "fts_only",
      recallReport: prior,
    });

    // q2 RR drops slightly: 1.0 → 0.5. Without noise floor that's drift;
    // with noise_floor_sd = 0.4 (2×0.4 = 0.8 threshold), the |delta|=0.5
    // is BELOW threshold and shouldn't count.
    const current = await runRecallEval(
      SAMPLE_QUERIES,
      adapter({ q1: ["a"], q2: ["x", "b", "c"] }),
    );
    const currentId = recordEvalRun(db, {
      querySetIdentity: IDENTITY,
      mode: "fts_only",
      recallReport: current,
      noiseFloorSd: 0.4,
    });
    const drift = computeDrift(db, currentId);
    // q1 unchanged (delta=0); q2 |delta|=0.5 < threshold(0.8) → NOT drifted.
    expect(drift.drifted).toBe(0);
    // But cumulative_delta still tracks raw sum.
    expect(drift.cumulativeDelta).toBeCloseTo(-0.5, 5);
  });

  it("prefers qualityScore over recallRR when both are present on both runs", async () => {
    const db = setupDb();
    registerQuerySet(db, IDENTITY, SAMPLE_QUERIES);

    const candidates = new Map<string, string>([
      ["q1", "c1"],
      ["q2", "c2"],
    ]);
    const recallR = await runRecallEval(
      SAMPLE_QUERIES,
      adapter({ q1: ["a"], q2: ["b", "c"] }),
    );

    const priorJudges: JudgeEntry[] = [{ judgeId: "j", call: constJudge(3) }];
    const priorQ = await runQualityEval(SAMPLE_QUERIES, candidates, priorJudges);
    recordEvalRun(db, {
      querySetIdentity: IDENTITY,
      mode: "hybrid",
      recallReport: recallR,
      qualityReport: priorQ,
    });

    const currJudges: JudgeEntry[] = [{ judgeId: "j", call: constJudge(5) }];
    const currQ = await runQualityEval(SAMPLE_QUERIES, candidates, currJudges);
    const currentId = recordEvalRun(db, {
      querySetIdentity: IDENTITY,
      mode: "hybrid",
      recallReport: recallR,
      qualityReport: currQ,
    });
    const drift = computeDrift(db, currentId);
    // Recall didn't change between runs → if we used recallRR delta = 0.
    // We use qualityScore: 5 - 3 = +2 per query.
    const q1 = drift.details.find((d) => d.queryId === "q1")!;
    expect(q1.delta).toBe(2);
    expect(drift.improved).toBe(2);
    expect(drift.regressed).toBe(0);
  });

  it("compares against the MOST RECENT prior run, not the oldest", async () => {
    const db = setupDb();
    registerQuerySet(db, IDENTITY, SAMPLE_QUERIES);

    // 3 prior runs, each with different RR for q1.
    const r1 = await runRecallEval(SAMPLE_QUERIES, adapter({ q1: ["a"] }));
    const r2 = await runRecallEval(SAMPLE_QUERIES, adapter({ q1: ["x", "a"] })); // RR=0.5
    const r3 = await runRecallEval(SAMPLE_QUERIES, adapter({ q1: ["a"] })); // RR=1.0
    recordEvalRun(db, {
      runId: "old-1",
      querySetIdentity: IDENTITY,
      mode: "fts_only",
      recallReport: r1,
    });
    recordEvalRun(db, {
      runId: "old-2",
      querySetIdentity: IDENTITY,
      mode: "fts_only",
      recallReport: r2,
    });
    const recentPriorId = recordEvalRun(db, {
      runId: "recent-prior",
      querySetIdentity: IDENTITY,
      mode: "fts_only",
      recallReport: r3,
    });

    // Sleep a tick so ran_at differs (datetime('now') has 1s resolution but
    // ORDER BY also tiebreaks on run_id DESC — so newer run_id wins anyway).
    const currR = await runRecallEval(
      SAMPLE_QUERIES,
      adapter({ q1: ["x", "y", "z", "a"] }), // RR=0.25
    );
    const currentId = recordEvalRun(db, {
      runId: "z-current", // 'z' > 'r' ensures DESC tiebreaker picks recent-prior
      querySetIdentity: IDENTITY,
      mode: "fts_only",
      recallReport: currR,
    });
    const drift = computeDrift(db, currentId);
    expect(drift.priorRunId).toBe(recentPriorId);
    const q1 = drift.details.find((d) => d.queryId === "q1")!;
    expect(q1.priorScore).toBe(1.0); // from r3, not r1 or r2
    expect(q1.currentScore).toBe(0.25);
    expect(q1.delta).toBe(-0.75);
  });

  it("throws when computing drift for a non-existent run", () => {
    const db = setupDb();
    expect(() => computeDrift(db, "missing-run-id")).toThrow(/no eval run found/);
  });
});
