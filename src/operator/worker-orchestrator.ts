/**
 * Worker orchestrator — LCM v4.1 Group F.
 *
 * Glues together all the worker job entry points so /lcm worker can
 * trigger them on demand (or — when persistent worker scheduling is
 * wired into plugin lifecycle — call them on a cadence).
 *
 * Three kinds of workloads coordinated here:
 *
 *   - embedding-backfill (B.04) — runBackfillTick
 *   - extraction (E.03) — runCoreferenceTick (entity coref over the
 *                         lcm_extraction_queue)
 *   - procedure-mining (E.02) — mineProceduresPass (less frequent;
 *                         caller pre-fetches candidates)
 *
 * The orchestrator does NOT own:
 *   - The actual job functions (those are in their own modules)
 *   - The cross-process worker_lock acquisition (each job function
 *     handles its own — orchestrator just coordinates dispatch)
 *   - The LLM call wiring (caller injects via opts)
 *   - The WorkerLoop scheduling (separate concern; this orchestrator
 *     can be the `run()` function passed to WorkerLoop jobs)
 *
 * Design choice: thin coordinator, thick injectables. Makes /lcm worker
 * tick <kind> easy to wire (one switch over kind → call appropriate
 * orchestrator method) without forcing the orchestrator to know about
 * every job's specific dependencies.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  acquireLock,
  generateWorkerId,
  heartbeatLock,
  lockInfo,
  releaseLock,
  type LockInfo,
} from "../concurrency/worker-lock.js";
import { WORKER_JOB_KINDS, type WorkerJobKind } from "../concurrency/model.js";
import {
  runBackfillTick,
  type BackfillOptions,
  type BackfillResult,
  countPendingDocs as countBackfillPending,
} from "../embeddings/backfill.js";
import {
  runCoreferenceTick,
  type CoreferenceTickOptions,
  type CoreferenceTickResult,
  type ExtractEntities,
  countPendingExtractions,
} from "../extraction/entity-coreference.js";
// Procedure mining was REMOVED in first-principles pass (2026-05-06).
// Module + types preserved in deferred-features draft PR (#616). When that
// ships, re-import: mineProceduresPass, CandidateLeaf, JudgeProcedureCluster,
// MineProceduresOptions, MineProceduresReport from "../extraction/procedure-mining.js".

export interface WorkerStatusSnapshot {
  /** Current lock state for each worker kind (null = no one holds). */
  locks: Record<WorkerJobKind, LockInfo | null>;
  /** Pending counts where applicable (helps operator decide what to tick). */
  pending: {
    embeddingBackfill: number;
    extractionQueue: number;
    /** Procedure mining doesn't have a queue — its trigger is corpus
     *  size + cadence. -1 means "not directly queryable". */
    procedureMining: number;
  };
}

/**
 * Snapshot of all worker state. Used by /lcm worker status and /lcm health.
 *
 * Caller passes `modelName` for backfill pending count (it's per-model
 * and the orchestrator doesn't know the active one — that's the
 * embeddings module's concern; defer to caller).
 */
export function getWorkerStatusSnapshot(
  db: DatabaseSync,
  args: { modelName?: string } = {},
): WorkerStatusSnapshot {
  const locks: Record<WorkerJobKind, LockInfo | null> = {} as Record<WorkerJobKind, LockInfo | null>;
  for (const kind of WORKER_JOB_KINDS) {
    locks[kind] = lockInfo(db, kind);
  }
  const embeddingBackfill = args.modelName
    ? countBackfillPending(db, { modelName: args.modelName })
    : -1;
  const extractionQueue = countPendingExtractions(db);
  return {
    locks,
    pending: {
      embeddingBackfill,
      extractionQueue,
      procedureMining: -1, // not directly queryable
    },
  };
}

export interface RunBackfillTickArgs extends Omit<BackfillOptions, "workerId"> {
  /** Override worker_id (defaults to generated). */
  workerId?: string;
}

/**
 * Manual backfill tick. Wraps runBackfillTick with a stable worker_id
 * if the caller doesn't provide one. Used by /lcm worker tick
 * embedding-backfill.
 */
export async function tickEmbeddingBackfill(
  db: DatabaseSync,
  args: RunBackfillTickArgs,
): Promise<BackfillResult> {
  const workerId = args.workerId ?? generateWorkerId("orchestrator-backfill");
  return runBackfillTick(db, { ...args, workerId });
}

export interface RunCoreferenceTickArgs extends Omit<CoreferenceTickOptions, "passId"> {
  /** Override pass ID (defaults to generated). */
  passId?: string;
  extractor: ExtractEntities;
}

/**
 * Manual entity-coreference tick. Wraps the worker-lock + tick call.
 * Used by /lcm worker tick extraction.
 *
 * Note: runCoreferenceTick (E.03) does NOT acquire the worker lock
 * internally (unlike backfill). The orchestrator wraps with explicit
 * acquire/release so two parallel calls can't double-process queued
 * extractions.
 */
