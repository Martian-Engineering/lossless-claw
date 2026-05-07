/**
 * Generic single-process worker loop — LCM v4.1 §0.
 *
 * One Node process running multiple background jobs cooperatively. Each
 * job has its own cadence (intervalMs) and runs in turn, single-threaded,
 * with the cross-process worker_lock providing single-flight across
 * processes.
 *
 * This is intentionally minimal — no thread pool, no cron expressions,
 * no priority queue. The plugin's worker scheduling needs are simple:
 *
 *   - Run backfill every ~10s (when there are pending docs)
 *   - Run extraction-queue every ~5s (when there are queued items)
 *   - Run condensation periodically
 *   - Run theme consolidation when idle
 *
 * Each job's run() function returns telemetry; the loop logs nothing on
 * its own (callers wire telemetry / logs).
 *
 * Lifecycle:
 *
 *   const loop = new WorkerLoop(db, {
 *     jobs: [
 *       { kind: "embedding-backfill", intervalMs: 10_000, run: async (db) => runBackfillTick(db, opts) },
 *       { kind: "extraction", intervalMs: 5_000, run: async (db) => runExtractionTick(db) },
 *       ...
 *     ],
 *   });
 *   loop.start();
 *   // ... process runs ...
 *   await loop.stop({ gracefulTimeoutMs: 30_000 });
 *
 * Single-process model: everything runs in this Node process. We do NOT
 * spawn worker_threads (per v4.1.1 A9, the worker_threads scaffolding
 * for true heartbeat-isolation is a future enhancement). For now, the
 * loop's setInterval-driven dispatch is good enough at these cadences.
 *
 * Cross-process safety: the per-job `run()` MUST acquire its own
 * lcm_worker_lock for its job_kind. Multiple processes may run the
 * same WorkerLoop concurrently (e.g. dev box + CI on the same DB),
 * and the lock prevents double-work.
 */

import type { DatabaseSync } from "node:sqlite";
import type { WorkerJobKind } from "./model.js";

export interface WorkerJob {
  /** Job kind matching {@link WorkerJobKind} (used for telemetry + lock). */
  kind: WorkerJobKind;
  /**
   * How often to invoke `run()`. The loop schedules with setInterval so
   * the actual cadence is approximate — drift accumulates if `run()`
   * exceeds intervalMs.
   */
  intervalMs: number;
  /**
   * Job entrypoint. Should:
   *   - Acquire lcm_worker_lock for `kind` (single-flight across processes)
   *   - Do its work
   *   - Release the lock
   *   - Return any telemetry; loop only uses it for `onJobComplete` hook
   *
   * If the function throws, the loop logs to telemetry and continues —
   * a single bad tick doesn't crash the loop. (Re-throws are NOT
   * propagated; if the job needs to fatally abort, it should call
   * loop.stop() explicitly first.)
   */
  run: (db: DatabaseSync) => Promise<unknown>;
}

export interface WorkerLoopOptions {
  jobs: WorkerJob[];
  /**
   * Hook called after each job tick (success or thrown). Used for
   * telemetry / logging. Loop never blocks on this.
   */
  onJobComplete?: (info: {
    kind: WorkerJobKind;
    durationMs: number;
    result?: unknown;
    error?: unknown;
  }) => void;
}

export class WorkerLoop {
  private readonly db: DatabaseSync;
  private readonly jobs: WorkerJob[];
  private readonly onJobComplete?: WorkerLoopOptions["onJobComplete"];
  private timers: NodeJS.Timeout[] = [];
  private running = false;
  // Ticks currently in-flight per kind. Used by stop() to wait for
  // graceful shutdown.
  private inFlight: Map<WorkerJobKind, Promise<void>> = new Map();
  // Set during start() to a unique token, checked at scheduled-tick time
  // so stop()-then-start() doesn't run leftover ticks from the old loop.
  private generationId = 0;

  constructor(db: DatabaseSync, opts: WorkerLoopOptions) {
    this.db = db;
    this.jobs = opts.jobs;
    this.onJobComplete = opts.onJobComplete;
    this.validateJobs();
  }

