/**
 * Retrieval recall@K — LCM v4.1 §11 / D.03.
 *
 * Pure metric module. Given a corpus of QueryRecord (each with optional
 * `expectedSummaryIds`) and an injected `RecallSearchAdapter`, computes:
 *
 *   - per-query recall@K for K ∈ kValues
 *   - per-query reciprocal rank (1/rank of first hit, 0 if none)
 *   - aggregate per-stratum + overall means
 *
 * NO LLM CALLS. Deterministic given the adapter — tests use synthetic
 * adapters that return canned hit lists.
 *
 * The wiring to actually call semantic-search/hybrid-search is a Group F
 * concern (the `/lcm eval` command); this module just measures whatever
 * the adapter returns.
 *
 * Recall@K convention used here:
 *   recallAtK = |hits[:K] ∩ expected| / |expected|
 * where the expected set is taken from the QueryRecord. Queries with
 * no expectedSummaryIds (or an empty list) are SKIPPED for recall
 * computation — their recallAtK map is empty and they don't contribute
 * to the per-stratum / overall means. (They CAN still contribute to
 * synthesis quality eval; that's a separate metric in judge.ts.)
 */

import type { QueryRecord, Stratum } from "./query-set.js";

/**
 * Caller-provided search adapter. The adapter is responsible for
 * whatever retrieval mode is being measured (FTS-only, hybrid,
 * semantic-only, etc.). The adapter's `mode` is opaque to this module.
 */
export interface RecallSearchAdapter {
  /**
   * Given a query, return the IDs the search returned, in rank order
   * (best first). May return more or fewer than max(kValues) — recall@K
   * truncates internally.
   */
  search(query: QueryRecord): Promise<string[]>;
}

export interface RecallResult {
  queryId: string;
  /** Hit list as returned by the adapter. */
  hits: string[];
  /** Ground-truth expected IDs (empty array if the query had none). */
  expected: string[];
  /** K → recall fraction (0..1). Empty if `expected` is empty. */
  recallAtK: Record<number, number>;
  /**
   * Reciprocal rank — 1 / (1-based rank of the first expected ID found
   * anywhere in `hits`). 0 if no expected ID was found.
   * (Standard MRR formula; `recallAtK[1]` is the binary version.)
   */
  reciprocalRank: number;
}

export interface RecallStratumAggregate {
  meanRecallAtK: Record<number, number>;
  meanRR: number;
  /** Number of queries that contributed to these means (i.e. had expected IDs). */
  n: number;
}

export interface RecallReport {
  perQuery: RecallResult[];
  /** Aggregates per stratum. Keys are the strata that had ≥1 scored query. */
  byStratum: Record<string, RecallStratumAggregate>;
  /** Overall aggregate across all scored queries. */
  overall: RecallStratumAggregate;
}

export interface RecallEvalOptions {
  /** K values to compute recall at. Default: [1, 5, 10, 20, 50]. */
  kValues?: number[];
  /**
   * Wave-4 Auditor #15 P1 fix: per-query timeout (ms). A pathological
   * adapter (network hang, vec0 deadlock) without this would hang the
   * whole eval indefinitely. Default 30s; queries that exceed this are
   * reported as failed (zero recall) and the eval continues.
   */
  perQueryTimeoutMs?: number;
}

const DEFAULT_K_VALUES = [1, 5, 10, 20, 50] as const;

function computePerQuery(
  queryId: string,
  hits: string[],
  expected: string[],
  kValues: number[],
): RecallResult {
  const recallAtK: Record<number, number> = {};
  if (expected.length > 0) {
    const expectedSet = new Set(expected);
    for (const k of kValues) {
      // Dedupe the window before counting intersection — if an adapter
      // ever returns the same ID twice (rare but possible), we don't
      // want recall > 1.
      const windowSet = new Set(hits.slice(0, k));
      let intersect = 0;
      for (const id of windowSet) {
        if (expectedSet.has(id)) intersect += 1;
      }
      recallAtK[k] = intersect / expected.length;
    }
  }

  let reciprocalRank = 0;
  if (expected.length > 0) {
    const expectedSet = new Set(expected);
    for (let i = 0; i < hits.length; i++) {
      if (expectedSet.has(hits[i]!)) {
        reciprocalRank = 1 / (i + 1);
        break;
      }
    }
  }

  return { queryId, hits, expected, recallAtK, reciprocalRank };
}

function emptyAggregate(kValues: number[]): RecallStratumAggregate {
  const meanRecallAtK: Record<number, number> = {};
  for (const k of kValues) meanRecallAtK[k] = 0;
  return { meanRecallAtK, meanRR: 0, n: 0 };
}

