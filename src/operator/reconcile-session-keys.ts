/**
 * Operator session-key reconciliation — LCM v4.1 §2 / Group F.04.
 *
 * The use case: pre-v4.1 conversations may have had NULL session_keys.
 * A.09 backfilled those to `legacy:conv_<id>` so cross-conv lookups
 * work, but each legacy thread remains in its OWN session bucket. An
 * operator (Eva) wants to merge several legacy threads into a single
 * logical session-key — e.g. `legacy:conv_5,legacy:conv_8 →
 * 'my-rebase-thread'` — so future retrieval treats them as one
 * conversation history.
 *
 * What this module does:
 *
 *   1. UPDATE conversations.session_key for every conversation matching
 *      one of the `from` keys to the new `to` key.
 *   2. UPDATE summaries.session_key for the same set, so retrieval
 *      surfaces (which scope by session_key) see the merged history.
 *   3. INSERT one audit row per CONVERSATION moved into
 *      lcm_session_key_audit. (Schema constraint: conversation_id is
 *      NOT NULL, so we cannot use a single bulk audit row per `from`
 *      key — the per-conversation grain is also more useful for the
 *      `/lcm undo-session-key-rekey <conv>` reverse path.)
 *
 * Refusal cases:
 *
 *   - `to === 'agent:main:main'` without `allowMainSession: true`. The
 *     main session_key is special — accidentally merging legacy work
 *     into it pollutes the operator's primary thread. They must opt
 *     in explicitly.
 *
 *   - `from` list is empty. (No-op would silently complete; we throw
 *     so operators notice typos.)
 *
 *   - Empty `reason`. Audit trail is load-bearing — the next operator
 *     reading lcm_session_key_audit needs to know WHY each rekey
 *     happened.
 *
 * Idempotency:
 *
 *   Re-running the same call once the data is already migrated is a
 *   no-op for the UPDATE statements (no rows match the `from` keys
 *   anymore) and writes ZERO new audit rows (because no conversations
 *   moved). The function returns the empty result; this is safe.
 */

import type { DatabaseSync } from "node:sqlite";

export interface ReconcileArgs {
  /** Source session_keys to merge. Must be non-empty. */
  fromSessionKeys: string[];
  /** Destination session_key. */
  toSessionKey: string;
  /** Required free-text reason. Recorded in lcm_session_key_audit.reason. */
  reason: string;
  /** Override safety: allow `to === 'agent:main:main'`. Default false. */
  allowMainSession?: boolean;
  /**
   * Defaults to "operator". Recorded in lcm_session_key_audit.applied_by
   * so we can distinguish operator-driven reconciles from migration
   * backfills (the A.09 step uses applied_by='migration').
   */
  appliedBy?: string;
}

export interface ReconcileResult {
  /** How many conversations rows were moved. */
  conversationsMoved: number;
  /** How many summaries rows were moved. */
  summariesMoved: number;
  /** How many audit rows were inserted (one per conversation moved). */
  auditEntries: number;
}

export class ReconcileError extends Error {
  constructor(
    public readonly kind:
      | "no_from_keys"
      | "missing_reason"
      | "main_session_blocked"
      | "active_conflict",
    message: string,
  ) {
    super(message);
    this.name = "ReconcileError";
  }
}

export interface ReconcileCandidate {
  sessionKey: string;
  conversationCount: number;
  leafCount: number;
}

/**
 * Run the reconcile. Throws ReconcileError on bad input. All writes
 * happen in a single transaction so partial failure is rolled back.
 *
 * Returns the count of conversations + summaries moved + audit rows
 * inserted. Idempotent re-runs return zeros.
 */
