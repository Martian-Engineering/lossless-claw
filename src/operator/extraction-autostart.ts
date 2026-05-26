/**
 * Extraction worker autostart — LCM v4.1 cycle-2.
 *
 * Mirror of backfill-autostart.ts, but for the entity-coreference
 * worker. Drains lcm_extraction_queue using an LLM-backed extractor
 * (entity-extractor-llm.ts).
 *
 * Pre-flight (each failure logged once):
 *   - LCM_EXTRACTION_LLM_ENABLED env var not set to 'false' (default
 *     enabled — extraction is intrinsic to v4.1, not opt-in like
 *     embedding which costs Voyage tokens)
 *   - At least one summarizer model resolves (we reuse deps.complete
 *     and deps.resolveModel, so if the gateway has any LLM configured,
 *     extraction works)
 *
 * Cadence: every 60s by default. Each tick processes up to 50 queue
 * items (perTickLimit=50). Cost per item: 1 small LLM call (the model
 * is whatever `LCM_SUMMARY_MODEL` env / per-prompt model_recommendation
 * resolves to; default `gpt-5.4-mini` ~$0.0001 each, ~$0.005 per tick).
 *
 * Auto-stop conditions (same as backfill):
 *   - 3 consecutive idle ticks (queue empty) → pause until next interval
 *     (re-checks; cheap)
 *   - 3 consecutive LLM failures → stop, log, require manual restart
 *   - gateway_stop → stop
 *
 * NOT in this module: procedure mining or themes consolidation. Those
 * have different scheduling needs (run less often: daily-ish) and
 * different LLM-injection shapes. Each gets its own autostart module.
 */

import type { DatabaseSync } from "node:sqlite";
import type { LcmDependencies } from "../types.js";
import { createEntityExtractorLlm } from "../extraction/entity-extractor-llm.js";
import {
  countPendingExtractions,
  type CoreferenceTickResult,
  type ExtractEntities,
} from "../extraction/entity-coreference.js";
import { tickExtraction } from "./worker-orchestrator.js";

export const DEFAULT_EXTRACTION_INTERVAL_MS = 60 * 1000; // 1 minute

export interface ExtractionAutostartLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface ExtractionAutostartOptions {
  log: ExtractionAutostartLogger;
  deps: LcmDependencies;
  intervalMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Override extractor (test injection). If omitted, uses
   *  createEntityExtractorLlm(deps). */
  extractorFn?: ExtractEntities;
}

export interface ExtractionAutostartHandle {
  stop(): void;
  isRunning(): boolean;
  tickCount(): number;
}

const NO_OP_HANDLE: ExtractionAutostartHandle = {
  stop: () => {},
  isRunning: () => false,
  tickCount: () => 0,
};

