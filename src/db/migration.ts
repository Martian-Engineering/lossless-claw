import type { DatabaseSync } from "node:sqlite";
import { getLcmDbFeatures } from "./features.js";
import { parseUtcTimestampOrNull } from "../store/parse-utc-timestamp.js";

type SummaryColumnInfo = {
  name?: string;
};

type SummaryDepthRow = {
  summary_id: string;
  conversation_id: number;
  kind: "leaf" | "condensed";
  depth: number;
  token_count: number;
  created_at: string;
};

type SummaryMessageTimeRangeRow = {
  summary_id: string;
  earliest_at: string | null;
  latest_at: string | null;
  source_message_token_count: number | null;
};

type SummaryParentEdgeRow = {
  summary_id: string;
  parent_summary_id: string;
};

function ensureSummaryDepthColumn(db: DatabaseSync): void {
  const summaryColumns = db.prepare(`PRAGMA table_info(summaries)`).all() as SummaryColumnInfo[];
  const hasDepth = summaryColumns.some((col) => col.name === "depth");
  if (!hasDepth) {
    db.exec(`ALTER TABLE summaries ADD COLUMN depth INTEGER NOT NULL DEFAULT 0`);
  }
}

function ensureSummaryMetadataColumns(db: DatabaseSync): void {
  const summaryColumns = db.prepare(`PRAGMA table_info(summaries)`).all() as SummaryColumnInfo[];
  const hasEarliestAt = summaryColumns.some((col) => col.name === "earliest_at");
  const hasLatestAt = summaryColumns.some((col) => col.name === "latest_at");
  const hasDescendantCount = summaryColumns.some((col) => col.name === "descendant_count");
  const hasDescendantTokenCount = summaryColumns.some((col) => col.name === "descendant_token_count");
  const hasSourceMessageTokenCount = summaryColumns.some(
    (col) => col.name === "source_message_token_count",
  );

  if (!hasEarliestAt) {
    db.exec(`ALTER TABLE summaries ADD COLUMN earliest_at TEXT`);
  }
  if (!hasLatestAt) {
    db.exec(`ALTER TABLE summaries ADD COLUMN latest_at TEXT`);
  }
  if (!hasDescendantCount) {
    db.exec(`ALTER TABLE summaries ADD COLUMN descendant_count INTEGER NOT NULL DEFAULT 0`);
  }
  if (!hasDescendantTokenCount) {
    db.exec(`ALTER TABLE summaries ADD COLUMN descendant_token_count INTEGER NOT NULL DEFAULT 0`);
  }
  if (!hasSourceMessageTokenCount) {
    db.exec(`ALTER TABLE summaries ADD COLUMN source_message_token_count INTEGER NOT NULL DEFAULT 0`);
  }
}

function parseTimestamp(value: string | null | undefined): Date | null {
  return parseUtcTimestampOrNull(value);
}

