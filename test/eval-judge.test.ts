import { describe, expect, it } from "vitest";
import {
  runQualityEval,
  type JudgeCall,
  type JudgeCallArgs,
  type JudgeCallResult,
  type JudgeEntry,
} from "../src/eval/judge.js";
import type { QueryRecord } from "../src/eval/query-set.js";

/** Build a deterministic judge that always returns the same score+reason. */
function constJudge(score: number | null, reason = "test"): JudgeCall {
  return {
    async judge(): Promise<JudgeCallResult> {
      return { score, reason };
    },
  };
}

/** Judge that throws on every call. */
function throwingJudge(message: string): JudgeCall {
  return {
    async judge(): Promise<JudgeCallResult> {
      throw new Error(message);
    },
  };
}

/** Judge that varies score by query. */
function perQueryJudge(scores: Record<string, number | null>): JudgeCall {
  return {
    async judge(args: JudgeCallArgs): Promise<JudgeCallResult> {
      const score = scores[args.query] ?? null;
      return { score, reason: `score for ${args.query}` };
    },
  };
}

const QUERIES: QueryRecord[] = [
  { queryId: "q1", queryText: "what is X", stratum: "fts-easy" },
  { queryId: "q2", queryText: "explain Y", stratum: "fts-medium" },
  {
    queryId: "q3",
    queryText: "describe Z",
    stratum: "paraphrastic",
    referenceSummary: "Z is the third letter of the latin alphabet from the end.",
  },
];

const CANDIDATES = new Map<string, string>([
  ["q1", "X is a thing."],
  ["q2", "Y is another thing."],
  ["q3", "Z is the last letter of the latin alphabet."],
]);

describe("eval/judge — basic ensemble", () => {
  it("aggregates across multiple judges", async () => {
    const judges: JudgeEntry[] = [
      { judgeId: "j-a", call: constJudge(4) },
      { judgeId: "j-b", call: constJudge(5) },
      { judgeId: "j-c", call: constJudge(3) },
    ];
    const report = await runQualityEval(QUERIES, CANDIDATES, judges);
    expect(report.perQuery).toHaveLength(3);
    for (const r of report.perQuery) {
      expect(r.perJudgeScores).toHaveLength(3);
      expect(r.meanScore).toBe(4); // (4+5+3)/3 = 4
    }
    expect(report.overall.meanScore).toBe(4);
    expect(report.overall.n).toBe(3);
    expect(report.overall.judgeFailures).toBe(0);
  });

  it("works with a single judge", async () => {
    const judges: JudgeEntry[] = [{ judgeId: "solo", call: constJudge(3.5) }];
    const report = await runQualityEval(QUERIES, CANDIDATES, judges);
    expect(report.overall.meanScore).toBe(3.5);
    expect(report.overall.n).toBe(3);
  });

  it("requires at least one judge", async () => {
    await expect(runQualityEval(QUERIES, CANDIDATES, [])).rejects.toThrow(
      /at least one judge/,
    );
  });
});

