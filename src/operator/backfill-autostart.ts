/**
 * Backfill auto-start — LCM v4.1 Wire-2.
 *
 * Plugin lifecycle hook that auto-runs the embedding-backfill cron in
 * the background until the corpus is fully embedded. Operator opt-in:
 * presence of `VOYAGE_API_KEY` env var. Without it, this module is a
 * silent no-op.
 *
 * Once started, runs a tick every {@link DEFAULT_AUTOSTART_INTERVAL_MS}
 * (default 5 minutes). Each tick processes up to perTickLimit=200 docs.
 * Stops automatically when:
 *   - countPendingDocs returns 0 for 3 consecutive ticks (idle drain)
 *   - gateway_stop fires (cleanup)
 *   - 3 consecutive Voyage failures (back off; manual intervention)
 *
 * Why this is auto-opt-in instead of always-on:
 *   - Costs Voyage tokens (~$1 for Eva's 4187-leaf corpus first run)
 *   - Operators in dev environments may not want background API calls
 *   - VOYAGE_API_KEY presence is a clear "I want this" signal
 *
 * NOT auto-started:
 *   - Entity coreference (needs LLM injection through plugin lifecycle —
 *     deferred to cycle-2)
 *   - Procedure mining (same)
 *   - Themes consolidation (same)
 *   - Worker_threads heartbeat isolation (v4.1.1 A9)
 *
 * Manual `/lcm worker tick embedding-backfill` still works — autostart
 * just makes it unnecessary in the typical case.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  countPendingDocs,
  type BackfillResult,
} from "../embeddings/backfill.js";
import { vec0Version } from "../embeddings/store.js";
import { getActiveEmbeddingModel } from "../embeddings/semantic-search.js";
import { tickEmbeddingBackfill } from "./worker-orchestrator.js";
import type { VoyageEmbeddingModel } from "../voyage/client.js";

export const DEFAULT_AUTOSTART_INTERVAL_MS = 5 * 60 * 1000; // 5 min

/** Caller-supplied logger (Plugin's deps.log). */
export interface AutostartLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface AutostartOptions {
  log: AutostartLogger;
  /** Override interval. Default {@link DEFAULT_AUTOSTART_INTERVAL_MS}. */
  intervalMs?: number;
  /**
   * Read VOYAGE_API_KEY from this env (default process.env). Tests may
   * inject a mock env to verify gating logic.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Override the actual tick function. Tests inject a stub that
   * doesn't make real Voyage calls.
   */
  tickFn?: (db: DatabaseSync, args: TickArgs) => Promise<BackfillResult>;
}

interface TickArgs {
  modelName: string;
  voyageModel: VoyageEmbeddingModel;
  inputType: "document";
  voyageMaxRetries?: number;
  voyageTimeoutMs?: number;
  maxRequestsPerSecond?: number;
  perTickLimit?: number;
}

export interface AutostartHandle {
  /** Stop the autostart loop. Idempotent. */
  stop(): void;
  /** True if currently scheduling ticks. */
  isRunning(): boolean;
  /** Number of ticks executed since start. */
  tickCount(): number;
}

const NO_OP_HANDLE: AutostartHandle = {
  stop: () => {},
  isRunning: () => false,
  tickCount: () => 0,
};

/**
 * Try to start the backfill auto-runner. Returns a handle for the
 * caller to call .stop() on gateway_stop.
 *
 * Returns NO_OP_HANDLE (silently) if pre-flight checks fail:
 *   - VOYAGE_API_KEY missing
 *   - vec0 not loaded
 *   - No active embedding profile registered
 *
 * Logs ONCE per failure reason (not per-tick), so the gateway log
 * isn't spammed.
 */
