/**
 * §0 Concurrency Model — LCM v4.1.1
 *
 * The load-bearing invariants for cross-process safety between gateway and worker.
 * This module is the single source of truth for §0 of architecture-v4.1.md +
 * v4.1.1 A6/A9 amendments. Code that violates these invariants must fail
 * loudly (assertion / throw) — never silently degrade.
 *
 * Invariants (architecture-v4.1.md §0.1, plus v4.1.1 A6 + A9):
 *
 *   1. NO LLM/network call inside any SQLite write transaction.
 *      Leaf-write commits in T1; embed/extract queue async to worker T2.
 *      Synthesis call happens OUTSIDE cache-write transaction (insert
 *      `status='building'` row in T1, run LLM, then update to `status='ready'`
 *      in T2 per v3.1 A8).
 *
 *   2. Gateway owns the hot path. Per-turn assemble + leaf write + agent
 *      tool calls. Latency budget: assemble <100ms; leaf write <50ms.
 *
 *   3. Worker owns cold rewrites. Condensation, extraction, embedding
 *      backfill, theme consolidation, synthesis profile rebuilds. May take
 *      seconds-to-minutes per job; gateway never waits on it.
 *
 *   4. Both processes use the same SQLite DB; no IPC beyond DB rows.
 *
 *   5. Worker uses SHORTER `busy_timeout` than gateway so gateway always
 *      wins on contention. See {@link GATEWAY_BUSY_TIMEOUT_MS} and
 *      {@link WORKER_BUSY_TIMEOUT_MS}.
 *
 *   6. Migration ratchet owned by gateway only. Worker startup checks
 *      `lcm_migration_state` for required v4.1 step; refuses to start if
 *      not present. Worker NEVER calls `runLcmMigrations`.
 *
 *   7. PRAGMA foreign_keys = ON on every connection (gateway and worker).
 *      Already set by `src/db/connection.ts:configureConnection()`. v4.1.1
 *      A6 amendment: any new connection path must run through that helper
 *      OR explicitly set the PRAGMA. Verified via {@link assertForeignKeysEnabled}.
 *
 *   8. Worker heartbeat must run on Node `worker_threads` Worker with its
 *      OWN DatabaseSync connection (v4.1.1 A9). Otherwise event-loop
 *      blocking by job code (long LLM call, ml-hclust pass) starves the
 *      heartbeat → fallback gateway steals an active worker's lock.
 *      (Worker_threads scaffolding lands in Group A.NN; this constant
 *      anchors the contract.)
 */

import type { DatabaseSync } from "node:sqlite";

/**
 * Gateway SQLite busy_timeout (ms). Already set by
 * `src/db/connection.ts:configureConnection()` to this value. Long timeout
 * accommodates worker-process write transactions during condensation /
 * extraction passes.
 */
export const GATEWAY_BUSY_TIMEOUT_MS = 30_000;

/**
 * Worker SQLite busy_timeout (ms). MUST be shorter than
 * {@link GATEWAY_BUSY_TIMEOUT_MS} so gateway always wins on contention.
 * Worker that hits SQLITE_BUSY backs off and retries; gateway hot path
 * does not stall waiting for worker writes.
 */
export const WORKER_BUSY_TIMEOUT_MS = 5_000;

/**
 * Worker heartbeat cadence (ms). Worker writes
 * `last_heartbeat_at = now, expires_at = now + WORKER_LOCK_TTL_MS` on its
 * held locks at this interval. See `lcm_worker_lock` table.
 */
export const WORKER_HEARTBEAT_MS = 30_000;

/**
 * Worker lock TTL (ms). If a worker dies without releasing its lock,
 * other workers / fallback gateway can GC the lock once `expires_at < now`.
 * 90s = 3× heartbeat cadence (allows one missed heartbeat without stealing).
 */
export const WORKER_LOCK_TTL_MS = 90_000;

/**
 * Gateway-fallback soak window (ms). Gateway can take over a worker job
 * only when BOTH:
 *   - lock is GC'd (per WORKER_LOCK_TTL_MS expiry), AND
 *   - last_heartbeat_at < now - GATEWAY_FALLBACK_SOAK_MS
 * Two conditions prevent gateway from racing a slow-LLM-but-alive worker
 * (v4.1.1 A9 amendment).
 */
export const GATEWAY_FALLBACK_SOAK_MS = 300_000;

/**
 * Job kinds tracked by the cross-process lock table. Adding a new kind
 * requires updating both this list AND the `lcm_worker_lock.job_kind`
 * CHECK constraint (when added; current schema is freeform TEXT for
 * forward-compat).
 */
export const WORKER_JOB_KINDS = [
  "condensation",
  "extraction",
  "embedding-backfill",
  "profile-rebuild",
  "theme-consolidation",
  "eval", // §11 ensemble judge runs (v4.1.1 §C MED item)
] as const;

export type WorkerJobKind = (typeof WORKER_JOB_KINDS)[number];

/**
 * Asserts `PRAGMA foreign_keys = ON` for the given connection. Throws if
 * disabled. Per v4.1.1 A6 invariant: every code path that opens a
 * SQLite connection MUST end up with FKs enabled, otherwise every
 * `ON DELETE CASCADE` clause in the schema becomes documentation-only.
 *
 * `src/db/connection.ts:configureConnection()` already does this for the
 * standard connection path — call this assertion in tests / hot paths
 * to defend against future paths that bypass `configureConnection`.
 */
export function assertForeignKeysEnabled(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: number } | undefined;
  if (!row || row.foreign_keys !== 1) {
    throw new Error(
      "[concurrency.model] foreign_keys is not ON for this connection — " +
        "every ON DELETE CASCADE in the schema would silently no-op. " +
        "Ensure the connection passes through configureConnection() in " +
        "src/db/connection.ts, or set PRAGMA foreign_keys = ON explicitly.",
    );
  }
}

/**
 * Asserts the connection is set up such that `BEGIN EXCLUSIVE` migration
 * + worker writes won't deadlock under contention. Specifically: busy_timeout
 * must be ≥ {@link WORKER_BUSY_TIMEOUT_MS} (worker) or
 * {@link GATEWAY_BUSY_TIMEOUT_MS} (gateway). Caller specifies which role.
 */
export function assertBusyTimeoutForRole(
  db: DatabaseSync,
  role: "gateway" | "worker",
): void {
  const expected = role === "gateway" ? GATEWAY_BUSY_TIMEOUT_MS : WORKER_BUSY_TIMEOUT_MS;
  const row = db.prepare("PRAGMA busy_timeout").get() as { timeout?: number } | undefined;
  const actual = row?.timeout ?? 0;
  if (actual < expected) {
    throw new Error(
      `[concurrency.model] busy_timeout for ${role} is ${actual}ms, ` +
        `expected at least ${expected}ms. Set via PRAGMA busy_timeout = ${expected}.`,
    );
  }
}
