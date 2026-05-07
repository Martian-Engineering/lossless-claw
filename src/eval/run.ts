/**
 * Eval run recording + drift — LCM v4.1 §11 / D.03.
 *
 * Records eval invocations into `lcm_eval_run` (one row per
 * (query_set_id, mode, run) triple) and computes drift vs the most-
 * recent prior run of the same (query_set_id, mode).
 *
 * SCHEMA GAPS (documented; not patched here)
 * ──────────────────────────────────────────
 *   1. `lcm_eval_run` has no `mode` column. The architecture spec
 *      asks us to compare runs of the SAME (query_set, mode) pair, so
 *      we serialize `mode` into the `per_query_scores` JSON envelope
 *      (`{"mode": "...", "perQuery": [...]}`). `selectPriorRun` parses
 *      this back out to find the right prior run. A schema migration
 *      that adds `mode TEXT NOT NULL` would let us index this directly
 *      and is recommended for v4.2.
 *
 *   2. `lcm_eval_drift` is aggregate-only — `cumulative_delta` +
 *      `window_runs`. The task spec asks for per-query drift; we
 *      surface that detail via the function return value (`details`)
 *      but only PERSIST the aggregate. A future migration could add
 *      a `lcm_eval_drift_per_query` table.
 *
 *   3. `lcm_eval_run.prompt_bundle_version` is NOT NULL with no schema
 *      default. Callers that don't yet wire the prompt-registry
 *      version into here can pass any positive integer (we default to
 *      1 if `promptBundleVersion` is omitted on the EvalRunRecord).
 *
 *   4. `lcm_eval_run.retrieval_recall_score` and
 *      `synthesis_quality_score` are both NOT NULL. If the caller
 *      provides only one of recallReport/qualityReport, the other
 *      score is recorded as 0 (and a flag in the per_query_scores
 *      envelope marks which side was actually measured).
 */

import type { DatabaseSync } from "node:sqlite";
import type { QualityReport } from "./judge.js";
import { encodeQuerySetId, type QuerySetIdentity } from "./query-set.js";
import type { RecallReport } from "./recall.js";

export type EvalTrigger =
  | "manual"
  | "prompt-update"
  | "model-update"
  | "ci"
  | "nightly";

export interface EvalRunRecord {
  /**
   * Optional caller-provided run_id. If omitted we generate one
   * (timestamp + random suffix). Returned by `recordEvalRun`.
   */
  runId?: string;
  querySetIdentity: QuerySetIdentity;
  /** 'fts_only' | 'hybrid' | 'semantic_only' | etc. — opaque tag. */
  mode: string;
  recallReport?: RecallReport;
  qualityReport?: QualityReport;
  /** Free-form caller note; stored in the per_query_scores envelope. */
  notes?: string;
  /** Defaults to 'manual' if omitted. */
  trigger?: EvalTrigger;
  /** Defaults to 1 if omitted. See SCHEMA GAPS §3. */
  promptBundleVersion?: number;
  /** Optional noise-floor SD from baseline calibration. */
  noiseFloorSd?: number;
}

export interface DriftDetail {
  queryId: string;
  /** Score on the prior run; null if the query wasn't in the prior run. */
  priorScore: number | null;
  /** Score on the current run; null if not in the current run. */
  currentScore: number | null;
  /** currentScore - priorScore. Null if either side is missing. */
  delta: number | null;
}

export interface DriftSummary {
  /** Number of per-query scores that changed by ≥ noise floor (or by any amount if no floor). */
  drifted: number;
  /** Of those, count that improved (delta > 0). */
  improved: number;
  /** Of those, count that regressed (delta < 0). */
  regressed: number;
  /** Per-query detail, sorted by absolute delta DESC. */
  details: DriftDetail[];
  /** ID of the run we compared against; null if no prior run existed. */
  priorRunId: string | null;
  /** Aggregate cumulative delta (sum of per-query deltas) — written to lcm_eval_drift. */
  cumulativeDelta: number;
}

/**
 * JSON envelope written to lcm_eval_run.per_query_scores.
 * Versioned so we can evolve the shape later.
 */
interface PerQueryScoresEnvelope {
  v: 1;
  mode: string;
  notes?: string;
  hasRecall: boolean;
  hasQuality: boolean;
  /**
   * queryId → {recallAtK?, recallRR?, qualityScore?}. Used by drift
   * to compare same-query scores across runs.
   */
  perQuery: Record<
    string,
    {
      recallRR?: number;
      // We aggregate quality on `meanScore` (mean of judge scores).
      qualityScore?: number | null;
    }
  >;
}

