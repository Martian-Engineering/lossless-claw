/**
 * Operator hard-forget — LCM v4.1 §10 / Group F.
 *
 * SOFT-SUPPRESSION ONLY after first-principles cuts (2026-05-06).
 *
 * Sets `summaries.suppressed_at` + `messages.suppressed_at` on matched
 * leaves; trigger cascades to vec0 metadata (B.03); condensed summaries
 * that contained the suppressed leaves are flagged via
 * `contains_suppressed_leaves=1` so the next assemble() pyramid sees
 * the staleness. Also DELETEs `context_items` (summary + message types)
 * and invalidates dependent `lcm_synthesis_cache` rows so no read path
 * can resurface the suppressed content (Final.review.3 Loop 2 fixes).
 *
 * The hard-delete `mode='immediate'` (with rebuild-worker drainer of
 * lcm_purge_rebuild_queue) was REMOVED in first-principles pass —
 * the drainer worker (~20-40h work, HIGH risk to assemble-pyramid
 * invariants) was never built. Implementation + queue schema preserved
 * in deferred-features draft PR (#616).
 *
 * IMPORTANT — soft purge is AGENT-VISIBLE SUPPRESSION ONLY:
 * - The leaf row, message row, and any embedding metadata stay in the
 *   DB. Only `suppressed_at` is set; downstream read paths filter on it.
 * - SQL VACUUM by itself does NOT byte-delete the suppressed content
 *   because the rows still exist (just with suppressed_at set).
 * - Byte-level deletion requires the cycle-3 hard-delete drainer
 *   (preserved in #616). Until that ships, any GDPR/erasure obligation
 *   that requires *physical* removal must be handled out-of-band by
 *   running raw `DELETE FROM messages/summaries WHERE summary_id IN
 *   (...)` followed by `VACUUM` (operator-only manual SQL).
 * - The current design is correct for "agent must not see this content
 *   in any read path" — which is the contract of soft purge — but it
 *   is NOT a substitute for a hard-delete process.
 *
 * Criteria — caller specifies one of:
 *   - summaryIds: explicit list
 *   - sessionKey + (since? + before?) + minTokenCount?: range purge
 *
 * Reason field is REQUIRED. It's recorded in `summaries.suppress_reason`
 * for the affected leaves.
 *
 * Refuses to:
 *   - Run with no criteria (would purge everything)
 *   - Run on the entire `agent:main:main` session (operator must be
 *     explicit; affects their primary thread)
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
   * Soft purge: set suppressed_at, leave content intact. The 'immediate'
   * mode (with hard-delete drainer worker) was REMOVED in first-principles
   * pass (2026-05-06) to honor "no Phase 2" mandate — the drainer worker
   * was never built (~20-40h work, HIGH risk to assemble-pyramid invariants).
   * runPurge always operates in soft mode now (agent-visible suppression
   * only — byte-level deletion is deferred). The hard-delete drainer +
   * lcm_purge_rebuild_queue schema are preserved in deferred-features
   * draft PR (#616). For GDPR-compliant byte erasure until that ships,
   * the operator must run raw SQL DELETE + VACUUM out-of-band; soft
   * purge alone (even followed by VACUUM) does NOT remove the underlying
   * row data because the rows remain — only suppressed_at is set.
   */
  /**
   * Free-text reason. Required (no default). Recorded in
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
  /** Summary IDs that were affected (suppressed). */
  affectedLeafIds: string[];
  /** Audit pass session ID (used for tracing). */
  purgeSessionId: string;
  /** Mode used — always "soft" after first-principles cuts. */
  mode: "soft";
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

  // Wave-8 Auditor #13-18 E-P1 fix: resolve targetLeaves INSIDE the
  // BEGIN IMMEDIATE transaction so a concurrent /lcm purge or
  // suppression update can't change the leaf set between resolve and
  // UPDATE. Previously resolve ran outside the tx → audit-trail loss
  // when an already-suppressed leaf got re-stamped with a new reason.
  // We pass the criteria into runSoftPurge and have it do resolve +
  // updates atomically.
  return runSoftPurgeAtomic(db, opts, opts.reason, purgeSessionId);
}

function runSoftPurgeAtomic(
  db: DatabaseSync,
  opts: PurgeCriteria,
  reason: string,
  purgeSessionId: string,
): PurgeResult {
  db.exec("BEGIN IMMEDIATE");
  try {
    const targetLeaves = resolveTargetLeafIds(db, opts);
    if (targetLeaves.length === 0) {
      db.exec("COMMIT");
      return {
        affectedLeafIds: [],
        purgeSessionId,
        mode: "soft",
      };
    }
    // Inline the runSoftPurge body here so the resolve + cascade UPDATEs
    // share a single transaction. (Don't call runSoftPurge directly —
    // it opens its own BEGIN IMMEDIATE which would conflict.)
    return runSoftPurgeBody(db, targetLeaves, reason, purgeSessionId, /*alreadyInTx*/ true);
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch {}
    throw e;
  }
}

// ---------- internals ----------

