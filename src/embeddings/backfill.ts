/**
 * Embedding backfill cron — LCM v4.1 §13 Group B.04.
 *
 * Walks unembedded `summaries` rows, batches them by token budget,
 * sends to Voyage, writes vec0 + meta. Designed to run as a worker
 * job (lock-protected, resumable, rate-limited). Single-tick API:
 * caller (worker scheduler) invokes once per tick; the function
 * acquires the worker lock, processes up to `perTickLimit` documents,
 * releases the lock, returns a summary.
 *
 * Key invariants (v4.1 §13 + §0):
 *
 *   1. NO LLM/network call inside any SQLite write transaction. Each
 *      Voyage HTTP call happens OUTSIDE the per-batch DB transaction:
 *      we (a) prepare the batch (read-only SELECT), (b) call Voyage,
 *      (c) write results (transaction). Rate-state UPDATE happens
 *      BEFORE the HTTP call as a brief BEGIN IMMEDIATE that COMMITs
 *      immediately — never holding a DB write lock through HTTP latency.
 *
 *   2. Single-flight via lcm_worker_lock. Only one process runs
 *      embedding-backfill at a time; otherwise we'd burn quota and
 *      potentially write duplicate vec0 rows.
 *
 *   3. Rate limit is per-process: simple per-call sleep
 *      (1/maxRequestsPerSecond). The worker_lock already guarantees
 *      single-flight, so RPM/TPM throttling is a single-process concern.
 *      Cross-process Voyage budget coordination via lcm_voyage_rate_state
 *      table was preserved in deferred-features draft PR (#616) for when
 *      multi-gateway scenario emerges.
 *
 *   4. Resumable. Each batch's writes commit independently, so a
 *      mid-tick crash loses at most one in-flight batch worth of
 *      Voyage spend. Next tick picks up the still-unembedded rows.
 *
 *   5. Idempotent on per-row basis. Caller's pre-filter "rows where
 *      no `lcm_embedding_meta` row exists for (model, kind, id)"
 *      means re-running the cron never re-embeds an already-embedded
 *      row. UPSERT semantics on the meta table also guard against
 *      double-write.
 *
 *   6. Suppression-aware. Rows where `summaries.suppressed_at IS NOT NULL`
 *      are skipped (we don't pay for embedding text the operator has
 *      asked us to forget).
 *
 *   7. Over-cap guard. Rows where `summaries.token_count > MAX_TOKENS_PER_EMBED_DOC`
 *      are skipped + reported in `BackfillResult.skippedOverCap`. v4.1
 *      operator tooling (Group F) should investigate these (likely a
 *      summary that didn't get re-summarized after the A.10 cap bump).
 */

import type { DatabaseSync } from "node:sqlite";
import { WORKER_HEARTBEAT_MS } from "../concurrency/model.js";
import {
  acquireLock,
  generateWorkerId,
  heartbeatLock,
  releaseLock,
} from "../concurrency/worker-lock.js";
import {
  embeddingsTableExists,
  isEmbedded,
  recordEmbedding,
  vec0Version,
  type EmbeddedKind,
} from "./store.js";
import {
  embedTexts,
  MAX_TOKENS_PER_EMBED_BATCH,
  MAX_TOKENS_PER_EMBED_DOC,
  VoyageError,
  type VoyageEmbeddingModel,
  type VoyageInputType,
} from "../voyage/client.js";