export function reconcileSessionKeys(
  db: DatabaseSync,
  args: ReconcileArgs,
): ReconcileResult {
  if (!args.fromSessionKeys || args.fromSessionKeys.length === 0) {
    throw new ReconcileError(
      "no_from_keys",
      "[reconcile] fromSessionKeys must be non-empty",
    );
  }
  if (!args.reason || args.reason.trim().length === 0) {
    throw new ReconcileError(
      "missing_reason",
      "[reconcile] reason is required",
    );
  }
  if (args.toSessionKey === "agent:main:main" && !args.allowMainSession) {
    throw new ReconcileError(
      "main_session_blocked",
      "[reconcile] refusing to write into agent:main:main without allowMainSession=true",
    );
  }

  // Final review Finding #5 fix: pre-check for active-session UNIQUE
  // collision. The `conversations_active_session_key_idx` partial UNIQUE
  // index over (session_key) WHERE active=1 AND session_key IS NOT NULL
  // would fire mid-UPDATE with a raw SQLite error. Operators see a
  // clear typed error instead, with a workaround.
  const fromPlaceholders = args.fromSessionKeys.map(() => "?").join(",");
  const activeFromCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM conversations
           WHERE session_key IN (${fromPlaceholders}) AND active = 1`,
      )
      .get(...args.fromSessionKeys) as { n: number }
  ).n;
  const activeToCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM conversations
           WHERE session_key = ? AND active = 1`,
      )
      .get(args.toSessionKey) as { n: number }
  ).n;
  // After-merge active count = activeFromCount + activeToCount; UNIQUE
  // partial index requires this be ≤ 1.
  if (activeFromCount + activeToCount > 1) {
    throw new ReconcileError(
      "active_conflict",
      `[reconcile] cannot merge ${activeFromCount} active conversation(s) from ` +
        `${args.fromSessionKeys.join(",")} into ${args.toSessionKey} (already has ${activeToCount} active) — ` +
        `the conversations.session_key UNIQUE-active partial index requires at most 1 active per session_key. ` +
        `Workaround: archive all but one conv first via ` +
        `UPDATE conversations SET active=0, archived_at=datetime('now') WHERE conversation_id=?, ` +
        `then re-run reconcile.`,
    );
  }

  const appliedBy = args.appliedBy ?? "operator";

  // Snapshot the affected conversations BEFORE the UPDATE so we can
  // record per-conv audit rows referencing the ORIGINAL session_key.
  // The audit table requires (conversation_id, original_session_key,
  // new_session_key) — we lose original_session_key once the UPDATE
  // runs, so capture it first.
  const placeholders = args.fromSessionKeys.map(() => "?").join(",");
  const affectedConvs = db
    .prepare(
      `SELECT conversation_id, session_key
         FROM conversations
         WHERE session_key IN (${placeholders})`,
    )
    .all(...args.fromSessionKeys) as Array<{
    conversation_id: number;
    session_key: string;
  }>;

  if (affectedConvs.length === 0) {
    // No matching conversations — likely already-migrated or typo. The
    // SUMMARIES update may still have orphan rows to migrate (e.g. if
    // an earlier reconcile partially committed) but in the common case
    // both UPDATEs produce 0 rows; skip the transaction to avoid noise.
    const orphanSummaryCount = countSummariesAtKeys(db, args.fromSessionKeys);
    if (orphanSummaryCount === 0) {
      return { conversationsMoved: 0, summariesMoved: 0, auditEntries: 0 };
    }
    // Fall through to the orphan-summaries cleanup path. Conv-side has
    // nothing to do, but summaries still need their session_key updated.
  }

  let conversationsMoved = 0;
  let summariesMoved = 0;
  let auditEntries = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (affectedConvs.length > 0) {
      const convResult = db
        .prepare(
          `UPDATE conversations SET session_key = ?
             WHERE session_key IN (${placeholders})`,
        )
        .run(args.toSessionKey, ...args.fromSessionKeys);
      conversationsMoved = Number(convResult.changes);
    }

    const sumResult = db
      .prepare(
        `UPDATE summaries SET session_key = ?
           WHERE session_key IN (${placeholders})`,
      )
      .run(args.toSessionKey, ...args.fromSessionKeys);
    summariesMoved = Number(sumResult.changes);

    // Per-conversation audit rows. Note: lcm_session_key_audit has
    // conversation_id NOT NULL (see migration schema), so we cannot
    // collapse this into one row per `from` key — the per-conv grain
    // is also more useful (operator can /lcm undo-session-key-rekey
    // a single conv without rolling back the whole batch).
    const auditStmt = db.prepare(
      `INSERT INTO lcm_session_key_audit
         (audit_id, conversation_id, original_session_key, new_session_key, reason, applied_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const conv of affectedConvs) {
      const auditId = `reconcile_${Date.now()}_${conv.conversation_id}_${randomSuffix()}`;
      auditStmt.run(
        auditId,
        conv.conversation_id,
        conv.session_key,
        args.toSessionKey,
        args.reason,
        appliedBy,
      );
      auditEntries += 1;
    }

    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  return { conversationsMoved, summariesMoved, auditEntries };
}

/**
 * List candidate `legacy:conv_*` session_keys that look like they
 * should be merged. For each candidate returns the session_key plus
 * its conversation + leaf counts, so operators can decide which
 * threads to combine.
 *
 * Sorted by conversation_count DESC so the chunkiest legacy threads
 * surface first.
 */
export function listLegacyCandidates(
  db: DatabaseSync,
): ReconcileCandidate[] {
  const rows = db
    .prepare(
      `SELECT c.session_key AS session_key,
              COUNT(DISTINCT c.conversation_id) AS conv_count,
              (SELECT COUNT(*) FROM summaries s
                WHERE s.session_key = c.session_key AND s.kind = 'leaf') AS leaf_count
         FROM conversations c
         WHERE c.session_key LIKE 'legacy:conv_%'
         GROUP BY c.session_key
         ORDER BY conv_count DESC, c.session_key ASC`,
    )
    .all() as Array<{
    session_key: string;
    conv_count: number;
    leaf_count: number;
  }>;
  return rows.map((r) => ({
    sessionKey: r.session_key,
    conversationCount: r.conv_count,
    leafCount: r.leaf_count,
  }));
}

// ---------- internals ----------

function countSummariesAtKeys(db: DatabaseSync, keys: string[]): number {
  if (keys.length === 0) return 0;
  const placeholders = keys.map(() => "?").join(",");
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM summaries WHERE session_key IN (${placeholders})`,
    )
    .get(...keys) as { n?: number } | undefined;
  return row?.n ?? 0;
}

function randomSuffix(): string {
  return Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0");
}