function aggregate(
  results: RecallResult[],
  kValues: number[],
): RecallStratumAggregate {
  if (results.length === 0) return emptyAggregate(kValues);

  const sumRecall: Record<number, number> = {};
  for (const k of kValues) sumRecall[k] = 0;
  let sumRR = 0;

  for (const r of results) {
    for (const k of kValues) {
      sumRecall[k] = (sumRecall[k] ?? 0) + (r.recallAtK[k] ?? 0);
    }
    sumRR += r.reciprocalRank;
  }

  const meanRecallAtK: Record<number, number> = {};
  for (const k of kValues) meanRecallAtK[k] = (sumRecall[k] ?? 0) / results.length;

  return { meanRecallAtK, meanRR: sumRR / results.length, n: results.length };
}

/**
 * Run the full recall eval. Queries are processed sequentially through
 * the adapter — concurrency is the adapter's call (most retrieval
 * surfaces aren't safe to parallelize against the same SQLite
 * connection).
 *
 * Adapter exceptions are NOT swallowed — if the adapter throws, the
 * caller sees the error. This is deliberate: silently dropping a
 * failed query would skew the aggregate.
 */
export async function runRecallEval(
  queries: QueryRecord[],
  adapter: RecallSearchAdapter,
  opts?: RecallEvalOptions,
): Promise<RecallReport> {
  const kValues = (opts?.kValues ?? DEFAULT_K_VALUES).slice().sort((a, b) => a - b);
  if (kValues.length === 0) throw new Error("kValues must be non-empty");
  for (const k of kValues) {
    if (!Number.isInteger(k) || k < 1) {
      throw new Error(`kValues entries must be positive integers (got ${k})`);
    }
  }

  // Wave-4 Auditor #15 P1 fix + Wave-5 P2 clamp: per-query timeout.
  // Default 30s. Clamp ≤0 / NaN to 30s — perQueryTimeoutMs=0 would
  // resolve immediately and zero out every query's recall, with no
  // error signal. Cap at 5min to prevent operator misuse.
  const requestedTimeoutMs = opts?.perQueryTimeoutMs;
  const perQueryTimeoutMs =
    typeof requestedTimeoutMs === "number" &&
    Number.isFinite(requestedTimeoutMs) &&
    requestedTimeoutMs >= 100
      ? Math.min(requestedTimeoutMs, 5 * 60 * 1000)
      : 30_000;
  const TIMEOUT_SENTINEL = Symbol("recall-eval-timeout");
  const perQuery: RecallResult[] = [];
  for (const q of queries) {
    const expected = q.expectedSummaryIds ?? [];
    // Wave-9 Agent #10 P1 fix: previously the setTimeout was never
    // cleared when the adapter resolved first, leaving a pending
    // timer in the event loop for `perQueryTimeoutMs` per query. For
    // an N=1000 baseline run that's 1000 pending timers + a 30s tail-
    // latency floor before the process can exit. Clear the timer in
    // a finally so neither path leaks it.
    let timerId: NodeJS.Timeout | undefined;
    let hits: string[] | typeof TIMEOUT_SENTINEL;
    try {
      hits = await Promise.race([
        adapter.search(q),
        new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
          timerId = setTimeout(() => resolve(TIMEOUT_SENTINEL), perQueryTimeoutMs);
        }),
      ]);
    } finally {
      if (timerId !== undefined) clearTimeout(timerId);
    }
    // Adapter exceptions still bubble (Promise.race rejects on first rejection)
    const resolvedHits = hits === TIMEOUT_SENTINEL ? [] : hits;
    perQuery.push(computePerQuery(q.queryId, resolvedHits, expected, kValues));
  }

  // Aggregate over queries that have ≥1 expected ID (others contribute
  // empty recallAtK maps and 0 RR — both would skew the mean).
  const scored = perQuery.filter((r) => r.expected.length > 0);

  const byStratumGroups = new Map<Stratum, RecallResult[]>();
  for (const r of scored) {
    const q = queries.find((qq) => qq.queryId === r.queryId);
    if (!q) continue;
    const arr = byStratumGroups.get(q.stratum) ?? [];
    arr.push(r);
    byStratumGroups.set(q.stratum, arr);
  }
  const byStratum: Record<string, RecallStratumAggregate> = {};
  for (const [stratum, results] of byStratumGroups) {
    byStratum[stratum] = aggregate(results, kValues);
  }

  return {
    perQuery,
    byStratum,
    overall: aggregate(scored, kValues),
  };
}
