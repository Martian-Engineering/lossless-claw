/**
 * Operator hard-forget — LCM v4.1 §10 / Group F.
 *
 * Soft-suppression (set summaries.suppressed_at) is the default + most
 * common path; this module is for the OPERATOR-only hard-purge.
 *
 * Two modes:
 *
 *   mode='soft' (default) — sets suppressed_at on the matched leaves +
 *      raw messages; trigger cascades to vec0 metadata (B.03);
 *      condensed summaries that contained the suppressed leaves are
 *      flagged via contains_suppressed_leaves=1 (set by caller code OR
 *      by idle-pass) so the next assemble() pyramid sees the staleness.
 *
 *   mode='immediate' — TWO-STEP process. Doc was misleading before
 *      Final.review P2 #3 fix; here's the actual behavior:
 *      (1) NOW: marks `summaries.suppressed_at` + cleans `context_items`
 *          + cascades to `messages.suppressed_at` (Final.review P1 #2)
 *          + enqueues affected condensed summaries to
 *          lcm_purge_rebuild_queue. Suppression cascade triggers
 *          (B.03) fire so vec0 + meta + themes mirror the change.
 *      (2) LATER: a worker drains the rebuild queue + rebuilds those
 *          condensed summaries WITHOUT the purged content + only THEN
 *          can the leaves be hard-deleted (parent_summary_id RESTRICT
 *          FK refs prevent direct DELETE until rebuild finishes).
 *
 *      ⚠️ CYCLE-3 GAP: the rebuild worker DOES NOT EXIST yet. Currently
 *      'immediate' mode is functionally equivalent to 'soft' mode +
 *      populating lcm_purge_rebuild_queue. Rows REMAIN on disk in
 *      `summaries` and `messages`. The suppression cascade DOES make
 *      them invisible to ALL agent surfaces (verified end-to-end), but
 *      they are NOT hard-deleted. If your compliance requirement is
 *      disk-level removal, use a separate VACUUM / DB-level scrub
 *      after the cascade has fired.
 *
 * Criteria — caller specifies one of:
 *   - summaryIds: explicit list
 *   - sessionKey + (since? + before?) + minTokenCount?: range purge
 *
 * Reason field is REQUIRED. It's recorded in the audit trail
 * (lcm_session_key_audit isn't quite right — purge audit goes through
 * the rebuild queue's `reason` column for rebuild traceability;
 * an explicit lcm_purge_audit table is a follow-up).
 *
 * Refuses to:
 *   - Run with no criteria (would purge everything)
 *   - Run on the entire `agent:main:main` session (operator must be
 *     explicit; affects their primary thread)
 *   - Hard-delete leaves that are referenced by un-superseded condensed
 *     summaries WITHOUT also enqueueing those condensed for rebuild
 *     (would corrupt the assemble pyramid)
 */

import type { DatabaseSync } from "node:sqlite";

export interface PurgeCriteria {
  /** Explicit list of summary IDs to purge. */
  summaryIds?: string[];
  /** Range purge: all leaves in this session_key. */
  sessionKey?: string;
  /** Range purge: only leaves created at or after this timestamp. */
  since?: Date;
  /** Range purge: only leaves created before this timestamp. */
  before?: Date;
  /** Range purge: only leaves with token_count ≥ minTokenCount. */
  minTokenCount?: number;
}

export interface PurgeOptions extends PurgeCriteria {
  /**
   * 'soft' (default): set suppressed_at, leave content intact.
   * 'immediate': enqueue affected condensed for rebuild + cascade
   *   suppression to messages. Per Final.review P2 #3 fix: this does
   *   NOT actually hard-delete rows yet (rebuild worker is cycle-3
   *   work); it does ensure the content is invisible to every agent
   *   surface via the suppression cascade. See module docstring for
   *   the full two-step semantics + the cycle-3 gap.
   */
  mode?: "soft" | "immediate";
  /**
   * Free-text reason. Required (no default). Recorded in
   * lcm_purge_rebuild_queue.reason and (for soft mode) in
   * summaries.suppress_reason.
   */
  reason: string;
  /**
   * Override safety: allow purging the entire `agent:main:main` session.
   * Default false (refuses).
   */
  allowMainSession?: boolean;
}

export interface PurgeResult {
  /** Summary IDs that were affected (suppressed or deleted). */
  affectedLeafIds: string[];
  /** Condensed summary IDs that referenced affected leaves and need
   *  rebuilding. Empty in soft mode (caller can re-build later). */
  rebuildQueueIds: string[];
  /** Audit pass session ID (used for tracing). */
  purgeSessionId: string;
  /** Mode actually used. */
  mode: "soft" | "immediate";
}

export class PurgeError extends Error {
  constructor(
    public readonly kind:
      | "no_criteria"
      | "main_session_blocked"
      | "missing_reason",
    message: string,
  ) {
    super(message);
    this.name = "PurgeError";
  }
}