function buildEnvelope(record: EvalRunRecord): PerQueryScoresEnvelope {
  const env: PerQueryScoresEnvelope = {
    v: 1,
    mode: record.mode,
    hasRecall: !!record.recallReport,
    hasQuality: !!record.qualityReport,
    perQuery: {},
  };
  if (record.notes !== undefined) env.notes = record.notes;

  if (record.recallReport) {
    for (const r of record.recallReport.perQuery) {
      const slot = env.perQuery[r.queryId] ?? {};
      slot.recallRR = r.reciprocalRank;
      env.perQuery[r.queryId] = slot;
    }
  }
  if (record.qualityReport) {
    for (const r of record.qualityReport.perQuery) {
      const slot = env.perQuery[r.queryId] ?? {};
      slot.qualityScore = r.meanScore;
      env.perQuery[r.queryId] = slot;
    }
  }

  return env;
}

function generateRunId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `evalrun_${ts}_${rand}`;
}

function generateDriftId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `drift_${ts}_${rand}`;
}

function judgeModelsFromQualityReport(report: QualityReport | undefined): string[] {
  if (!report) return [];
  const seen = new Set<string>();
  for (const r of report.perQuery) {
    for (const s of r.perJudgeScores) seen.add(s.judgeId);
  }
  return [...seen].sort();
}

/**
 * Insert a single eval run row. Returns the run_id.
 */