export function tryStartExtractionAutostart(
  db: DatabaseSync,
  opts: ExtractionAutostartOptions,
): ExtractionAutostartHandle {
  const env = opts.env ?? process.env;
  const log = opts.log;

  // Opt-out via env (default ON)
  if (env.LCM_EXTRACTION_LLM_ENABLED?.trim().toLowerCase() === "false") {
    log.info(
      "[lcm] extraction autostart: disabled via LCM_EXTRACTION_LLM_ENABLED=false. Extraction queue will accumulate; manually drain via the runCoreferenceTick service.",
    );
    return NO_OP_HANDLE;
  }

  // Pre-flight: deps.complete must exist
  if (typeof opts.deps.complete !== "function") {
    log.warn(
      "[lcm] extraction autostart: deps.complete not available — gateway must be configured with at least one LLM provider. Disabling.",
    );
    return NO_OP_HANDLE;
  }

  log.info(
    `[lcm] extraction autostart: starting (interval=${(opts.intervalMs ?? DEFAULT_EXTRACTION_INTERVAL_MS) / 1000}s, perTickLimit=50)`,
  );

  const intervalMs = opts.intervalMs ?? DEFAULT_EXTRACTION_INTERVAL_MS;
  const extractor = opts.extractorFn ?? createEntityExtractorLlm({ deps: opts.deps });
  let consecutiveIdleTicks = 0;
  let consecutiveFailures = 0;
  let totalTicks = 0;
  let inFlight = false;
  let stopped = false;

  const runOneTick = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    // v4.1 Final.review.3 fix (Loop 9 B2 HIGH): outer try/catch wraps the
    // ENTIRE tick body, not just the runCoreferenceTick call. Without this,
    // any throw before line 122 (e.g. countPendingExtractions failing
    // because gateway_stop closed the DB mid-tick) becomes an unhandled
    // promise rejection from `void runOneTick()` in the setInterval/Timeout
    // callback. Backfill-autostart already had this pattern; extraction
    // was modeled on backfill but lost the outer catch in cycle-2.
    try {
      const pending = countPendingExtractions(db);
      if (pending === 0) {
        consecutiveIdleTicks++;
        if (consecutiveIdleTicks === 1) {
          log.info("[lcm] extraction autostart: queue empty; idle.");
        }
        return;
      }
      consecutiveIdleTicks = 0;

      const startedAt = Date.now();
      let result: CoreferenceTickResult & { lockAcquired: boolean };
      try {
        // Wave-1 Auditor #6 finding #4: previously called runCoreferenceTick
        // directly, bypassing the worker lock. Two gateway processes booting
        // simultaneously would both pull the same queue items and double-
        // process them (duplicate entities, duplicate mentions). Use
        // tickExtraction (orchestrator-wrapped) so the autostart shares
        // the same locking discipline as /lcm worker tick extraction.
        result = await tickExtraction(db, {
          extractor,
          passId: `autostart-${Date.now().toString(36)}`,
          perTickLimit: 50,
        });
      } catch (e) {
        consecutiveFailures++;
        log.error(
          `[lcm] extraction autostart: tick threw (consecutive=${consecutiveFailures}): ${e instanceof Error ? e.message : String(e)}`,
        );
        if (consecutiveFailures >= 3) {
          log.error(
            `[lcm] extraction autostart: 3 consecutive failures — stopping. Inspect /lcm health worker status; restart gateway after fixing the underlying issue.`,
          );
          handle.stop();
        }
        return;
      }
      totalTicks++;

      if (!result.lockAcquired) {
        log.info(
          `[lcm] extraction autostart: lock held by another worker; skipping this tick.`,
        );
        return;
      }

      const durationMs = Date.now() - startedAt;
      log.info(
        `[lcm] extraction autostart: tick ${totalTicks} processed=${result.processedCount} ` +
          `entities=${result.newEntities} mentions=${result.newMentions} ` +
          `extractor-failures=${result.extractorFailures} duration=${(durationMs / 1000).toFixed(1)}s ` +
          `(pending was ${pending}, now ${countPendingExtractions(db)})`,
      );
      // Per-tick extractor failures aren't fatal — the queue items just
      // aren't marked completed so they'll retry next tick. Only count
      // tick-level throws as "consecutive failures".
      consecutiveFailures = 0;
    } catch (e: unknown) {
      // Outer catch — anything before/after the runCoreferenceTick
      // (countPendingExtractions, log calls themselves, etc) doesn't escape.
      consecutiveFailures++;
      log.error(
        `[lcm] extraction autostart: outer tick body threw (consecutive=${consecutiveFailures}): ${e instanceof Error ? e.message : String(e)}`,
      );
      if (consecutiveFailures >= 3) {
        log.error(
          `[lcm] extraction autostart: 3 consecutive outer-tick failures — stopping. ` +
            `Likely gateway_stop closed the DB mid-tick; restart gateway after diagnosing.`,
        );
        handle.stop();
      }
    } finally {
      inFlight = false;
    }
  };

  const initialDelay = setTimeout(() => {
    if (!stopped) void runOneTick();
  }, 10_000);

  const interval = setInterval(() => {
    if (!stopped) void runOneTick();
  }, intervalMs);

  const handle: ExtractionAutostartHandle = {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      clearTimeout(initialDelay);
      log.info(`[lcm] extraction autostart: stopped (after ${totalTicks} ticks)`);
    },
    isRunning: () => !stopped,
    tickCount: () => totalTicks,
  };
  return handle;
}