describe("eval/judge — failure handling", () => {
  it("treats null-score returns as failures (not in mean)", async () => {
    const judges: JudgeEntry[] = [
      { judgeId: "j-a", call: constJudge(4) },
      { judgeId: "j-b", call: constJudge(null, "no-decision") },
    ];
    const report = await runQualityEval(QUERIES, CANDIDATES, judges);
    for (const r of report.perQuery) {
      expect(r.perJudgeScores).toHaveLength(2);
      expect(r.meanScore).toBe(4); // 4 from j-a; j-b's null is excluded
    }
    expect(report.overall.judgeFailures).toBe(3); // j-b failed on all 3 queries
    expect(report.overall.n).toBe(3); // all 3 queries had ≥1 success
  });

  it("treats throwing judges as failures (with judge_error reason)", async () => {
    const judges: JudgeEntry[] = [
      { judgeId: "j-good", call: constJudge(5) },
      { judgeId: "j-broken", call: throwingJudge("network timeout") },
    ];
    const report = await runQualityEval(QUERIES, CANDIDATES, judges);
    const q1 = report.perQuery.find((r) => r.queryId === "q1")!;
    const brokenScore = q1.perJudgeScores.find((s) => s.judgeId === "j-broken")!;
    expect(brokenScore.score).toBeNull();
    expect(brokenScore.reason).toMatch(/judge_error.*network timeout/);
    expect(q1.meanScore).toBe(5);
    expect(report.overall.judgeFailures).toBe(3);
  });

  it("treats non-finite scores as failures", async () => {
    const weirdJudge: JudgeCall = {
      async judge() {
        return { score: Number.NaN, reason: "?" };
      },
    };
    const judges: JudgeEntry[] = [
      { judgeId: "j-good", call: constJudge(4) },
      { judgeId: "j-weird", call: weirdJudge },
    ];
    const report = await runQualityEval(QUERIES, CANDIDATES, judges);
    const q1 = report.perQuery[0]!;
    const weird = q1.perJudgeScores.find((s) => s.judgeId === "j-weird")!;
    expect(weird.score).toBeNull();
    expect(weird.reason).toMatch(/invalid_score/);
  });

  it("returns null meanScore when ALL judges fail for a query", async () => {
    const judges: JudgeEntry[] = [
      { judgeId: "j-a", call: throwingJudge("A down") },
      { judgeId: "j-b", call: constJudge(null, "B can't tell") },
    ];
    const report = await runQualityEval(QUERIES, CANDIDATES, judges);
    for (const r of report.perQuery) {
      expect(r.meanScore).toBeNull();
    }
    // overall.n = number of queries with ≥1 success → 0
    expect(report.overall.n).toBe(0);
    expect(report.overall.meanScore).toBe(0);
    expect(report.overall.judgeFailures).toBe(6); // 2 judges × 3 queries
  });

  it("computes overall mean over only queries that had ≥1 success", async () => {
    // q1 + q2 succeed (judges return valid scores); q3 has all judges fail.
    const j1 = perQueryJudge({ "what is X": 4, "explain Y": 5, "describe Z": null });
    const j2 = perQueryJudge({
      "what is X": 2,
      "explain Y": 3,
      "describe Z": null,
    });
    const judges: JudgeEntry[] = [
      { judgeId: "j1", call: j1 },
      { judgeId: "j2", call: j2 },
    ];
    const report = await runQualityEval(QUERIES, CANDIDATES, judges);
    // q1.mean = (4+2)/2 = 3; q2.mean = (5+3)/2 = 4; q3.mean = null
    expect(report.perQuery.find((r) => r.queryId === "q1")!.meanScore).toBe(3);
    expect(report.perQuery.find((r) => r.queryId === "q2")!.meanScore).toBe(4);
    expect(report.perQuery.find((r) => r.queryId === "q3")!.meanScore).toBeNull();
    // overall = (3+4)/2 = 3.5; n = 2; failures = 2 (both judges on q3)
    expect(report.overall.meanScore).toBe(3.5);
    expect(report.overall.n).toBe(2);
    expect(report.overall.judgeFailures).toBe(2);
  });
});

describe("eval/judge — query selection", () => {
  it("skips queries with no candidate (no per-query result, no n bump)", async () => {
    const partial = new Map<string, string>([["q1", "X candidate"]]);
    const judges: JudgeEntry[] = [{ judgeId: "j", call: constJudge(5) }];
    const report = await runQualityEval(QUERIES, partial, judges);
    expect(report.perQuery).toHaveLength(1);
    expect(report.perQuery[0]!.queryId).toBe("q1");
    expect(report.overall.n).toBe(1);
  });

  it("forwards reference text when present on the query", async () => {
    let seenRef: string | undefined;
    const sniff: JudgeCall = {
      async judge(args: JudgeCallArgs) {
        seenRef = args.reference;
        return { score: 5, reason: "ok" };
      },
    };
    const judges: JudgeEntry[] = [{ judgeId: "sniff", call: sniff }];
    await runQualityEval([QUERIES[2]!], CANDIDATES, judges);
    expect(seenRef).toBe(
      "Z is the third letter of the latin alphabet from the end.",
    );
  });

  it("does NOT forward reference when the query lacks one", async () => {
    let seenRef: string | undefined = "set-to-something-non-undefined";
    const sniff: JudgeCall = {
      async judge(args: JudgeCallArgs) {
        seenRef = args.reference;
        return { score: 5, reason: "ok" };
      },
    };
    const judges: JudgeEntry[] = [{ judgeId: "sniff", call: sniff }];
    await runQualityEval([QUERIES[0]!], CANDIDATES, judges);
    expect(seenRef).toBeUndefined();
  });
});
