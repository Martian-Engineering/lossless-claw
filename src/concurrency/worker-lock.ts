/**
 * Cross-process worker job lock — LCM v4.1 §0.
 *
 * Backed by `lcm_worker_lock` table (one row per job_kind). All worker
 * jobs (condensation, extraction, embedding-backfill, profile-rebuild,
 * theme-consolidation, eval) coordinate via this table so only one
 * process at a time runs each kind.
 *
 * Acquisition is atomic via PRIMARY KEY uniqueness on (job_kind):
 * INSERT OR IGNORE returns 1 row affected if we got the lock, 0 if
 * someone else already holds it. No advisory lock dance, no application
 * semaphore — SQLite's row-uniqueness IS the lock.
 *
 * TTL + heartbeat (v4.1.1 A9):
 *   - WORKER_LOCK_TTL_MS = 90s default
 *   - Worker calls heartbeatLock() every WORKER_HEARTBEAT_MS = 30s while running
 *   - If a worker dies without releasing, its lock auto-expires after 90s
 *   - acquireLock() GC's stale (expired) locks BEFORE attempting INSERT
 *
 * Why TTL is short and heartbeat is shorter: gateway-fallback soak window
 * (GATEWAY_FALLBACK_SOAK_MS = 5min) prevents a slow-LLM-but-alive worker
 * from being preempted. The fast TTL only matters when the worker is
 * actually dead.
 */

import type { DatabaseSync } from "node:sqlite";
import { WORKER_LOCK_TTL_MS, type WorkerJobKind } from "./model.js";

export interface AcquireLockOptions {
  /** Unique worker identifier (e.g. process.pid + start time + nonce). */
  workerId: string;
  /** Lock expiration in ms from now. Defaults to WORKER_LOCK_TTL_MS. */
  ttlMs?: number;
  /**
   * Optional scope — if set, the lock is logically scoped to this
   * session_key. Other code paths can read this column to make
   * "same kind but different session" decisions (e.g. condensation
   * runs simultaneously on different sessions but only one per session).
   * NOTE: the lock itself is still per-job_kind (table PK). This column
   * is informational only.
   */
  jobSessionKey?: string;
  /** Arbitrary worker-set tag for diagnostics (e.g. "backfill: model=voyage4large"). */
  jobMetadata?: string;
}

export interface LockInfo {
  jobKind: string;
  workerId: string;
  acquiredAt: string;
  expiresAt: string;
  lastHeartbeatAt: string;
  jobSessionKey: string | null;
  jobMetadata: string | null;
}

/**
 * Try to acquire a job lock. Returns true if acquired (caller now owns
 * the lock; must call {@link releaseLock} or let it expire). Returns
 * false if another worker holds it and the lock has not yet expired.
 *
 * Side effect: GC's any expired lock for this job_kind before attempting
 * acquisition (so a stale dead-worker lock doesn't permanently block).
 *
 * Best practice: caller should wrap acquire + work + release in
 * try/finally and emit telemetry on contention (acquire returning false
 * frequently means the work isn't fitting into the lock window).
 */