export interface BackfillOptions {
  /**
   * Profile model name (must match a row in lcm_embedding_profile).
   * E.g. "voyage-4-large".
   */
  modelName: string;
  /**
   * Voyage API model id (the actual model passed to Voyage). Usually
   * == modelName but kept separate so we can switch profile names
   * (e.g. "voyage-4-large-v2" → still uses "voyage-4-large" upstream).
   */
  voyageModel: VoyageEmbeddingModel;
  /**
   * Voyage `input_type`. For backfilling stored documents this MUST be
   * 'document' — using 'query' here would degrade retrieval quality
   * because Voyage's asymmetric embedding optimizes queries for
   * matching documents, not the reverse.
   */
  inputType: VoyageInputType;
  /** Override VOYAGE_API_KEY env. */
  voyageApiKey?: string;
  /** Inject mock fetch for tests. */
  voyageFetch?: typeof fetch;
  /**
   * Override Voyage client retry count. Default 1 (so backfill caps at
   * 2 total attempts per batch). The Voyage client's own default (3
   * retries) means worst-case wall-time per batch can be ~4 minutes
   * (4 attempts × 60s timeoutMs). With WORKER_LOCK_TTL_MS = 90s, that
   * means a slow batch can let another worker GC the lock and
   * double-process. Capping at 1 retry + reduced timeoutMs (below)
   * keeps worst-case per-batch under 90s. (Group B adversarial Gap 1.)
   * Tests can opt to 0 (surface 5xx immediately, no backoff).
   */
  voyageMaxRetries?: number;
  /**
   * Wave-11 reviewer P1 fix: target output dimension. If the registered
   * profile is 256/512/2048 dim (non-default), this MUST be passed so
   * Voyage returns the right-shape vectors. Default: omit (Voyage uses
   * 1024). Resolved from `lcm_embedding_profile.dim` by callers.
   */
  voyageOutputDimension?: number;
  /**
   * Override Voyage per-attempt timeout. Default 30_000 ms (30s) here
   * (vs Voyage client's 60s default). Combined with default
   * voyageMaxRetries=1 → worst case per batch ≈ 2×30 + 0.5s backoff
   * ≈ 60.5s, comfortably under WORKER_LOCK_TTL_MS=90s. (Group B Gap 1.)
   */
  voyageTimeoutMs?: number;
  /**
   * Max requests per second to Voyage. Default 0.5 (one request every
   * 2 seconds) — generous safety margin under Voyage tier-1 limits
   * (300 RPM = 5 RPS). Worker lock-holder is the only RPS source so
   * this rate IS what hits the API.
   */
  maxRequestsPerSecond?: number;
  /** Max total Voyage tokens per single request batch. */
  maxBatchTokens?: number;
  /** What kind to embed. Default 'summary'. */
  embeddedKind?: EmbeddedKind;
  /**
   * Limit how many DOCUMENTS to embed in one cron tick. After this many,
   * release the lock and return so the next worker tick can re-acquire.
   * Default 200 — at 80K tokens/batch and 2s/batch (0.5 RPS), this is
   * roughly 7-15 minutes per tick depending on doc length. Tune up
   * for first-run backfill (no contention); down for steady state
   * (where the cron should yield to other work).
   */
  perTickLimit?: number;
  /** Min token count for a leaf to be considered. Skips empty stubs. Default 1. */
  minTokenCount?: number;
  /**
   * Max token count per single doc. Voyage rejects > 32K for voyage-4-large.
   * Default = MAX_TOKENS_PER_EMBED_DOC = 30K.
   */
  maxTokenCount?: number;
  /**
   * Worker ID for the lock. Default: generated. Caller can override
   * (e.g. tests, or worker-process scheduling that needs a stable ID
   * across cron ticks).
   */
  workerId?: string;
  /**
   * Hook for tests / observability. Called for each batch with the
   * count of docs in the batch (whether successful or failed).
   */
  onBatchComplete?: (info: {
    batchSize: number;
    succeeded: number;
    failed: number;
    voyageTokens: number;
  }) => void;
  /**
   * Skip the worker-lock acquisition. Tests/operators sometimes want
   * to run a single backfill pass without coordinating with other
   * workers. Default false.
   */
  skipLock?: boolean;
}

export interface BackfillSkippedDoc {
  summaryId: string;
  reason: "over_cap" | "voyage_400" | "voyage_other";
  detail?: string;
}

