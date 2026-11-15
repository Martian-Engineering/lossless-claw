import type { DatabaseSync } from "node:sqlite";
import { getFileBackedDatabasePath } from "../db/connection.js";
import { buildLcmDatabaseBackupPath, writeLcmDatabaseBackup } from "./lcm-db-backup.js";

export type DoctorCleanerId =
  | "archived_subagents"
  | "cron_sessions"
  | "null_subagent_context";

export type DoctorCleanerExample = {
  conversationId: number;
  sessionKey: string | null;
  messageCount: number;
  firstMessagePreview: string | null;
};

export type DoctorCleanerFilterStat = {
  id: DoctorCleanerId;
  label: string;
  description: string;
  conversationCount: number;
  messageCount: number;
  examples: DoctorCleanerExample[];
};

export type DoctorCleanerScan = {
  filters: DoctorCleanerFilterStat[];
  totalDistinctConversations: number;
  totalDistinctMessages: number;
};

export type DoctorCleanerApplyResult =
  | {
      kind: "applied";
      filterIds: DoctorCleanerId[];
      deletedConversations: number;
      deletedMessages: number;
      vacuumed: boolean;
      backupPath: string;
    }
  | {
      kind: "unavailable";
      reason: string;
    };

type CleanerDefinition = {
  id: DoctorCleanerId;
  label: string;
  description: string;
  candidatePredicateSql: string;
  predicateSql: string;
  sessionKeyLane?: "cron" | "subagent";
  needsFirstMessage?: boolean;
};

type CleanerCountRow = {
  filter_id?: DoctorCleanerId;
  conversation_count: number | null;
  message_count: number | null;
};

type CleanerExampleRow = {
  filter_id: DoctorCleanerId;
  conversation_id: number;
  session_key: string | null;
  message_count: number | null;
  first_message_preview: string | null;
};

const SCAN_FIRST_MESSAGE_PREVIEW_LIMIT = 256;

const CLEANER_DEFINITIONS: CleanerDefinition[] = [
  {
    id: "archived_subagents",
    label: "Archived subagents",
    description: "Archived subagent conversations for configured OpenClaw agent IDs.",
    candidatePredicateSql: "(c.active = 0)",
    predicateSql: "(c.active = 0)",
    sessionKeyLane: "subagent",
  },
  {
    id: "cron_sessions",
    label: "Cron sessions",
    description: "Background cron conversations for configured OpenClaw agent IDs.",
    candidatePredicateSql: "1",
    predicateSql: "1",
    sessionKeyLane: "cron",
  },
  {
    id: "null_subagent_context",
    label: "NULL-key subagent context",
    description:
      "Archived conversations with NULL session_key whose first stored message begins with [Subagent Context].",
    candidatePredicateSql: "(c.session_key IS NULL AND c.active = 0 AND c.archived_at IS NOT NULL)",
    predicateSql:
      "(c.session_key IS NULL AND c.active = 0 AND c.archived_at IS NOT NULL AND message_stats.first_message_preview LIKE '[Subagent Context]%')",
    needsFirstMessage: true,
  },
];

const DOCTOR_CLEANER_IDS = CLEANER_DEFINITIONS.map(
  (definition) => definition.id,
) as DoctorCleanerId[];

function getCleanerDefinitions(filterIds?: DoctorCleanerId[]): CleanerDefinition[] {
  if (!filterIds || filterIds.length === 0) {
    return CLEANER_DEFINITIONS;
  }
  const requested = new Set(filterIds);
  return CLEANER_DEFINITIONS.filter((definition) => requested.has(definition.id));
}

function normalizeCleanerAgentIds(agentIds?: string[]): string[] {
  const normalized = [...new Set(agentIds?.map((agentId) => agentId.trim()).filter(Boolean))];
  return normalized.length > 0 ? normalized : ["main"];
}