export function acquireLock(
  db: DatabaseSync,
  jobKind: WorkerJobKind,
  opts: AcquireLockOptions,
): boolean {
  if (!opts.workerId || opts.workerId.trim().length === 0) {
    throw new Error("[worker-lock] workerId is required");
  }
  // GC stale lock (if any). datetime('now') comparison; SQLite TEXT
  // comparison works lexicographically on ISO-8601 strings.
  // Note: `<=` not `<` so a lock with ttl=0 is immediately reclaimable.
  // The race "another process acquires in the gap between DELETE and
  // INSERT" is handled by the INSERT OR IGNORE on PK uniqueness — the
  // second writer's INSERT just no-ops. Worst case: caller is told false
  // when they could have had the lock; never silently double-acquires.
  db.prepare(
    `DELETE FROM lcm_worker_lock
       WHERE job_kind = ? AND expires_at <= datetime('now')`,
  ).run(jobKind);

  const ttlSeconds = Math.round((opts.ttlMs ?? WORKER_LOCK_TTL_MS) / 1000);
  // INSERT OR IGNORE: succeeds (changes=1) if no row holds the PK; no-ops
  // (changes=0) if someone else is already there.
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO lcm_worker_lock
         (job_kind, worker_id, acquired_at, expires_at, last_heartbeat_at,
          job_session_key, job_metadata)
       VALUES (?, ?, datetime('now'),
               datetime('now', '+' || ? || ' seconds'),
               datetime('now'), ?, ?)`,
    )
    .run(
      jobKind,
      opts.workerId,
      ttlSeconds,
      opts.jobSessionKey ?? null,
      opts.jobMetadata ?? null,
    );
  return Number(result.changes) > 0;
}

/**
 * Release a held lock. Returns true if the row existed and matched the
 * worker_id (so we deleted it). Returns false if the lock was already
 * gone (e.g. expired + GC'd, or never acquired by this worker).
 *
 * NOTE: a stale-but-not-yet-GC'd lock CAN be deleted here if you pass
 * the worker_id that originally acquired it. This is intentional —
 * worker that just woke from sleep should be able to release its old
 * lock if it remembers having it.
 */
export function releaseLock(
  db: DatabaseSync,
  jobKind: WorkerJobKind,
  workerId: string,
): boolean {
  const result = db
    .prepare(`DELETE FROM lcm_worker_lock WHERE job_kind = ? AND worker_id = ?`)
    .run(jobKind, workerId);
  return Number(result.changes) > 0;
}

/**
 * Extend the expiration on a lock the worker still holds. Idempotent.
 * Returns true if the worker still owns the lock (so the heartbeat
 * succeeded). Returns false if the lock was lost (e.g. preempted by
 * fallback gateway, or a different worker now owns it) — caller MUST
 * abort its work in that case to avoid double-processing.
 */
export function heartbeatLock(
  db: DatabaseSync,
  jobKind: WorkerJobKind,
  workerId: string,
  ttlMs?: number,
): boolean {
  const ttlSeconds = Math.round((ttlMs ?? WORKER_LOCK_TTL_MS) / 1000);
  // Wave-1 Auditor #2 finding #2: previous version had no `expires_at`
  // predicate. If our 90s lock had already expired (worker was blocked
  // in a long Voyage call), but no other worker had yet stolen it via
  // acquireLock's lazy-DELETE, this UPDATE would silently re-extend an
  // EXPIRED lock — making it look alive again. A concurrent autostart
  // tick that started just before our heartbeat could then GC + acquire
  // in between, both holding "the" lock simultaneously.
  //
  // Fix: require `expires_at > now` AND `worker_id = ?`. If our lock has
  // expired we report `false` (caller MUST abort) and DO NOT extend it —
  // the lazy-GC in acquireLock will then clean up.
  const result = db
    .prepare(
      `UPDATE lcm_worker_lock
         SET last_heartbeat_at = datetime('now'),
             expires_at = datetime('now', '+' || ? || ' seconds')
         WHERE job_kind = ?
           AND worker_id = ?
           AND expires_at > datetime('now')`,
    )
    .run(ttlSeconds, jobKind, workerId);
  return Number(result.changes) > 0;
}

/**
 * Inspect the current lock holder (or null if no one holds the lock).
 * Used by `/lcm health` to report worker state.
 */
export function lockInfo(db: DatabaseSync, jobKind: WorkerJobKind): LockInfo | null {
  const row = db
    .prepare(
      `SELECT job_kind, worker_id, acquired_at, expires_at, last_heartbeat_at,
              job_session_key, job_metadata
         FROM lcm_worker_lock WHERE job_kind = ?`,
    )
    .get(jobKind) as
    | {
        job_kind: string;
        worker_id: string;
        acquired_at: string;
        expires_at: string;
        last_heartbeat_at: string;
        job_session_key: string | null;
        job_metadata: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    jobKind: row.job_kind,
    workerId: row.worker_id,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    jobSessionKey: row.job_session_key,
    jobMetadata: row.job_metadata,
  };
}

/**
 * Generate a worker_id suitable for {@link acquireLock}. Format:
 * `<role>-<pid>-<startMs>-<nonce>` where nonce is a 6-char hex string.
 * Uniqueness is across-time + across-process; collisions are
 * astronomically unlikely.
 */
export function generateWorkerId(role: string): string {
  const nonce = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0");
  return `${role}-${process.pid}-${Date.now()}-${nonce}`;
}