export interface BackfillResult {
  /** Number of rows successfully embedded (vec0 + meta inserts succeeded). */
  embeddedCount: number;
  /** Rows skipped without spending quota (over-cap, suppressed). */
  skippedOverCap: number;
  /** Rows that were attempted but failed (voyage error per row). */
  skipped: BackfillSkippedDoc[];
  /** Did we hit perTickLimit? (Caller schedules next tick if so.) */
  perTickLimitReached: boolean;
  /** Did we fail to acquire the lock? (Caller skips this tick.) */
  lockNotAcquired: boolean;
  /** Total tokens consumed on Voyage (from API response usage.total_tokens). */
  voyageTokensConsumed: number;
  /** Walltime in ms. */
  durationMs: number;
}

interface PendingDoc {
  summaryId: string;
  content: string;
  tokenCount: number;
}

const DEFAULT_MAX_RPS = 0.5;
const DEFAULT_PER_TICK_LIMIT = 200;
const DEFAULT_MIN_TOKEN_COUNT = 1;

/**
 * Run one backfill tick. Acquires the worker lock, processes pending
 * documents, returns. See {@link BackfillOptions} + {@link BackfillResult}.
 *
 * Caller is responsible for re-scheduling the next tick if
 * `perTickLimitReached === true` or if more rows are still pending
 * (cheap `SELECT COUNT(*)` to check).
 *
 * Throws only on PROGRAMMER errors (bad opts, unloadable vec0, missing
 * profile, missing embeddings table). Voyage errors are caught per-batch
 * and surfaced in the result; the cron continues with the next batch.
 */
