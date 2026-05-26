import { describe, expect, it } from "vitest";
import type { QueryRecord } from "../src/eval/query-set.js";
import {
  runRecallEval,
  type RecallSearchAdapter,
} from "../src/eval/recall.js";

/** Simple deterministic adapter — returns canned hits per queryId. */
function fakeAdapter(byId: Record<string, string[]>): RecallSearchAdapter {
  return {
    async search(q: QueryRecord): Promise<string[]> {
      return byId[q.queryId] ?? [];
    },
  };
}

const QUERIES: QueryRecord[] = [
  // q1: 1 expected, returned at rank 1 → recall@1=1.0, RR=1.0
  {
    queryId: "q1",
    queryText: "perfect hit at top",
    stratum: "fts-easy",
    expectedSummaryIds: ["sum_a"],
  },
  // q2: 2 expected, returned at ranks 2 and 5 → recall@1=0, @5=1.0, RR=0.5
  {
    queryId: "q2",
    queryText: "two expected, partial @ low K",
    stratum: "fts-medium",
    expectedSummaryIds: ["sum_b", "sum_c"],
  },
  // q3: paraphrastic, no hits at all → recall=0 everywhere, RR=0
  {
    queryId: "q3",
    queryText: "paraphrastic, total miss",
    stratum: "paraphrastic",
    expectedSummaryIds: ["sum_d"],
  },
  // q4: no expected IDs → SKIPPED from aggregates
  {
    queryId: "q4",
    queryText: "no ground truth",
    stratum: "fts-easy",
  },
];

const HITS = {
  q1: ["sum_a", "sum_x", "sum_y"],
  q2: ["sum_x", "sum_b", "sum_y", "sum_z", "sum_c"],
  q3: ["sum_x", "sum_y", "sum_z"],
  q4: ["sum_x"],
};

describe("eval/recall — per-query metrics", () => {
  it("computes recall@K + RR for a perfect rank-1 hit", async () => {
    const report = await runRecallEval(QUERIES, fakeAdapter(HITS), {
      kValues: [1, 5, 10],
    });
    const q1 = report.perQuery.find((r) => r.queryId === "q1")!;
    expect(q1.recallAtK[1]).toBe(1.0);
    expect(q1.recallAtK[5]).toBe(1.0);
    expect(q1.reciprocalRank).toBe(1.0);
  });

  it("computes recall@K + RR for partial hits at higher K", async () => {
    const report = await runRecallEval(QUERIES, fakeAdapter(HITS), {
      kValues: [1, 5, 10],
    });
    const q2 = report.perQuery.find((r) => r.queryId === "q2")!;
    // q2 expected = [sum_b, sum_c]. hits = [sum_x, sum_b, sum_y, sum_z, sum_c]
    // window@1 = [sum_x] → 0/2 = 0
    // window@5 = all 5 → both found → 2/2 = 1.0
    expect(q2.recallAtK[1]).toBe(0);
    expect(q2.recallAtK[5]).toBe(1.0);
    expect(q2.reciprocalRank).toBe(0.5); // sum_b at rank 2 → 1/2
  });

  it("returns zero recall + zero RR for total misses", async () => {
    const report = await runRecallEval(QUERIES, fakeAdapter(HITS), {
      kValues: [1, 5, 10],
    });
    const q3 = report.perQuery.find((r) => r.queryId === "q3")!;
    expect(q3.recallAtK[1]).toBe(0);
    expect(q3.recallAtK[5]).toBe(0);
    expect(q3.recallAtK[10]).toBe(0);
    expect(q3.reciprocalRank).toBe(0);
  });

  it("returns empty recallAtK + 0 RR for queries with no expected", async () => {
    const report = await runRecallEval(QUERIES, fakeAdapter(HITS), {
      kValues: [1, 5, 10],
    });
    const q4 = report.perQuery.find((r) => r.queryId === "q4")!;
    expect(q4.recallAtK).toEqual({});
    expect(q4.expected).toEqual([]);
    expect(q4.reciprocalRank).toBe(0);
  });
});