function buildConfiguredSessionKeyPredicateSql(lane: "cron" | "subagent"): string {
  const prefixSql = `('agent:' || configured_agent.agent_id || ':${lane}:')`;
  return `EXISTS (
                SELECT 1
                FROM temp.doctor_cleaner_agent_ids configured_agent
                WHERE length(c.session_key) > length(${prefixSql})
                  AND substr(c.session_key, 1, length(${prefixSql})) = ${prefixSql} COLLATE BINARY
              )`;
}

function buildCleanerPredicateSql(
  definition: CleanerDefinition,
  kind: "candidate" | "matched",
): string {
  const basePredicate = kind === "candidate"
    ? definition.candidatePredicateSql
    : definition.predicateSql;
  if (!definition.sessionKeyLane) {
    return basePredicate;
  }
  return `(${basePredicate} AND ${buildConfiguredSessionKeyPredicateSql(definition.sessionKeyLane)})`;
}

function stageCleanerAgentIds(db: DatabaseSync, agentIds?: string[]): void {
  db.exec(`
    CREATE TEMP TABLE doctor_cleaner_agent_ids (
      agent_id TEXT PRIMARY KEY
    ) WITHOUT ROWID
  `);
  const insert = db.prepare(
    `INSERT INTO temp.doctor_cleaner_agent_ids (agent_id) VALUES (?)`,
  );
  for (const agentId of normalizeCleanerAgentIds(agentIds)) {
    insert.run(agentId);
  }
}