export function tryStartBackfillAutostart(
  db: DatabaseSync,
  opts: AutostartOptions,
): AutostartHandle {
  const env = opts.env ?? process.env;
  const log = opts.log;

  // Pre-flight: VOYAGE_API_KEY
  if (!env.VOYAGE_API_KEY?.trim()) {
    log.info(
      "[lcm] backfill autostart: VOYAGE_API_KEY not set — semantic retrieval will use FTS-only until you set it (or run /lcm worker tick embedding-backfill manually).",
    );
    return NO_OP_HANDLE;
  }

  // Pre-flight: vec0 loaded
  if (vec0Version(db) === null) {
    log.warn(
      "[lcm] backfill autostart: sqlite-vec extension not loaded — install via `pnpm add sqlite-vec` and restart. Backfill will not run until then.",
    );
    return NO_OP_HANDLE;
  }

  // Pre-flight: active model
  const active = getActiveEmbeddingModel(db);
  if (!active) {
    log.warn(
      "[lcm] backfill autostart: no active embedding profile registered. INSERT a row into lcm_embedding_profile (e.g. voyage-4-large dim=1024) and restart.",
    );
    return NO_OP_HANDLE;
  }

  log.info(
    `[lcm] backfill autostart: starting (model=${active.modelName} dim=${active.dim} interval=${(opts.intervalMs ?? DEFAULT_AUTOSTART_INTERVAL_MS) / 1000}s)`,
  );

  const intervalMs = opts.intervalMs ?? DEFAULT_AUTOSTART_INTERVAL_MS;
  const tickFn = opts.tickFn ?? tickEmbeddingBackfill;
  let consecutiveIdleTicks = 0;
  let consecutiveFailures = 0;
  let totalTicks = 0;
  let inFlight = false;
  let stopped = false;

  const runOneTick = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const pending = countPendingDocs(db, { modelName: active.modelName });
      if (pending === 0) {
        consecutiveIdleTicks++;
        if (consecutiveIdleTicks === 1) {
          log.info(
            `[lcm] backfill autostart: pending=0; corpus fully embedded. Will keep checking but rare.`,
          );
        }
        if (consecutiveIdleTicks >= 3) {
          log.info(
            `[lcm] backfill autostart: idle for 3 consecutive ticks; pausing. New leaves on the next leaf-write will re-trigger via the auto-tick on next interval.`,
          );
        }
        return;
      }
      consecutiveIdleTicks = 0;

      const startedAt = Date.now();
      const result = await tickFn(db, {
        modelName: active.modelName,
        voyageModel: active.modelName as VoyageEmbeddingModel,
        inputType: "document",
        // Wave-12 reviewer P1 fix: previously omitted, so a registered
        // profile with non-default dim (256/512/2048) had its
        // `recordEmbedding` writes rejected for vector.length mismatch.
        // The dim was logged at autostart but never plumbed through to
        // the Voyage call. Pass it explicitly.
        voyageOutputDimension: active.dim,
        // v4.1 Final.review.3 fix (Loop 1 Bug 1.1 / Loop 7 B1 HIGH):
        // 2 retries × 30s + backoff = ~91s worst-case > WORKER_LOCK_TTL_MS (90s).
        // Lock can expire mid-call; another worker can acquire + write to vec0
        // simultaneously. Drop to 1 retry → worst-case 60.5s, well under TTL.
        // Matches the safe default in backfill.ts BackfillOptions.
        voyageMaxRetries: 1,
        voyageTimeoutMs: 30_000,
        maxRequestsPerSecond: 0.5,
        perTickLimit: 200,
      });
      const durationMs = Date.now() - startedAt;
      totalTicks++;

      if (result.lockNotAcquired) {
        log.info(
          `[lcm] backfill autostart: lock held by another worker; ticking again next interval.`,
        );
        return;
      }
      log.info(
        `[lcm] backfill autostart: tick ${totalTicks} embedded=${result.embeddedCount} skipped=${result.skipped.length} ` +
          `tokens=${result.voyageTokensConsumed} duration=${(durationMs / 1000).toFixed(1)}s ` +
          `(pending was ${pending}, now ${countPendingDocs(db, { modelName: active.modelName })})`,
      );
      // v4.1 Final.review.3 fix (Loop 7 B5 HIGH):
      // Treat all-failed-batches ticks (embeddedCount=0 with non-empty skipped
      // when there were docs to process) as a failure, otherwise consecutiveFailures
      // never increments through 5xx exhaustion / network errors / 400s — they
      // become `result.skipped` entries instead of throws. Without this,
      // a Voyage outage burns quota indefinitely without auto-stopping.
      const allSkipped =
        result.embeddedCount === 0 && result.skipped.length > 0 && pending > 0;
      if (allSkipped) {
        consecutiveFailures++;
        log.warn(
          `[lcm] backfill autostart: tick ${totalTicks} returned 0 embedded with ${result.skipped.length} skipped (consecutive=${consecutiveFailures}); ` +
            `sample reasons: ${result.skipped.slice(0, 3).map((s) => s.reason).join(", ")}`,
        );
        if (consecutiveFailures >= 3) {
          log.error(
            `[lcm] backfill autostart: 3 consecutive all-failed ticks; stopping autostart. Investigate Voyage availability + restart gateway to retry.`,
          );
          handle.stop();
        }
      } else {
        consecutiveFailures = 0;
      }
    } catch (e: unknown) {
      consecutiveFailures++;
      log.error(
        `[lcm] backfill autostart: tick failed (consecutive=${consecutiveFailures}): ${e instanceof Error ? e.message : String(e)}`,
      );
      if (consecutiveFailures >= 3) {
        log.error(
          `[lcm] backfill autostart: 3 consecutive failures — stopping. Run /lcm worker tick embedding-backfill manually after fixing the underlying issue.`,
        );
        handle.stop();
      }
    } finally {
      inFlight = false;
    }
  };

  // Kick off first tick after a short delay (let gateway finish booting)
  const initialDelay = setTimeout(() => {
    if (!stopped) void runOneTick();
  }, 5_000);

  const interval = setInterval(() => {
    if (!stopped) void runOneTick();
  }, intervalMs);

  const handle: AutostartHandle = {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      clearTimeout(initialDelay);
      log.info(`[lcm] backfill autostart: stopped (after ${totalTicks} ticks)`);
    },
    isRunning: () => !stopped,
    tickCount: () => totalTicks,
  };
  return handle;
}
