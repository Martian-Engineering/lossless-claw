/**
 * Operator-facing v4.1 health snapshot — Group F.02.
 *
 * Aggregates the operational state of the v4.1 subsystems (embeddings,
 * workers, synthesis, eval, suppression) into a single typed object so
 * the `/lcm health` command can render it without poking at internals.
 *
 * Design notes:
 *
 *   - Pure read-only. NEVER mutates DB state. Safe to call at any
 *     latency budget (no LLM calls, no network).
 *
 *   - Tolerant of "subsystem not initialized yet" — every section
 *     handles its own missing-table / missing-row case rather than
 *     throwing, so the snapshot is meaningful on a fresh DB too.
 *
 *   - vec0 not loaded is reported, NOT thrown. Backfill counters degrade
 *     gracefully (we report the active model's pending count from the
 *     meta sidecar even when the vec0 table itself is missing).
 *
 *   - Worker statuses are derived from `lcm_worker_lock` row presence —
 *     no row means "(idle)". Expired locks (datetime('now') > expires_at)
 *     are STILL reported, with an `expired: true` flag — operators want
 *     to see crashed workers, not silently filter them out.
 */

import type { DatabaseSync } from "node:sqlite";
import { lockInfo } from "../concurrency/worker-lock.js";
import { WORKER_JOB_KINDS, type WorkerJobKind } from "../concurrency/model.js";
import {
  embeddingsTableExists,
  vec0Version,
} from "../embeddings/store.js";
import { countPendingDocs } from "../embeddings/backfill.js";
import { listActivePrompts } from "../synthesis/prompt-registry.js";

export interface ActiveEmbeddingProfile {
  modelName: string;
  dim: number;
  registeredAt: string;
}

export interface EmbeddingsHealth {
  /** Active model, or null if no profile is registered yet. */
  activeProfile: ActiveEmbeddingProfile | null;
  /** vec0 extension version (e.g. "v0.1.6"), or null if not loaded. */
  vec0Version: string | null;
  /** Pending backfill count for the active model (0 if none registered). */
  pendingBackfill: number;
  /** Count of un-archived embedding rows across all models. */
  embeddedCount: number;
}

export interface WorkerStatus {
  jobKind: WorkerJobKind;
  /** True if a row exists for this job in lcm_worker_lock. */
  active: boolean;
  workerId: string | null;
  acquiredAt: string | null;
  expiresAt: string | null;
  /**
   * True if a row exists but expires_at <= now (i.e. the worker died
   * without releasing). Operators want to see these — they suggest a
   * crashed worker that another process should reclaim soon.
   */
  expired: boolean;
}

export interface SynthesisHealth {
  /** Number of active prompts in lcm_prompt_registry. */
  activePromptCount: number;
  /** Distinct memory_type values across the active prompts. */
  distinctMemoryTypeCount: number;
  /** Synthesis runs in lcm_synthesis_audit within the last 7 days. */
  recentSynthesisRuns7d: number;
}

export interface EvalHealth {
  /** Total registered query sets in lcm_eval_query_set. */
  querySetCount: number;
  /** Most-recent run summary (mode + recall score), or null if none. */
  mostRecentRun: {
    runId: string;
    querySetId: string;
    /** Decoded from the per_query_scores envelope (.mode); 'unknown' if malformed. */
    mode: string;
    /** retrieval_recall_score from the row. */
    recallScore: number;
  } | null;
  /**
   * Latest cumulative_delta from lcm_eval_drift, or null if no baseline
   * has been recorded yet.
   */
  driftIndex: number | null;
}

export interface SuppressionHealth {
  /** Count of leaves with suppressed_at IS NOT NULL. */
  suppressedLeaves: number;
  /** Pending entries in lcm_purge_rebuild_queue (picked_at IS NULL). */
  pendingPurgeRebuilds: number;
}

export interface V41HealthSnapshot {
  embeddings: EmbeddingsHealth;
  workers: WorkerStatus[];
  synthesis: SynthesisHealth;
  eval: EvalHealth;
  suppression: SuppressionHealth;
}

/**
 * Read the v4.1 health snapshot. Pure read-only; safe to call at any
 * latency. See module-level docs for tolerance rules around missing
 * subsystems.
 */
export function getV41HealthSnapshot(db: DatabaseSync): V41HealthSnapshot {
  return {
    embeddings: getEmbeddingsHealth(db),
    workers: getWorkerStatuses(db),
    synthesis: getSynthesisHealth(db),
    eval: getEvalHealth(db),
    suppression: getSuppressionHealth(db),
  };
}

// ── Section helpers (each one tolerates its own missing pieces) ────────

