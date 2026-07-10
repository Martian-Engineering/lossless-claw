import type { DatabaseSync } from "node:sqlite";
import {
  decodeCursor,
  encodeCursor,
  type ConversationSelector,
  type SummaryKind,
} from "./args.js";
import { CliError, type PaginationMetadata } from "./output.js";

export type SummaryDepthStats = {
  kind: SummaryKind;
  depth: number;
  count: number;
  tokens: number;
};

export type GlobalStatus = {
  conversations: { total: number; active: number };
  messages: { count: number; tokens: number; earliestAt: string | null; latestAt: string | null };
  summaries: {
    count: number;
    tokens: number;
    sourceMessageTokens: number;
    earliestAt: string | null;
    latestAt: string | null;
    byDepth: SummaryDepthStats[];
  };
  context: { items: number; tokens: number };
  maintenance: { pending: number; running: number; failed: number };
};

export type ConversationIdentity = {
  conversationId: number;
  sessionId: string;
  sessionKey: string | null;
  active: boolean;
  archivedAt: string | null;
  title: string | null;
  bootstrappedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ConversationListItem = ConversationIdentity & {
  messageCount: number;
  messageTokens: number;
  earliestMessageAt: string | null;
  latestMessageAt: string | null;
  summaryCount: number;
  summaryTokens: number;
  summarizedSourceTokens: number;
  earliestSummaryAt: string | null;
  latestSummaryAt: string | null;
  maxSummaryDepth: number | null;
  contextItems: number;
  contextTokens: number;
  freshTailMessages: number;
  freshTailTokens: number;
};

export type ConversationPage = {
  items: ConversationListItem[];
  pagination: PaginationMetadata;
};

type ConversationQueryInput = {
  limit: number;
  freshTailCount: number;
  cursor?: string;
  conversationId?: number;
};

type GlobalStatusRow = {
  conversationCount: number;
  activeConversationCount: number;
  messageCount: number;
  messageTokens: number;
  earliestMessageAt: string | null;
  latestMessageAt: string | null;
  summaryCount: number;
  summaryTokens: number;
  summarizedSourceTokens: number;
  earliestSummaryAt: string | null;
  latestSummaryAt: string | null;
  contextItems: number;
  contextTokens: number;
  maintenancePending: number;
  maintenanceRunning: number;
  maintenanceFailed: number;
};

type ConversationIdentityRow = Omit<ConversationIdentity, "active"> & { active: number };
type ConversationListRow = Omit<ConversationListItem, "active"> & { active: number };

type TelemetryRow = {
  lastObservedCacheRead: number | null;
  lastObservedCacheWrite: number | null;
  lastObservedPromptTokenCount: number | null;
  lastObservedCacheHitAt: string | null;
  lastObservedCacheBreakAt: string | null;
  cacheState: string;
  consecutiveColdObservations: number;
  retention: string | null;
  lastLeafCompactionAt: string | null;
  turnsSinceLeafCompaction: number;
  tokensAccumulatedSinceLeafCompaction: number;
  lastActivityBand: string;
  lastApiCallAt: string | null;
  lastCacheTouchAt: string | null;
  provider: string | null;
  model: string | null;
  updatedAt: string;
};

type MaintenanceRow = {
  pending: number;
  requestedAt: string | null;
  reason: string | null;
  running: number;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastFailureSummary: string | null;
  tokenBudget: number | null;
  currentTokenCount: number | null;
  projectedTokenCount: number | null;
  rawTokensOutsideTail: number | null;
  contextThreshold: number | null;
  contextThresholdSource: string | null;
  retryAttempts: number;
  nextAttemptAfter: string | null;
  updatedAt: string;
};

type BootstrapRow = {
  sessionFilePath: string;
  lastSeenSize: number;
  lastSeenMtimeMs: number;
  lastProcessedOffset: number;
  lastProcessedEntryHash: string | null;
  sessionHeaderId: string | null;
  lastProcessedEntryId: string | null;
  forkBounded: number;
  forkSourceMessageCount: number;
  updatedAt: string;
};

type ActiveFocusBriefRow = {
  briefId: string;
  prompt: string;
  tokenCount: number;
  targetTokens: number;
  coveredLatestAt: string | null;
  coveredMessageSeq: number | null;
  generatorRunId: string | null;
  generatorSessionKey: string | null;
  createdAt: string;
  updatedAt: string;
};

type ContextStatsRow = { itemType: "message" | "summary"; count: number; tokens: number };
type LargeFileStatsRow = { count: number; bytes: number; latestAt: string | null };

export type ConversationDiagnostics = {
  conversation: ConversationListItem;
  summaryDepths: SummaryDepthStats[];
  context: ContextStatsRow[];
  telemetry: TelemetryRow | null;
  maintenance: (Omit<MaintenanceRow, "pending" | "running"> & { pending: boolean; running: boolean }) | null;
  bootstrap: (Omit<BootstrapRow, "forkBounded"> & { forkBounded: boolean }) | null;
  focusBriefs: { count: number; activeBrief: ActiveFocusBriefRow | null };
  largeFiles: LargeFileStatsRow;
};

// Map SQLite integer booleans to the stable JSON representation.
function mapConversationIdentity(row: ConversationIdentityRow): ConversationIdentity {
  return { ...row, active: row.active === 1 };
}

// Map an aggregate list row while preserving nullable diagnostic fields.
function mapConversationListItem(row: ConversationListRow): ConversationListItem {
  return { ...row, active: row.active === 1 };
}

// Load grouped summary depth statistics in deterministic depth/kind order.
function getSummaryDepthStats(db: DatabaseSync, conversationId?: number): SummaryDepthStats[] {
  const rows = db.prepare(
    `SELECT kind, depth, COUNT(*) AS count, COALESCE(SUM(token_count), 0) AS tokens
       FROM summaries
      ${conversationId === undefined ? "" : "WHERE conversation_id = ?"}
      GROUP BY kind, depth
      ORDER BY depth ASC, kind ASC`,
  ).all(...(conversationId === undefined ? [] : [conversationId])) as SummaryDepthStats[];
  return rows;
}

/** Return database-wide counts, token totals, time coverage, and maintenance state. */
export function getGlobalStatus(db: DatabaseSync): GlobalStatus {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM conversations) AS conversationCount,
      (SELECT COUNT(*) FROM conversations WHERE active = 1) AS activeConversationCount,
      (SELECT COUNT(*) FROM messages) AS messageCount,
      (SELECT COALESCE(SUM(token_count), 0) FROM messages) AS messageTokens,
      (SELECT MIN(created_at) FROM messages) AS earliestMessageAt,
      (SELECT MAX(created_at) FROM messages) AS latestMessageAt,
      (SELECT COUNT(*) FROM summaries) AS summaryCount,
      (SELECT COALESCE(SUM(token_count), 0) FROM summaries) AS summaryTokens,
      (SELECT COALESCE(SUM(source_message_token_count), 0) FROM summaries) AS summarizedSourceTokens,
      (SELECT MIN(COALESCE(earliest_at, created_at)) FROM summaries) AS earliestSummaryAt,
      (SELECT MAX(COALESCE(latest_at, created_at)) FROM summaries) AS latestSummaryAt,
      (SELECT COUNT(*) FROM context_items) AS contextItems,
      (SELECT COALESCE(SUM(tokens), 0) FROM (
        SELECT m.token_count AS tokens
          FROM context_items ci JOIN messages m ON m.message_id = ci.message_id
         WHERE ci.item_type = 'message'
        UNION ALL
        SELECT s.token_count AS tokens
          FROM context_items ci JOIN summaries s ON s.summary_id = ci.summary_id
         WHERE ci.item_type = 'summary'
      )) AS contextTokens,
      (SELECT COUNT(*) FROM conversation_compaction_maintenance WHERE pending = 1) AS maintenancePending,
      (SELECT COUNT(*) FROM conversation_compaction_maintenance WHERE running = 1) AS maintenanceRunning,
      (SELECT COUNT(*) FROM conversation_compaction_maintenance
        WHERE last_failure_summary IS NOT NULL AND TRIM(last_failure_summary) <> '') AS maintenanceFailed
  `).get() as GlobalStatusRow;

  return {
    conversations: { total: row.conversationCount, active: row.activeConversationCount },
    messages: {
      count: row.messageCount,
      tokens: row.messageTokens,
      earliestAt: row.earliestMessageAt,
      latestAt: row.latestMessageAt,
    },
    summaries: {
      count: row.summaryCount,
      tokens: row.summaryTokens,
      sourceMessageTokens: row.summarizedSourceTokens,
      earliestAt: row.earliestSummaryAt,
      latestAt: row.latestSummaryAt,
      byDepth: getSummaryDepthStats(db),
    },
    context: { items: row.contextItems, tokens: row.contextTokens },
    maintenance: {
      pending: row.maintenancePending,
      running: row.maintenanceRunning,
      failed: row.maintenanceFailed,
    },
  };
}

/** Resolve one persisted conversation from a numeric ID or stable session key. */
export function resolveConversation(
  db: DatabaseSync,
  selector: ConversationSelector,
): ConversationIdentity {
  const select = `SELECT
      conversation_id AS conversationId,
      session_id AS sessionId,
      session_key AS sessionKey,
      active,
      archived_at AS archivedAt,
      title,
      bootstrapped_at AS bootstrappedAt,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM conversations`;
  const row = selector.kind === "conversationId"
    ? db.prepare(`${select} WHERE conversation_id = ?`).get(selector.value) as ConversationIdentityRow | undefined
    : db.prepare(`${select}
        WHERE session_key = ?
        ORDER BY active DESC, julianday(created_at) DESC, conversation_id DESC
        LIMIT 1`).get(selector.value) as ConversationIdentityRow | undefined;

  if (!row) {
    throw new CliError(
      "CONVERSATION_NOT_FOUND",
      selector.kind === "conversationId"
        ? `No conversation matched id ${selector.value}.`
        : `No conversation matched session key ${selector.value}.`,
      3,
      selector,
    );
  }
  return mapConversationIdentity(row);
}

// Query aggregate conversation rows for either one ID or a keyset-paged list.
function queryConversationRows(db: DatabaseSync, input: ConversationQueryInput): ConversationListRow[] {
  const where: string[] = [];
  const args: Array<number | string> = [Math.max(0, Math.floor(input.freshTailCount))];
  if (input.conversationId !== undefined) {
    where.push("c.conversation_id = ?");
    args.push(input.conversationId);
  } else if (input.cursor) {
    const cursor = decodeCursor(input.cursor, "conversations");
    if (typeof cursor.id !== "number" || !Number.isInteger(cursor.id)) {
      throw new CliError("INVALID_CURSOR", "Invalid conversations cursor.", 2);
    }
    where.push(`(
      julianday(c.updated_at) < julianday(?)
      OR (julianday(c.updated_at) = julianday(?) AND c.conversation_id < ?)
    )`);
    args.push(cursor.timestamp, cursor.timestamp, cursor.id);
  }
  args.push(input.limit);

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return db.prepare(`
    WITH
    message_stats AS (
      SELECT conversation_id, COUNT(*) AS messageCount,
             COALESCE(SUM(token_count), 0) AS messageTokens,
             MIN(created_at) AS earliestMessageAt, MAX(created_at) AS latestMessageAt
        FROM messages GROUP BY conversation_id
    ),
    summary_stats AS (
      SELECT conversation_id, COUNT(*) AS summaryCount,
             COALESCE(SUM(token_count), 0) AS summaryTokens,
             COALESCE(SUM(source_message_token_count), 0) AS summarizedSourceTokens,
             MIN(COALESCE(earliest_at, created_at)) AS earliestSummaryAt,
             MAX(COALESCE(latest_at, created_at)) AS latestSummaryAt,
             MAX(depth) AS maxSummaryDepth
        FROM summaries GROUP BY conversation_id
    ),
    context_stats AS (
      SELECT conversation_id, COUNT(*) AS contextItems, COALESCE(SUM(tokens), 0) AS contextTokens
        FROM (
          SELECT ci.conversation_id, m.token_count AS tokens
            FROM context_items ci JOIN messages m ON m.message_id = ci.message_id
           WHERE ci.item_type = 'message'
          UNION ALL
          SELECT ci.conversation_id, s.token_count AS tokens
            FROM context_items ci JOIN summaries s ON s.summary_id = ci.summary_id
           WHERE ci.item_type = 'summary'
        ) GROUP BY conversation_id
    ),
    ranked_messages AS (
      SELECT conversation_id, token_count,
             ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY seq DESC) AS tailRank
        FROM messages
    ),
    fresh_tail_stats AS (
      SELECT conversation_id, COUNT(*) AS freshTailMessages,
             COALESCE(SUM(token_count), 0) AS freshTailTokens
        FROM ranked_messages WHERE tailRank <= ? GROUP BY conversation_id
    )
    SELECT
      c.conversation_id AS conversationId,
      c.session_id AS sessionId,
      c.session_key AS sessionKey,
      c.active,
      c.archived_at AS archivedAt,
      c.title,
      c.bootstrapped_at AS bootstrappedAt,
      c.created_at AS createdAt,
      c.updated_at AS updatedAt,
      COALESCE(ms.messageCount, 0) AS messageCount,
      COALESCE(ms.messageTokens, 0) AS messageTokens,
      ms.earliestMessageAt,
      ms.latestMessageAt,
      COALESCE(ss.summaryCount, 0) AS summaryCount,
      COALESCE(ss.summaryTokens, 0) AS summaryTokens,
      COALESCE(ss.summarizedSourceTokens, 0) AS summarizedSourceTokens,
      ss.earliestSummaryAt,
      ss.latestSummaryAt,
      ss.maxSummaryDepth,
      COALESCE(cs.contextItems, 0) AS contextItems,
      COALESCE(cs.contextTokens, 0) AS contextTokens,
      COALESCE(fts.freshTailMessages, 0) AS freshTailMessages,
      COALESCE(fts.freshTailTokens, 0) AS freshTailTokens
    FROM conversations c
    LEFT JOIN message_stats ms ON ms.conversation_id = c.conversation_id
    LEFT JOIN summary_stats ss ON ss.conversation_id = c.conversation_id
    LEFT JOIN context_stats cs ON cs.conversation_id = c.conversation_id
    LEFT JOIN fresh_tail_stats fts ON fts.conversation_id = c.conversation_id
    ${whereClause}
    ORDER BY julianday(c.updated_at) DESC, c.conversation_id DESC
    LIMIT ?
  `).all(...args) as ConversationListRow[];
}

/** Return one keyset-paginated page of aggregate conversation diagnostics. */
export function listConversations(
  db: DatabaseSync,
  input: { limit: number; freshTailCount: number; cursor?: string },
): ConversationPage {
  const rows = queryConversationRows(db, { ...input, limit: input.limit + 1 });
  const hasMore = rows.length > input.limit;
  const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
  const items = pageRows.map(mapConversationListItem);
  const last = items.at(-1);
  return {
    items,
    pagination: {
      limit: input.limit,
      returned: items.length,
      hasMore,
      nextCursor: hasMore && last
        ? encodeCursor("conversations", last.updatedAt, last.conversationId)
        : null,
    },
  };
}

// Load one conversation's context item counts and token totals in prompt order.
function getContextStats(db: DatabaseSync, conversationId: number): ContextStatsRow[] {
  return db.prepare(`
    SELECT ci.item_type AS itemType, COUNT(*) AS count,
           COALESCE(SUM(COALESCE(m.token_count, s.token_count, 0)), 0) AS tokens
      FROM context_items ci
      LEFT JOIN messages m ON m.message_id = ci.message_id
      LEFT JOIN summaries s ON s.summary_id = ci.summary_id
     WHERE ci.conversation_id = ?
     GROUP BY ci.item_type
     ORDER BY MIN(ci.ordinal)
  `).all(conversationId) as ContextStatsRow[];
}

// Load the optional persisted compaction telemetry row.
function getTelemetry(db: DatabaseSync, conversationId: number): TelemetryRow | null {
  const row = db.prepare(`SELECT
      last_observed_cache_read AS lastObservedCacheRead,
      last_observed_cache_write AS lastObservedCacheWrite,
      last_observed_prompt_token_count AS lastObservedPromptTokenCount,
      last_observed_cache_hit_at AS lastObservedCacheHitAt,
      last_observed_cache_break_at AS lastObservedCacheBreakAt,
      cache_state AS cacheState,
      consecutive_cold_observations AS consecutiveColdObservations,
      retention,
      last_leaf_compaction_at AS lastLeafCompactionAt,
      turns_since_leaf_compaction AS turnsSinceLeafCompaction,
      tokens_accumulated_since_leaf_compaction AS tokensAccumulatedSinceLeafCompaction,
      last_activity_band AS lastActivityBand,
      last_api_call_at AS lastApiCallAt,
      last_cache_touch_at AS lastCacheTouchAt,
      provider, model, updated_at AS updatedAt
    FROM conversation_compaction_telemetry WHERE conversation_id = ?`
  ).get(conversationId) as TelemetryRow | undefined;
  return row ?? null;
}

// Load the optional deferred compaction maintenance row.
function getMaintenance(
  db: DatabaseSync,
  conversationId: number,
): ConversationDiagnostics["maintenance"] {
  const row = db.prepare(`SELECT
      pending, requested_at AS requestedAt, reason, running,
      last_started_at AS lastStartedAt, last_finished_at AS lastFinishedAt,
      last_failure_summary AS lastFailureSummary, token_budget AS tokenBudget,
      current_token_count AS currentTokenCount, projected_token_count AS projectedTokenCount,
      raw_tokens_outside_tail AS rawTokensOutsideTail, context_threshold AS contextThreshold,
      context_threshold_source AS contextThresholdSource, retry_attempts AS retryAttempts,
      next_attempt_after AS nextAttemptAfter, updated_at AS updatedAt
    FROM conversation_compaction_maintenance WHERE conversation_id = ?`
  ).get(conversationId) as MaintenanceRow | undefined;
  return row ? { ...row, pending: row.pending === 1, running: row.running === 1 } : null;
}

// Load the optional transcript bootstrap frontier without reading the session file.
function getBootstrap(db: DatabaseSync, conversationId: number): ConversationDiagnostics["bootstrap"] {
  const row = db.prepare(`SELECT
      session_file_path AS sessionFilePath, last_seen_size AS lastSeenSize,
      last_seen_mtime_ms AS lastSeenMtimeMs, last_processed_offset AS lastProcessedOffset,
      last_processed_entry_hash AS lastProcessedEntryHash, session_header_id AS sessionHeaderId,
      last_processed_entry_id AS lastProcessedEntryId, fork_bounded AS forkBounded,
      fork_source_message_count AS forkSourceMessageCount, updated_at AS updatedAt
    FROM conversation_bootstrap_state WHERE conversation_id = ?`
  ).get(conversationId) as BootstrapRow | undefined;
  return row ? { ...row, forkBounded: row.forkBounded === 1 } : null;
}

// Count all focus briefs and expose only the newest active brief metadata.
function getFocusBriefStats(
  db: DatabaseSync,
  conversationId: number,
): ConversationDiagnostics["focusBriefs"] {
  const countRow = db.prepare(
    "SELECT COUNT(*) AS count FROM focus_briefs WHERE conversation_id = ?",
  ).get(conversationId) as { count: number };
  const activeBrief = db.prepare(`SELECT
      brief_id AS briefId, prompt, token_count AS tokenCount,
      target_tokens AS targetTokens, covered_latest_at AS coveredLatestAt,
      covered_message_seq AS coveredMessageSeq, generator_run_id AS generatorRunId,
      generator_session_key AS generatorSessionKey, created_at AS createdAt,
      updated_at AS updatedAt
    FROM focus_briefs
    WHERE conversation_id = ? AND status = 'active'
    ORDER BY julianday(created_at) DESC, brief_id DESC LIMIT 1`
  ).get(conversationId) as ActiveFocusBriefRow | undefined;
  return { count: countRow.count, activeBrief: activeBrief ?? null };
}

// Aggregate externalized large-file storage without reading file contents.
function getLargeFileStats(db: DatabaseSync, conversationId: number): LargeFileStatsRow {
  return db.prepare(`SELECT COUNT(*) AS count,
      COALESCE(SUM(byte_size), 0) AS bytes, MAX(created_at) AS latestAt
    FROM large_files WHERE conversation_id = ?`
  ).get(conversationId) as LargeFileStatsRow;
}

/** Return the complete read-only diagnostic projection for one conversation. */
export function getConversationDiagnostics(
  db: DatabaseSync,
  selector: ConversationSelector,
  input: { freshTailCount: number },
): ConversationDiagnostics {
  const identity = resolveConversation(db, selector);
  const row = queryConversationRows(db, {
    limit: 1,
    freshTailCount: input.freshTailCount,
    conversationId: identity.conversationId,
  })[0];
  if (!row) {
    throw new CliError("CONVERSATION_NOT_FOUND", "Conversation disappeared during query.", 3, selector);
  }

  return {
    conversation: mapConversationListItem(row),
    summaryDepths: getSummaryDepthStats(db, identity.conversationId),
    context: getContextStats(db, identity.conversationId),
    telemetry: getTelemetry(db, identity.conversationId),
    maintenance: getMaintenance(db, identity.conversationId),
    bootstrap: getBootstrap(db, identity.conversationId),
    focusBriefs: getFocusBriefStats(db, identity.conversationId),
    largeFiles: getLargeFileStats(db, identity.conversationId),
  };
}
