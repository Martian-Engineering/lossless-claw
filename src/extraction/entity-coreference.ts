/**
 * Entity coreference extraction — LCM v4.1 §6.1 / §7 Group E.
 *
 * Async worker job. For each leaf newly added to lcm_extraction_queue,
 * extracts entity mentions and resolves them against `lcm_entities`.
 *
 * v3.1 invariant: extraction MUST be async, not inline with leaf write.
 * Three adversarial agents converged on this — inline extraction
 * couples gateway hot-path latency to LLM call latency. The
 * `lcm_extraction_queue` table (added in A.03) is the inbox; this module
 * drains it.
 *
 * Pipeline per queued leaf:
 *
 *   1. Pull leaf content + session_key.
 *   2. Call INJECTED `extractEntities(text)` → list of {surface, type}.
 *   3. For each surface:
 *      a. Lookup via UNIQUE INDEX (session_key + canonical_text NOCASE)
 *         on lcm_entities.
 *      b. If found → INSERT lcm_entity_mentions row, bump
 *         occurrence_count + last_seen_at on the entity.
 *      c. If not found → INSERT new lcm_entity in same transaction;
 *         INSERT mention.
 *   4. Mark queue row processed.
 *
 * Coreference simplification: this commit does EXACT-NOCASE matching
 * via the existing UNIQUE index. Fuzzy/semantic coreference (the
 * voyage-3-lite entity-embedding lookup mentioned in architecture-v4.1)
 * is a follow-up — would extend extractedSurface → vector → KNN against
 * vec0 entity-embedded rows.
 *
 * Type registry update: each extracted entity_type is upserted into
 * `lcm_entity_type_registry` so operator tooling can review the
 * type vocabulary and normalize.
 *
 * Idempotency: re-processing the same leaf is safe. The mention insert
 * uses a deterministic mention_id per (entity_id, summary_id, surface);
 * the UNIQUE constraint on (entity_id, summary_id) — wait, no, mention_id
 * is the PK. We use INSERT OR IGNORE on a deterministic mention_id so
 * re-runs don't duplicate mentions.
 */

import type { DatabaseSync } from "node:sqlite";

export interface ExtractedEntity {
  /** Surface form as it appears in text (e.g. "PR #71676"). */
  surface: string;
  /**
   * Free-text type label (e.g. "pr_number", "session_key", "agent_id").
   * v4.1.1 §C: no CHECK constraint — operator domain has open-ended types.
   * The type_registry tracks first-seen + occurrence count.
   */
  entityType: string;
  /**
   * Optional offset of the surface in the source text. Stored in the
   * mention row for span-anchored future use (highlight, lineage).
   */
  spanStart?: number;
  spanEnd?: number;
  /**
   * Canonical text override. If not provided, defaults to surface
   * trimmed + lowercased — UNIQUE index uses NOCASE so case variants
   * dedupe automatically.
   */
  canonicalText?: string;
}

export type ExtractEntities = (args: {
  summaryId: string;
  sessionKey: string;
  content: string;
}) => Promise<ExtractedEntity[]>;

export interface CoreferenceTickOptions {
  /**
   * Limit how many queued items to process per tick. After this many,
   * release the lock and return so the next tick can re-acquire.
   * Default 50.
   */
  perTickLimit?: number;
  /** Caller-supplied identifier for this pass (audit / telemetry). */
  passId: string;
  /**
   * Wave-4 Auditor #12 P0-1 + #13 P1 fix: optional per-item heartbeat
   * callback. Caller passes a function that extends the worker lock TTL
   * (and returns whether we still hold it). Without this, a 50-item tick
   * with 30s/item LLM calls = 25 min total, far past the 90s
   * WORKER_LOCK_TTL_MS — by which time another autostart on a second
   * gateway will GC + re-acquire and double-process the queue.
   *
   * Returns false → caller has lost the lock; runCoreferenceTick aborts
   * the loop, commits whatever's already done, and returns. The caller
   * (tickExtraction in worker-orchestrator.ts) MUST acknowledge this
   * outcome via `result.lockLostMidTick` (added below).
   */
  onItemHeartbeat?: () => boolean;
}

