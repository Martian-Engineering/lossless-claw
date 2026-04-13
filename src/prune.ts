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
  /** Maximum conversations to delete per write transaction. Default 100. */
  batchSize?: number;
  /** Maximum delete batches to run before returning. Default unlimited. */
  maxBatches?: number;
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
 * Normalize prune batch size to a small positive integer.
 */
function resolveBatchSize(batchSize?: number): number {
  if (batchSize == null) {
    return 100;
  }
  if (!Number.isFinite(batchSize) || batchSize <= 0) {
    throw new Error(`Invalid batch size "${batchSize}". Expected a positive integer.`);
  }
  return Math.floor(batchSize);
}

/**
 * Normalize the optional batch cap for confirm-mode pruning.
 */
function resolveMaxBatches(maxBatches?: number): number | null {
  if (maxBatches == null) {
    return null;
  }
  if (!Number.isFinite(maxBatches) || maxBatches <= 0) {
    throw new Error(`Invalid max batches "${maxBatches}". Expected a positive integer.`);
  }
  return Math.floor(maxBatches);
}

/**
 * Load prune candidates using SQLite date math so mixed timestamp formats are
 * compared chronologically instead of lexically.
 */
function loadPruneCandidates(
  db: DatabaseSync,
  cutoffDate: string,
  limit?: number,
): PruneCandidate[] {
  const sql = limit == null ? SELECT_PRUNE_CANDIDATES_SQL : `${SELECT_PRUNE_CANDIDATES_SQL}\n LIMIT ?`;
  const rows = (
    limit == null
      ? db.prepare(sql).all(cutoffDate)
      : db.prepare(sql).all(cutoffDate, limit)
  ) as PruneCandidateRow[];
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
 * Detect whether an optional SQLite table exists.
 */
function hasTable(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`)
    .get(tableName) as { found: number } | undefined;
  return row?.found === 1;
}

/**
 * Create temp tables containing the conversations, summaries, and messages
 * selected for pruning so dependent deletes can use simple indexed lookups.
 */
function stageCandidateConversationIds(
  db: DatabaseSync,
  candidates: PruneCandidate[],
): void {
  db.exec(`DROP TABLE IF EXISTS temp.prune_candidate_ids`);
  db.exec(`DROP TABLE IF EXISTS temp.prune_candidate_summary_ids`);
  db.exec(`DROP TABLE IF EXISTS temp.prune_candidate_message_ids`);
  db.exec(`CREATE TEMP TABLE prune_candidate_ids (conversation_id INTEGER PRIMARY KEY)`);
  db.exec(`CREATE TEMP TABLE prune_candidate_summary_ids (summary_id TEXT PRIMARY KEY)`);
  db.exec(`CREATE TEMP TABLE prune_candidate_message_ids (message_id INTEGER PRIMARY KEY)`);
  const insertStmt = db.prepare(
    `INSERT INTO temp.prune_candidate_ids (conversation_id) VALUES (?)`,
  );
  for (const candidate of candidates) {
    insertStmt.run(candidate.conversationId);
  }
  db.exec(`
    INSERT INTO temp.prune_candidate_summary_ids (summary_id)
    SELECT s.summary_id
    FROM summaries s
    JOIN temp.prune_candidate_ids p ON p.conversation_id = s.conversation_id
  `);
  db.exec(`
    INSERT INTO temp.prune_candidate_message_ids (message_id)
    SELECT m.message_id
    FROM messages m
    JOIN temp.prune_candidate_ids p ON p.conversation_id = m.conversation_id
  `);
}

/**
 * Remove the temp candidate table.
 */
function dropCandidateConversationIds(db: DatabaseSync): void {
  db.exec(`DROP TABLE IF EXISTS temp.prune_candidate_message_ids`);
  db.exec(`DROP TABLE IF EXISTS temp.prune_candidate_summary_ids`);
  db.exec(`DROP TABLE IF EXISTS temp.prune_candidate_ids`);
}

/**
 * Delete candidate conversations and return the number of rows removed.
 */
function deleteCandidates(db: DatabaseSync, candidates: PruneCandidate[]): number {
  if (candidates.length === 0) {
    return 0;
  }

  const tableOptions = {
    hasMessagesFts: hasTable(db, "messages_fts"),
    hasSummariesFts: hasTable(db, "summaries_fts"),
    hasSummariesFtsCjk: hasTable(db, "summaries_fts_cjk"),
  };

  stageCandidateConversationIds(db, candidates);
  try {
    db.prepare(
      `DELETE FROM summary_messages
       WHERE summary_id IN (SELECT summary_id FROM temp.prune_candidate_summary_ids)`,
    ).run();

    db.prepare(
      `DELETE FROM summary_messages
       WHERE message_id IN (SELECT message_id FROM temp.prune_candidate_message_ids)`,
    ).run();

    db.prepare(
      `DELETE FROM summary_parents
       WHERE summary_id IN (SELECT summary_id FROM temp.prune_candidate_summary_ids)`,
    ).run();

    db.prepare(
      `DELETE FROM summary_parents
       WHERE parent_summary_id IN (SELECT summary_id FROM temp.prune_candidate_summary_ids)`,
    ).run();

    db.prepare(
      `DELETE FROM context_items
       WHERE message_id IN (SELECT message_id FROM temp.prune_candidate_message_ids)`,
    ).run();

    db.prepare(
      `DELETE FROM context_items
       WHERE summary_id IN (SELECT summary_id FROM temp.prune_candidate_summary_ids)`,
    ).run();

    db.prepare(
      `DELETE FROM context_items
       WHERE conversation_id IN (SELECT conversation_id FROM temp.prune_candidate_ids)`,
    ).run();

    if (tableOptions.hasMessagesFts) {
      db.prepare(
        `DELETE FROM messages_fts
         WHERE rowid IN (SELECT message_id FROM temp.prune_candidate_message_ids)`,
      ).run();
    }

    if (tableOptions.hasSummariesFts) {
      db.prepare(
        `DELETE FROM summaries_fts
         WHERE summary_id IN (SELECT summary_id FROM temp.prune_candidate_summary_ids)`,
      ).run();
    }

    if (tableOptions.hasSummariesFtsCjk) {
      db.prepare(
        `DELETE FROM summaries_fts_cjk
         WHERE summary_id IN (SELECT summary_id FROM temp.prune_candidate_summary_ids)`,
      ).run();
    }

    return Number(
      db
        .prepare(
          `DELETE FROM conversations
           WHERE conversation_id IN (SELECT conversation_id FROM temp.prune_candidate_ids)`,
        )
        .run().changes ?? 0,
    );
  } finally {
    dropCandidateConversationIds(db);
  }
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
  const batchSize = resolveBatchSize(options.batchSize);
  const maxBatches = resolveMaxBatches(options.maxBatches);

  let deleted = 0;
  let vacuumed = false;
  let candidates: PruneCandidate[];

  if (!options.confirm) {
    candidates = loadPruneCandidates(db, cutoffDate);
  } else {
    candidates = [];
    let batchesRun = 0;
    while (true) {
      let batchCount = 0;
      db.exec("BEGIN IMMEDIATE");
      try {
        const batch = loadPruneCandidates(db, cutoffDate, batchSize);
        batchCount = batch.length;
        if (batch.length === 0) {
          db.exec("COMMIT");
          break;
        }
        deleted += deleteCandidates(db, batch);
        candidates.push(...batch);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      if (batchCount < batchSize) {
        break;
      }
      batchesRun += 1;
      if (maxBatches != null && batchesRun >= maxBatches) {
        break;
      }
    }
  }

  if (options.vacuum && deleted > 0) {
    db.exec("VACUUM");
    // VACUUM in WAL mode can leave the reclaimed pages in the WAL file until
    // a checkpoint folds them back into the main database.
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    vacuumed = true;
  }

  return {
    candidates,
    deleted,
    vacuumed,
    cutoffDate,
  };
}