function truncatePreview(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 117)}...`;
}

function buildMatchedConversationsSql(params: {
  definitions: CleanerDefinition[];
  includeFilterId?: boolean;
  messageStatsTableName?: string;
}): string {
  const { definitions, includeFilterId = true, messageStatsTableName } = params;
  if (definitions.length === 0) {
    return includeFilterId
      ? `SELECT NULL AS filter_id, NULL AS conversation_id WHERE 0`
      : `SELECT NULL AS conversation_id WHERE 0`;
  }
  return definitions
    .map((definition) => {
      const selectSql = includeFilterId
        ? `SELECT '${definition.id}' AS filter_id, c.conversation_id`
        : `SELECT c.conversation_id`;
      const joinSql =
        definition.needsFirstMessage && messageStatsTableName
          ? `LEFT JOIN ${messageStatsTableName} message_stats ON message_stats.conversation_id = c.conversation_id`
          : "";
      return `${selectSql}
              FROM conversations c
              ${joinSql}
              WHERE ${buildCleanerPredicateSql(definition, "matched")}`;
    })
    .join(`\nUNION ALL\n`);
}

function buildCandidateConversationsSql(definitions: CleanerDefinition[]): string {
  if (definitions.length === 0) {
    return `SELECT NULL AS conversation_id WHERE 0`;
  }
  return definitions
    .map(
      (definition) => `SELECT c.conversation_id
              FROM conversations c
              WHERE ${buildCleanerPredicateSql(definition, "candidate")}`,
    )
    .join(`\nUNION\n`);
}

function dropTempCleanerScanTables(db: DatabaseSync): void {
  db.exec(`DROP TABLE IF EXISTS temp.doctor_cleaner_scan_matches`);
  db.exec(`DROP TABLE IF EXISTS temp.doctor_cleaner_scan_message_stats`);
  db.exec(`DROP TABLE IF EXISTS temp.doctor_cleaner_candidate_conversations`);
  db.exec(`DROP TABLE IF EXISTS temp.doctor_cleaner_agent_ids`);
}

function stageCleanerScanTables(
  db: DatabaseSync,
  definitions: CleanerDefinition[],
  agentIds?: string[],
): void {
  dropTempCleanerScanTables(db);
  if (definitions.length === 0) {
    return;
  }
  stageCleanerAgentIds(db, agentIds);
  db.exec(`
    CREATE TEMP TABLE doctor_cleaner_candidate_conversations (
      conversation_id INTEGER PRIMARY KEY
    ) WITHOUT ROWID
  `);
  db.exec(`
    INSERT INTO temp.doctor_cleaner_candidate_conversations (conversation_id)
    ${buildCandidateConversationsSql(definitions)}
  `);
  db.exec(`
    CREATE TEMP TABLE doctor_cleaner_scan_message_stats (
      conversation_id INTEGER PRIMARY KEY,
      first_message_preview TEXT,
      message_count INTEGER NOT NULL
    )
  `);
  if (definitions.some((definition) => definition.needsFirstMessage)) {
    db.exec(`
      WITH ranked_messages AS (
        SELECT
          m.conversation_id,
          m.content,
          ROW_NUMBER() OVER (
            PARTITION BY m.conversation_id
            ORDER BY m.seq ASC, m.created_at ASC, m.message_id ASC
          ) AS row_num,
          COUNT(*) OVER (PARTITION BY m.conversation_id) AS message_count
        FROM messages m
        JOIN temp.doctor_cleaner_candidate_conversations candidates
          ON candidates.conversation_id = m.conversation_id
      )
      INSERT INTO temp.doctor_cleaner_scan_message_stats (
        conversation_id,
        first_message_preview,
        message_count
      )
      SELECT
        conversation_id,
        MAX(CASE WHEN row_num = 1 THEN substr(content, 1, ${SCAN_FIRST_MESSAGE_PREVIEW_LIMIT}) END) AS first_message_preview,
        MAX(message_count) AS message_count
      FROM ranked_messages
      GROUP BY conversation_id
    `);
  } else {
    db.exec(`
      INSERT INTO temp.doctor_cleaner_scan_message_stats (
        conversation_id,
        first_message_preview,
        message_count
      )
      SELECT
        m.conversation_id,
        NULL AS first_message_preview,
        COUNT(*) AS message_count
      FROM messages m
      JOIN temp.doctor_cleaner_candidate_conversations candidates
        ON candidates.conversation_id = m.conversation_id
      GROUP BY m.conversation_id
    `);
  }
  db.exec(`
    CREATE TEMP TABLE doctor_cleaner_scan_matches (
      filter_id TEXT NOT NULL,
      conversation_id INTEGER NOT NULL,
      PRIMARY KEY (filter_id, conversation_id)
    ) WITHOUT ROWID
  `);
  const matchedConversationsSql = buildMatchedConversationsSql({
    definitions,
    includeFilterId: true,
    messageStatsTableName: "temp.doctor_cleaner_scan_message_stats",
  });
  db.exec(`
    INSERT INTO temp.doctor_cleaner_scan_matches (filter_id, conversation_id)
    ${matchedConversationsSql}
  `);
}

export function getDoctorCleanerFilters(): Array<Pick<DoctorCleanerFilterStat, "id" | "label" | "description">> {
  return CLEANER_DEFINITIONS.map(({ id, label, description }) => ({
    id,
    label,
    description,
  }));
}

export function getDoctorCleanerFilterIds(): DoctorCleanerId[] {
  return [...DOCTOR_CLEANER_IDS];
}

export function scanDoctorCleaners(
  db: DatabaseSync,
  filterIds?: DoctorCleanerId[],
  agentIds?: string[],
): DoctorCleanerScan {
  const definitions = getCleanerDefinitions(filterIds);
  if (definitions.length === 0) {
    return {
      filters: [],
      totalDistinctConversations: 0,
      totalDistinctMessages: 0,
    };
  }
  try {
    stageCleanerScanTables(db, definitions, agentIds);
    const counts = db
      .prepare(
        `WITH filter_counts AS (
           SELECT
             matches.filter_id,
             COUNT(*) AS conversation_count,
             COALESCE(SUM(COALESCE(stats.message_count, 0)), 0) AS message_count
           FROM temp.doctor_cleaner_scan_matches matches
           LEFT JOIN temp.doctor_cleaner_scan_message_stats stats
             ON stats.conversation_id = matches.conversation_id
           GROUP BY matches.filter_id
         ),
         distinct_conversations AS (
           SELECT DISTINCT conversation_id
           FROM temp.doctor_cleaner_scan_matches
         )
         SELECT
           fc.filter_id,
           fc.conversation_count,
           fc.message_count,
           COALESCE((SELECT COUNT(*) FROM distinct_conversations), 0) AS total_conversation_count,
           COALESCE((
             SELECT SUM(COALESCE(stats.message_count, 0))
             FROM distinct_conversations dc
             LEFT JOIN temp.doctor_cleaner_scan_message_stats stats
               ON stats.conversation_id = dc.conversation_id
           ), 0) AS total_message_count
         FROM filter_counts fc`,
      )
      .all() as Array<
        CleanerCountRow & {
          filter_id: DoctorCleanerId;
          total_conversation_count: number | null;
          total_message_count: number | null;
        }
      >;

    const examples = db
      .prepare(
        `WITH ranked_examples AS (
           SELECT
             matches.filter_id,
             c.conversation_id,
             c.session_key,
             COALESCE(stats.message_count, 0) AS message_count,
             stats.first_message_preview,
             ROW_NUMBER() OVER (
               PARTITION BY matches.filter_id
               ORDER BY COALESCE(stats.message_count, 0) DESC, c.created_at DESC, c.conversation_id DESC
             ) AS example_rank
           FROM temp.doctor_cleaner_scan_matches matches
           JOIN conversations c ON c.conversation_id = matches.conversation_id
           LEFT JOIN temp.doctor_cleaner_scan_message_stats stats
             ON stats.conversation_id = matches.conversation_id
         )
         SELECT
           filter_id,
           conversation_id,
           session_key,
           message_count,
           first_message_preview
         FROM ranked_examples
         WHERE example_rank <= 3
         ORDER BY filter_id, example_rank`,
      )
      .all() as CleanerExampleRow[];

    const countsById = new Map(counts.map((row) => [row.filter_id, row]));
    const examplesById = new Map<DoctorCleanerId, CleanerExampleRow[]>();
    for (const row of examples) {
      const rows = examplesById.get(row.filter_id) ?? [];
      rows.push(row);
      examplesById.set(row.filter_id, rows);
    }

    const filters = definitions.map((definition) => {
      const countRow = countsById.get(definition.id);
      const exampleRows = examplesById.get(definition.id) ?? [];
      return {
        id: definition.id,
        label: definition.label,
        description: definition.description,
        conversationCount: countRow?.conversation_count ?? 0,
        messageCount: countRow?.message_count ?? 0,
        examples: exampleRows.map((row) => ({
          conversationId: row.conversation_id,
          sessionKey: row.session_key ?? null,
          messageCount: row.message_count ?? 0,
          firstMessagePreview: truncatePreview(row.first_message_preview ?? null),
        })),
      };
    });

    const totals = counts[0];

    return {
      filters,
      totalDistinctConversations: totals?.total_conversation_count ?? 0,
      totalDistinctMessages: totals?.total_message_count ?? 0,
    };
  } finally {
    dropTempCleanerScanTables(db);
  }
}

function hasTable(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`)
    .get(tableName) as { found?: number } | undefined;
  return row?.found === 1;
}

