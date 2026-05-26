import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import {
  EvalRunnerError,
  formatEvalReport,
  runEval,
} from "../src/operator/eval-runner.js";
import { registerQuerySet, type QueryRecord } from "../src/eval/query-set.js";
import type { RecallSearchAdapter } from "../src/eval/recall.js";

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false });
  return db;
}

const SAMPLE_QUERIES: QueryRecord[] = [
  {
    queryId: "q1",
    queryText: "what is the timezone setting",
    stratum: "fts-easy",
    expectedSummaryIds: ["leaf_a", "leaf_b"],
  },
  {
    queryId: "q2",
    queryText: "describe the rebase workflow",
    stratum: "paraphrastic",
    expectedSummaryIds: ["leaf_c"],
  },
  {
    queryId: "q3",
    queryText: "no expected ids — skipped from recall",
    stratum: "fts-medium",
  },
];

/**
 * Build a deterministic adapter that returns canned hits per query
 * id. Tests inject this so neither vec0 nor Voyage are required.
 */
function makeMockAdapter(canned: Record<string, string[]>): RecallSearchAdapter {
  return {
    async search(q) {
      return canned[q.queryId] ?? [];
    },
  };
}

describe("operator-eval-runner — input validation", () => {
  it("throws EvalRunnerError(missing_query_set) when query set is unknown", async () => {
    const db = setupDb();
    await expect(
      runEval(db, {
        querySetIdentity: { name: "no-such-set", version: 1 },
        mode: "fts_only",
        retrievalAdapter: makeMockAdapter({}),
      }),
    ).rejects.toThrow(EvalRunnerError);
    db.close();
  });
});

describe("operator-eval-runner — basic recall flow", () => {
  it("records a run and returns a recall report", async () => {
    const db = setupDb();
    registerQuerySet(db, { name: "test-set", version: 1 }, SAMPLE_QUERIES);
    const result = await runEval(db, {
      querySetIdentity: { name: "test-set", version: 1 },
      mode: "fts_only",
      retrievalAdapter: makeMockAdapter({
        q1: ["leaf_a", "leaf_b", "leaf_x"],
        q2: ["leaf_c", "leaf_y"],
        q3: ["leaf_z"],
      }),
    });
    expect(result.runId).toMatch(/^evalrun_/);
    // q1 hit both expected at top-2; recall@5 = 2/2 = 1.0
    const q1 = result.recallReport.perQuery.find((r) => r.queryId === "q1")!;
    expect(q1.recallAtK[5]).toBe(1.0);
    // q2 hit the one expected at rank 1 → MRR contribution = 1.0
    const q2 = result.recallReport.perQuery.find((r) => r.queryId === "q2")!;
    expect(q2.reciprocalRank).toBe(1.0);
    // overall mean RR averages the SCORED queries (q3 is excluded)
    expect(result.recallReport.overall.n).toBe(2);
    db.close();
  });

  it("records the run row with the correct mode + recall score", async () => {
    const db = setupDb();
    registerQuerySet(db, { name: "test-set", version: 1 }, SAMPLE_QUERIES);
    const result = await runEval(db, {
      querySetIdentity: { name: "test-set", version: 1 },
      mode: "hybrid",
      retrievalAdapter: makeMockAdapter({
        q1: ["leaf_a"],
        q2: ["leaf_c"],
      }),
    });
    const row = db
      .prepare(`SELECT mode_check.*, query_set_id, retrieval_recall_score, per_query_scores
                  FROM lcm_eval_run mode_check WHERE run_id = ?`)
      .get(result.runId) as {
      query_set_id: string;
      retrieval_recall_score: number;
      per_query_scores: string;
    };
    expect(row.query_set_id).toBe("test-set@v1");
    expect(row.retrieval_recall_score).toBeGreaterThan(0);
    const env = JSON.parse(row.per_query_scores);
    expect(env.mode).toBe("hybrid");
    db.close();
  });

  it("first run reports drift=null (no baseline)", async () => {
    const db = setupDb();
    registerQuerySet(db, { name: "test-set", version: 1 }, SAMPLE_QUERIES);
    const result = await runEval(db, {
      querySetIdentity: { name: "test-set", version: 1 },
      mode: "fts_only",
      retrievalAdapter: makeMockAdapter({ q1: ["leaf_a"], q2: ["leaf_c"] }),
    });
    expect(result.drift).toBeNull();
    db.close();
  });
});