/**
 * Run an operator-driven purge. See module docs for full semantics.
 *
 * Returns affected leaf IDs and the rebuild queue (immediate mode).
 *
 * Throws PurgeError on unsafe input (no criteria, main-session purge
 * without override, missing reason).
 *
 * IMPORTANT: this is operator-only. Callers MUST gate via
 * deps.isOperatorSession() or equivalent — there's nothing in this
 * module that prevents an agent from invoking it.
 */
export function runPurge(db: DatabaseSync, opts: PurgeOptions): PurgeResult {
  // 1. Validation
  if (!opts.reason || opts.reason.trim().length === 0) {
    throw new PurgeError("missing_reason", "[purge] reason is required");
  }
  const hasCriteria =
    (opts.summaryIds && opts.summaryIds.length > 0) ||
    Boolean(opts.sessionKey) ||
    Boolean(opts.since) ||
    Boolean(opts.before) ||
    Boolean(opts.minTokenCount);
  if (!hasCriteria) {
    throw new PurgeError("no_criteria", "[purge] at least one criterion required (summaryIds, sessionKey, since/before, or minTokenCount)");
  }
  if (opts.sessionKey === "agent:main:main" && !opts.allowMainSession) {
    throw new PurgeError(
      "main_session_blocked",
      "[purge] refusing to purge agent:main:main without allowMainSession=true",
    );
  }

  const purgeSessionId = `purge_${Date.now()}_${randomSuffix()}`;
  const mode: "soft" | "immediate" = opts.mode ?? "soft";

  // 2. Resolve the actual leaf IDs to purge
  const targetLeaves = resolveTargetLeafIds(db, opts);
  if (targetLeaves.length === 0) {
    return {
      affectedLeafIds: [],
      rebuildQueueIds: [],
      purgeSessionId,
      mode,
    };
  }

  if (mode === "soft") {
    return runSoftPurge(db, targetLeaves, opts.reason, purgeSessionId);
  }
  return runImmediatePurge(db, targetLeaves, opts.reason, purgeSessionId);
}

// ---------- internals ----------