function dropTempCleanerTables(db: DatabaseSync): void {
  db.exec(`DROP TABLE IF EXISTS temp.doctor_cleaner_first_messages`);
  db.exec(`DROP TABLE IF EXISTS temp.doctor_cleaner_message_ids`);
  db.exec(`DROP TABLE IF EXISTS temp.doctor_cleaner_summary_ids`);
  db.exec(`DROP TABLE IF EXISTS temp.doctor_cleaner_batch_conversation_ids`);
  db.exec(`DROP TABLE IF EXISTS temp.doctor_cleaner_summary_fts_rowids`);
  db.exec(`DROP TABLE IF EXISTS temp.doctor_cleaner_staged_summary_ids`);
  db.exec(`DROP TABLE IF EXISTS temp.doctor_cleaner_batch_fts_rowids`);
  db.exec(`DROP TABLE IF EXISTS temp.doctor_cleaner_conversation_ids`);
  db.exec(`DROP TABLE IF EXISTS temp.doctor_cleaner_agent_ids`);
}

/**
 * Stage first-message previews for the conversations the first-message
 * cleaners could match, reading only their own messages.
 */
function stageTempCleanerFirstMessages(db: DatabaseSync, definitions: CleanerDefinition[]): void {
  db.exec(`
    CREATE TEMP TABLE doctor_cleaner_first_messages (
      conversation_id INTEGER PRIMARY KEY,
      first_message_preview TEXT
    )
  `);
  db.exec(`
    WITH candidates AS (
      ${buildCandidateConversationsSql(definitions.filter((definition) => definition.needsFirstMessage))}
    ),
    ranked_messages AS (
      SELECT
        m.conversation_id,
        substr(m.content, 1, ${SCAN_FIRST_MESSAGE_PREVIEW_LIMIT}) AS content,
        ROW_NUMBER() OVER (
          PARTITION BY m.conversation_id
          ORDER BY m.seq ASC, m.created_at ASC, m.message_id ASC
        ) AS row_num
      FROM messages m
      JOIN candidates ON candidates.conversation_id = m.conversation_id
    )
    INSERT INTO temp.doctor_cleaner_first_messages (
      conversation_id,
      first_message_preview
    )
    SELECT
      conversation_id,
      MAX(CASE WHEN row_num = 1 THEN content END) AS first_message_preview
    FROM ranked_messages
    GROUP BY conversation_id
  `);
}

