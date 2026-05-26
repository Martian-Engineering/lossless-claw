/**
 * Operator-facing eval runner — LCM v4.1 §11 / Group F.05.
 *
 * Wires the D.03 eval harness (query sets + recall + run recording +
 * drift) into the `/lcm eval` operator command. The retrieval adapter
 * is INJECTED so this module is testable without a Voyage key or vec0
 * extension — production code wires the real adapter (FTS-only or
 * hybrid) at the call site.
 *
 * What this commit covers:
 *
 *   - Recall@K eval with an arbitrary mode tag (caller provides the
 *     adapter, we report the recall).
 *   - Drift comparison vs the prior run of the same (query_set, mode)
 *     — `recordEvalRun` + `computeDrift` from D.03 do the work; we
 *     just compose them.
 *   - Tolerant of a missing query set: throws with a clear message
 *     instead of an opaque FK violation.
 *
 * What this commit DOES NOT cover (per the task spec — deferred):
 *
 *   - Synthesis-quality (judge) eval. The d.03 judge module exists,
 *     but operator quality eval needs the assemble-pyramid output as
 *     input plus the judge wiring; v4.1 first cut is recall-only.
 *
 *   - 5x noise-floor calibration. That's an operational concern (run
 *     the baseline 5x, compute per-query SD) handled outside this
 *     module by an operator workflow.
 *
 *   - --register-set --queries-file. Operators seed the corpus today
 *     by inserting rows directly via `registerQuerySet()`; a CLI flag
 *     for JSON loading lands in a follow-up.
 */

import type { DatabaseSync } from "node:sqlite";
import { runRecallEval, type RecallReport, type RecallSearchAdapter } from "../eval/recall.js";
import { recordEvalRun, computeDrift, type DriftSummary } from "../eval/run.js";
import { encodeQuerySetId, getQuerySet, type QuerySetIdentity } from "../eval/query-set.js";

export type EvalMode = "fts_only" | "semantic_only" | "hybrid";

export interface RunEvalArgs {
  /** Identifies which query set to run. */
  querySetIdentity: QuerySetIdentity;
  /** Retrieval mode tag — recorded on the run, used to find the prior
   *  run for drift comparison. */
  mode: EvalMode;
  /** Caller-provided retrieval adapter — must call into FTS / hybrid /
   *  semantic search per the mode. */
  retrievalAdapter: RecallSearchAdapter;
  /** Optional caller note recorded on the run. */
  notes?: string;
  /** Defaults to 'manual'. Recorded on the run row. */
  trigger?: "manual" | "prompt-update" | "model-update" | "ci" | "nightly";
  /** Defaults to 1. Recorded on the run row (see eval/run SCHEMA GAPS §3). */
  promptBundleVersion?: number;
  /** K values for recall@K computation. Default [1,5,10,20,50]. */
  kValues?: number[];
}

export interface RunEvalResult {
  runId: string;
  recallReport: RecallReport;
  /** Null if no prior run exists for the same (query_set, mode). */
  drift: DriftSummary | null;
}

export class EvalRunnerError extends Error {
  constructor(
    public readonly kind: "missing_query_set" | "empty_query_set",
    message: string,
  ) {
    super(message);
    this.name = "EvalRunnerError";
  }
}

/**
 * Run a recall eval against the registered query set + injected
 * retrieval adapter. Records the run + computes drift.
 */
export async function runEval(
  db: DatabaseSync,
  args: RunEvalArgs,
): Promise<RunEvalResult> {
  const querySet = getQuerySet(db, args.querySetIdentity);
  if (!querySet) {
    throw new EvalRunnerError(
      "missing_query_set",
      // Final review Finding #4 fix: previous error pointed at a flag
      // (/lcm reconcile-session-keys --register-set) that doesn't exist.
      // Operators seed the eval corpus today via the registerQuerySet()
      // service (not via /lcm). The CLI seed flag is deferred to cycle-2.
      `[eval] query set ${encodeQuerySetId(args.querySetIdentity)} is not registered. ` +
        `Seed via the registerQuerySet() service (Node REPL: ` +
        `registerQuerySet(db, {name, version}, queries[])) ` +
        `or via SQL INSERT into lcm_eval_query_set + lcm_eval_query. ` +
        `The /lcm CLI seed flag is deferred to a cycle-2 follow-up.`,
    );
  }
  if (querySet.queries.length === 0) {
    throw new EvalRunnerError(
      "empty_query_set",
      `[eval] query set ${encodeQuerySetId(args.querySetIdentity)} contains no queries`,
    );
  }

  const recallReport = await runRecallEval(querySet.queries, args.retrievalAdapter, {
    kValues: args.kValues,
  });

  const runId = recordEvalRun(db, {
    querySetIdentity: args.querySetIdentity,
    mode: args.mode,
    recallReport,
    notes: args.notes,
    trigger: args.trigger ?? "manual",
    promptBundleVersion: args.promptBundleVersion,
  });

  // computeDrift returns a DriftSummary even when no prior run exists
  // (priorRunId is null then). We surface that distinction at the
  // operator level by returning null for the "fresh baseline" case
  // rather than a zeroed summary.
  const driftSummary = computeDrift(db, runId);
  const drift = driftSummary.priorRunId === null ? null : driftSummary;

  return { runId, recallReport, drift };
}

/**
 * Format a recall + drift result as an operator-facing markdown
 * summary. Pure formatter — no DB / IO.
 */
export function formatEvalReport(args: {
  querySetIdentity: QuerySetIdentity;
  mode: EvalMode;
  result: RunEvalResult;
}): string {
  const { recallReport, drift, runId } = args.result;
  const lines: string[] = [];

  lines.push(
    `**Eval run** \`${runId}\``,
    `query set: \`${encodeQuerySetId(args.querySetIdentity)}\``,
    `mode: \`${args.mode}\``,
    "",
  );

  // ── Recall@K per-stratum table ────────────────────────────────────
  lines.push("**Recall@K — overall**");
  lines.push(formatRecallLine(recallReport.overall));
  lines.push("");

  const strata = Object.keys(recallReport.byStratum).sort();
  if (strata.length > 0) {
    lines.push("**Recall@K — per stratum**");
    for (const s of strata) {
      lines.push(`  ${s}: ${formatRecallLine(recallReport.byStratum[s]!)}`);
    }
    lines.push("");
  }

  // ── Drift ─────────────────────────────────────────────────────────
  lines.push("**Drift**");
  if (!drift) {
    lines.push("  no prior run for this (query_set, mode) — recorded as new baseline");
  } else {
    const sign = drift.cumulativeDelta >= 0 ? "+" : "";
    lines.push(
      `  vs prior run \`${drift.priorRunId}\`: cumulative_delta=${sign}${drift.cumulativeDelta.toFixed(4)}`,
    );
    lines.push(
      `  drifted=${drift.drifted} (improved=${drift.improved}, regressed=${drift.regressed})`,
    );
  }

  return lines.join("\n");
}

function formatRecallLine(agg: {
  meanRecallAtK: Record<number, number>;
  meanRR: number;
  n: number;
}): string {
  const ks = Object.keys(agg.meanRecallAtK)
    .map((k) => Number(k))
    .sort((a, b) => a - b);
  const recallStr = ks
    .map((k) => `R@${k}=${(agg.meanRecallAtK[k] ?? 0).toFixed(3)}`)
    .join(" ");
  return `n=${agg.n} ${recallStr} MRR=${agg.meanRR.toFixed(3)}`;
}
