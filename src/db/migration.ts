import type { DatabaseSync } from "node:sqlite";
import { getLcmDbFeatures } from "./features.js";
import { buildMessageIdentityHash } from "../store/message-identity.js";
import { parseUtcTimestampOrNull } from "../store/parse-utc-timestamp.js";

type MigrationLogger = {
  info?: (message: string) => void;
};

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

type TableNameRow = {
  name?: string;
};

type MessageIdentityBackfillRow = {
  message_id: number;
  role: string;
  content: string;
};

type FtsTableSpec = {
  tableName: string;
  createSql: string;
  seedSql: string;
  expectedColumns: string[];
  staleSchemaPatterns?: string[];
};

const VERSIONED_BACKFILL_STEPS = {
  backfillSummaryDepths: 1,
  backfillSummaryMetadata: 1,
  backfillToolCallColumns: 1,
} as const;

type VersionedBackfillStepName = keyof typeof VERSIONED_BACKFILL_STEPS;

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

/**
 * v4.1 schema additions to `summaries`:
 *   - session_key                  (v3.1 A1: cross-conv identity for assemble + retrieval)
 *   - suppressed_at                (v3.1 A3: lossless-forget flag; cascade triggers)
 *   - entity_index                 (v3.1: JSON sidecar populated by §7.2 entity coreference)
 *   - contains_suppressed_leaves   (v3.1 A3: marks condensed needing idle rebuild)
 *   - suppress_reason              (v4.1.1 A2: read by lcm_describe; written by lcm_suppress)
 *   - superseded_by                (v4.1.1 A2: forwarder pattern; idle rebuild keeps old row immutable
 *                                   and points to new row via this FK)
 *   - leaf_summarizer_cap_was      (v4.1: forensic marker for the 2,415-token cap fix; NULL =
 *                                   leaf was never capped or has been regenerated)
 *
 * SQLite ADD COLUMN constraints satisfied:
 *   - No PRIMARY KEY / UNIQUE in any new column.
 *   - No CURRENT_TIMESTAMP defaults.
 *   - NOT NULL columns have non-NULL defaults.
 *   - REFERENCES columns have NULL default (per SQLite ADD COLUMN with FK rule).
 */
function ensureSummaryV41Columns(db: DatabaseSync): void {
  const cols = db.prepare(`PRAGMA table_info(summaries)`).all() as SummaryColumnInfo[];
  const has = (name: string): boolean => cols.some((c) => c.name === name);

  if (!has("session_key")) {
    db.exec(`ALTER TABLE summaries ADD COLUMN session_key TEXT NOT NULL DEFAULT ''`);
  }
  if (!has("suppressed_at")) {
    db.exec(`ALTER TABLE summaries ADD COLUMN suppressed_at TEXT`);
  }
  if (!has("entity_index")) {
    db.exec(`ALTER TABLE summaries ADD COLUMN entity_index TEXT`);
  }
  if (!has("contains_suppressed_leaves")) {
    db.exec(
      `ALTER TABLE summaries ADD COLUMN contains_suppressed_leaves INTEGER NOT NULL DEFAULT 0`,
    );
  }
  if (!has("suppress_reason")) {
    db.exec(`ALTER TABLE summaries ADD COLUMN suppress_reason TEXT`);
  }
  if (!has("superseded_by")) {
    // FK with SET NULL on parent delete. SQLite ADD COLUMN with REFERENCES requires NULL default.
    db.exec(
      `ALTER TABLE summaries ADD COLUMN superseded_by TEXT REFERENCES summaries(summary_id) ON DELETE SET NULL`,
    );
  }
  if (!has("leaf_summarizer_cap_was")) {
    db.exec(`ALTER TABLE summaries ADD COLUMN leaf_summarizer_cap_was INTEGER`);
  }
}

/**
 * v3.1 A3 (extended in v4.1.1 A3): suppression cascade reaches raw messages
 * via `messages.suppressed_at`. lcm_quote / lcm_factcheck filter on this.
 */
function ensureMessageSuppressedAtColumn(db: DatabaseSync): void {
  const cols = db.prepare(`PRAGMA table_info(messages)`).all() as SummaryColumnInfo[];
  const hasSuppressedAt = cols.some((c) => c.name === "suppressed_at");
  if (!hasSuppressedAt) {
    db.exec(`ALTER TABLE messages ADD COLUMN suppressed_at TEXT`);
  }
}

/**
 * v4.1.1 A8 — feature-flag storage for v4.1 sections (e.g. semantic
 * retrieval can be disabled if vec0 extension fails to load).
 *
 * Code-as-ground-truth note: v4.1.1 A8 originally proposed extending
 * `lcm_migration_flags` with a `value` column. That table doesn't exist
 * in the upstream source — it's a fork-side legacy table that only
 * exists on Eva's live DB. This implementation creates a clean new
 * `lcm_feature_flags` table that doesn't conflict with the legacy table.
 */
