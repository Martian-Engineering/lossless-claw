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
}

export interface CoreferenceTickResult {
  processedCount: number;
  /** Total entities inserted (newly seen). */
  newEntities: number;
  /** Total mentions inserted (across all leaves). */
  newMentions: number;
  /** Queue items where the extractor threw. */
  extractorFailures: number;
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

  // 1. Pull queued items (kind='entity') ordered by queued_at ASC
  const queueItems = db
    .prepare(
      `SELECT q.queue_id, q.leaf_id, s.content, s.session_key
         FROM lcm_extraction_queue q
         JOIN summaries s ON s.summary_id = q.leaf_id
         WHERE q.kind = 'entity' AND q.completed_at IS NULL
           AND s.suppressed_at IS NULL
         ORDER BY q.queued_at ASC
         LIMIT ?`,
    )
    .all(perTickLimit) as Array<{
    queue_id: string;
    leaf_id: string;
    content: string;
    session_key: string;
  }>;

  for (const item of queueItems) {
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
      itemDetail.error = e instanceof Error ? e.message : String(e);
      result.extractorFailures++;
      result.perItem.push(itemDetail);
      continue; // don't mark queue row processed — next tick will retry
    }

    let entityCountThisItem = 0;
    let mentionCountThisItem = 0;

    db.exec("BEGIN IMMEDIATE");
    try {
      // 2. For each extracted entity surface, upsert + mention
      for (const ent of extracted) {
        const canonical = (ent.canonicalText ?? ent.surface).trim();
        if (canonical.length === 0) continue;

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
          db.prepare(
            `UPDATE lcm_entities
               SET occurrence_count = occurrence_count + 1,
                   last_seen_at = datetime('now')
               WHERE entity_id = ?`,
          ).run(entityId);
        } else {
          entityId = `ent_${randomSuffix()}`;
          db.prepare(
            `INSERT INTO lcm_entities
               (entity_id, session_key, canonical_text, entity_type,
                first_seen_at, last_seen_at, first_seen_in_summary_id, occurrence_count)
             VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), ?, 1)`,
          ).run(entityId, item.session_key, canonical, ent.entityType, item.leaf_id);
          entityCountThisItem++;
          // Update type registry (PK = type_name)
          db.prepare(
            `INSERT INTO lcm_entity_type_registry (type_name, first_seen_at, occurrence_count)
             VALUES (?, datetime('now'), 1)
             ON CONFLICT(type_name) DO UPDATE SET
               occurrence_count = occurrence_count + 1`,
          ).run(ent.entityType);
        }

        // Group E adversarial Gap 3 fix: TRULY deterministic mention_id
        // (no random suffix — was defeating the INSERT OR IGNORE
        // idempotency guarantee, causing duplicate mentions on re-runs).
        // Same surface in same leaf for same entity = SAME mention_id =
        // INSERT OR IGNORE no-ops (correct semantics).
        const mentionId = `men_${entityId}_${item.leaf_id}_${truncateForId(ent.surface, 16)}`;
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
  const kind = args.kind ?? "entity";
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM lcm_extraction_queue
         WHERE kind = ? AND completed_at IS NULL`,
    )
    .get(kind) as { n: number };
  return row.n;
}

function randomSuffix(): string {
  return Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0");
}

function truncateForId(s: string, maxLen: number): string {
  // Strip non-alphanumerics for use in mention_id; truncate.
  return s
    .replace(/[^A-Za-z0-9]/g, "_")
    .slice(0, maxLen);
}