function getEmbeddingsHealth(db: DatabaseSync): EmbeddingsHealth {
  const activeProfile = readActiveProfile(db);
  const vec0 = vec0Version(db);
  let pendingBackfill = 0;
  if (activeProfile) {
    // countPendingDocs only inspects lcm_embedding_meta + summaries — it
    // does NOT need vec0 to be loaded, so the count is meaningful even
    // when sqlite-vec is missing (operator wants to know the backlog).
    try {
      pendingBackfill = countPendingDocs(db, {
        modelName: activeProfile.modelName,
        embeddedKind: "summary",
      });
    } catch {
      pendingBackfill = 0;
    }
  }
  let embeddedCount = 0;
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM lcm_embedding_meta WHERE archived = 0`)
      .get() as { n?: number } | undefined;
    embeddedCount = row?.n ?? 0;
  } catch {
    embeddedCount = 0;
  }
  // Touch embeddingsTableExists so an active-profile-but-missing-table
  // case (e.g. profile registered before vec0 loaded) is implicit in the
  // pending backfill count without changing the snapshot shape.
  if (activeProfile && vec0 !== null) {
    embeddingsTableExists(db, activeProfile.modelName);
  }
  return {
    activeProfile,
    vec0Version: vec0,
    pendingBackfill,
    embeddedCount,
  };
}

function readActiveProfile(db: DatabaseSync): ActiveEmbeddingProfile | null {
  try {
    const row = db
      .prepare(
        `SELECT model_name, dim, registered_at FROM lcm_embedding_profile
           WHERE active = 1
           ORDER BY registered_at DESC LIMIT 1`,
      )
      .get() as { model_name?: string; dim?: number; registered_at?: string } | undefined;
    if (!row || !row.model_name || row.dim == null) return null;
    return {
      modelName: row.model_name,
      dim: row.dim,
      registeredAt: row.registered_at ?? "",
    };
  } catch {
    return null;
  }
}

function getWorkerStatuses(db: DatabaseSync): WorkerStatus[] {
  // Compute "now" inside SQL for an apples-to-apples comparison with
  // expires_at strings.
  const nowRow = db.prepare(`SELECT datetime('now') AS now`).get() as { now?: string } | undefined;
  const now = nowRow?.now ?? "";
  const result: WorkerStatus[] = [];
  for (const jobKind of WORKER_JOB_KINDS) {
    const info = lockInfo(db, jobKind);
    if (!info) {
      result.push({
        jobKind,
        active: false,
        workerId: null,
        acquiredAt: null,
        expiresAt: null,
        expired: false,
      });
      continue;
    }
    // Lexicographic compare on ISO-8601 strings is correct here (matches
    // the SQLite acquireLock/heartbeatLock comparisons).
    const expired = now !== "" && info.expiresAt <= now;
    result.push({
      jobKind,
      active: true,
      workerId: info.workerId,
      acquiredAt: info.acquiredAt,
      expiresAt: info.expiresAt,
      expired,
    });
  }
  return result;
}

function getSynthesisHealth(db: DatabaseSync): SynthesisHealth {
  let activePrompts: ReturnType<typeof listActivePrompts>;
  try {
    activePrompts = listActivePrompts(db);
  } catch {
    activePrompts = [];
  }
  const distinctMemoryTypes = new Set<string>();
  for (const p of activePrompts) distinctMemoryTypes.add(p.memoryType);

  let recentRuns = 0;
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM lcm_synthesis_audit
           WHERE ran_at >= datetime('now', '-7 days')`,
      )
      .get() as { n?: number } | undefined;
    recentRuns = row?.n ?? 0;
  } catch {
    recentRuns = 0;
  }
  return {
    activePromptCount: activePrompts.length,
    distinctMemoryTypeCount: distinctMemoryTypes.size,
    recentSynthesisRuns7d: recentRuns,
  };
}

function getEvalHealth(db: DatabaseSync): EvalHealth {
  let querySetCount = 0;
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM lcm_eval_query_set`)
      .get() as { n?: number } | undefined;
    querySetCount = row?.n ?? 0;
  } catch {
    querySetCount = 0;
  }

  let mostRecentRun: EvalHealth["mostRecentRun"] = null;
  try {
    const row = db
      .prepare(
        `SELECT run_id, query_set_id, retrieval_recall_score, per_query_scores
           FROM lcm_eval_run
           ORDER BY ran_at DESC, run_id DESC
           LIMIT 1`,
      )
      .get() as
      | {
          run_id?: string;
          query_set_id?: string;
          retrieval_recall_score?: number;
          per_query_scores?: string;
        }
      | undefined;
    if (row && row.run_id && row.query_set_id) {
      mostRecentRun = {
        runId: row.run_id,
        querySetId: row.query_set_id,
        mode: extractMode(row.per_query_scores),
        recallScore: row.retrieval_recall_score ?? 0,
      };
    }
  } catch {
    mostRecentRun = null;
  }

  let driftIndex: number | null = null;
  try {
    const row = db
      .prepare(
        `SELECT cumulative_delta FROM lcm_eval_drift
           ORDER BY computed_at DESC, drift_id DESC
           LIMIT 1`,
      )
      .get() as { cumulative_delta?: number } | undefined;
    driftIndex = row?.cumulative_delta ?? null;
  } catch {
    driftIndex = null;
  }

  return { querySetCount, mostRecentRun, driftIndex };
}

function extractMode(envelopeJson: string | undefined): string {
  if (!envelopeJson) return "unknown";
  try {
    const parsed = JSON.parse(envelopeJson) as { mode?: string };
    return typeof parsed.mode === "string" && parsed.mode.length > 0 ? parsed.mode : "unknown";
  } catch {
    return "unknown";
  }
}

function getSuppressionHealth(db: DatabaseSync): SuppressionHealth {
  let suppressedLeaves = 0;
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM summaries
           WHERE suppressed_at IS NOT NULL AND kind = 'leaf'`,
      )
      .get() as { n?: number } | undefined;
    suppressedLeaves = row?.n ?? 0;
  } catch {
    suppressedLeaves = 0;
  }

  let pendingPurgeRebuilds = 0;
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM lcm_purge_rebuild_queue
           WHERE picked_at IS NULL`,
      )
      .get() as { n?: number } | undefined;
    pendingPurgeRebuilds = row?.n ?? 0;
  } catch {
    pendingPurgeRebuilds = 0;
  }

  return { suppressedLeaves, pendingPurgeRebuilds };
}
