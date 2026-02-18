import type { DatabaseSync } from "node:sqlite";

type SummaryColumnInfo = {
  name?: string;
};

type SummaryDepthRow = {
  summary_id: string;
  kind: "leaf" | "condensed";
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
        `SELECT summary_id, kind
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

export function runLcmMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
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

    -- Indexes
    CREATE INDEX IF NOT EXISTS messages_conv_seq_idx ON messages (conversation_id, seq);
    CREATE INDEX IF NOT EXISTS summaries_conv_created_idx ON summaries (conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS message_parts_message_idx ON message_parts (message_id);
    CREATE INDEX IF NOT EXISTS message_parts_type_idx ON message_parts (part_type);
    CREATE INDEX IF NOT EXISTS context_items_conv_idx ON context_items (conversation_id, ordinal);
    CREATE INDEX IF NOT EXISTS large_files_conv_idx ON large_files (conversation_id, created_at);
  `);

  // Forward-compatible conversations migration for existing DBs.
  const conversationColumns = db.prepare(`PRAGMA table_info(conversations)`).all() as Array<{
    name?: string;
  }>;
  const hasBootstrappedAt = conversationColumns.some((col) => col.name === "bootstrapped_at");
  if (!hasBootstrappedAt) {
    db.exec(`ALTER TABLE conversations ADD COLUMN bootstrapped_at TEXT`);
  }

  ensureSummaryDepthColumn(db);
  backfillSummaryDepths(db);

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
}