export async function runBackfillTick(
  db: DatabaseSync,
  opts: BackfillOptions,
): Promise<BackfillResult> {
  const startedAt = Date.now();

  // Validate vec0 environment up-front.
  if (vec0Version(db) === null) {
    throw new Error("[backfill] sqlite-vec is not loaded — call tryLoadSqliteVec() first");
  }
  if (!embeddingsTableExists(db, opts.modelName)) {
    throw new Error(
      `[backfill] embeddings table for ${opts.modelName} doesn't exist — ` +
        `call ensureEmbeddingsTable() first`,
    );
  }

  const workerId = opts.workerId ?? generateWorkerId("embed-backfill");
  const embeddedKind: EmbeddedKind = opts.embeddedKind ?? "summary";
  const maxBatchTokens = opts.maxBatchTokens ?? MAX_TOKENS_PER_EMBED_BATCH;
  const maxTokenCount = opts.maxTokenCount ?? MAX_TOKENS_PER_EMBED_DOC;
  const minTokenCount = opts.minTokenCount ?? DEFAULT_MIN_TOKEN_COUNT;
  const perTickLimit = opts.perTickLimit ?? DEFAULT_PER_TICK_LIMIT;
  const maxRps = opts.maxRequestsPerSecond ?? DEFAULT_MAX_RPS;
  const minBatchInterval = maxRps > 0 ? 1000 / maxRps : 0;

  const empty: BackfillResult = {
    embeddedCount: 0,
    skippedOverCap: 0,
    skipped: [],
    perTickLimitReached: false,
    lockNotAcquired: false,
    voyageTokensConsumed: 0,
    durationMs: 0,
  };

  // Acquire worker lock (unless explicitly skipping).
  if (!opts.skipLock) {
    const got = acquireLock(db, "embedding-backfill", {
      workerId,
      jobMetadata: `model=${opts.modelName} kind=${embeddedKind}`,
    });
    if (!got) {
      return { ...empty, lockNotAcquired: true, durationMs: Date.now() - startedAt };
    }
  }

  let result = empty;
  let lastBatchAt = 0;
  // Per-tick blocklist: docs that already failed Voyage this tick. Each
  // is excluded from subsequent SELECTs so we don't retry within the
  // same tick (next tick will re-attempt — Voyage may have recovered).
  const failedThisTick = new Set<string>();
  try {
    let processed = 0;

    while (processed < perTickLimit) {
      // 1. SELECT next batch — only documents NOT in lcm_embedding_meta
      //    for this (model, kind), within token bounds, not suppressed.
      const remaining = perTickLimit - processed;
      const batchSize = Math.min(remaining, 64); // cap per SELECT
      const candidates = selectPendingDocs(db, {
        modelName: opts.modelName,
        embeddedKind,
        minTokenCount,
        maxTokenCount,
        limit: batchSize,
        excludeIds: failedThisTick,
      });
      if (candidates.length === 0) {
        // No more pending — done.
        break;
      }

      // 2. Identify over-cap (shouldn't happen due to SELECT filter, but
      //    defensive). And separate the over-cap from the queryable.
      const queryable: PendingDoc[] = [];
      for (const doc of candidates) {
        if (doc.tokenCount > maxTokenCount) {
          result = withSkippedOverCap(result, doc.summaryId);
        } else {
          queryable.push(doc);
        }
      }
      if (queryable.length === 0) {
        processed += candidates.length;
        continue;
      }

      // 3. Group queryable into batches that fit maxBatchTokens.
      const batches = packBatches(queryable, maxBatchTokens);

      for (const batch of batches) {
        // Rate-limit pacing: wait at least minBatchInterval since last call.
        if (lastBatchAt > 0 && minBatchInterval > 0) {
          const elapsed = Date.now() - lastBatchAt;
          if (elapsed < minBatchInterval) {
            await sleep(minBatchInterval - elapsed);
          }
        }
        // Heartbeat the lock so we don't get preempted mid-tick.
        if (!opts.skipLock) {
          const stillOurs = heartbeatLock(db, "embedding-backfill", workerId);
          if (!stillOurs) {
            // Another worker stole the lock — abort cleanly.
            return {
              ...result,
              durationMs: Date.now() - startedAt,
              lockNotAcquired: true,
            };
          }
        }

        lastBatchAt = Date.now();
        let resp;
        try {
          resp = await embedTexts({
            model: opts.voyageModel,
            texts: batch.map((d) => d.content),
            inputType: opts.inputType,
            apiKey: opts.voyageApiKey,
            fetch: opts.voyageFetch,
            // Group B Gap 1 fix: cap per-batch wall-time below
            // WORKER_LOCK_TTL_MS=90s. See voyageMaxRetries / voyageTimeoutMs
            // option docs for rationale. Use ?? not || so an explicit 0
            // (test scenarios) is honored.
            maxRetries: opts.voyageMaxRetries ?? 1,
            timeoutMs: opts.voyageTimeoutMs ?? 30_000,
            // Wave-11 reviewer P1: forward output dimension so 256/512/
            // 2048-dim profiles get the right-shape vectors back.
            outputDimension: opts.voyageOutputDimension,
          });
        } catch (e: unknown) {
          // Voyage error — record in skipped list, continue with next
          // batch. We DO NOT retry per-doc; that would amplify cost.
          // The next tick will re-attempt the same docs (they still
          // have no meta row).
          if (e instanceof VoyageError && e.kind === "auth") {
            // Auth error is fatal — every subsequent batch will fail too.
            // Re-throw so caller (worker scheduler) surfaces to operator.
            throw e;
          }
          for (const doc of batch) {
            failedThisTick.add(doc.summaryId);
            result = withSkippedDoc(result, {
              summaryId: doc.summaryId,
              reason: e instanceof VoyageError && e.kind === "bad_request" ? "voyage_400" : "voyage_other",
              detail: e instanceof Error ? e.message : String(e),
            });
          }
          opts.onBatchComplete?.({
            batchSize: batch.length,
            succeeded: 0,
            failed: batch.length,
            voyageTokens: 0,
          });
          processed += batch.length;
          continue;
        }

        // 4. Write results (vec0 + meta). One implicit transaction per
        //    batch via writeBatch's internal BEGIN/COMMIT.
        const writeReport = writeBatch(db, opts.modelName, embeddedKind, batch, resp.vectors);
        result = {
          ...result,
          embeddedCount: result.embeddedCount + writeReport.succeeded,
          voyageTokensConsumed: result.voyageTokensConsumed + resp.totalTokens,
          skipped: [...result.skipped, ...writeReport.errors],
        };
        opts.onBatchComplete?.({
          batchSize: batch.length,
          succeeded: writeReport.succeeded,
          failed: writeReport.errors.length,
          voyageTokens: resp.totalTokens,
        });
        processed += batch.length;
      }
    }

    if (processed >= perTickLimit) {
      result = { ...result, perTickLimitReached: true };
    }
  } finally {
    if (!opts.skipLock) {
      releaseLock(db, "embedding-backfill", workerId);
    }
  }

  return { ...result, durationMs: Date.now() - startedAt };
}