  private validateJobs(): void {
    const seen = new Set<string>();
    for (const job of this.jobs) {
      if (seen.has(job.kind)) {
        throw new Error(`[worker-loop] duplicate job kind: ${job.kind}`);
      }
      seen.add(job.kind);
      if (!Number.isFinite(job.intervalMs) || job.intervalMs <= 0) {
        throw new Error(`[worker-loop] job ${job.kind} has invalid intervalMs ${job.intervalMs}`);
      }
    }
  }

  /**
   * Start scheduling. Idempotent — calling on an already-running loop
   * is a no-op (returns false; doesn't throw).
   */
  start(): boolean {
    if (this.running) return false;
    this.running = true;
    this.generationId++;
    const myGeneration = this.generationId;
    for (const job of this.jobs) {
      const timer = setInterval(() => {
        if (!this.running || this.generationId !== myGeneration) return;
        // Only dispatch if no in-flight tick for this kind. Skip
        // overlapping ticks — the next interval will pick up.
        if (this.inFlight.has(job.kind)) return;
        const startedAt = Date.now();
        const promise = (async () => {
          try {
            const result = await job.run(this.db);
            this.onJobComplete?.({
              kind: job.kind,
              durationMs: Date.now() - startedAt,
              result,
            });
          } catch (error: unknown) {
            this.onJobComplete?.({
              kind: job.kind,
              durationMs: Date.now() - startedAt,
              error,
            });
          }
        })();
        this.inFlight.set(job.kind, promise);
        promise.finally(() => {
          this.inFlight.delete(job.kind);
        });
      }, job.intervalMs);
      this.timers.push(timer);
    }
    return true;
  }

  /**
   * Stop scheduling. Optionally waits for in-flight ticks up to
   * `gracefulTimeoutMs` (default 30s). Returns true if all in-flight
   * ticks finished cleanly; false if any timed out.
   */
  async stop(opts: { gracefulTimeoutMs?: number } = {}): Promise<boolean> {
    if (!this.running) return true;
    this.running = false;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];

    if (this.inFlight.size === 0) return true;

    const timeout = opts.gracefulTimeoutMs ?? 30_000;
    const inFlightPromises = Array.from(this.inFlight.values());
    const allDone = Promise.all(inFlightPromises);
    const timer: { handle: NodeJS.Timeout | null } = { handle: null };
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timer.handle = setTimeout(() => resolve("timeout"), timeout);
    });
    const result = await Promise.race([
      allDone.then(() => "done" as const),
      timeoutPromise,
    ]);
    if (timer.handle) clearTimeout(timer.handle);
    return result === "done";
  }

  /** Is the loop currently running (i.e., scheduling new ticks)? */
  isRunning(): boolean {
    return this.running;
  }

  /** How many job kinds have a tick currently in flight? */
  inFlightCount(): number {
    return this.inFlight.size;
  }

  /**
   * Run a specific job kind once, immediately, outside the regular
   * schedule. Returns whatever the job's run() returned. Throws if
   * the job is in flight already (use isJobRunning to check).
   *
   * Useful for: leaf-write hooks that want to nudge backfill, manual
   * /lcm worker tick CLI, tests.
   */
  async runOnce(kind: WorkerJobKind): Promise<unknown> {
    const job = this.jobs.find((j) => j.kind === kind);
    if (!job) throw new Error(`[worker-loop] no job kind: ${kind}`);
    if (this.inFlight.has(kind)) {
      throw new Error(`[worker-loop] job ${kind} is already in flight`);
    }
    const startedAt = Date.now();
    const promise = (async () => {
      try {
        const result = await job.run(this.db);
        this.onJobComplete?.({
          kind,
          durationMs: Date.now() - startedAt,
          result,
        });
        return result;
      } catch (error: unknown) {
        this.onJobComplete?.({
          kind,
          durationMs: Date.now() - startedAt,
          error,
        });
        throw error;
      }
    })();
    this.inFlight.set(kind, promise.then(() => undefined).catch(() => undefined));
    try {
      return await promise;
    } finally {
      this.inFlight.delete(kind);
    }
  }
}