export function recordEvalRun(db: DatabaseSync, record: EvalRunRecord): string {
  const runId = record.runId ?? generateRunId();
  const querySetId = encodeQuerySetId(record.querySetIdentity);

  // Verify FK target exists — better error than the SQLite FK violation.
  const headerStmt = db.prepare(
    `SELECT 1 FROM lcm_eval_query_set WHERE query_set_id = ?`,
  );
  if (!headerStmt.get(querySetId)) {
    throw new Error(
      `cannot record eval run for unregistered query set ${querySetId}`,
    );
  }

  const recallScore = record.recallReport?.overall.meanRR ?? 0;
  const qualityScore = record.qualityReport?.overall.meanScore ?? 0;
  const envelope = buildEnvelope(record);
  const judgeModels = judgeModelsFromQualityReport(record.qualityReport);
  const trigger: EvalTrigger = record.trigger ?? "manual";
  const promptBundleVersion = record.promptBundleVersion ?? 1;

  const insertStmt = db.prepare(
    `INSERT INTO lcm_eval_run (
       run_id, query_set_id, prompt_bundle_version,
       retrieval_recall_score, synthesis_quality_score,
       per_query_scores, judge_models, noise_floor_sd, trigger
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertStmt.run(
    runId,
    querySetId,
    promptBundleVersion,
    recallScore,
    qualityScore,
    JSON.stringify(envelope),
    JSON.stringify(judgeModels),
    record.noiseFloorSd ?? null,
    trigger,
  );

  return runId;
}

/**
 * Find the most-recent run with the same (query_set_id, mode) that
 * isn't `currentRunId`. Mode is parsed from the JSON envelope (see
 * SCHEMA GAPS §1).
 */
function selectPriorRun(
  db: DatabaseSync,
  querySetId: string,
  mode: string,
  currentRunId: string,
): { runId: string; envelope: PerQueryScoresEnvelope } | null {
  const stmt = db.prepare(
    `SELECT run_id, per_query_scores
     FROM lcm_eval_run
     WHERE query_set_id = ? AND run_id != ?
     ORDER BY ran_at DESC, run_id DESC`,
  );
  const rows = stmt.all(querySetId, currentRunId) as Array<{
    run_id: string;
    per_query_scores: string;
  }>;
  for (const row of rows) {
    let env: PerQueryScoresEnvelope;
    try {
      env = JSON.parse(row.per_query_scores) as PerQueryScoresEnvelope;
    } catch {
      continue; // skip malformed envelope.
    }
    if (env.mode === mode) return { runId: row.run_id, envelope: env };
  }
  return null;
}

/**
 * Pick the per-query score we'll diff. Preference order:
 *   1. qualityScore (if both runs have it)
 *   2. recallRR     (if both runs have it)
 *   3. null         (otherwise — the query is excluded from drift)
 */
function pickComparableScore(
  prior: { recallRR?: number; qualityScore?: number | null } | undefined,
  current: { recallRR?: number; qualityScore?: number | null } | undefined,
): { prior: number | null; current: number | null } {
  const pq = prior?.qualityScore;
  const cq = current?.qualityScore;
  if (typeof pq === "number" && typeof cq === "number") {
    return { prior: pq, current: cq };
  }
  const pr = prior?.recallRR;
  const cr = current?.recallRR;
  if (typeof pr === "number" && typeof cr === "number") {
    return { prior: pr, current: cr };
  }
  return {
    prior: typeof pq === "number" ? pq : typeof pr === "number" ? pr : null,
    current: typeof cq === "number" ? cq : typeof cr === "number" ? cr : null,
  };
}

/**
 * Compare `runId` to the most-recent prior run of the same
 * (query_set_id, mode). Records aggregate drift into lcm_eval_drift.
 *
 * Returns a DriftSummary with per-query detail. If no prior run
 * exists, returns a zero summary and writes nothing to lcm_eval_drift.
 *
 * "drifted" threshold: if `noise_floor_sd` was recorded on the
 * current run, the threshold is 2× that SD (per architecture-v4.1
 * §11.1 — "2× empirical SD"). Otherwise any non-zero delta counts.
 */
export function computeDrift(db: DatabaseSync, runId: string): DriftSummary {
  const currentStmt = db.prepare(
    `SELECT query_set_id, per_query_scores, noise_floor_sd
     FROM lcm_eval_run
     WHERE run_id = ?`,
  );
  const currentRow = currentStmt.get(runId) as
    | { query_set_id: string; per_query_scores: string; noise_floor_sd: number | null }
    | undefined;
  if (!currentRow) {
    throw new Error(`computeDrift: no eval run found with id ${runId}`);
  }
  let currentEnv: PerQueryScoresEnvelope;
  try {
    currentEnv = JSON.parse(currentRow.per_query_scores) as PerQueryScoresEnvelope;
  } catch (err) {
    throw new Error(`computeDrift: malformed per_query_scores for run ${runId}: ${String(err)}`);
  }

  const prior = selectPriorRun(
    db,
    currentRow.query_set_id,
    currentEnv.mode,
    runId,
  );
  if (!prior) {
    return {
      drifted: 0,
      improved: 0,
      regressed: 0,
      details: [],
      priorRunId: null,
      cumulativeDelta: 0,
    };
  }

  const allQueryIds = new Set<string>([
    ...Object.keys(prior.envelope.perQuery),
    ...Object.keys(currentEnv.perQuery),
  ]);

  const noiseFloor = currentRow.noise_floor_sd ?? null;
  const driftThreshold = noiseFloor !== null ? 2 * noiseFloor : 0;

  const details: DriftDetail[] = [];
  let drifted = 0;
  let improved = 0;
  let regressed = 0;
  let cumulative = 0;

  for (const qid of allQueryIds) {
    const { prior: ps, current: cs } = pickComparableScore(
      prior.envelope.perQuery[qid],
      currentEnv.perQuery[qid],
    );
    const delta = ps !== null && cs !== null ? cs - ps : null;
    if (delta !== null) {
      cumulative += delta;
      const threshold = driftThreshold;
      const drifted_p =
        threshold > 0 ? Math.abs(delta) >= threshold : delta !== 0;
      if (drifted_p) {
        drifted += 1;
        if (delta > 0) improved += 1;
        else if (delta < 0) regressed += 1;
      }
    }
    details.push({ queryId: qid, priorScore: ps, currentScore: cs, delta });
  }

  details.sort((a, b) => {
    const da = a.delta === null ? -1 : Math.abs(a.delta);
    const db_ = b.delta === null ? -1 : Math.abs(b.delta);
    return db_ - da;
  });

  // Persist aggregate drift (per-query detail not persisted — see SCHEMA GAPS §2).
  const driftStmt = db.prepare(
    `INSERT INTO lcm_eval_drift
      (drift_id, query_set_id, cumulative_delta, window_runs)
     VALUES (?, ?, ?, ?)`,
  );
  driftStmt.run(generateDriftId(), currentRow.query_set_id, cumulative, 2);

  return {
    drifted,
    improved,
    regressed,
    details,
    priorRunId: prior.runId,
    cumulativeDelta: cumulative,
  };
}