/** Build the SQL selecting distinct conversation ids that match `definitions` now. */
function buildCleanerMatchSql(definitions: CleanerDefinition[]): string {
  const needsFirstMessage = definitions.some((definition) => definition.needsFirstMessage);
  return `SELECT DISTINCT conversation_id
    FROM (
      ${buildMatchedConversationsSql({
        definitions,
        includeFilterId: false,
        messageStatsTableName: needsFirstMessage
          ? "temp.doctor_cleaner_first_messages"
          : undefined,
      })}
    )`;
}

/**
 * Stage the matched conversations with their message counts. Staging only
 * reads, so it runs outside any write transaction.
 */
function stageCleanerConversationIds(
  db: DatabaseSync,
  definitions: CleanerDefinition[],
  agentIds?: string[],
): void {
  dropTempCleanerTables(db);
  db.exec(`
    CREATE TEMP TABLE doctor_cleaner_conversation_ids (
      conversation_id INTEGER PRIMARY KEY,
      message_count INTEGER NOT NULL
    )
  `);
  db.exec(`CREATE TEMP TABLE doctor_cleaner_batch_conversation_ids (conversation_id INTEGER PRIMARY KEY)`);
  db.exec(`CREATE TEMP TABLE doctor_cleaner_summary_ids (summary_id TEXT PRIMARY KEY)`);
  db.exec(`CREATE TEMP TABLE doctor_cleaner_message_ids (message_id INTEGER PRIMARY KEY)`);

  if (definitions.length === 0) {
    return;
  }
  stageCleanerAgentIds(db, agentIds);
  if (definitions.some((definition) => definition.needsFirstMessage)) {
    stageTempCleanerFirstMessages(db, definitions);
  }
  db.exec(`
    INSERT INTO temp.doctor_cleaner_conversation_ids (conversation_id, message_count)
    SELECT matched.conversation_id, COUNT(m.message_id)
    FROM (${buildCleanerMatchSql(definitions)}) matched
    LEFT JOIN messages m ON m.conversation_id = matched.conversation_id
    GROUP BY matched.conversation_id
  `);
  stageCleanerSummaryFtsRowids(db);
}

const SUMMARY_FTS_TABLES = ["summaries_fts", "summaries_fts_cjk"] as const;

/**
 * Resolve the FTS rowids of every staged summary once. The summary FTS tables
 * keep summary_id as an UNINDEXED column, so looking rows up by summary_id
 * scans the whole table; doing that once here keeps per-batch deletes on
 * rowid lookups.
 */