function isoStringOrNull(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function ensureSummaryModelColumn(db: DatabaseSync): void {
  const summaryColumns = db.prepare(`PRAGMA table_info(summaries)`).all() as SummaryColumnInfo[];
  const hasModel = summaryColumns.some((col) => col.name === "model");
  if (!hasModel) {
    db.exec(`ALTER TABLE summaries ADD COLUMN model TEXT NOT NULL DEFAULT 'unknown'`);
  }
}

function ensureCompactionTelemetryColumns(db: DatabaseSync): void {
  const telemetryColumns = db.prepare(`PRAGMA table_info(conversation_compaction_telemetry)`).all() as SummaryColumnInfo[];
  const hasLastLeafCompactionAt = telemetryColumns.some((col) => col.name === "last_leaf_compaction_at");
  const hasTurnsSinceLeafCompaction = telemetryColumns.some((col) => col.name === "turns_since_leaf_compaction");
  const hasTokensAccumulatedSinceLeafCompaction = telemetryColumns.some(
    (col) => col.name === "tokens_accumulated_since_leaf_compaction",
  );
  const hasLastActivityBand = telemetryColumns.some((col) => col.name === "last_activity_band");

  if (!hasLastLeafCompactionAt) {
    db.exec(`ALTER TABLE conversation_compaction_telemetry ADD COLUMN last_leaf_compaction_at TEXT`);
  }
  if (!hasTurnsSinceLeafCompaction) {
    db.exec(
      `ALTER TABLE conversation_compaction_telemetry ADD COLUMN turns_since_leaf_compaction INTEGER NOT NULL DEFAULT 0`,
    );
  }
  if (!hasTokensAccumulatedSinceLeafCompaction) {
    db.exec(
      `ALTER TABLE conversation_compaction_telemetry ADD COLUMN tokens_accumulated_since_leaf_compaction INTEGER NOT NULL DEFAULT 0`,
    );
  }
  if (!hasLastActivityBand) {
    db.exec(
      `ALTER TABLE conversation_compaction_telemetry ADD COLUMN last_activity_band TEXT NOT NULL DEFAULT 'low' CHECK (last_activity_band IN ('low', 'medium', 'high'))`,
    );
  }
}

function backfillSummaryDepths(db: DatabaseSync): void {
  // Leaves are always depth 0, even if legacy rows had malformed values.
  db.exec(`UPDATE summaries SET depth = 0 WHERE kind = 'leaf'`);

  const conversationRows = db
    .prepare(`SELECT DISTINCT conversation_id FROM summaries WHERE kind = 'condensed'`)
    .all() as Array<{ conversation_id: number }>;
  if (conversationRows.length === 0) {
    return;
  }

  const updateDepthStmt = db.prepare(`UPDATE summaries SET depth = ? WHERE summary_id = ?`);

  for (const row of conversationRows) {
    const conversationId = row.conversation_id;
    const summaries = db
      .prepare(
        `SELECT summary_id, conversation_id, kind, depth, token_count, created_at
         FROM summaries
         WHERE conversation_id = ?`,
      )
      .all(conversationId) as SummaryDepthRow[];

    const depthBySummaryId = new Map<string, number>();
    const unresolvedCondensedIds = new Set<string>();
    for (const summary of summaries) {
      if (summary.kind === "leaf") {
        depthBySummaryId.set(summary.summary_id, 0);
        continue;
      }
      unresolvedCondensedIds.add(summary.summary_id);
    }

    const edges = db
      .prepare(
        `SELECT summary_id, parent_summary_id
         FROM summary_parents
         WHERE summary_id IN (
           SELECT summary_id FROM summaries
           WHERE conversation_id = ? AND kind = 'condensed'
         )`,
      )
      .all(conversationId) as SummaryParentEdgeRow[];
    const parentsBySummaryId = new Map<string, string[]>();
    for (const edge of edges) {
      const existing = parentsBySummaryId.get(edge.summary_id) ?? [];
      existing.push(edge.parent_summary_id);
      parentsBySummaryId.set(edge.summary_id, existing);
    }

    while (unresolvedCondensedIds.size > 0) {
      let progressed = false;

      for (const summaryId of [...unresolvedCondensedIds]) {
        const parentIds = parentsBySummaryId.get(summaryId) ?? [];
        if (parentIds.length === 0) {
          depthBySummaryId.set(summaryId, 1);
          unresolvedCondensedIds.delete(summaryId);
          progressed = true;
          continue;
        }

        let maxParentDepth = -1;
        let allParentsResolved = true;
        for (const parentId of parentIds) {
          const parentDepth = depthBySummaryId.get(parentId);
          if (parentDepth == null) {
            allParentsResolved = false;
            break;
          }
          if (parentDepth > maxParentDepth) {
            maxParentDepth = parentDepth;
          }
        }

        if (!allParentsResolved) {
          continue;
        }

        depthBySummaryId.set(summaryId, maxParentDepth + 1);
        unresolvedCondensedIds.delete(summaryId);
        progressed = true;
      }

      // Guard against malformed cycles/cross-conversation references.
      if (!progressed) {
        for (const summaryId of unresolvedCondensedIds) {
          depthBySummaryId.set(summaryId, 1);
        }
        unresolvedCondensedIds.clear();
      }
    }

    for (const summary of summaries) {
      const depth = depthBySummaryId.get(summary.summary_id);
      if (depth == null) {
        continue;
      }
      updateDepthStmt.run(depth, summary.summary_id);
    }
  }
}

function backfillSummaryMetadata(db: DatabaseSync): void {
  const conversationRows = db
    .prepare(`SELECT DISTINCT conversation_id FROM summaries`)
    .all() as Array<{ conversation_id: number }>;
  if (conversationRows.length === 0) {
    return;
  }

  const updateMetadataStmt = db.prepare(
    `UPDATE summaries
     SET earliest_at = ?, latest_at = ?, descendant_count = ?,
         descendant_token_count = ?, source_message_token_count = ?
     WHERE summary_id = ?`,
  );

  for (const conversationRow of conversationRows) {
    const conversationId = conversationRow.conversation_id;
    const summaries = db
      .prepare(
        `SELECT summary_id, conversation_id, kind, depth, token_count, created_at
         FROM summaries
         WHERE conversation_id = ?
         ORDER BY depth ASC, created_at ASC`,
      )
      .all(conversationId) as SummaryDepthRow[];
    if (summaries.length === 0) {
      continue;
    }

    const leafRanges = db
      .prepare(
        `SELECT
           sm.summary_id,
           MIN(m.created_at) AS earliest_at,
           MAX(m.created_at) AS latest_at,
           COALESCE(SUM(m.token_count), 0) AS source_message_token_count
         FROM summary_messages sm
         JOIN messages m ON m.message_id = sm.message_id
         JOIN summaries s ON s.summary_id = sm.summary_id
         WHERE s.conversation_id = ? AND s.kind = 'leaf'
         GROUP BY sm.summary_id`,
      )
      .all(conversationId) as SummaryMessageTimeRangeRow[];
    const leafRangeBySummaryId = new Map(
      leafRanges.map((row) => [
        row.summary_id,
        {
          earliestAt: row.earliest_at,
          latestAt: row.latest_at,
          sourceMessageTokenCount: row.source_message_token_count,
        },
      ]),
    );

    const edges = db
      .prepare(
        `SELECT summary_id, parent_summary_id
         FROM summary_parents
         WHERE summary_id IN (
           SELECT summary_id FROM summaries WHERE conversation_id = ?
         )`,
      )
      .all(conversationId) as SummaryParentEdgeRow[];
    const parentsBySummaryId = new Map<string, string[]>();
    for (const edge of edges) {
      const existing = parentsBySummaryId.get(edge.summary_id) ?? [];
      existing.push(edge.parent_summary_id);
      parentsBySummaryId.set(edge.summary_id, existing);
    }

    const metadataBySummaryId = new Map<
      string,
      {
        earliestAt: Date | null;
        latestAt: Date | null;
        descendantCount: number;
        descendantTokenCount: number;
        sourceMessageTokenCount: number;
      }
    >();
    const tokenCountBySummaryId = new Map(
      summaries.map((summary) => [summary.summary_id, Math.max(0, Math.floor(summary.token_count ?? 0))]),
    );

    for (const summary of summaries) {
      const fallbackDate = parseTimestamp(summary.created_at);
      if (summary.kind === "leaf") {
        const range = leafRangeBySummaryId.get(summary.summary_id);
        const earliestAt = parseTimestamp(range?.earliestAt ?? summary.created_at) ?? fallbackDate;
        const latestAt = parseTimestamp(range?.latestAt ?? summary.created_at) ?? fallbackDate;

        metadataBySummaryId.set(summary.summary_id, {
          earliestAt,
          latestAt,
          descendantCount: 0,
          descendantTokenCount: 0,
          sourceMessageTokenCount: Math.max(
            0,
            Math.floor(range?.sourceMessageTokenCount ?? 0),
          ),
        });
        continue;
      }

      const parentIds = parentsBySummaryId.get(summary.summary_id) ?? [];
      if (parentIds.length === 0) {
        metadataBySummaryId.set(summary.summary_id, {
          earliestAt: fallbackDate,
          latestAt: fallbackDate,
          descendantCount: 0,
          descendantTokenCount: 0,
          sourceMessageTokenCount: 0,
        });
        continue;
      }

      let earliestAt: Date | null = null;
      let latestAt: Date | null = null;
      let descendantCount = 0;
      let descendantTokenCount = 0;
      let sourceMessageTokenCount = 0;

      for (const parentId of parentIds) {
        const parentMetadata = metadataBySummaryId.get(parentId);
        if (!parentMetadata) {
          continue;
        }

        const parentEarliest = parentMetadata.earliestAt;
        if (parentEarliest && (!earliestAt || parentEarliest < earliestAt)) {
          earliestAt = parentEarliest;
        }

        const parentLatest = parentMetadata.latestAt;
        if (parentLatest && (!latestAt || parentLatest > latestAt)) {
          latestAt = parentLatest;
        }

        descendantCount += Math.max(0, parentMetadata.descendantCount) + 1;
        const parentTokenCount = tokenCountBySummaryId.get(parentId) ?? 0;
        descendantTokenCount +=
          Math.max(0, parentTokenCount) + Math.max(0, parentMetadata.descendantTokenCount);
        sourceMessageTokenCount += Math.max(0, parentMetadata.sourceMessageTokenCount);
      }

      metadataBySummaryId.set(summary.summary_id, {
        earliestAt: earliestAt ?? fallbackDate,
        latestAt: latestAt ?? fallbackDate,
        descendantCount: Math.max(0, descendantCount),
        descendantTokenCount: Math.max(0, descendantTokenCount),
        sourceMessageTokenCount: Math.max(0, sourceMessageTokenCount),
      });
    }

    for (const summary of summaries) {
      const metadata = metadataBySummaryId.get(summary.summary_id);
      if (!metadata) {
        continue;
      }

      updateMetadataStmt.run(
        isoStringOrNull(metadata.earliestAt),
        isoStringOrNull(metadata.latestAt),
        Math.max(0, metadata.descendantCount),
        Math.max(0, metadata.descendantTokenCount),
        Math.max(0, metadata.sourceMessageTokenCount),
        summary.summary_id,
      );
    }
  }
}

/**
 * Backfill tool_call_id, tool_name, and tool_input from metadata JSON for rows
 * where the DB columns are NULL but the values exist in metadata.  This covers
 * legacy text-type parts where the string-content ingestion path stored tool
 * info only in the metadata JSON (see #158).
 */
function backfillToolCallColumns(db: DatabaseSync): void {
  db.exec(
    `UPDATE message_parts
     SET tool_call_id = COALESCE(
       json_extract(metadata, '$.toolCallId'),
       json_extract(metadata, '$.raw.id'),
       json_extract(metadata, '$.raw.call_id'),
       json_extract(metadata, '$.raw.toolCallId'),
       json_extract(metadata, '$.raw.tool_call_id')
     )
     WHERE tool_call_id IS NULL
       AND metadata IS NOT NULL
       AND COALESCE(
         json_extract(metadata, '$.toolCallId'),
         json_extract(metadata, '$.raw.id'),
         json_extract(metadata, '$.raw.call_id'),
         json_extract(metadata, '$.raw.toolCallId'),
         json_extract(metadata, '$.raw.tool_call_id')
       ) IS NOT NULL`,
  );

  db.exec(
    `UPDATE message_parts
     SET tool_name = COALESCE(
       json_extract(metadata, '$.toolName'),
       json_extract(metadata, '$.raw.name'),
       json_extract(metadata, '$.raw.toolName'),
       json_extract(metadata, '$.raw.tool_name')
     )
     WHERE tool_name IS NULL
       AND metadata IS NOT NULL
       AND COALESCE(
         json_extract(metadata, '$.toolName'),
         json_extract(metadata, '$.raw.name'),
         json_extract(metadata, '$.raw.toolName'),
         json_extract(metadata, '$.raw.tool_name')
       ) IS NOT NULL`,
  );

  db.exec(
    `UPDATE message_parts
     SET tool_input = COALESCE(
       json_extract(metadata, '$.raw.input'),
       json_extract(metadata, '$.raw.arguments'),
       json_extract(metadata, '$.raw.toolInput')
     )
     WHERE tool_input IS NULL
       AND metadata IS NOT NULL
       AND COALESCE(
         json_extract(metadata, '$.raw.input'),
         json_extract(metadata, '$.raw.arguments'),
         json_extract(metadata, '$.raw.toolInput')
       ) IS NOT NULL`,
  );
}

export function runLcmMigrations(
  db: DatabaseSync,
  options?: { fts5Available?: boolean },
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      session_key TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      archived_at TEXT,
      title TEXT,
      bootstrapped_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      message_id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (conversation_id, seq)
    );

    CREATE TABLE IF NOT EXISTS summaries (
      summary_id TEXT PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('leaf', 'condensed')),
      depth INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      earliest_at TEXT,
      latest_at TEXT,
      descendant_count INTEGER NOT NULL DEFAULT 0,
      descendant_token_count INTEGER NOT NULL DEFAULT 0,
      source_message_token_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      file_ids TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS message_parts (
      part_id TEXT PRIMARY KEY,
      message_id INTEGER NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      part_type TEXT NOT NULL CHECK (part_type IN (
        'text', 'reasoning', 'tool', 'patch', 'file',
        'subtask', 'compaction', 'step_start', 'step_finish',
        'snapshot', 'agent', 'retry'
      )),
      ordinal INTEGER NOT NULL,
      text_content TEXT,
      is_ignored INTEGER,
      is_synthetic INTEGER,
      tool_call_id TEXT,
      tool_name TEXT,
      tool_status TEXT,
      tool_input TEXT,
      tool_output TEXT,
      tool_error TEXT,
      tool_title TEXT,
      patch_hash TEXT,
      patch_files TEXT,
      file_mime TEXT,
      file_name TEXT,
      file_url TEXT,
      subtask_prompt TEXT,
      subtask_desc TEXT,
      subtask_agent TEXT,
      step_reason TEXT,
      step_cost REAL,
      step_tokens_in INTEGER,
      step_tokens_out INTEGER,
      snapshot_hash TEXT,
      compaction_auto INTEGER,
      metadata TEXT,
      UNIQUE (message_id, ordinal)
    );

    CREATE TABLE IF NOT EXISTS summary_messages (
      summary_id TEXT NOT NULL REFERENCES summaries(summary_id) ON DELETE CASCADE,
      message_id INTEGER NOT NULL REFERENCES messages(message_id) ON DELETE RESTRICT,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY (summary_id, message_id)
    );

    CREATE TABLE IF NOT EXISTS summary_parents (
      summary_id TEXT NOT NULL REFERENCES summaries(summary_id) ON DELETE CASCADE,
      parent_summary_id TEXT NOT NULL REFERENCES summaries(summary_id) ON DELETE RESTRICT,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY (summary_id, parent_summary_id)
    );

    CREATE TABLE IF NOT EXISTS context_items (
      conversation_id INTEGER NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      item_type TEXT NOT NULL CHECK (item_type IN ('message', 'summary')),
      message_id INTEGER REFERENCES messages(message_id) ON DELETE RESTRICT,
      summary_id TEXT REFERENCES summaries(summary_id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (conversation_id, ordinal),
      CHECK (
        (item_type = 'message' AND message_id IS NOT NULL AND summary_id IS NULL) OR
        (item_type = 'summary' AND summary_id IS NOT NULL AND message_id IS NULL)
      )
    );

    CREATE TABLE IF NOT EXISTS large_files (
      file_id TEXT PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
      file_name TEXT,
      mime_type TEXT,
      byte_size INTEGER,
      storage_uri TEXT NOT NULL,
      exploration_summary TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversation_bootstrap_state (
      conversation_id INTEGER PRIMARY KEY REFERENCES conversations(conversation_id) ON DELETE CASCADE,
      session_file_path TEXT NOT NULL,
      last_seen_size INTEGER NOT NULL,
      last_seen_mtime_ms INTEGER NOT NULL,
      last_processed_offset INTEGER NOT NULL,
      last_processed_entry_hash TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversation_compaction_telemetry (
      conversation_id INTEGER PRIMARY KEY REFERENCES conversations(conversation_id) ON DELETE CASCADE,
      last_observed_cache_read INTEGER,
      last_observed_cache_write INTEGER,
      last_observed_cache_hit_at TEXT,
      last_observed_cache_break_at TEXT,
      cache_state TEXT NOT NULL DEFAULT 'unknown'
        CHECK (cache_state IN ('hot', 'cold', 'unknown')),
      retention TEXT,
      last_leaf_compaction_at TEXT,
      turns_since_leaf_compaction INTEGER NOT NULL DEFAULT 0,
      tokens_accumulated_since_leaf_compaction INTEGER NOT NULL DEFAULT 0,
      last_activity_band TEXT NOT NULL DEFAULT 'low'
        CHECK (last_activity_band IN ('low', 'medium', 'high')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS messages_conv_seq_idx ON messages (conversation_id, seq);
    CREATE INDEX IF NOT EXISTS summaries_conv_created_idx ON summaries (conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS summary_messages_message_idx ON summary_messages (message_id);
    CREATE INDEX IF NOT EXISTS summary_parents_parent_summary_idx ON summary_parents (parent_summary_id);
    CREATE INDEX IF NOT EXISTS message_parts_message_idx ON message_parts (message_id);
    CREATE INDEX IF NOT EXISTS message_parts_type_idx ON message_parts (part_type);
    CREATE INDEX IF NOT EXISTS context_items_conv_idx ON context_items (conversation_id, ordinal);
    CREATE INDEX IF NOT EXISTS large_files_conv_idx ON large_files (conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS bootstrap_state_path_idx
      ON conversation_bootstrap_state (session_file_path, updated_at);
    CREATE INDEX IF NOT EXISTS compaction_telemetry_state_idx
      ON conversation_compaction_telemetry (cache_state, updated_at);

    -- Speed up summary_messages lookups by message_id (PK is summary_id,message_id)
    CREATE INDEX IF NOT EXISTS summary_messages_message_idx ON summary_messages (message_id);
  `);

  // Forward-compatible conversations migration for existing DBs.
  const conversationColumns = db.prepare(`PRAGMA table_info(conversations)`).all() as Array<{
    name?: string;
  }>;
  const hasBootstrappedAt = conversationColumns.some((col) => col.name === "bootstrapped_at");
  if (!hasBootstrappedAt) {
    db.exec(`ALTER TABLE conversations ADD COLUMN bootstrapped_at TEXT`);
  }

  const hasSessionKey = conversationColumns.some((col) => col.name === "session_key");
  if (!hasSessionKey) {
    db.exec(`ALTER TABLE conversations ADD COLUMN session_key TEXT`);
  }

  const hasActive = conversationColumns.some((col) => col.name === "active");
  if (!hasActive) {
    db.exec(`ALTER TABLE conversations ADD COLUMN active INTEGER NOT NULL DEFAULT 1`);
  }

  const hasArchivedAt = conversationColumns.some((col) => col.name === "archived_at");
  if (!hasArchivedAt) {
    db.exec(`ALTER TABLE conversations ADD COLUMN archived_at TEXT`);
  }

  db.exec(`UPDATE conversations SET active = 1 WHERE active IS NULL`);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS conversations_active_session_key_idx
    ON conversations (session_key)
    WHERE session_key IS NOT NULL AND active = 1
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS conversations_session_key_active_created_idx
    ON conversations (session_key, active, created_at)
  `);
  db.exec(`DROP INDEX IF EXISTS conversations_session_key_idx`);
  ensureSummaryDepthColumn(db);
  ensureSummaryMetadataColumns(db);
  ensureSummaryModelColumn(db);
  ensureCompactionTelemetryColumns(db);
  backfillSummaryDepths(db);
  // Index on depth — created AFTER backfillSummaryDepths to avoid index
  // maintenance overhead during bulk depth updates on large existing DBs.
  db.exec(`CREATE INDEX IF NOT EXISTS summaries_conv_depth_kind_idx ON summaries (conversation_id, depth, kind)`);
  backfillSummaryMetadata(db);
  backfillToolCallColumns(db);

  const fts5Available = options?.fts5Available ?? getLcmDbFeatures(db).fts5Available;
  if (!fts5Available) {
    return;
  }

  // FTS5 virtual tables for full-text search (cannot use IF NOT EXISTS, so check manually)
  const hasFts = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'")
    .get();

  if (hasFts) {
    // Check for stale schema: external-content FTS tables with content_rowid cause errors.
    // Drop and recreate as standalone FTS if the old schema is detected.
    const ftsSchema = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages_fts'")
        .get() as { sql: string } | undefined
    )?.sql;
    if (ftsSchema && ftsSchema.includes("content_rowid")) {
      db.exec("DROP TABLE messages_fts");
      db.exec(`
        CREATE VIRTUAL TABLE messages_fts USING fts5(
          content,
          tokenize='porter unicode61'
        );
        INSERT INTO messages_fts(rowid, content) SELECT message_id, content FROM messages;
      `);
    }
  } else {
    db.exec(`
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        content,
        tokenize='porter unicode61'
      );
    `);
  }

  const summariesFtsInfo = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='summaries_fts'")
    .get() as { sql?: string } | undefined;
  const summariesFtsSql = summariesFtsInfo?.sql ?? "";
  const summariesFtsColumns = db.prepare(`PRAGMA table_info(summaries_fts)`).all() as Array<{
    name?: string;
  }>;
  const hasSummaryIdColumn = summariesFtsColumns.some((col) => col.name === "summary_id");
  const shouldRecreateSummariesFts =
    !summariesFtsInfo ||
    !hasSummaryIdColumn ||
    summariesFtsSql.includes("content_rowid='summary_id'") ||
    summariesFtsSql.includes('content_rowid="summary_id"');
  if (shouldRecreateSummariesFts) {
    db.exec(`
      DROP TABLE IF EXISTS summaries_fts;
      CREATE VIRTUAL TABLE summaries_fts USING fts5(
        summary_id UNINDEXED,
        content,
        tokenize='porter unicode61'
      );
      INSERT INTO summaries_fts(summary_id, content)
      SELECT summary_id, content FROM summaries;
    `);
  }

  // ── CJK trigram FTS table ────────────────────────────────────────────────
  // FTS5 unicode61 (porter) tokenizer cannot segment CJK ideographs, so CJK
  // queries currently fall back to a LIKE path with AND logic.  When the user's
  // phrasing doesn't match the summary verbatim (e.g. "端到端测试结果" vs
  // "端到端测试"), ALL terms must match and the query returns 0 candidates.
  //
  // A trigram-tokenized table indexes every 3-character substring, enabling
  // native CJK substring matching via FTS5 MATCH with OR semantics.
  const cjkTableExists = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='summaries_fts_cjk'",
    )
    .get();
  if (!cjkTableExists) {
    db.exec(`
      CREATE VIRTUAL TABLE summaries_fts_cjk USING fts5(
        summary_id UNINDEXED,
        content,
        tokenize='trigram'
      );
      INSERT INTO summaries_fts_cjk(summary_id, content)
      SELECT summary_id, content FROM summaries;
    `);
  }
}