describe("operator-eval-runner — drift comparison", () => {
  it("second run computes drift vs first (same query_set + mode)", async () => {
    const db = setupDb();
    registerQuerySet(db, { name: "test-set", version: 1 }, SAMPLE_QUERIES);
    // Run 1: q2 finds expected at rank 1 (MRR=1.0)
    await runEval(db, {
      querySetIdentity: { name: "test-set", version: 1 },
      mode: "fts_only",
      retrievalAdapter: makeMockAdapter({ q1: ["leaf_a", "leaf_b"], q2: ["leaf_c"] }),
    });
    // Run 2: q2 now finds expected at rank 2 (MRR=0.5) — regression
    const second = await runEval(db, {
      querySetIdentity: { name: "test-set", version: 1 },
      mode: "fts_only",
      retrievalAdapter: makeMockAdapter({
        q1: ["leaf_a", "leaf_b"],
        q2: ["leaf_x", "leaf_c"],
      }),
    });
    expect(second.drift).not.toBeNull();
    expect(second.drift!.priorRunId).toMatch(/^evalrun_/);
    // q2 should appear in details with delta ≈ -0.5
    const q2drift = second.drift!.details.find((d) => d.queryId === "q2");
    expect(q2drift?.delta).toBeCloseTo(-0.5, 3);
    db.close();
  });

  it("different mode → fresh baseline (no prior run match)", async () => {
    const db = setupDb();
    registerQuerySet(db, { name: "test-set", version: 1 }, SAMPLE_QUERIES);
    await runEval(db, {
      querySetIdentity: { name: "test-set", version: 1 },
      mode: "fts_only",
      retrievalAdapter: makeMockAdapter({ q1: ["leaf_a"] }),
    });
    const hybridRun = await runEval(db, {
      querySetIdentity: { name: "test-set", version: 1 },
      mode: "hybrid",
      retrievalAdapter: makeMockAdapter({ q1: ["leaf_a"] }),
    });
    expect(hybridRun.drift).toBeNull();
    db.close();
  });
});

describe("operator-eval-runner — formatting", () => {
  it("formatEvalReport renders overall + per-stratum + drift sections", async () => {
    const db = setupDb();
    registerQuerySet(db, { name: "test-set", version: 1 }, SAMPLE_QUERIES);
    const result = await runEval(db, {
      querySetIdentity: { name: "test-set", version: 1 },
      mode: "fts_only",
      retrievalAdapter: makeMockAdapter({
        q1: ["leaf_a", "leaf_b"],
        q2: ["leaf_c"],
      }),
    });
    const text = formatEvalReport({
      querySetIdentity: { name: "test-set", version: 1 },
      mode: "fts_only",
      result,
    });
    expect(text).toContain("Eval run");
    expect(text).toContain("Recall@K — overall");
    expect(text).toContain("MRR=");
    expect(text).toContain("Drift");
    expect(text).toContain("no prior run");
    db.close();
  });

  it("formatEvalReport reports cumulative_delta when a prior run exists", async () => {
    const db = setupDb();
    registerQuerySet(db, { name: "test-set", version: 1 }, SAMPLE_QUERIES);
    await runEval(db, {
      querySetIdentity: { name: "test-set", version: 1 },
      mode: "fts_only",
      retrievalAdapter: makeMockAdapter({ q1: ["leaf_a"], q2: ["leaf_c"] }),
    });
    const second = await runEval(db, {
      querySetIdentity: { name: "test-set", version: 1 },
      mode: "fts_only",
      retrievalAdapter: makeMockAdapter({ q1: ["leaf_a"], q2: ["leaf_x", "leaf_c"] }),
    });
    const text = formatEvalReport({
      querySetIdentity: { name: "test-set", version: 1 },
      mode: "fts_only",
      result: second,
    });
    expect(text).toMatch(/cumulative_delta=/);
    expect(text).toContain("vs prior run");
    db.close();
  });
});

describe("operator-eval-runner — per-stratum aggregation", () => {
  it("groups recall by stratum (only scored queries contribute)", async () => {
    const db = setupDb();
    registerQuerySet(db, { name: "test-set", version: 1 }, SAMPLE_QUERIES);
    const result = await runEval(db, {
      querySetIdentity: { name: "test-set", version: 1 },
      mode: "fts_only",
      retrievalAdapter: makeMockAdapter({
        q1: ["leaf_a", "leaf_b"],
        q2: ["leaf_c"],
        q3: ["leaf_z"],
      }),
    });
    expect(result.recallReport.byStratum["fts-easy"]?.n).toBe(1);
    expect(result.recallReport.byStratum["paraphrastic"]?.n).toBe(1);
    // q3 had no expectedSummaryIds → not in any stratum aggregate
    expect(result.recallReport.byStratum["fts-medium"]).toBeUndefined();
    db.close();
  });
});