/** How many documents are pending embedding for this (model, kind)? */
export function countPendingDocs(
  db: DatabaseSync,
  args: {
    modelName: string;
    embeddedKind?: EmbeddedKind;
    minTokenCount?: number;
    maxTokenCount?: number;
  },
): number {
  const kind = args.embeddedKind ?? "summary";
  const minTC = args.minTokenCount ?? DEFAULT_MIN_TOKEN_COUNT;
  const maxTC = args.maxTokenCount ?? MAX_TOKENS_PER_EMBED_DOC;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM summaries s
         WHERE s.suppressed_at IS NULL
           AND s.token_count BETWEEN ? AND ?
           AND s.kind = 'leaf'
           AND NOT EXISTS (
             SELECT 1 FROM lcm_embedding_meta m
               WHERE m.embedded_id = s.summary_id
                 AND m.embedded_kind = ?
                 AND m.embedding_model = ?
                 AND m.archived = 0
           )`,
    )
    .get(minTC, maxTC, kind, args.modelName) as { n: number };
  return row.n;
}

// ---------- internals ----------

function selectPendingDocs(
  db: DatabaseSync,
  args: {
    modelName: string;
    embeddedKind: EmbeddedKind;
    minTokenCount: number;
    maxTokenCount: number;
    limit: number;
    /** IDs to exclude (e.g. failed-this-tick blocklist). */
    excludeIds?: Set<string>;
  },
): PendingDoc[] {
  // ORDER BY summary_id DESC: prioritize newer leaves so freshest content
  // gets queryable fastest. Deterministic ordering also helps us debug
  // (next tick pulls the same set if conditions don't change).
  const exclude = args.excludeIds && args.excludeIds.size > 0 ? Array.from(args.excludeIds) : [];
  // Build IN-list dynamically; exclude can be empty (no IN clause needed).
  const excludeClause = exclude.length > 0
    ? `AND s.summary_id NOT IN (${exclude.map(() => "?").join(",")})`
    : "";
  const sql = `SELECT s.summary_id, s.content, s.token_count
       FROM summaries s
       WHERE s.suppressed_at IS NULL
         AND s.token_count BETWEEN ? AND ?
         AND s.kind = 'leaf'
         ${excludeClause}
         AND NOT EXISTS (
           SELECT 1 FROM lcm_embedding_meta m
             WHERE m.embedded_id = s.summary_id
               AND m.embedded_kind = ?
               AND m.embedding_model = ?
               AND m.archived = 0
         )
       ORDER BY s.summary_id DESC
       LIMIT ?`;
  const rows = db
    .prepare(sql)
    .all(
      args.minTokenCount,
      args.maxTokenCount,
      ...exclude,
      args.embeddedKind,
      args.modelName,
      args.limit,
    ) as Array<{ summary_id: string; content: string; token_count: number }>;
  return rows.map((r) => ({
    summaryId: r.summary_id,
    content: r.content,
    tokenCount: r.token_count,
  }));
}

/**
 * Pack docs into batches that fit `maxBatchTokens`. Greedy-bin-pack —
 * docs are already in SELECT order; we don't re-sort. Each batch
 * respects: sum(token_count) <= maxBatchTokens AND batch.length >= 1.
 * If a single doc exceeds maxBatchTokens, it goes in a batch of 1
 * (Voyage rejects with 400; caller records as skipped voyage_400 and moves on).
 */
function packBatches(docs: PendingDoc[], maxBatchTokens: number): PendingDoc[][] {
  const batches: PendingDoc[][] = [];
  let current: PendingDoc[] = [];
  let currentTokens = 0;
  for (const doc of docs) {
    if (current.length > 0 && currentTokens + doc.tokenCount > maxBatchTokens) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(doc);
    currentTokens += doc.tokenCount;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function writeBatch(
  db: DatabaseSync,
  modelName: string,
  embeddedKind: EmbeddedKind,
  batch: PendingDoc[],
  vectors: Float32Array[],
): { succeeded: number; errors: BackfillSkippedDoc[] } {
  const errors: BackfillSkippedDoc[] = [];
  let succeeded = 0;
  // Wave-1 Auditor #2 finding #4: per-row write failure inside the batch
  // tx left a phantom vec0 row (no corresponding meta) when recordEmbedding
  // partially succeeded — the meta-side INSERT failed but the vec0-side
  // had already gone through. On the next tick, NOT EXISTS in meta would
  // re-pick the doc, INSERT a SECOND vec0 row, and now we have duplicate
  // KNN entries.
  //
  // Each row gets its own SAVEPOINT so we can roll back JUST that row's
  // partial writes (vec0 + meta together) on per-row failure, without
  // killing the whole batch.
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let i = 0; i < batch.length; i++) {
      const doc = batch[i];
      const vec = vectors[i];
      const sp = `bf_${i}`;
      db.exec(`SAVEPOINT ${sp}`);
      try {
        recordEmbedding(db, {
          modelName,
          embeddedId: doc.summaryId,
          embeddedKind,
          vector: vec,
          sourceTokenCount: doc.tokenCount,
        });
        db.exec(`RELEASE ${sp}`);
        succeeded++;
      } catch (e: unknown) {
        // Per-row write failure (rare — dim mismatch, e.g.). Roll back to
        // SAVEPOINT — that erases any vec0 partial write, leaving the row
        // entirely unsynced. Caller will re-pick on next tick (clean slate).
        try {
          db.exec(`ROLLBACK TO ${sp}`);
          db.exec(`RELEASE ${sp}`);
        } catch {
          // best-effort; if savepoint rollback fails the outer
          // try/catch will catch and ROLLBACK the whole tx.
        }
        errors.push({
          summaryId: doc.summaryId,
          reason: "voyage_other",
          detail: e instanceof Error ? e.message : String(e),
        });
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    // Transaction-level error (constraint failure, lock loss). Roll
    // back; caller will see no progress on these docs and re-attempt.
    db.exec("ROLLBACK");
    for (const doc of batch) {
      errors.push({
        summaryId: doc.summaryId,
        reason: "voyage_other",
        detail: `tx-rollback: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    succeeded = 0;
  }
  return { succeeded, errors };
}

function withSkippedOverCap(prev: BackfillResult, summaryId: string): BackfillResult {
  return {
    ...prev,
    skippedOverCap: prev.skippedOverCap + 1,
    skipped: [...prev.skipped, { summaryId, reason: "over_cap" }],
  };
}

function withSkippedDoc(prev: BackfillResult, doc: BackfillSkippedDoc): BackfillResult {
  return { ...prev, skipped: [...prev.skipped, doc] };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Re-export for backfill internals so the caller doesn't have to know about
// the heartbeat cadence externally.
export { WORKER_HEARTBEAT_MS, isEmbedded };
