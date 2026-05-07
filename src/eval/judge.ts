/**
 * Synthesis quality judging — LCM v4.1 §11 / D.03.
 *
 * Architecture spec: "ensemble judge (3 different model families) at
 * production gate" → callers inject an arbitrary array of judges
 * (1..N), each independently scores a candidate, and the harness
 * aggregates the per-judge scores.
 *
 * INJECTION PATTERN
 * ─────────────────
 *   Same shape as src/synthesis/dispatch.ts's `LlmCall` — caller
 *   supplies the function, tests inject deterministic mocks. No model
 *   wiring lives here; the wiring is a Group F concern.
 *
 * JUDGE FAILURE HANDLING
 * ──────────────────────
 *   A judge can:
 *     - return a score (1..5)
 *     - return null score (judge couldn't decide — counted as failure)
 *     - throw (also counted as failure; we record reason as the error
 *       message and a null score)
 *
 *   Per-query meanScore is computed over only the judges that returned
 *   a non-null score. If ALL judges failed for a query, meanScore is
 *   null and the failure count increments.
 *
 *   The aggregate `judgeFailures` counts the total number of judge
 *   failure events across all queries (not the count of queries that
 *   had ≥1 failure).
 *
 * SCORE RANGE
 * ───────────
 *   We don't enforce 1..5 on the judge return value (the architecture
 *   may evolve to use a different rubric scale); we only require the
 *   number to be finite. Callers are responsible for prompting their
 *   judges into the expected range.
 */

import type { QueryRecord } from "./query-set.js";

export interface JudgeCallArgs {
  query: string;
  candidate: string;
  /** Optional reference text for grounded judging. */
  reference?: string;
}

export interface JudgeCallResult {
  /** Score, typically 1..5. Null if the judge couldn't decide. */
  score: number | null;
  /** Brief human-readable reason — surfaced in the per-query report. */
  reason: string;
}

export interface JudgeCall {
  judge(args: JudgeCallArgs): Promise<JudgeCallResult>;
}

/** A judge entry in the ensemble. `judgeId` is opaque (typically the
 *  model family name, e.g. 'claude-opus-4-7' or 'gpt-5-mini'). */
export interface JudgeEntry {
  judgeId: string;
  call: JudgeCall;
}

export interface PerJudgeScore {
  judgeId: string;
  score: number | null;
  reason: string;
}

export interface QualityResult {
  queryId: string;
  candidate: string;
  perJudgeScores: PerJudgeScore[];
  /** Mean of non-null judge scores. Null if every judge failed. */
  meanScore: number | null;
}

export interface QualityReport {
  perQuery: QualityResult[];
  overall: {
    /** Mean over queries with ≥1 successful judge. 0 if no such queries. */
    meanScore: number;
    /** Number of queries that had ≥1 successful judge. */
    n: number;
    /** Total judge failure events across (queries × judges). */
    judgeFailures: number;
  };
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

async function callOneJudge(
  entry: JudgeEntry,
  args: JudgeCallArgs,
): Promise<PerJudgeScore> {
  let result: JudgeCallResult;
  try {
    result = await entry.call.judge(args);
  } catch (err) {
    return {
      judgeId: entry.judgeId,
      score: null,
      reason: `judge_error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (result.score === null || result.score === undefined) {
    return {
      judgeId: entry.judgeId,
      score: null,
      reason: result.reason ?? "no_decision",
    };
  }
  if (!isFiniteNumber(result.score)) {
    return {
      judgeId: entry.judgeId,
      score: null,
      reason: `invalid_score: ${String(result.score)}`,
    };
  }
  return { judgeId: entry.judgeId, score: result.score, reason: result.reason ?? "" };
}

/**
 * Run quality judging for a set of (query → candidate) pairs.
 *
 * Queries with no entry in `candidatesByQuery` are SKIPPED (they
 * contribute no per-query result and don't bump n). This is the
 * common case when retrieval failed and there's nothing to judge.
 *
 * Within a single query we run all judges in parallel via
 * `Promise.all` — they're independent calls to different external
 * services. Across queries we run sequentially to avoid stampeding
 * the same judge endpoints; if you want intra-set concurrency, batch
 * candidatesByQuery yourself and call this in chunks.
 */
export async function runQualityEval(
  queries: QueryRecord[],
  candidatesByQuery: Map<string, string>,
  judges: JudgeEntry[],
): Promise<QualityReport> {
  if (judges.length === 0) {
    throw new Error("runQualityEval requires at least one judge");
  }

  const perQuery: QualityResult[] = [];
  let totalJudgeFailures = 0;

  for (const q of queries) {
    const candidate = candidatesByQuery.get(q.queryId);
    if (candidate === undefined) continue; // skip — nothing to score.

    const args: JudgeCallArgs = { query: q.queryText, candidate };
    if (q.referenceSummary !== undefined) args.reference = q.referenceSummary;

    const perJudgeScores = await Promise.all(
      judges.map((j) => callOneJudge(j, args)),
    );

    let sum = 0;
    let count = 0;
    for (const s of perJudgeScores) {
      if (s.score === null) {
        totalJudgeFailures += 1;
      } else {
        sum += s.score;
        count += 1;
      }
    }
    const meanScore = count > 0 ? sum / count : null;
    perQuery.push({ queryId: q.queryId, candidate, perJudgeScores, meanScore });
  }

  const successful = perQuery.filter((r) => r.meanScore !== null);
  const overallMean =
    successful.length > 0
      ? successful.reduce((acc, r) => acc + (r.meanScore as number), 0) / successful.length
      : 0;

  return {
    perQuery,
    overall: {
      meanScore: overallMean,
      n: successful.length,
      judgeFailures: totalJudgeFailures,
    },
  };
}