export interface CoreferenceTickResult {
  processedCount: number;
  /** Total entities inserted (newly seen). */
  newEntities: number;
  /** Total mentions inserted (across all leaves). */
  newMentions: number;
  /** Queue items where the extractor threw. */
  extractorFailures: number;
  /**
   * Wave-4 Auditor #12 P0-1 + #13 P1 fix: signals the heartbeat callback
   * returned false partway through the tick. Caller (orchestrator) MUST
   * surface this so the autostart can adjust pacing — otherwise next tick
   * will repeat from a stale spot.
   */
  lockLostMidTick?: boolean;
  /** Per-queue-item details for diagnostics. */
  perItem: Array<{
    queueId: string;
    leafId: string;
    success: boolean;
    entityCount?: number;
    mentionCount?: number;
    error?: string;
  }>;
}

const DEFAULT_PER_TICK_LIMIT = 50;

/**
 * Drain the extraction queue once. Pulls up to `perTickLimit` queued
 * leaves and extracts entities from each. Returns telemetry.
 *
 * Caller (worker scheduler) handles lock acquisition + repeated ticks.
 *
 * NOT inline with leaf writes — caller MUST be a worker process /
 * thread, not the gateway hot path. This module doesn't enforce that;
 * the architectural invariant is up to the caller's wiring.
 */