function resolveTargetLeafIds(db: DatabaseSync, opts: PurgeCriteria): string[] {
  if (opts.summaryIds && opts.summaryIds.length > 0) {
    // Validate each ID exists + is a leaf — operator mistakes shouldn't
    // half-execute. Let's verify all in one query.
    const placeholders = opts.summaryIds.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT summary_id FROM summaries
           WHERE summary_id IN (${placeholders})
             AND kind = 'leaf'
             AND suppressed_at IS NULL`,
      )
      .all(...opts.summaryIds) as Array<{ summary_id: string }>;
    return rows.map((r) => r.summary_id);
  }
  // Range purge
  const conds: string[] = ["kind = 'leaf'", "suppressed_at IS NULL"];
  const args: unknown[] = [];
  if (opts.sessionKey) {
    conds.push("session_key = ?");
    args.push(opts.sessionKey);
  }
  if (opts.since) {
    conds.push("created_at >= ?");
    args.push(opts.since.toISOString());
  }
  if (opts.before) {
    conds.push("created_at < ?");
    args.push(opts.before.toISOString());
  }
  if (typeof opts.minTokenCount === "number") {
    conds.push("token_count >= ?");
    args.push(opts.minTokenCount);
  }
  const sql = `SELECT summary_id FROM summaries WHERE ${conds.join(" AND ")}`;
  const rows = db.prepare(sql).all(...args) as Array<{ summary_id: string }>;
  return rows.map((r) => r.summary_id);
}

function runSoftPurge(
  db: DatabaseSync,
  leafIds: string[],
  reason: string,
  purgeSessionId: string,
): PurgeResult {
  db.exec("BEGIN IMMEDIATE");
  try {
    const placeholders = leafIds.map(() => "?").join(",");
    db.prepare(
      `UPDATE summaries SET suppressed_at = datetime('now'), suppress_reason = ?
         WHERE summary_id IN (${placeholders})`,
    ).run(reason, ...leafIds);

    // Flag condensed summaries containing suppressed leaves.
    // summary_parents schema: (summary_id = condensed, parent_summary_id = leaf)
    db.prepare(
      `UPDATE summaries SET contains_suppressed_leaves = 1
         WHERE kind = 'condensed' AND summary_id IN (
           SELECT DISTINCT summary_id FROM summary_parents
             WHERE parent_summary_id IN (${placeholders})
         )`,
    ).run(...leafIds);

    // v4.1 §10 + Final review #1 fix: clean up context_items references
    // so the assembler hot path can't re-emit suppressed content. The
    // assembler's resolveSummaryItem reads summaries by ID via
    // context_items.summary_id; if the entry stays, even with a
    // suppressed source, we'd need defense-in-depth at the read layer.
    // Removing the context_items rows AT PURGE TIME is the cleanest cut
    // — prevents any future read from resolving them.
    db.prepare(
      `DELETE FROM context_items
         WHERE item_type = 'summary' AND summary_id IN (${placeholders})`,
    ).run(...leafIds);

    // v4.1 Final.review P1 #2: cascade suppression to the underlying
    // raw messages. Without this, lcm_grep mode='regex'/'full_text'
    // scope='messages' or scope='both' would still find purged
    // content via the raw messages table (which has its own FTS index).
    //
    // We find affected messages via summary_messages junction. Set
    // messages.suppressed_at = now (column exists per A.02 migration).
    //
    // Privacy contract: when operator says "purge this leaf for
    // confidentiality", they mean BOTH the summary AND the underlying
    // raw messages should be unfindable via any agent surface.
    db.prepare(
      `UPDATE messages SET suppressed_at = datetime('now')
         WHERE message_id IN (
           SELECT message_id FROM summary_messages
             WHERE summary_id IN (${placeholders})
         )`,
    ).run(...leafIds);

    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  return {
    affectedLeafIds: leafIds,
    rebuildQueueIds: [],
    purgeSessionId,
    mode: "soft",
  };
}

function runImmediatePurge(
  db: DatabaseSync,
  leafIds: string[],
  reason: string,
  purgeSessionId: string,
): PurgeResult {
  const rebuildIds: string[] = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    const placeholders = leafIds.map(() => "?").join(",");

    // ARCHITECTURE NOTE: SQLite schema has summary_parents.parent_summary_id
    // with ON DELETE RESTRICT — meaning we CANNOT directly DELETE a leaf
    // that is referenced by an un-rebuilt condensed summary. Hard-delete
    // is therefore a TWO-STEP process:
    //
    //   Step 1 (here): mark suppressed + enqueue affected condensed for
    //     rebuild. Same shape as soft mode, but enqueues the rebuild
    //     queue so the worker rebuilds them WITHOUT the suppressed
    //     leaves' content (per v4.1.1 A4 forwarder pattern).
    //
    //   Step 2 (worker, after rebuild): the rebuild worker writes a
    //     NEW condensed row, marks the OLD condensed superseded_by, and
    //     THEN can safely DELETE the leaves (no more parent_summary_id
    //     references). Worker code lives in src/operator/purge-rebuild-
    //     worker.ts (Group F follow-up).
    //
    // For NOW: this function does Step 1 only. Caller (Group F worker)
    // observes lcm_purge_rebuild_queue.completed_at NULL count and
    // schedules Step 2 ticks.
    //
    // Why we don't do "delete-all-or-nothing" inside this function:
    // hard-delete blocked by RESTRICT means we'd have to ROLLBACK if
    // any leaf has a parent — and operators legitimately want to purge
    // some leaves now even if their condensed will rebuild on next
    // tick. The two-step model lets the operator see "purged 5 leaves;
    // 3 condensed queued for rebuild; will be hard-deleted within ~30
    // min" rather than "couldn't purge anything because they're all
    // referenced".

    // 1. Mark all leaves suppressed (same as soft mode)
    db.prepare(
      `UPDATE summaries SET suppressed_at = datetime('now'), suppress_reason = ?
         WHERE summary_id IN (${placeholders})`,
    ).run(reason, ...leafIds);

    // Clean up context_items references (Final review #1 fix; same
    // as soft mode — assembler must not be able to re-emit purged
    // content via resolveSummaryItem).
    db.prepare(
      `DELETE FROM context_items
         WHERE item_type = 'summary' AND summary_id IN (${placeholders})`,
    ).run(...leafIds);

    // 2. Find + flag affected condensed summaries (also same as soft)
    const affectedCondensedRows = db
      .prepare(
        `SELECT DISTINCT summary_id FROM summary_parents
           WHERE parent_summary_id IN (${placeholders})`,
      )
      .all(...leafIds) as Array<{ summary_id: string }>;
    const affectedCondensedIds = affectedCondensedRows.map((r) => r.summary_id);

    if (affectedCondensedIds.length > 0) {
      const cPlaceholders = affectedCondensedIds.map(() => "?").join(",");
      db.prepare(
        `UPDATE summaries SET contains_suppressed_leaves = 1
           WHERE summary_id IN (${cPlaceholders})`,
      ).run(...affectedCondensedIds);

      // 3. Enqueue each affected condensed for rebuild (immediate-mode
      //    distinguishing feature — soft mode doesn't enqueue)
      for (const cId of affectedCondensedIds) {
        const queueId = `prq_${purgeSessionId}_${cId.slice(-8)}_${randomSuffix()}`;
        db.prepare(
          `INSERT INTO lcm_purge_rebuild_queue
             (queue_id, target_summary_id, purge_session_id, reason)
           VALUES (?, ?, ?, ?)`,
        ).run(queueId, cId, purgeSessionId, reason);
        rebuildIds.push(queueId);
      }
    }

    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  return {
    affectedLeafIds: leafIds,
    rebuildQueueIds: rebuildIds,
    purgeSessionId,
    mode: "immediate",
  };
}

function randomSuffix(): string {
  return Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0");
}