describe("eval/recall — aggregates", () => {
  it("aggregates per-stratum, skipping queries with no expected", async () => {
    const report = await runRecallEval(QUERIES, fakeAdapter(HITS), {
      kValues: [1, 5],
    });
    // Strata that have ≥1 SCORED query (i.e., had expected IDs):
    //   fts-easy: q1 only (q4 skipped)
    //   fts-medium: q2
    //   paraphrastic: q3
    expect(report.byStratum["fts-easy"]!.n).toBe(1);
    expect(report.byStratum["fts-easy"]!.meanRecallAtK[1]).toBe(1.0);
    expect(report.byStratum["fts-easy"]!.meanRR).toBe(1.0);

    expect(report.byStratum["fts-medium"]!.n).toBe(1);
    expect(report.byStratum["fts-medium"]!.meanRecallAtK[1]).toBe(0);
    expect(report.byStratum["fts-medium"]!.meanRecallAtK[5]).toBe(1.0);
    expect(report.byStratum["fts-medium"]!.meanRR).toBe(0.5);

    expect(report.byStratum["paraphrastic"]!.n).toBe(1);
    expect(report.byStratum["paraphrastic"]!.meanRecallAtK[1]).toBe(0);
  });

  it("computes overall mean across scored queries only", async () => {
    const report = await runRecallEval(QUERIES, fakeAdapter(HITS), {
      kValues: [1, 5],
    });
    // Scored: q1, q2, q3 (3 queries). mean recall@1 = (1+0+0)/3 = 0.333…
    expect(report.overall.n).toBe(3);
    expect(report.overall.meanRecallAtK[1]).toBeCloseTo(1 / 3, 5);
    expect(report.overall.meanRecallAtK[5]).toBeCloseTo(2 / 3, 5);
    // mean RR = (1.0 + 0.5 + 0) / 3 = 0.5
    expect(report.overall.meanRR).toBeCloseTo(0.5, 5);
  });

  it("uses default kValues [1,5,10,20,50] when none specified", async () => {
    const report = await runRecallEval(QUERIES.slice(0, 1), fakeAdapter(HITS));
    const q1 = report.perQuery[0]!;
    expect(Object.keys(q1.recallAtK).sort((a, b) => +a - +b)).toEqual([
      "1",
      "5",
      "10",
      "20",
      "50",
    ]);
  });

  it("sorts kValues ascending internally (caller can supply unsorted)", async () => {
    const report = await runRecallEval([QUERIES[0]!], fakeAdapter(HITS), {
      kValues: [50, 1, 5],
    });
    const q1 = report.perQuery[0]!;
    expect(q1.recallAtK[1]).toBe(1.0);
    expect(q1.recallAtK[5]).toBe(1.0);
    expect(q1.recallAtK[50]).toBe(1.0);
  });

  it("rejects empty kValues", async () => {
    await expect(
      runRecallEval([QUERIES[0]!], fakeAdapter(HITS), { kValues: [] }),
    ).rejects.toThrow(/non-empty/);
  });

  it("rejects non-positive K", async () => {
    await expect(
      runRecallEval([QUERIES[0]!], fakeAdapter(HITS), { kValues: [0, 5] }),
    ).rejects.toThrow(/positive integers/);
    await expect(
      runRecallEval([QUERIES[0]!], fakeAdapter(HITS), { kValues: [1.5] }),
    ).rejects.toThrow(/positive integers/);
  });
});

describe("eval/recall — edge cases", () => {
  it("returns empty report when given no queries", async () => {
    const report = await runRecallEval([], fakeAdapter(HITS), { kValues: [1, 5] });
    expect(report.perQuery).toEqual([]);
    expect(report.byStratum).toEqual({});
    expect(report.overall.n).toBe(0);
    expect(report.overall.meanRR).toBe(0);
    expect(report.overall.meanRecallAtK[1]).toBe(0);
  });

  it("propagates adapter exceptions (does not swallow)", async () => {
    const failingAdapter: RecallSearchAdapter = {
      async search() { throw new Error("retrieval boom"); },
    };
    await expect(
      runRecallEval([QUERIES[0]!], failingAdapter, { kValues: [1] }),
    ).rejects.toThrow(/retrieval boom/);
  });

  it("dedupes the window so duplicate hits don't push recall above 1", async () => {
    const queries: QueryRecord[] = [
      {
        queryId: "qx",
        queryText: "x",
        stratum: "fts-easy",
        expectedSummaryIds: ["a", "b"],
      },
    ];
    const adapter = fakeAdapter({ qx: ["a", "a", "b", "b", "c"] });
    const report = await runRecallEval(queries, adapter, { kValues: [3] });
    // window@3 = [a, a, b] → deduped to {a, b} → ∩ expected = {a, b} → 2/2 = 1.0
    expect(report.perQuery[0]!.recallAtK[3]).toBe(1.0);
  });
});