export async function tickExtraction(
  db: DatabaseSync,
  args: RunCoreferenceTickArgs,
): Promise<CoreferenceTickResult & { lockAcquired: boolean }> {
  const workerId = generateWorkerId("orchestrator-extraction");
  const got = acquireLock(db, "extraction", { workerId, jobMetadata: "tickExtraction" });
  if (!got) {
    return {
      processedCount: 0,
      newEntities: 0,
      newMentions: 0,
      extractorFailures: 0,
      perItem: [],
      lockAcquired: false,
    };
  }
  try {
    // Wave-4 Auditor #12 P0-1 + #13 P1 fix: pass an onItemHeartbeat
    // closure so runCoreferenceTick can extend the worker lock TTL
    // between items. Without this, a 50-item tick × 30s/item = 25 min
    // would blow past the 90s WORKER_LOCK_TTL_MS, allowing a second
    // gateway's autostart to GC + re-acquire and double-process the
    // queue — directly causing the duplicate-mention scenario the
    // INSERT OR IGNORE path was fixed for in Wave-1.
    const result = await runCoreferenceTick(db, args.extractor, {
      ...args,
      passId: args.passId ?? `tick-${Date.now()}`,
      onItemHeartbeat: () => heartbeatLock(db, "extraction", workerId),
    });
    // Wave-7 Auditor #4/13 P1 fix: surface lockLostMidTick. The W4 fix
    // wired the heartbeat callback + result field, but tickExtraction
    // returned `lockAcquired: true` regardless — collapsing "lost lock
    // partway" into "ran cleanly". Now if heartbeat returned false
    // mid-tick, lockAcquired flips to false so callers (autostart)
    // can pace down + treat as soft failure.
    return {
      ...result,
      lockAcquired: result.lockLostMidTick ? false : true,
    };
  } finally {
    releaseLock(db, "extraction", workerId);
  }
}

// tickProcedureMining was REMOVED in first-principles pass (2026-05-06).
// Implementation + types preserved in deferred-features draft PR (#616).

/**
 * Force-release a stuck lock. Operator escape hatch when a worker
 * crashed without releasing. Returns true if a lock existed and was
 * deleted.
 *
 * USE WITH CAUTION — if the original holder is still alive, this
 * causes a race where two workers may end up doing the same job (one
 * succeeded, one inserts duplicates). The TTL+heartbeat mechanism is
 * the SAFE way to recover from dead workers; this is for cases where
 * heartbeat is broken (e.g., DST clock jump, NTP correction).
 */
export function forceReleaseLock(
  db: DatabaseSync,
  jobKind: WorkerJobKind,
  opts: { expectedWorkerId?: string } = {},
): boolean {
  // Wave-4 Auditor #13 P1 fix: when expectedWorkerId is provided, scope
  // the DELETE to that worker so an operator slip doesn't evict a
  // healthy holder mid-tick (which would cascade into double-processing
  // the queue exactly as the Wave-1 INSERT OR IGNORE protections aim
  // to prevent). When omitted, behavior matches the legacy escape-hatch
  // semantic (delete by kind only) — caller takes responsibility.
  if (opts.expectedWorkerId) {
    const r = db
      .prepare(`DELETE FROM lcm_worker_lock WHERE job_kind = ? AND worker_id = ?`)
      .run(jobKind, opts.expectedWorkerId);
    return Number(r.changes) > 0;
  }
  const r = db
    .prepare(`DELETE FROM lcm_worker_lock WHERE job_kind = ?`)
    .run(jobKind);
  return Number(r.changes) > 0;
}

/**
 * Heartbeat all currently-held worker locks (called by the WorkerLoop
 * if/when the gateway wires it). For each kind in WORKER_JOB_KINDS,
 * if a lock exists, refresh its expires_at. Returns the count refreshed.
 *
 * The operator-orchestrator caller is the EXPECTED caller; tests
 * verify the no-op behavior when no locks are held.
 */
export function heartbeatAllHeldLocks(
  db: DatabaseSync,
  workerIdsByKind: Partial<Record<WorkerJobKind, string>>,
): { refreshed: number; perKind: Partial<Record<WorkerJobKind, "ok" | "lost" | "skipped">> } {
  // Wave-4 Auditor #13 P1 fix: previously returned only a count, throwing
  // away the per-kind boolean. A worker that lost its lock between ticks
  // (stolen during a long LLM call) saw `refreshed=0` indistinguishable
  // from "we never held it." Now returns per-kind status so callers can
  // detect lock-loss and abort the in-flight tick. Also wraps each call
  // in try/catch so one failed heartbeat doesn't abort the loop.
  let refreshed = 0;
  const perKind: Partial<Record<WorkerJobKind, "ok" | "lost" | "skipped">> = {};
  for (const kind of WORKER_JOB_KINDS) {
    const wid = workerIdsByKind[kind];
    if (!wid) {
      perKind[kind] = "skipped";
      continue;
    }
    try {
      const ok = heartbeatLock(db, kind, wid);
      perKind[kind] = ok ? "ok" : "lost";
      if (ok) refreshed++;
    } catch {
      // DB closed mid-shutdown or transient SQLite error; treat as lost
      perKind[kind] = "lost";
    }
  }
  return { refreshed, perKind };
}