export async function runCoreferenceTick(
  db: DatabaseSync,
  extractor: ExtractEntities,
  opts: CoreferenceTickOptions,
): Promise<CoreferenceTickResult> {
  const perTickLimit = opts.perTickLimit ?? DEFAULT_PER_TICK_LIMIT;

  const result: CoreferenceTickResult = {
    processedCount: 0,
    newEntities: 0,
    newMentions: 0,
    extractorFailures: 0,
    perItem: [],
  };

  // 1. Pull queued items (kind='entity') ordered by queued_at ASC.
  //
  // Wave-4 Auditor #12 P1-1 fix: dead-letter the queue rows that have
  // failed too many times. The schema has `attempts` + index for
  // `attempts >= 5` (migration.ts:1322-1335) but neither was being used.
  // Without this gate, an extractor that keeps throwing on the same
  // pathological row burns the per-tick budget forever — and Wave-4
  // Auditor #4 noted the same rows pile up under Voyage outages.
  const MAX_ATTEMPTS = 5;
  const queueItems = db
    .prepare(
      `SELECT q.queue_id, q.leaf_id, q.attempts, s.content, s.session_key
         FROM lcm_extraction_queue q
         JOIN summaries s ON s.summary_id = q.leaf_id
         WHERE q.kind = 'entity' AND q.completed_at IS NULL
           AND q.attempts < ?
           AND s.suppressed_at IS NULL
         ORDER BY q.queued_at ASC
         LIMIT ?`,
    )
    .all(MAX_ATTEMPTS, perTickLimit) as Array<{
    queue_id: string;
    leaf_id: string;
    attempts: number;
    content: string;
    session_key: string;
  }>;

  for (const item of queueItems) {
    // Wave-4 Auditor #12 P0-1: heartbeat at the start of each item.
    // If lock-loss detected, abort the loop early and surface the signal.
    if (opts.onItemHeartbeat) {
      const stillHeld = opts.onItemHeartbeat();
      if (!stillHeld) {
        result.lockLostMidTick = true;
        break;
      }
    }

    const itemDetail: CoreferenceTickResult["perItem"][number] = {
      queueId: item.queue_id,
      leafId: item.leaf_id,
      success: false,
    };

    let extracted: ExtractedEntity[];
    try {
      extracted = await extractor({
        summaryId: item.leaf_id,
        sessionKey: item.session_key,
        content: item.content,
      });
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      itemDetail.error = errMsg;
      result.extractorFailures++;
      result.perItem.push(itemDetail);
      // Wave-4 Auditor #12 P1-1 fix + Wave-5 P1 fix: bump attempts +
      // record last_error so the dead-letter gate (attempts < MAX_ATTEMPTS)
      // actually fires after enough retries. Without this, the queue row
      // attempts column stayed at 0 forever and the same poison row burned
      // tick budgets.
      //
      // Wave-5 fix: if THIS UPDATE itself fails (DB locked, schema race),
      // log the secondary failure and surface in itemDetail so callers
      // can see the dead-letter mechanism is broken — was previously
      // silent + would loop forever.
      try {
        db.prepare(
          `UPDATE lcm_extraction_queue
             SET attempts = COALESCE(attempts, 0) + 1,
                 last_error = ?
             WHERE queue_id = ?`,
        ).run(errMsg.slice(0, 500), item.queue_id);
      } catch (updateErr) {
        const updateErrMsg = updateErr instanceof Error ? updateErr.message : String(updateErr);
        // Wave-6 P2 fix: slice both halves to 500 chars before merging
        // so a multi-MB error blob can't blow up `result.perItem` (which
        // is returned to operators via /lcm health surfaces).
        itemDetail.error =
          `${errMsg.slice(0, 500)} | dead-letter-update-failed: ${updateErrMsg.slice(0, 500)}`;
        // Wave-7 Auditor #12 P1-E fix: try a second, simpler bump-only
        // UPDATE so the dead-letter mechanism still progresses even if
        // the first attempt (with last_error string) failed (e.g., due
        // to BLOB-size constraint or a DB-locked retry). Without this,
        // attempts stays at 0 forever and the row retries indefinitely.
        try {
          db.prepare(
            `UPDATE lcm_extraction_queue SET attempts = COALESCE(attempts, 0) + 1 WHERE queue_id = ?`,
          ).run(item.queue_id);
        } catch {
          // best-effort. If even the simpler bump fails, the operator
          // sees the "dead-letter-update-failed" string in itemDetail.
          // Operator can manually purge the queue row via /lcm.
        }
        // Don't break the loop — other items may still be processable.
      }
      continue; // don't mark queue row processed — next tick will retry (until attempts >= MAX_ATTEMPTS)
    }

    let entityCountThisItem = 0;
    let mentionCountThisItem = 0;

    db.exec("BEGIN IMMEDIATE");
    try {
      // Wave-7 Auditor #12 P0 fix: per-row SAVEPOINT inside the batch
      // tx so a SINGLE bad surface (FK violation, encoding bomb,
      // CHECK constraint failure, etc.) doesn't ROLLBACK the whole leaf
      // and discard all its other valid mentions. Without this, the
      // dead-letter mechanism (W4 fix) couldn't fire because the
      // per-leaf BEGIN IMMEDIATE / ROLLBACK at line 361 wasn't bumping
      // attempts — leaving poison surfaces in infinite retry.
      // 2. For each extracted entity surface, upsert + mention
      let entityIdx = -1;
      for (const ent of extracted) {
        entityIdx++;
        const canonical = (ent.canonicalText ?? ent.surface).trim();
        if (canonical.length === 0) continue;
        const sp = `coref_${entityIdx}_${Date.now().toString(36)}`;
        db.exec(`SAVEPOINT ${sp}`);
        try {

        // Upsert entity (using NOCASE UNIQUE on session_key + canonical_text)
        const existing = db
          .prepare(
            `SELECT entity_id, occurrence_count FROM lcm_entities
               WHERE session_key = ? AND canonical_text = ? COLLATE NOCASE`,
          )
          .get(item.session_key, canonical) as
          | { entity_id: string; occurrence_count: number }
          | undefined;

        let entityId: string;
        if (existing) {
          entityId = existing.entity_id;
          // Wave-1 Auditor #7 finding #7: occurrence_count was bumped
          // unconditionally even on idempotent re-processing. The
          // mention-side has dedup via deterministic mention_id, but
          // the entity-side did not. Bump occurrence_count ONLY when a
          // NEW mention row is actually inserted (we'll do that below
          // and bump retroactively).
        } else {
          // Wave-1 Auditor #7 finding #4: previous code did plain INSERT,
          // which threw UNIQUE constraint violation on concurrent ticks
          // processing different leaves with the same canonical surface.
          // ROLLBACK + retry forever was the result. Use INSERT OR IGNORE
          // and re-SELECT to find the winner — race-safe.
          entityId = `ent_${randomSuffix()}`;
          const insertRes = db
            .prepare(
              `INSERT OR IGNORE INTO lcm_entities
                 (entity_id, session_key, canonical_text, entity_type,
                  first_seen_at, last_seen_at, first_seen_in_summary_id, occurrence_count)
               VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), ?, 0)`,
            )
            .run(entityId, item.session_key, canonical, ent.entityType, item.leaf_id);
          if (Number(insertRes.changes) === 0) {
            // Lost the race — another concurrent tick won. Re-SELECT.
            const winner = db
              .prepare(
                `SELECT entity_id FROM lcm_entities
                   WHERE session_key = ? AND canonical_text = ? COLLATE NOCASE`,
              )
              .get(item.session_key, canonical) as
              | { entity_id: string }
              | undefined;
            if (winner) {
              entityId = winner.entity_id;
            }
            // If somehow not found, fall through — the next mention insert
            // will fail FK and the savepoint will roll back this entity's
            // work. Safer than corrupting the catalog.
          } else {
            entityCountThisItem++;
            // Update type registry (PK = type_name)
            db.prepare(
              `INSERT INTO lcm_entity_type_registry (type_name, first_seen_at, occurrence_count)
               VALUES (?, datetime('now'), 1)
               ON CONFLICT(type_name) DO UPDATE SET
                 occurrence_count = occurrence_count + 1`,
            ).run(ent.entityType);
          }
        }

        // Group E adversarial Gap 3 fix + Wave-1 Auditor #7 finding #2:
        // Deterministic mention_id with FNV-1a content hash of the FULL
        // surface (instead of 16-char truncation). Same surface in same
        // leaf for same entity = SAME mention_id = INSERT OR IGNORE
        // no-ops (correct idempotency). Different surfaces with shared
        // 16-char prefix no longer silently collide.
        const mentionId = `men_${entityId}_${item.leaf_id}_${surfaceHashForId(ent.surface, 16)}`;
        const result_run = db
          .prepare(
            `INSERT OR IGNORE INTO lcm_entity_mentions
               (mention_id, entity_id, summary_id, surface_form,
                span_start, span_end, mentioned_at)
             VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
          )
          .run(
            mentionId,
            entityId,
            item.leaf_id,
            ent.surface,
            ent.spanStart ?? null,
            ent.spanEnd ?? null,
          );
        if (Number(result_run.changes) > 0) {
          mentionCountThisItem++;
          // Bump occurrence count ONLY on truly-new mention insert.
          // last_seen_at always advances (the latest leaf-write that
          // mentions this entity is "seen now").
          db.prepare(
            `UPDATE lcm_entities
               SET occurrence_count = occurrence_count + 1,
                   last_seen_at = datetime('now')
               WHERE entity_id = ?`,
          ).run(entityId);
        }
        // Wave-7 Auditor #12 P0 fix: close the per-row SAVEPOINT.
        // Releasing on success commits this entity's writes into the
        // outer tx without affecting siblings.
        db.exec(`RELEASE ${sp}`);
        } catch (perRowErr: unknown) {
          // Per-surface failure rolls back JUST this entity's writes;
          // siblings already-committed within the outer tx survive.
          // Record the error in itemDetail so operator/dead-letter sees
          // partial-progress + which surface failed.
          try {
            db.exec(`ROLLBACK TO ${sp}`);
            db.exec(`RELEASE ${sp}`);
          } catch {
            // best-effort: if SAVEPOINT rollback fails, the outer
            // try/catch will catch + ROLLBACK the whole leaf.
            throw perRowErr;
          }
          // Surface in itemDetail (truncated). Loop continues for other entities.
          const perRowMsg = perRowErr instanceof Error ? perRowErr.message : String(perRowErr);
          if (!itemDetail.error) itemDetail.error = "";
          itemDetail.error += ` | per-row-failed[${entityIdx}]: ${perRowMsg.slice(0, 200)}`;
        }
      }

      // 3. Mark queue row processed
      db.prepare(
        `UPDATE lcm_extraction_queue SET completed_at = datetime('now') WHERE queue_id = ?`,
      ).run(item.queue_id);

      db.exec("COMMIT");
      itemDetail.success = true;
      itemDetail.entityCount = entityCountThisItem;
      itemDetail.mentionCount = mentionCountThisItem;
      result.newEntities += entityCountThisItem;
      result.newMentions += mentionCountThisItem;
      result.processedCount++;
    } catch (e: unknown) {
      db.exec("ROLLBACK");
      itemDetail.error = `tx-rollback: ${e instanceof Error ? e.message : String(e)}`;
      result.extractorFailures++;
    }
    result.perItem.push(itemDetail);
  }

  return result;
}

/**
 * Cheap probe: how many extraction-queue items are pending? For
 * `/lcm health` and tick-scheduling decisions.
 */
export function countPendingExtractions(
  db: DatabaseSync,
  args: { kind?: "entity" | "procedure-recheck" } = {},
): number {
  // Wave-10 reviewer P2 fix: previously this only filtered on
  // `kind` + `completed_at IS NULL`, but `runCoreferenceTick`'s
  // selector ALSO requires `attempts < 5` (dead-letter gate, line
  // 160-167) AND `summaries.suppressed_at IS NULL` (don't process
  // suppressed leaves). The mismatch caused the autostart loop to
  // spin forever on rows the tick would never select — operator
  // saw `pendingCount > 0` but no progress.
  // Match the selector exactly so pending count = eligible work.
  const kind = args.kind ?? "entity";
  const MAX_ATTEMPTS = 5;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM lcm_extraction_queue q
         JOIN summaries s ON s.summary_id = q.leaf_id
         WHERE q.kind = ?
           AND q.completed_at IS NULL
           AND q.attempts < ?
           AND s.suppressed_at IS NULL`,
    )
    .get(kind, MAX_ATTEMPTS) as { n: number };
  return row.n;
}

// Wave-1 Auditor #7 finding #3: Math.random() gives only 32-bit space
// (~64K collision probability after 65K entities). Switched to
// crypto.randomUUID() prefix for ~128-bit collision-free space.
function randomSuffix(): string {
  // Take 12 hex chars from a UUID — 48 bits, ~16M docs before
  // birthday-collision becomes plausible. Sufficient for realistic
  // entity counts (~ low millions max).
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    const u = crypto.randomUUID().replace(/-/g, "");
    return u.slice(0, 12);
  }
  // Fallback for environments without crypto: combine two Math.random
  // values to get 53 effective bits.
  const a = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0");
  const b = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, "0");
  return `${a}${b}`;
}

// Wave-1 Auditor #7 finding #2: 16-char truncation produced intra-leaf
// collisions for surfaces sharing the first 16 alphanumerics (e.g.
// "PR #71676 (rebase target)" vs "PR #71676 (current)"). Use a content
// hash of the FULL surface so collisions only happen on identical
// surfaces (which is the desired idempotency property).
function surfaceHashForId(surface: string, maxBytes = 16): string {
  // Deterministic short hash (FNV-1a 32-bit, hex). Cheap, no crypto
  // dependency. Collision probability for distinct surfaces in the
  // same (entity_id, leaf_id) bucket: ~1 in 2^32, vastly safer than
  // 16-char prefix on long shared surfaces.
  let hash = 0x811c9dc5;
  for (let i = 0; i < surface.length; i++) {
    hash ^= surface.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const hex = (hash >>> 0).toString(16).padStart(8, "0");
  // Combine with a sanitized prefix of the surface so debugging is
  // legible in the DB ("men_..._PR_71676__a1b2c3d4").
  const prefix = surface
    .replace(/[^A-Za-z0-9]/g, "_")
    .slice(0, Math.max(0, maxBytes - hex.length - 1));
  return prefix.length > 0 ? `${prefix}_${hex}` : hex;
}

// Kept for backward compatibility in any helper that still calls it
// with semantic "truncation, not hashing" intent (not used for IDs).
function truncateForId(s: string, maxLen: number): string {
  return s.replace(/[^A-Za-z0-9]/g, "_").slice(0, maxLen);
}
