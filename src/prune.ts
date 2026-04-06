/**
 * Conversation pruning for data retention.
 *
 * Identifies and deletes conversations where ALL messages are older than a
 * given threshold.  Relies on ON DELETE CASCADE foreign keys in the schema
 * to clean up messages, summaries, context_items, and other dependent rows.
 */
import type { DatabaseSync } from "node:sqlite";

// ── Duration parsing ────────────────────────────────────────────────────────

const DURATION_RE = /^(\d+)\s*(d|day|days|w|week|weeks|m|month|months|y|year|years)$/i;

const UNIT_TO_DAYS: Record<string, number> = {
  d: 1,
  day: 1,
  days: 1,
  w: 7,
  week: 7,
  weeks: 7,
  m: 30,
  month: 30,
  months: 30,
  y: 365,
  year: 365,
  years: 365,
};

/**
 * Parse a human-friendly duration string (e.g. "90d", "3m", "1y") into
 * a number of days.  Returns `null` when the input is not recognized.
 */
export function parseDuration(input: string): number | null {
  const trimmed = input.trim().toLowerCase();
  const match = DURATION_RE.exec(trimmed);
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const multiplier = UNIT_TO_DAYS[unit];
  if (multiplier == null || !Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  return amount * multiplier;
}

// ── Prune types ─────────────────────────────────────────────────────────────

export type PruneCandidate = {
  conversationId: number;
  sessionKey: string | null;
  messageCount: number;
  summaryCount: number;
  latestMessageAt: string;
  createdAt: string;
};

export type PruneResult = {
  /** Conversations that matched the age threshold. */
  candidates: PruneCandidate[];
  /** Number of conversations actually deleted (0 in dry-run mode). */
  deleted: number;
  /** Whether VACUUM was executed after deletion. */
  vacuumed: boolean;
  /** The cutoff date used (ISO-8601 UTC string). */
  cutoffDate: string;
};

export type PruneOptions = {
  /** Duration string, e.g. "90d", "30d", "1y". */
  before: string;
  /** When true, actually delete. Default is dry-run (false). */
  confirm?: boolean;
  /** When true, run VACUUM after deletion. Default false. */
  vacuum?: boolean;
  /** Override "now" for testing. ISO-8601 UTC string. */
  now?: string;
};

// ── Core prune logic ────────────────────────────────────────────────────────

type PruneCandidateRow = {
  conversation_id: number;
  session_key: string | null;
  message_count: number;
  summary_count: number;
  latest_message_at: string;
  created_at: string;
};

const SELECT_PRUNE_CANDIDATES_SQL = `SELECT
   c.conversation_id,
   c.session_key,
   COALESCE(msg_stats.message_count, 0) AS message_count,
   COALESCE(sum_stats.summary_count, 0) AS summary_count,
   COALESCE(msg_stats.latest_message_at, c.created_at) AS latest_message_at,
   c.created_at
 FROM conversations c
 LEFT JOIN (
   SELECT conversation_id,
          COUNT(*) AS message_count,
          MAX(created_at) AS latest_message_at
   FROM messages
   GROUP BY conversation_id
 ) msg_stats ON msg_stats.conversation_id = c.conversation_id
 LEFT JOIN (
   SELECT conversation_id,
          COUNT(*) AS summary_count
   FROM summaries
   GROUP BY conversation_id
 ) sum_stats ON sum_stats.conversation_id = c.conversation_id
 WHERE julianday(COALESCE(msg_stats.latest_message_at, c.created_at)) < julianday(?)
 ORDER BY julianday(COALESCE(msg_stats.latest_message_at, c.created_at)) ASC,
          c.conversation_id ASC`;

/**
 * Compute the UTC cutoff date by subtracting `days` from `now`.
 */
function computeCutoffDate(days: number, now?: string): string {
  const base = now ? new Date(now) : new Date();
  base.setUTCDate(base.getUTCDate() - days);
  return base.toISOString();
}

/**
 * Load prune candidates using SQLite date math so mixed timestamp formats are
 * compared chronologically instead of lexically.
 */
function loadPruneCandidates(db: DatabaseSync, cutoffDate: string): PruneCandidate[] {
  const rows = db.prepare(SELECT_PRUNE_CANDIDATES_SQL).all(cutoffDate) as PruneCandidateRow[];
  return rows.map((row) => ({
    conversationId: row.conversation_id,
    sessionKey: row.session_key,
    messageCount: row.message_count,
    summaryCount: row.summary_count,
    latestMessageAt: row.latest_message_at,
    createdAt: row.created_at,
  }));
}

/**
 * Delete candidate conversations and return the number of rows removed.
 */
function deleteCandidates(db: DatabaseSync, candidates: PruneCandidate[]): number {
  const deleteStmt = db.prepare(`DELETE FROM conversations WHERE conversation_id = ?`);
  let deleted = 0;
  for (const candidate of candidates) {
    deleted += Number(deleteStmt.run(candidate.conversationId).changes ?? 0);
  }
  return deleted;
}

/**
 * Prune old conversations from the LCM database.
 *
 * In dry-run mode (default), returns the list of conversations that would be
 * deleted without modifying the database.  With `confirm: true`, deletes them
 * and relies on ON DELETE CASCADE for cleanup of child rows.
 */
export function pruneConversations(
  db: DatabaseSync,
  options: PruneOptions,
): PruneResult {
  const days = parseDuration(options.before);
  if (days == null) {
    throw new Error(
      `Invalid duration "${options.before}". Expected a value like "90d", "30d", "3m", or "1y".`,
    );
  }

  const cutoffDate = computeCutoffDate(days, options.now);

  let deleted = 0;
  let vacuumed = false;
  let candidates: PruneCandidate[];

  if (!options.confirm) {
    candidates = loadPruneCandidates(db, cutoffDate);
  } else {
    db.exec("BEGIN IMMEDIATE");
    try {
      candidates = loadPruneCandidates(db, cutoffDate);
      deleted = deleteCandidates(db, candidates);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  if (options.vacuum && deleted > 0) {
    db.exec("VACUUM");
    vacuumed = true;
  }

  return {
    candidates,
    deleted,
    vacuumed,
    cutoffDate,
  };
}