function ensureLcmFeatureFlagsTable(db: DatabaseSync): void {
  // Note: explicit NOT NULL on the TEXT PRIMARY KEY column — SQLite's
  // legacy behavior allows NULL in TEXT PK columns without it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS lcm_feature_flags (
      flag TEXT NOT NULL PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

function ensureCompactionTelemetryColumns(db: DatabaseSync): void {
  const telemetryColumns = db.prepare(`PRAGMA table_info(conversation_compaction_telemetry)`).all() as SummaryColumnInfo[];
  const hasConsecutiveColdObservations = telemetryColumns.some(
    (col) => col.name === "consecutive_cold_observations",
  );
  const hasLastLeafCompactionAt = telemetryColumns.some((col) => col.name === "last_leaf_compaction_at");
  const hasTurnsSinceLeafCompaction = telemetryColumns.some((col) => col.name === "turns_since_leaf_compaction");
  const hasTokensAccumulatedSinceLeafCompaction = telemetryColumns.some(
    (col) => col.name === "tokens_accumulated_since_leaf_compaction",
  );
  const hasLastActivityBand = telemetryColumns.some((col) => col.name === "last_activity_band");
  const hasLastApiCallAt = telemetryColumns.some((col) => col.name === "last_api_call_at");
  const hasLastCacheTouchAt = telemetryColumns.some((col) => col.name === "last_cache_touch_at");
  const hasProvider = telemetryColumns.some((col) => col.name === "provider");
  const hasModel = telemetryColumns.some((col) => col.name === "model");
  const hasLastObservedPromptTokenCount = telemetryColumns.some(
    (col) => col.name === "last_observed_prompt_token_count",
  );

  if (!hasConsecutiveColdObservations) {
    db.exec(
      `ALTER TABLE conversation_compaction_telemetry ADD COLUMN consecutive_cold_observations INTEGER NOT NULL DEFAULT 0`,
    );
  }
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
  if (!hasLastApiCallAt) {
    db.exec(`ALTER TABLE conversation_compaction_telemetry ADD COLUMN last_api_call_at TEXT`);
  }
  if (!hasLastCacheTouchAt) {
    db.exec(`ALTER TABLE conversation_compaction_telemetry ADD COLUMN last_cache_touch_at TEXT`);
  }
  if (!hasProvider) {
    db.exec(`ALTER TABLE conversation_compaction_telemetry ADD COLUMN provider TEXT`);
  }
  if (!hasModel) {
    db.exec(`ALTER TABLE conversation_compaction_telemetry ADD COLUMN model TEXT`);
  }
  if (!hasLastObservedPromptTokenCount) {
    db.exec(`ALTER TABLE conversation_compaction_telemetry ADD COLUMN last_observed_prompt_token_count INTEGER`);
  }
}

/**
 * Belt-and-suspenders guard: create `message_parts` if it does not yet exist.
 *
 * `message_parts` is defined inside the large `db.exec()` block in
 * `runLcmMigrations`.  On some Node.js SQLite builds (particularly
 * `node:sqlite` before v22.12) a syntax error or constraint-check mismatch
 * anywhere in that block causes the exec to stop early, silently leaving
 * tables that appear later in the string uncreated.  Any subsequent INSERT
 * into `message_parts` then throws "no such table".
 *
 * This function probes `sqlite_master` directly and creates the table +
 * indexes when absent, matching the pattern used for column guards
 * (`ensureSummaryDepthColumn`, `ensureMessageIdentityHashColumn`, …).
 */
function ensureMessagePartsTable(db: DatabaseSync): void {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message_parts'`)
    .all() as { name: string }[];
  if (tables.length > 0) return;

  db.exec(`
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
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS message_parts_message_idx ON message_parts (message_id)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS message_parts_type_idx ON message_parts (part_type)`,
  );
}

function ensureMessageIdentityHashColumn(db: DatabaseSync): void {
  const messageColumns = db.prepare(`PRAGMA table_info(messages)`).all() as SummaryColumnInfo[];
  const hasIdentityHash = messageColumns.some((col) => col.name === "identity_hash");
  if (!hasIdentityHash) {
    db.exec(`ALTER TABLE messages ADD COLUMN identity_hash TEXT`);
  }
}

function backfillMessageIdentityHashes(
  db: DatabaseSync,
  options?: { managesOwnTransaction?: boolean },
): void {
  const selectStmt = db.prepare(
    `SELECT message_id, role, content
     FROM messages
     WHERE message_id > ?
       AND (identity_hash IS NULL OR identity_hash = '')
     ORDER BY message_id
     LIMIT ?`,
  );
  const updateStmt = db.prepare(`UPDATE messages SET identity_hash = ? WHERE message_id = ?`);
  let lastProcessedMessageId = 0;
  const managesOwnTransaction = options?.managesOwnTransaction ?? true;

  while (true) {
    const rows = selectStmt.all(lastProcessedMessageId, 1_000) as MessageIdentityBackfillRow[];
    if (rows.length === 0) {
      return;
    }
    if (managesOwnTransaction) {
      db.exec(`BEGIN`);
    }
    try {
      for (const row of rows) {
        updateStmt.run(buildMessageIdentityHash(row.role, row.content), row.message_id);
      }
      if (managesOwnTransaction) {
        db.exec(`COMMIT`);
      }
    } catch (error) {
      if (managesOwnTransaction) {
        try {
          db.exec(`ROLLBACK`);
        } catch {
          // Preserve the original migration failure if rollback also errors.
        }
      }
      throw error;
    }
    lastProcessedMessageId = rows[rows.length - 1]?.message_id ?? lastProcessedMessageId;
  }
}

function describeMigrationError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runMigrationStep(
  name: string,
  log: MigrationLogger | undefined,
  step: () => void,
): void {
  const startedAt = Date.now();
  try {
    step();
    log?.info?.(
      `[lcm] migration step complete: step=${name} durationMs=${Date.now() - startedAt}`,
    );
  } catch (error) {
    log?.info?.(
      `[lcm] migration step failed: step=${name} durationMs=${Date.now() - startedAt} error=${describeMigrationError(error)}`,
    );
    throw error;
  }
}

function getVersionedBackfillSavepointName(stepName: VersionedBackfillStepName): string {
  return `lcm_backfill_${stepName}`;
}

function hasCompletedVersionedBackfill(
  db: DatabaseSync,
  stepName: VersionedBackfillStepName,
  algorithmVersion: number,
): boolean {
  const row = db
    .prepare(
      `SELECT 1
       FROM lcm_migration_state
       WHERE step_name = ? AND algorithm_version = ?
       LIMIT 1`,
    )
    .get(stepName, algorithmVersion) as { 1?: number } | undefined;
  return row != null;
}

function markVersionedBackfillComplete(
  db: DatabaseSync,
  stepName: VersionedBackfillStepName,
  algorithmVersion: number,
): void {
  db.prepare(
    `INSERT INTO lcm_migration_state (step_name, algorithm_version, completed_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(step_name, algorithm_version)
     DO UPDATE SET completed_at = excluded.completed_at`,
  ).run(stepName, algorithmVersion);
}

function rollbackSavepoint(db: DatabaseSync, savepointName: string): void {
  try {
    db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
  } finally {
    db.exec(`RELEASE SAVEPOINT ${savepointName}`);
  }
}

function runVersionedBackfillStep(
  db: DatabaseSync,
  stepName: VersionedBackfillStepName,
  log: MigrationLogger | undefined,
  step: () => void,
): void {
  const algorithmVersion = VERSIONED_BACKFILL_STEPS[stepName];
  if (hasCompletedVersionedBackfill(db, stepName, algorithmVersion)) {
    log?.info?.(
      `[lcm] migration step skipped: step=${stepName} algorithmVersion=${algorithmVersion} reason=already-complete`,
    );
    return;
  }

  const startedAt = Date.now();
  const savepointName = getVersionedBackfillSavepointName(stepName);

  db.exec(`SAVEPOINT ${savepointName}`);

  try {
    step();
    markVersionedBackfillComplete(db, stepName, algorithmVersion);
    db.exec(`RELEASE SAVEPOINT ${savepointName}`);
    log?.info?.(
      `[lcm] migration step complete: step=${stepName} algorithmVersion=${algorithmVersion} durationMs=${Date.now() - startedAt}`,
    );
  } catch (error) {
    rollbackSavepoint(db, savepointName);
    log?.info?.(
      `[lcm] migration step failed: step=${stepName} algorithmVersion=${algorithmVersion} durationMs=${Date.now() - startedAt} error=${describeMigrationError(error)}`,
    );
    throw error;
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

function getExistingTableNames(db: DatabaseSync, names: string[]): Set<string> {
  if (names.length === 0) {
    return new Set();
  }
  const placeholders = names.map(() => "?").join(", ");
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`)
    .all(...names) as TableNameRow[];
  return new Set(
    rows
      .map((row) => row.name)
      .filter((name): name is string => typeof name === "string" && name.length > 0),
  );
}

function getFtsShadowTableNames(tableName: string): string[] {
  return [
    `${tableName}_data`,
    `${tableName}_idx`,
    `${tableName}_content`,
    `${tableName}_docsize`,
    `${tableName}_config`,
  ];
}

function quoteSqlIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid SQL identifier: ${identifier}`);
  }
  return `"${identifier.replaceAll(`"`, `""`)}"`;
}

function shouldRecreateStandaloneFtsTable(db: DatabaseSync, spec: FtsTableSpec): boolean {
  const shadowTables = getFtsShadowTableNames(spec.tableName);
  const existingTables = getExistingTableNames(db, [spec.tableName, ...shadowTables]);
  if (!existingTables.has(spec.tableName)) {
    return true;
  }
  if (shadowTables.some((name) => !existingTables.has(name))) {
    return true;
  }

  try {
    const info = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?")
      .get(spec.tableName) as { sql?: string } | undefined;
    const sql = info?.sql ?? "";
    if (spec.staleSchemaPatterns?.some((pattern) => sql.includes(pattern))) {
      return true;
    }

    const columns = db
      .prepare(`PRAGMA table_info(${quoteSqlIdentifier(spec.tableName)})`)
      .all() as SummaryColumnInfo[];
    const columnNames = new Set(
      columns
        .map((col) => col.name)
        .filter((name): name is string => typeof name === "string" && name.length > 0),
    );
    return spec.expectedColumns.some((column) => !columnNames.has(column));
  } catch {
    return true;
  }
}

function ensureStandaloneFtsTable(db: DatabaseSync, spec: FtsTableSpec): void {
  if (!shouldRecreateStandaloneFtsTable(db, spec)) {
    return;
  }

  db.exec(`DROP TABLE IF EXISTS ${quoteSqlIdentifier(spec.tableName)}`);
  for (const shadowTableName of getFtsShadowTableNames(spec.tableName)) {
    db.exec(`DROP TABLE IF EXISTS ${quoteSqlIdentifier(shadowTableName)}`);
  }
  db.exec(spec.createSql);
  db.exec(spec.seedSql);
}

export function runLcmMigrations(
  db: DatabaseSync,
  options?: { fts5Available?: boolean; log?: MigrationLogger },
): void {
  const log = options?.log;
  let transactionActive = false;
  db.exec(`BEGIN EXCLUSIVE`);
  transactionActive = true;

  try {
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
      identity_hash TEXT,
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
      last_observed_prompt_token_count INTEGER,
      last_observed_cache_hit_at TEXT,
      last_observed_cache_break_at TEXT,
      cache_state TEXT NOT NULL DEFAULT 'unknown'
        CHECK (cache_state IN ('hot', 'cold', 'unknown')),
      consecutive_cold_observations INTEGER NOT NULL DEFAULT 0,
      retention TEXT,
      last_leaf_compaction_at TEXT,
      turns_since_leaf_compaction INTEGER NOT NULL DEFAULT 0,
      tokens_accumulated_since_leaf_compaction INTEGER NOT NULL DEFAULT 0,
      last_activity_band TEXT NOT NULL DEFAULT 'low'
        CHECK (last_activity_band IN ('low', 'medium', 'high')),
      last_api_call_at TEXT,
      last_cache_touch_at TEXT,
      provider TEXT,
      model TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversation_compaction_maintenance (
      conversation_id INTEGER PRIMARY KEY REFERENCES conversations(conversation_id) ON DELETE CASCADE,
      pending INTEGER NOT NULL DEFAULT 0,
      requested_at TEXT,
      reason TEXT,
      running INTEGER NOT NULL DEFAULT 0,
      last_started_at TEXT,
      last_finished_at TEXT,
      last_failure_summary TEXT,
      token_budget INTEGER,
      current_token_count INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS lcm_migration_state (
      step_name TEXT NOT NULL,
      algorithm_version INTEGER NOT NULL,
      completed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (step_name, algorithm_version)
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
    db.exec(`
      CREATE INDEX IF NOT EXISTS conversations_session_id_active_created_idx
      ON conversations (session_id, active, created_at)
    `);
    db.exec(`DROP INDEX IF EXISTS conversations_session_key_idx`);
    runMigrationStep("ensureSummaryDepthColumn", log, () => ensureSummaryDepthColumn(db));
    runMigrationStep("ensureSummaryMetadataColumns", log, () =>
      ensureSummaryMetadataColumns(db),
    );
    runMigrationStep("ensureSummaryModelColumn", log, () => ensureSummaryModelColumn(db));
    runMigrationStep("ensureMessageIdentityHashColumn", log, () =>
      ensureMessageIdentityHashColumn(db),
    );
    // Belt-and-suspenders: ensure message_parts exists even if the bulk
    // CREATE TABLE block above was interrupted before reaching it.
    runMigrationStep("ensureMessagePartsTable", log, () => ensureMessagePartsTable(db));
    runMigrationStep("backfillMessageIdentityHashes", log, () =>
      backfillMessageIdentityHashes(db, { managesOwnTransaction: false }),
    );
    runMigrationStep("createMessagesIdentityHashIndex", log, () =>
      db.exec(
        `CREATE INDEX IF NOT EXISTS messages_conv_identity_hash_idx ON messages (conversation_id, identity_hash)`,
      ),
    );
    runMigrationStep("ensureCompactionTelemetryColumns", log, () =>
      ensureCompactionTelemetryColumns(db),
    );
    runVersionedBackfillStep(db, "backfillSummaryDepths", log, () => backfillSummaryDepths(db));
    // Index on depth — created AFTER backfillSummaryDepths to avoid index
    // maintenance overhead during bulk depth updates on large existing DBs.
    runMigrationStep("createSummariesDepthIndex", log, () =>
      db.exec(
        `CREATE INDEX IF NOT EXISTS summaries_conv_depth_kind_idx ON summaries (conversation_id, depth, kind)`,
      ),
    );
    runVersionedBackfillStep(db, "backfillSummaryMetadata", log, () =>
      backfillSummaryMetadata(db),
    );
    runVersionedBackfillStep(db, "backfillToolCallColumns", log, () =>
      backfillToolCallColumns(db),
    );

    const detectedFeatures = options?.fts5Available === false ? null : getLcmDbFeatures(db);
    const fts5Available = options?.fts5Available ?? detectedFeatures?.fts5Available ?? false;
    if (fts5Available) {
      const trigramTokenizerAvailable = detectedFeatures?.trigramTokenizerAvailable ?? false;
      if (!trigramTokenizerAvailable) {
        try {
          db.exec(`DROP TABLE IF EXISTS summaries_fts_cjk`);
        } catch {
          // Best effort only. A stale virtual table should not block core migration.
        }
      }

      // FTS5 virtual tables for full-text search (cannot use IF NOT EXISTS, so check manually)
      runMigrationStep("ensureMessagesFts", log, () => {
        ensureStandaloneFtsTable(db, {
          tableName: "messages_fts",
          createSql: `
            CREATE VIRTUAL TABLE messages_fts USING fts5(
              content,
              tokenize='porter unicode61'
            )
          `,
          seedSql: `
            INSERT INTO messages_fts(rowid, content)
            SELECT message_id, content FROM messages
          `,
          expectedColumns: ["content"],
          staleSchemaPatterns: ["content_rowid"],
        });
      });

      runMigrationStep("ensureSummariesFts", log, () => {
        ensureStandaloneFtsTable(db, {
          tableName: "summaries_fts",
          createSql: `
            CREATE VIRTUAL TABLE summaries_fts USING fts5(
              summary_id UNINDEXED,
              content,
              tokenize='porter unicode61'
            )
          `,
          seedSql: `
            INSERT INTO summaries_fts(summary_id, content)
            SELECT summary_id, content FROM summaries
          `,
          expectedColumns: ["summary_id", "content"],
          staleSchemaPatterns: [
            "content_rowid='summary_id'",
            'content_rowid="summary_id"',
          ],
        });
      });

      // ── CJK trigram FTS table ────────────────────────────────────────────────
      // FTS5 unicode61 (porter) tokenizer cannot segment CJK ideographs, so CJK
      // queries currently fall back to a LIKE path with AND logic.  When the user's
      // phrasing doesn't match the summary verbatim (e.g. "端到端测试结果" vs
      // "端到端测试"), ALL terms must match and the query returns 0 candidates.
      //
      // A trigram-tokenized table indexes every 3-character substring, enabling
      // native CJK substring matching via FTS5 MATCH with OR semantics.
      runMigrationStep("ensureSummariesFtsCjk", log, () => {
        if (trigramTokenizerAvailable) {
          ensureStandaloneFtsTable(db, {
            tableName: "summaries_fts_cjk",
            createSql: `
              CREATE VIRTUAL TABLE summaries_fts_cjk USING fts5(
                summary_id UNINDEXED,
                content,
                tokenize='trigram'
              )
            `,
            seedSql: `
              INSERT INTO summaries_fts_cjk(summary_id, content)
              SELECT summary_id, content FROM summaries
            `,
            expectedColumns: ["summary_id", "content"],
          });
        }
      });
    }

    // ── v4.1 schema additions ────────────────────────────────────────────────
    // Each block resolves a specific amendment from architecture-v4.1.1.md.
    // Tables are created idempotently so the migration is safe to re-run.
    //
    // v4.1.1 A9 — `lcm_worker_lock`: cross-process job lock for the worker
    // sidecar (condensation, extraction, embedding backfill, theme
    // consolidation, eval, profile rebuild). `last_heartbeat_at` is
    // required by §0.5 fallback rule (gateway can take over only when
    // BOTH `expires_at < now` AND `last_heartbeat_at < now - 300s`).
    // See `src/concurrency/model.ts` for the invariants and constants.
    runMigrationStep("ensureLcmWorkerLockTable", log, () => {
      // Note: explicit NOT NULL on the TEXT PRIMARY KEY column — SQLite's
      // legacy behavior allows NULL in TEXT PK columns without it.
      db.exec(`
        CREATE TABLE IF NOT EXISTS lcm_worker_lock (
          job_kind TEXT NOT NULL PRIMARY KEY,
          worker_id TEXT NOT NULL,
          acquired_at TEXT NOT NULL DEFAULT (datetime('now')),
          expires_at TEXT NOT NULL,
          last_heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
          job_session_key TEXT,
          job_metadata TEXT
        )
      `);
    });

    // v3.1 A1/A3 + v4.1.1 A2 — additive columns on summaries (session_key,
    // suppressed_at, entity_index, contains_suppressed_leaves, suppress_reason,
    // superseded_by, leaf_summarizer_cap_was). Idempotent via PRAGMA check.
    runMigrationStep("ensureSummaryV41Columns", log, () => ensureSummaryV41Columns(db));

    // v3.1 A3 — messages.suppressed_at for raw-message suppression cascade.
    runMigrationStep("ensureMessageSuppressedAtColumn", log, () =>
      ensureMessageSuppressedAtColumn(db),
    );

    // v4.1.1 A8 — feature flags for v4.1 sections (e.g. v4_section_1_enabled
    // when vec0 extension is available). Creates clean new table; does NOT
    // touch Eva's legacy lcm_migration_flags table.
    runMigrationStep("ensureLcmFeatureFlagsTable", log, () =>
      ensureLcmFeatureFlagsTable(db),
    );

    // v4.1.1 A3 — lcm_extraction_queue: gateway atomically inserts a row
    // alongside every leaf write; worker picks up the queue to run entity
    // coreference (and procedure-recheck on demand). Per v4.1.1 A3 + B18
    // atomicity rule: leaf-write transaction MUST insert the queue row in
    // the same transaction as the leaf insert (Group B leaf-write code).
    runMigrationStep("ensureLcmExtractionQueueTable", log, () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS lcm_extraction_queue (
          queue_id TEXT NOT NULL PRIMARY KEY,
          leaf_id TEXT NOT NULL REFERENCES summaries(summary_id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('entity', 'procedure-recheck')),
          queued_at TEXT NOT NULL DEFAULT (datetime('now')),
          picked_at TEXT,
          worker_id TEXT,
          completed_at TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT
        )
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS lcm_extraction_queue_pending_idx
          ON lcm_extraction_queue (queued_at)
          WHERE picked_at IS NULL
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS lcm_extraction_queue_dead_letter_idx
          ON lcm_extraction_queue (attempts)
          WHERE attempts >= 5
      `);
    });

    // v4.1.1 B2 — lcm_purge_rebuild_queue: persistent rebuild queue for
    // operator-on-demand hard-purge (lcm_purge --immediate). T1 fires
    // suppression cascade + enqueues rebuild targets; worker drains the
    // queue using A4 forwarder pattern (INSERT new condensed row, UPDATE
    // OLD.superseded_by, never mutate summary_parents).
    runMigrationStep("ensureLcmPurgeRebuildQueueTable", log, () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS lcm_purge_rebuild_queue (
          queue_id TEXT NOT NULL PRIMARY KEY,
          target_summary_id TEXT NOT NULL REFERENCES summaries(summary_id) ON DELETE CASCADE,
          purge_session_id TEXT NOT NULL,
          reason TEXT NOT NULL,
          queued_at TEXT NOT NULL DEFAULT (datetime('now')),
          picked_at TEXT,
          worker_id TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT
        )
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS lcm_purge_rebuild_queue_pending_idx
          ON lcm_purge_rebuild_queue (queued_at)
          WHERE picked_at IS NULL
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS lcm_purge_rebuild_queue_session_idx
          ON lcm_purge_rebuild_queue (purge_session_id)
      `);
    });

    // v4.1.1 B3 — lcm_voyage_rate_state: cross-process rate-limit budget
    // for Voyage embeddings + reranker. SQLite serializes BEGIN IMMEDIATE
    // naturally so gateway query embeds, worker leaf-time embeds, worker
    // entity-coref embeds, and worker backfill all coordinate via this
    // shared row. Caller pattern (per v4.1.1 B3): brief BEGIN IMMEDIATE
    // updates the counters and COMMITs BEFORE the HTTP call (HTTP must
    // NOT be wrapped in the transaction — that would serialize all calls).
    runMigrationStep("ensureLcmVoyageRateStateTable", log, () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS lcm_voyage_rate_state (
          bucket TEXT NOT NULL PRIMARY KEY CHECK (bucket IN ('embed', 'rerank')),
          tokens_consumed_window INTEGER NOT NULL DEFAULT 0,
          requests_consumed_window INTEGER NOT NULL DEFAULT 0,
          window_started_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_429_at TEXT,
          consecutive_429_count INTEGER NOT NULL DEFAULT 0
        )
      `);
      // Seed both buckets so callers can UPDATE without first INSERTing.
      db.exec(`
        INSERT OR IGNORE INTO lcm_voyage_rate_state (bucket) VALUES ('embed'), ('rerank')
      `);
    });

    // v4.1.1 §C item — lcm_session_key_audit: reversibility log for the
    // §2.1 step 1 re-key of 5 legacy convs to agent:main:main. Eva can
    // run /lcm undo-session-key-rekey <conversation_id> if the spike's
    // identification turns out to be wrong for any of those convs.
    runMigrationStep("ensureLcmSessionKeyAuditTable", log, () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS lcm_session_key_audit (
          audit_id TEXT NOT NULL PRIMARY KEY,
          conversation_id INTEGER NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
          original_session_key TEXT,
          new_session_key TEXT NOT NULL,
          reason TEXT NOT NULL,
          applied_at TEXT NOT NULL DEFAULT (datetime('now')),
          applied_by TEXT NOT NULL DEFAULT 'migration'
        )
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS lcm_session_key_audit_conv_idx
          ON lcm_session_key_audit (conversation_id, applied_at DESC)
      `);
    });

    // ── v4.1 synthesis layer (A.04) ─────────────────────────────────────────
    // Prompt registry → synthesis cache (FK on prompt_id) → audit trail (FK
    // on both summary_id and cache_id, CHECK that at least one is set).
    // Tables created in dependency order so FKs work on first run.
    //
    // v4.1 §3 + v4.1.1 D items — lcm_prompt_registry: versioned prompts per
    // memory_type × tier × pass_kind. Append-only (old versions deactivated,
    // never deleted). bundle_version groups synchronized prompt sets so
    // voice-consistency rebuild fires on bundle delta.
    runMigrationStep("ensureLcmPromptRegistryTable", log, () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS lcm_prompt_registry (
          prompt_id TEXT NOT NULL PRIMARY KEY,
          memory_type TEXT NOT NULL CHECK (memory_type IN (
            'episodic-leaf',
            'episodic-condensed',
            'episodic-yearly',
            'procedural-extract',
            'prospective-extract',
            'entity-extract',
            'theme-consolidation'
          )),
          tier_label TEXT,
          pass_kind TEXT NOT NULL CHECK (pass_kind IN ('single', 'verify_fidelity', 'best_of_n_judge')),
          version INTEGER NOT NULL,
          template TEXT NOT NULL,
          model_recommendation TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          active INTEGER NOT NULL DEFAULT 1,
          bundle_version INTEGER NOT NULL DEFAULT 1,
          notes TEXT,
          UNIQUE(memory_type, tier_label, pass_kind, version)
        )
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS lcm_prompt_registry_active_idx
          ON lcm_prompt_registry (memory_type, tier_label, pass_kind)
          WHERE active = 1
      `);
    });

    // v3.1 A8 + v4.1.1 B4 — lcm_synthesis_cache: rebuildable derived layer
    // for ad-hoc synthesize() output (custom ranges + filtered grep + yearly
    // tier per A2). Has `status='building'` single-flight (v3.1 A8) and
    // prompt_id FK (v4.1.1 B2 fix — cache invalidation can be prompt-selective).
    // UNIQUE lookup index (v4.1.1 B4) enables `INSERT OR IGNORE` cross-process
    // single-flight pattern (loser of race reads back the in-flight row).
    runMigrationStep("ensureLcmSynthesisCacheTable", log, () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS lcm_synthesis_cache (
          cache_id TEXT NOT NULL PRIMARY KEY,
          session_key TEXT NOT NULL,
          range_start TEXT NOT NULL,
          range_end TEXT NOT NULL,
          grep_filter TEXT,
          leaf_fingerprint TEXT NOT NULL,
          content TEXT,
          entity_index TEXT NOT NULL DEFAULT '{}',
          model_used TEXT NOT NULL,
          prompt_id TEXT NOT NULL REFERENCES lcm_prompt_registry(prompt_id),
          tier_label TEXT NOT NULL CHECK (tier_label IN ('year', 'custom', 'filtered')),
          source_leaf_ids TEXT NOT NULL,
          source_condensed_ids TEXT,
          built_at TEXT NOT NULL DEFAULT (datetime('now')),
          source_token_count INTEGER NOT NULL,
          output_token_count INTEGER NOT NULL,
          actual_range_covered TEXT NOT NULL,
          leaf_count_synthesized INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'ready'
            CHECK (status IN ('building', 'ready', 'failed')),
          building_started_at TEXT,
          failure_reason TEXT
        )
      `);
      // UNIQUE lookup index (v4.1.1 B4): enables INSERT OR IGNORE for
      // cross-process single-flight. Both gateway + worker can attempt to
      // create the same cache row; exactly one wins.
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS lcm_synthesis_cache_lookup_uniq
          ON lcm_synthesis_cache (session_key, range_start, range_end,
                                  leaf_fingerprint, COALESCE(grep_filter, ''))
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS lcm_synthesis_cache_built_idx
          ON lcm_synthesis_cache (session_key, built_at DESC)
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS lcm_synthesis_cache_status_building_idx
          ON lcm_synthesis_cache (building_started_at)
          WHERE status = 'building'
      `);
    });

    // v3.1 A3 (extension) — lcm_cache_leaf_refs: inverse index for the
    // proactive purge path. When a leaf is suppressed, query this table
    // to find every cache_id that referenced it; delete those rows so
    // stale content doesn't get served. CASCADE both directions so the
    // refs go when either parent (cache_id or leaf_summary_id) is deleted.
    runMigrationStep("ensureLcmCacheLeafRefsTable", log, () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS lcm_cache_leaf_refs (
          cache_id TEXT NOT NULL REFERENCES lcm_synthesis_cache(cache_id) ON DELETE CASCADE,
          leaf_summary_id TEXT NOT NULL REFERENCES summaries(summary_id) ON DELETE CASCADE,
          PRIMARY KEY (cache_id, leaf_summary_id)
        )
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS lcm_cache_leaf_refs_by_leaf_idx
          ON lcm_cache_leaf_refs (leaf_summary_id)
      `);
    });

    // v4.1.1 B1 — lcm_synthesis_audit: per-pass log for synthesis (draft,
    // verify_fidelity, best-of-N drafts, judge). pass_output is NULLable
    // so it can be inserted BEFORE the LLM call returns (status='started');
    // post-LLM UPDATE sets pass_output + status='completed'/'failed'.
    // pass_session_id groups all passes of one logical synthesis attempt
    // (helps debug best-of-N runs + GC orphaned partial sessions).
    runMigrationStep("ensureLcmSynthesisAuditTable", log, () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS lcm_synthesis_audit (
          audit_id TEXT NOT NULL PRIMARY KEY,
          pass_session_id TEXT NOT NULL,
          target_summary_id TEXT REFERENCES summaries(summary_id) ON DELETE CASCADE,
          target_cache_id TEXT REFERENCES lcm_synthesis_cache(cache_id) ON DELETE CASCADE,
          prompt_id TEXT NOT NULL REFERENCES lcm_prompt_registry(prompt_id),
          pass_kind TEXT NOT NULL,
          pass_input_truncated TEXT NOT NULL,
          pass_output TEXT,
          status TEXT NOT NULL DEFAULT 'started'
            CHECK (status IN ('started', 'completed', 'failed')),
          model_used TEXT NOT NULL,
          latency_ms INTEGER,
          cost_usd_cents INTEGER,
          last_error TEXT,
          ran_at TEXT NOT NULL DEFAULT (datetime('now')),
          CHECK (target_summary_id IS NOT NULL OR target_cache_id IS NOT NULL)
        )
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS lcm_synthesis_audit_target_summary_idx
          ON lcm_synthesis_audit (target_summary_id, ran_at DESC)
          WHERE target_summary_id IS NOT NULL
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS lcm_synthesis_audit_target_cache_idx
          ON lcm_synthesis_audit (target_cache_id, ran_at DESC)
          WHERE target_cache_id IS NOT NULL
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS lcm_synthesis_audit_session_idx
          ON lcm_synthesis_audit (pass_session_id)
      `);
      // GC index: orphaned 'started' rows stuck >1h (v4.1.1 B1 GC pattern)
      db.exec(`
        CREATE INDEX IF NOT EXISTS lcm_synthesis_audit_started_gc_idx
          ON lcm_synthesis_audit (ran_at)
          WHERE status = 'started'
      `);
    });

    // ── v4.1 eval harness tables (A.05) ─────────────────────────────────────
    // Per v4.1 §11 + v4.1.1 (revising the v4 design): N≥100 stratified
    // queries, 2× empirical SD threshold (calibrate by 5x repeated runs),
    // ensemble judge, mixed absolute+pairwise per dimension, drift index
    // for cumulative regression. Measures BOTH retrieval recall AND
    // synthesis quality (separate metrics, not collapsed).
    runMigrationStep("ensureLcmEvalQuerySetTable", log, () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS lcm_eval_query_set (
          query_set_id TEXT NOT NULL PRIMARY KEY,
          version INTEGER NOT NULL,
          description TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
    });

    runMigrationStep("ensureLcmEvalQueryTable", log, () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS lcm_eval_query (
          query_id TEXT NOT NULL PRIMARY KEY,
          query_set_id TEXT NOT NULL REFERENCES lcm_eval_query_set(query_set_id) ON DELETE CASCADE,
          query_text TEXT NOT NULL,
          stratum TEXT NOT NULL CHECK (stratum IN ('fts-easy', 'fts-medium', 'paraphrastic')),
          expected_topics TEXT NOT NULL,
          expected_sources TEXT,
          reference_summary TEXT,
          must_not_regress INTEGER NOT NULL DEFAULT 0,
          rubric TEXT NOT NULL
        )
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS lcm_eval_query_set_stratum_idx
          ON lcm_eval_query (query_set_id, stratum)
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS lcm_eval_query_must_not_regress_idx
          ON lcm_eval_query (query_set_id)
          WHERE must_not_regress = 1
      `);
    });

    runMigrationStep("ensureLcmEvalRunTable", log, () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS lcm_eval_run (
          run_id TEXT NOT NULL PRIMARY KEY,
          query_set_id TEXT NOT NULL REFERENCES lcm_eval_query_set(query_set_id) ON DELETE CASCADE,
          prompt_bundle_version INTEGER NOT NULL,
          ran_at TEXT NOT NULL DEFAULT (datetime('now')),
          retrieval_recall_score REAL NOT NULL,
          synthesis_quality_score REAL NOT NULL,
          per_query_scores TEXT NOT NULL,
          judge_models TEXT NOT NULL,
          noise_floor_sd REAL,
          trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'prompt-update', 'model-update', 'ci', 'nightly'))
        )
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS lcm_eval_run_recent_idx
          ON lcm_eval_run (query_set_id, ran_at DESC)
      `);
    });

    runMigrationStep("ensureLcmEvalDriftTable", log, () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS lcm_eval_drift (
          drift_id TEXT NOT NULL PRIMARY KEY,
          query_set_id TEXT NOT NULL REFERENCES lcm_eval_query_set(query_set_id) ON DELETE CASCADE,
          cumulative_delta REAL NOT NULL,
          window_runs INTEGER NOT NULL,
          computed_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS lcm_eval_drift_recent_idx
          ON lcm_eval_drift (query_set_id, computed_at DESC)
      `);
    });

    // ── v4.1 entity layer (A.06) ────────────────────────────────────────────
    // Per v4.1 §7 + v4.1.1 B5/B6 — simplified entity schema (no separate
    // lcm_aliases table; alternate surface forms denormalized into
    // lcm_entities.alternate_surfaces JSON; entity embeddings live in
    // vec0 with embedded_kind='entity'). Coreference uses entity-table
    // lookup (B6), not the v4 ±N leaf positional window.
    //
    // entity_type is freeform TEXT (no CHECK constraint per v4.1.1
    // §C — Eva's domain has session_keys, config_flags, error_codes,
    // R-XXX agent IDs, etc. that don't fit a closed enum). The
    // type_registry table tracks first-seen + occurrence count per type
    // so the operator can review/normalize types post-hoc.
    runMigrationStep("ensureLcmEntityTypeRegistryTable", log, () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS lcm_entity_type_registry (
          type_name TEXT NOT NULL PRIMARY KEY,
          first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
          occurrence_count INTEGER NOT NULL DEFAULT 1
        )
      `);
    });

    // v4.1.1 B4 — UNIQUE index on (session_key, canonical_text COLLATE NOCASE)
    // enables INSERT OR IGNORE for cross-process entity coref single-flight.
    runMigrationStep("ensureLcmEntitiesTable", log, () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS lcm_entities (
          entity_id TEXT NOT NULL PRIMARY KEY,
          session_key TEXT NOT NULL,
          canonical_text TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          first_seen_in_summary_id TEXT REFERENCES summaries(summary_id) ON DELETE SET NULL,
          occurrence_count INTEGER NOT NULL DEFAULT 1,
          alternate_surfaces TEXT,
          metadata TEXT
        )
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS lcm_entities_lookup_idx
          ON lcm_entities (session_key, entity_type, last_seen_at DESC)
      `);
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS lcm_entities_canonical_uniq
          ON lcm_entities (session_key, canonical_text COLLATE NOCASE)
      `);
    });

    runMigrationStep("ensureLcmEntityMentionsTable", log, () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS lcm_entity_mentions (
          mention_id TEXT NOT NULL PRIMARY KEY,
          entity_id TEXT NOT NULL REFERENCES lcm_entities(entity_id) ON DELETE CASCADE,
          summary_id TEXT NOT NULL REFERENCES summaries(summary_id) ON DELETE CASCADE,
          surface_form TEXT NOT NULL,
          span_start INTEGER,
          span_end INTEGER,
          mentioned_at TEXT NOT NULL
        )
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS lcm_entity_mentions_by_entity_idx
          ON lcm_entity_mentions (entity_id, mentioned_at DESC)
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS lcm_entity_mentions_by_summary_idx
          ON lcm_entity_mentions (summary_id)
      `);
    });

    // v4.1 §7.1 + v4.1.1 B7/B8 — procedures with empirically-tuned
    // promotion threshold (4 occurrences per B8, was 8 in v4.1) and
    // status lifecycle. extraction_source distinguishes auto-extracted
    // procedures from manually-flagged ones (lcm_remember_procedure).
    runMigrationStep("ensureLcmProceduresTable", log, () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS lcm_procedures (
          procedure_id TEXT NOT NULL PRIMARY KEY,
          session_key TEXT NOT NULL,
          name TEXT NOT NULL,
          steps TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          source_leaf_ids TEXT NOT NULL,
          extracted_at TEXT NOT NULL DEFAULT (datetime('now')),
          status TEXT NOT NULL DEFAULT 'draft'
            CHECK (status IN ('draft', 'active', 'stale', 'archived', 'deprecated')),
          occurrence_count INTEGER NOT NULL DEFAULT 1,
          confidence REAL,
          extracted_by_pass_id TEXT,
          extraction_source TEXT NOT NULL DEFAULT 'auto'
            CHECK (extraction_source IN ('auto', 'manual'))
        )
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS lcm_procedures_lookup_idx
          ON lcm_procedures (session_key, name, status)
      `);
    });

    // v3 + v4.1 §7.3 + v4.1.1 B11 — intentions; resolution_text added in
    // v4.1.1 B11 so lcm_resolve_intention can capture WHY an intention
    // was fulfilled/cancelled. NOTE: source_leaf_id was NOT NULL in v4.1
    // spec — relaxed here to NULL-allowed since suppression sets
    // suppressed_at on the leaf (NOT delete) AND ON DELETE SET NULL only
    // makes sense if the column allows NULL. v4.1.1 §C item.
    runMigrationStep("ensureLcmIntentionsTable", log, () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS lcm_intentions (
          intention_id TEXT NOT NULL PRIMARY KEY,
          session_key TEXT NOT NULL,
          text TEXT NOT NULL,
          target_date TEXT,
          source_leaf_id TEXT REFERENCES summaries(summary_id) ON DELETE SET NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'fulfilled', 'cancelled')),
          resolution_text TEXT,
          resolved_at TEXT,
          extracted_at TEXT NOT NULL DEFAULT (datetime('now')),
          surfaced_at TEXT
        )
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS lcm_intentions_due_idx
          ON lcm_intentions (session_key, target_date)
          WHERE status = 'pending'
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS lcm_intentions_session_status_idx
          ON lcm_intentions (session_key, status)
      `);
    });

    // ── v4.1 embedding registry tables (A.07) ───────────────────────────────
    // Per v4.1 §1 + v4.1.1 A5/A7 — these are the MANAGED tables (regular
    // SQLite tables, not vec0 virtual). The vec0 table itself
    // (`lcm_embeddings_<model_slug>` virtual table) defers to Group B
    // because creating a vec0 table requires the sqlite-vec extension to
    // be loaded — which is best-effort (graceful degrade per v4.1.1 A7
    // splits the migration into Transaction 1 = required schema (this
    // file) + Transaction 2 = vec0 + triggers (loaded at runtime in
    // src/embeddings/store.ts during Group B)).
    //
    // lcm_embedding_profile: registry of embedding models (active/archive).
    // Used by Group B's profile-versioning logic. seed row added during
    // Group B startup when sqlite-vec successfully loads.
    runMigrationStep("ensureLcmEmbeddingProfileTable", log, () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS lcm_embedding_profile (
          model_name TEXT NOT NULL PRIMARY KEY,
          dim INTEGER NOT NULL,
          registered_at TEXT NOT NULL DEFAULT (datetime('now')),
          active INTEGER NOT NULL DEFAULT 1,
          archive_after TEXT
        )
      `);
    });

    // lcm_embedding_meta: sidecar for non-vector queries (model attribution,
    // backfill progress, archival state). Composite PK supports parallel
    // rows during model-bump cutover (one summary embedded under both
    // old + new model). NOTE: no FK to summaries (polymorphic — embedded_id
    // can also reference lcm_entities.entity_id or lcm_themes.theme_id).
    // Polymorphic-orphan cleanup deferred to Group B's idle pass.
    runMigrationStep("ensureLcmEmbeddingMetaTable", log, () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS lcm_embedding_meta (
          embedded_id TEXT NOT NULL,
          embedded_kind TEXT NOT NULL CHECK (embedded_kind IN ('summary', 'entity', 'theme')),
          embedding_model TEXT NOT NULL REFERENCES lcm_embedding_profile(model_name),
          embedded_at TEXT NOT NULL DEFAULT (datetime('now')),
          source_token_count INTEGER NOT NULL,
          archived INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (embedded_id, embedded_kind, embedding_model)
        )
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS lcm_embedding_meta_active_idx
          ON lcm_embedding_meta (embedding_model, embedded_at DESC)
          WHERE archived = 0
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS lcm_embedding_meta_by_kind_idx
          ON lcm_embedding_meta (embedded_kind, embedded_id)
      `);
    });

    db.exec(`COMMIT`);
    transactionActive = false;
  } catch (error) {
    if (transactionActive) {
      try {
        db.exec(`ROLLBACK`);
      } catch {
        // Preserve the original migration failure if rollback also errors.
      }
    }
    throw error;
  }
}