function stageCleanerSummaryFtsRowids(db: DatabaseSync): void {
  db.exec(`
    CREATE TEMP TABLE doctor_cleaner_summary_fts_rowids (
      fts_table TEXT NOT NULL,
      fts_rowid INTEGER NOT NULL,
      summary_id TEXT NOT NULL,
      PRIMARY KEY (fts_table, summary_id, fts_rowid)
    ) WITHOUT ROWID
  `);
  db.exec(`CREATE TEMP TABLE doctor_cleaner_staged_summary_ids (summary_id TEXT PRIMARY KEY) WITHOUT ROWID`);
  db.exec(`
    CREATE TEMP TABLE doctor_cleaner_batch_fts_rowids (
      fts_rowid INTEGER PRIMARY KEY,
      summary_id TEXT NOT NULL
    )
  `);
  db.exec(`
    INSERT INTO temp.doctor_cleaner_staged_summary_ids (summary_id)
    SELECT s.summary_id
    FROM summaries s
    JOIN temp.doctor_cleaner_conversation_ids ids ON ids.conversation_id = s.conversation_id
  `);
  for (const table of SUMMARY_FTS_TABLES) {
    if (!hasTable(db, table)) {
      continue;
    }
    db.exec(`
      INSERT INTO temp.doctor_cleaner_summary_fts_rowids (fts_table, fts_rowid, summary_id)
      SELECT '${table}', fts.rowid, fts.summary_id
      FROM ${table} fts
      WHERE fts.summary_id IN (SELECT summary_id FROM temp.doctor_cleaner_staged_summary_ids)
    `);
  }
}

/**
 * Split staged conversations into delete batches of at most
 * `maxMessages` messages (or one oversized conversation) and
 * `maxConversations` conversations, so each write transaction stays short.
 */