/**
 * Wave-2 Auditor #6 fix BUG-2 + BUG-3: dry-run preview helper that uses
 * the EXACT same predicate as resolveTargetLeafIds so the dry-run count
 * matches the apply count. Previously the operator tool implemented its
 * own `WHERE` clauses — they used `datetime(created_at) >= datetime(?)`
 * while runPurge uses raw `created_at >= ?`. Edge cases (timezone
 * offsets, microseconds) gave divergent counts.
 *
 * Returns the count of leaves that runPurge() would actually affect.
 * For --summary-ids: counts only IDs that EXIST AND are kind='leaf' AND
 * are not yet suppressed (matches the implicit filter in runPurge).
 *
 * Does NOT modify the DB.
 */
export function previewPurgeAffected(db: DatabaseSync, opts: PurgeCriteria): number {
  return resolveTargetLeafIds(db, opts).length;
}

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
  // Wave-9 TS-tightening: typed for DatabaseSync.all(...args) which
  // requires SQLInputValue. All pushed values below are strings
  // (sessionKey, ISO timestamps) or numbers (token count).
  const args: (string | number)[] = [];
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

function runSoftPurgeBody(
  db: DatabaseSync,
  leafIds: string[],
  reason: string,
  purgeSessionId: string,
  alreadyInTx = false,
): PurgeResult {
  // Wave-8 P1 fix: caller may already hold BEGIN IMMEDIATE from
  // runSoftPurgeAtomic — don't open a second one (SQLite would error
  // "cannot start a transaction within a transaction").
  if (!alreadyInTx) {
    db.exec("BEGIN IMMEDIATE");
  }
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

    // v4.1 Final.review.3 fix (Loop 2 Leak 2.1 BLOCKER companion):
    // Also DELETE context_items WHERE item_type='message' for any messages
    // about to be cascade-suppressed below. Without this, the assembler
    // hot path (assembler.resolveMessageItem → conversationStore.getMessageById)
    // still loaded the suppressed message content into the prompt because
    // the context_items pointer survived. The getMessageById fix (now
    // filters suppressed_at IS NULL by default) handles the message-level
    // read filter, but cleaning context_items here is the cleanest cut —
    // prevents the assembler from even attempting the resolve.
    db.prepare(
      `DELETE FROM context_items
         WHERE item_type = 'message' AND message_id IN (
           SELECT message_id FROM summary_messages
             WHERE summary_id IN (${placeholders})
         )`,
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
    // raw messages should be unfindable via any agent surface — UNLESS
    // the message is shared with a non-purged leaf, in which case
    // suppressing it would orphan that other leaf's content.
    //
    // Wave-7 Auditor #14 P0-2 fix: only suppress messages whose
    // EVERY referencing leaf is being suppressed. Without this gate,
    // purging one of two leaves that share a message would silently
    // suppress the message for both — breaking the non-purged leaf's
    // assemble path. The NOT EXISTS predicate checks for any
    // non-suppressed referencing summary OUTSIDE the current purge set.
    db.prepare(
      `UPDATE messages SET suppressed_at = datetime('now')
         WHERE message_id IN (
           SELECT sm.message_id FROM summary_messages sm
             WHERE sm.summary_id IN (${placeholders})
         )
         AND NOT EXISTS (
           SELECT 1 FROM summary_messages sm2
             JOIN summaries s2 ON s2.summary_id = sm2.summary_id
             WHERE sm2.message_id = messages.message_id
               AND s2.suppressed_at IS NULL
               AND sm2.summary_id NOT IN (${placeholders})
         )`,
    ).run(...leafIds, ...leafIds);

    // v4.1 Final.review.3 fix (Loop 2 Leak 2.5):
    // Invalidate any rebuildable synthesis caches that referenced the
    // suppressed leaves. lcm_cache_leaf_refs has ON DELETE CASCADE on
    // both lcm_synthesis_cache.cache_id and summaries.summary_id, but
    // the cascade only fires on hard DELETE, not on soft suppression.
    // We MUST DELETE the cache rows explicitly so any future cache read
    // (or future re-synthesis) doesn't surface PII baked in before
    // suppression. Cache is REBUILDABLE by design — losing rows is safe.
    db.prepare(
      `DELETE FROM lcm_synthesis_cache
         WHERE cache_id IN (
           SELECT DISTINCT cache_id FROM lcm_cache_leaf_refs
             WHERE leaf_summary_id IN (${placeholders})
         )`,
    ).run(...leafIds);

    db.exec("COMMIT");
  } catch (e) {
    // Wave-8 P1: only ROLLBACK if WE opened the tx; otherwise let outer
    // try/catch handle it (the runSoftPurgeAtomic caller).
    if (!alreadyInTx) {
      try { db.exec("ROLLBACK"); } catch {}
    }
    throw e;
  }

  return {
    affectedLeafIds: leafIds,
    purgeSessionId,
    mode: "soft",
  };
}

// Backward-compat shim: runSoftPurge (used by tests/internal callers)
// still works as before — opens its own tx.
function runSoftPurge(
  db: DatabaseSync,
  leafIds: string[],
  reason: string,
  purgeSessionId: string,
): PurgeResult {
  return runSoftPurgeBody(db, leafIds, reason, purgeSessionId, /*alreadyInTx*/ false);
}

// runImmediatePurge REMOVED in first-principles pass (2026-05-06).
// Implementation + lcm_purge_rebuild_queue schema preserved in
// deferred-features draft PR (#616).

function randomSuffix(): string {
  return Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0");
}