function planCleanerDeleteBatches(
  db: DatabaseSync,
  limits: { maxConversations: number; maxMessages: number },
): number[][] {
  const rows = db
    .prepare(
      `SELECT conversation_id, message_count
       FROM temp.doctor_cleaner_conversation_ids
       ORDER BY conversation_id`,
    )
    .all() as Array<{ conversation_id: number; message_count: number }>;
  const batches: number[][] = [];
  let current: number[] = [];
  let currentMessages = 0;
  for (const row of rows) {
    if (
      current.length > 0
      && (current.length >= limits.maxConversations
        || currentMessages + row.message_count > limits.maxMessages)
    ) {
      batches.push(current);
      current = [];
      currentMessages = 0;
    }
    current.push(row.conversation_id);
    currentMessages += row.message_count;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

/**
 * Inside the batch's write transaction, re-check which of `conversationIds`
 * still match and stage their messages and summaries.
 */
function stageCleanerDeleteBatch(
  db: DatabaseSync,
  definitions: CleanerDefinition[],
  conversationIds: number[],
): number {
  db.exec(`DELETE FROM temp.doctor_cleaner_batch_conversation_ids`);
  db.exec(`DELETE FROM temp.doctor_cleaner_summary_ids`);
  db.exec(`DELETE FROM temp.doctor_cleaner_message_ids`);
  db.prepare(
    `INSERT INTO temp.doctor_cleaner_batch_conversation_ids (conversation_id)
     SELECT conversation_id
     FROM (${buildCleanerMatchSql(definitions)})
     WHERE conversation_id IN (${conversationIds.map(() => "?").join(", ")})`,
  ).run(...conversationIds);
  db.exec(`
    INSERT INTO temp.doctor_cleaner_summary_ids (summary_id)
    SELECT s.summary_id
    FROM temp.doctor_cleaner_batch_conversation_ids ids
    JOIN summaries s ON s.conversation_id = ids.conversation_id
  `);
  return Number(
    db.prepare(`
      INSERT INTO temp.doctor_cleaner_message_ids (message_id)
      SELECT m.message_id
      FROM temp.doctor_cleaner_batch_conversation_ids ids
      JOIN messages m ON m.conversation_id = ids.conversation_id
    `).run().changes ?? 0,
  );
}

/**
 * Delete the batch's summary FTS rows by their staged rowids, keeping only
 * rowids that still hold the same summary_id (an FTS rebuild between staging
 * and this batch renumbers rows). Summaries whose staged rows no longer match,
 * or that were created after staging, fall back to a summary_id lookup, which
 * scans the FTS table.
 */
function deleteBatchSummaryFtsRows(
  db: DatabaseSync,
  table: (typeof SUMMARY_FTS_TABLES)[number],
): void {
  db.exec(`DELETE FROM temp.doctor_cleaner_batch_fts_rowids`);
  db.prepare(
    `INSERT INTO temp.doctor_cleaner_batch_fts_rowids (fts_rowid, summary_id)
     SELECT staged.fts_rowid, staged.summary_id
     FROM temp.doctor_cleaner_summary_fts_rowids staged
     JOIN temp.doctor_cleaner_summary_ids ids ON ids.summary_id = staged.summary_id
     JOIN ${table} current ON current.rowid = staged.fts_rowid
     WHERE staged.fts_table = ? AND current.summary_id = staged.summary_id`,
  ).run(table);
  db.exec(
    `DELETE FROM ${table}
     WHERE rowid IN (SELECT fts_rowid FROM temp.doctor_cleaner_batch_fts_rowids)`,
  );
  const unresolvedSql = `
    SELECT ids.summary_id
    FROM temp.doctor_cleaner_summary_ids ids
    WHERE ids.summary_id NOT IN (SELECT summary_id FROM temp.doctor_cleaner_staged_summary_ids)
       OR EXISTS (
         SELECT 1
         FROM temp.doctor_cleaner_summary_fts_rowids staged
         WHERE staged.fts_table = ?
           AND staged.summary_id = ids.summary_id
           AND staged.fts_rowid NOT IN (SELECT fts_rowid FROM temp.doctor_cleaner_batch_fts_rowids)
       )`;
  const unresolved = db.prepare(`${unresolvedSql} LIMIT 1`).get(table);
  if (unresolved) {
    db.prepare(`DELETE FROM ${table} WHERE summary_id IN (${unresolvedSql})`).run(table);
  }
}

function deleteTempCleanerCandidates(db: DatabaseSync): number {
  const hasMessagesFts = hasTable(db, "messages_fts");
  const hasSummariesFts = hasTable(db, "summaries_fts");
  const hasSummariesFtsCjk = hasTable(db, "summaries_fts_cjk");

  db.prepare(
    `DELETE FROM summary_messages
     WHERE summary_id IN (SELECT summary_id FROM temp.doctor_cleaner_summary_ids)`,
  ).run();
  db.prepare(
    `DELETE FROM summary_messages
     WHERE message_id IN (SELECT message_id FROM temp.doctor_cleaner_message_ids)`,
  ).run();

  db.prepare(
    `DELETE FROM summary_parents
     WHERE summary_id IN (SELECT summary_id FROM temp.doctor_cleaner_summary_ids)`,
  ).run();
  db.prepare(
    `DELETE FROM summary_parents
     WHERE parent_summary_id IN (SELECT summary_id FROM temp.doctor_cleaner_summary_ids)`,
  ).run();

  db.prepare(
    `DELETE FROM context_items
     WHERE message_id IN (SELECT message_id FROM temp.doctor_cleaner_message_ids)`,
  ).run();
  db.prepare(
    `DELETE FROM context_items
     WHERE summary_id IN (SELECT summary_id FROM temp.doctor_cleaner_summary_ids)`,
  ).run();
  db.prepare(
    `DELETE FROM context_items
     WHERE conversation_id IN (SELECT conversation_id FROM temp.doctor_cleaner_batch_conversation_ids)`,
  ).run();

  if (hasMessagesFts) {
    db.prepare(
      `DELETE FROM messages_fts
       WHERE rowid IN (SELECT message_id FROM temp.doctor_cleaner_message_ids)`,
    ).run();
  }
  for (const [table, present] of [
    ["summaries_fts", hasSummariesFts],
    ["summaries_fts_cjk", hasSummariesFtsCjk],
  ] as const) {
    if (present) {
      deleteBatchSummaryFtsRows(db, table);
    }
  }

  return Number(
    db
      .prepare(
        `DELETE FROM conversations
         WHERE conversation_id IN (SELECT conversation_id FROM temp.doctor_cleaner_batch_conversation_ids)`,
      )
      .run().changes ?? 0,
  );
}

export function getDoctorCleanerApplyUnavailableReason(databasePath: string): string | null {
  return getFileBackedDatabasePath(databasePath)
    ? null
    : "Cleaner apply requires a file-backed SQLite database so Lossless Claw can create a backup first.";
}

function buildCleanerBackupPath(databasePath: string): string | null {
  return buildLcmDatabaseBackupPath(databasePath, "doctor-cleaners");
}

/** Per-transaction size of cleaner deletes. */
export const DOCTOR_CLEANER_DELETE_BATCH_LIMITS = {
  maxConversations: 200,
  maxMessages: 1_000,
};

/**
 * Back up the database, then delete matched conversations in short batched
 * write transactions so concurrent writers on other connections can interleave.
 * Each batch re-checks its filters and removes whole conversations, so an
 * interrupted apply leaves only fully kept or fully deleted conversations and
 * can be rerun.
 */
export function applyDoctorCleaners(
  db: DatabaseSync,
  options: {
    databasePath: string;
    filterIds?: DoctorCleanerId[];
    agentIds?: string[];
    vacuum?: boolean;
    batchLimits?: { maxConversations: number; maxMessages: number };
  },
): DoctorCleanerApplyResult {
  const definitions = getCleanerDefinitions(options.filterIds);
  if (definitions.length === 0) {
    return {
      kind: "unavailable",
      reason: "No valid doctor cleaner filters were selected.",
    };
  }

  const unavailableReason = getDoctorCleanerApplyUnavailableReason(options.databasePath);
  if (unavailableReason) {
    return {
      kind: "unavailable",
      reason: unavailableReason,
    };
  }
  const backupPath = buildCleanerBackupPath(options.databasePath);
  if (!backupPath) {
    return {
      kind: "unavailable",
      reason:
        getDoctorCleanerApplyUnavailableReason(options.databasePath)
        ?? "Cleaner apply could not determine a backup path.",
    };
  }

  writeLcmDatabaseBackup(db, backupPath);

  let deletedConversations = 0;
  let deletedMessages = 0;
  let vacuumed = false;

  try {
    stageCleanerConversationIds(db, definitions, options.agentIds);
    const batches = planCleanerDeleteBatches(
      db,
      options.batchLimits ?? DOCTOR_CLEANER_DELETE_BATCH_LIMITS,
    );
    for (const conversationIds of batches) {
      let transactionActive = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        transactionActive = true;
        const batchMessages = stageCleanerDeleteBatch(db, definitions, conversationIds);
        const batchConversations = deleteTempCleanerCandidates(db);
        db.exec("COMMIT");
        transactionActive = false;
        deletedConversations += batchConversations;
        deletedMessages += batchMessages;
        // Checkpoint the batch's WAL frames on this connection, so the next
        // small commit on another connection doesn't inherit the work.
        db.exec("PRAGMA wal_checkpoint(PASSIVE)");
      } catch (error) {
        if (transactionActive) {
          db.exec("ROLLBACK");
        }
        throw error;
      }
    }
  } finally {
    dropTempCleanerTables(db);
  }

  if (options.vacuum && deletedConversations > 0) {
    db.exec("VACUUM");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    vacuumed = true;
  }

  return {
    kind: "applied",
    filterIds: definitions.map((definition) => definition.id),
    deletedConversations,
    deletedMessages,
    vacuumed,
    backupPath,
  };
}
