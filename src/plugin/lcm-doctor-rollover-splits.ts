import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { getFileBackedDatabasePath } from "../db/connection.js";
import { isIsolatedCronSessionKey } from "../session-patterns.js";
import {
  DELIBERATE_ARCHIVE_CAUSES,
  normalizeMessageContentForFullTextIndex,
} from "../store/conversation-store.js";
import type { ArchiveCause } from "../store/conversation-store.js";
import { withDatabaseTransaction } from "../transaction-mutex.js";
import { createLcmDatabaseBackup } from "./lcm-db-backup.js";

export const ROLLOVER_SPLIT_MAINTENANCE_REASON = "doctor-rollover-split-repair";

export type RolloverSplitCounts = {
  messages: number;
  summaries: number;
  contextItems: number;
  largeFiles: number;
  focusBriefs: number;
};

export type RolloverSplitExample = RolloverSplitCounts & {
  sessionKey: string;
  sourceConversationIds: number[];
  targetConversationId: number;
};

export type RolloverSplitReviewGroup = RolloverSplitCounts & {
  sessionKey: string;
  conversationIds: number[];
  reasons: string[];
};

export type RolloverSplitScan = {
  safe: RolloverSplitExample[];
  needsReview: RolloverSplitReviewGroup[];
  totals: RolloverSplitCounts & {
    safeLanes: number;
    needsReviewLanes: number;
  };
};

export type RolloverSplitApplyResult =
  | {
      kind: "applied";
      backupPath: string;
      repairedLanes: number;
      skippedReviewLanes: number;
      totals: RolloverSplitCounts;
      verification: {
        integrity: string;
        foreignKeys: string;
      };
    }
  | {
      kind: "unavailable";
      reason: string;
    };

type ConversationRow = {
  conversation_id: number;
  session_key: string;
  active: number;
  archived_at: string | null;
  archive_cause: string | null;
  created_at: string;
  messages: number;
  summaries: number;
  context_items: number;
  large_files: number;
  focus_briefs: number;
};

type SafeGroup = RolloverSplitExample & {
  sourceConversationIds: number[];
  targetConversationId: number;
  orderedConversationIds: number[];
};

type DuplicateRow = {
  value: string | number | null;
  count: number;
};

type ForeignKeyViolationRow = {
  table?: string;
  rowid?: number | null;
  parent?: string;
  fkid?: number;
};

const HANDLED_CONVERSATION_ID_TABLES = new Set([
  "conversations",
  "messages",
  "summaries",
  "context_items",
  "large_files",
  "conversation_bootstrap_state",
  "conversation_compaction_telemetry",
  "conversation_compaction_maintenance",
  "focus_briefs",
  "pending_compaction_batches",
  "pending_summary_nodes",
]);

const EMPTY_COUNTS: RolloverSplitCounts = {
  messages: 0,
  summaries: 0,
  contextItems: 0,
  largeFiles: 0,
  focusBriefs: 0,
};

function quoteSqlIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

function addCounts(left: RolloverSplitCounts, right: RolloverSplitCounts): RolloverSplitCounts {
  return {
    messages: left.messages + right.messages,
    summaries: left.summaries + right.summaries,
    contextItems: left.contextItems + right.contextItems,
    largeFiles: left.largeFiles + right.largeFiles,
    focusBriefs: left.focusBriefs + right.focusBriefs,
  };
}

function countsFromRows(rows: ConversationRow[]): RolloverSplitCounts {
  return rows.reduce<RolloverSplitCounts>(
    (counts, row) =>
      addCounts(counts, {
        messages: row.messages,
        summaries: row.summaries,
        contextItems: row.context_items,
        largeFiles: row.large_files,
        focusBriefs: row.focus_briefs,
      }),
    { ...EMPTY_COUNTS },
  );
}

function hasStrandedData(row: ConversationRow): boolean {
  return (
    row.messages > 0 ||
    row.summaries > 0 ||
    row.context_items > 0 ||
    row.large_files > 0 ||
    row.focus_briefs > 0
  );
}

// Deliberate archives (e.g. an operator /reset) are excluded from merge sources:
// the user wiped that conversation on purpose. A legacy NULL cause stays
// merge-eligible so a genuine pre-deploy broken split is never withheld.
function isDeliberateArchive(row: ConversationRow): boolean {
  return (
    row.archive_cause !== null && DELIBERATE_ARCHIVE_CAUSES.has(row.archive_cause as ArchiveCause)
  );
}

function compareConversationChronology(left: ConversationRow, right: ConversationRow): number {
  const created = left.created_at.localeCompare(right.created_at);
  if (created !== 0) return created;
  const archived = (left.archived_at ?? "").localeCompare(right.archived_at ?? "");
  if (archived !== 0) return archived;
  return left.conversation_id - right.conversation_id;
}

function loadSessionKeysWithMultipleConversations(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      `SELECT session_key
       FROM conversations
       WHERE session_key IS NOT NULL
       GROUP BY session_key
       HAVING COUNT(*) > 1
       ORDER BY session_key ASC`,
    )
    .all() as Array<{ session_key: string }>;
  return rows.map((row) => row.session_key);
}

function loadConversationRows(db: DatabaseSync, sessionKey: string): ConversationRow[] {
  return db
    .prepare(
      `SELECT
         c.conversation_id,
         c.session_key,
         c.active,
         c.archived_at,
         c.archive_cause,
         c.created_at,
         COALESCE((SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.conversation_id), 0) AS messages,
         COALESCE((SELECT COUNT(*) FROM summaries s WHERE s.conversation_id = c.conversation_id), 0) AS summaries,
         COALESCE((SELECT COUNT(*) FROM context_items ci WHERE ci.conversation_id = c.conversation_id), 0) AS context_items,
         COALESCE((SELECT COUNT(*) FROM large_files lf WHERE lf.conversation_id = c.conversation_id), 0) AS large_files,
         COALESCE((SELECT COUNT(*) FROM focus_briefs fb WHERE fb.conversation_id = c.conversation_id), 0) AS focus_briefs
       FROM conversations c
       WHERE c.session_key = ?
       ORDER BY c.created_at ASC, c.archived_at ASC, c.conversation_id ASC`,
    )
    .all(sessionKey) as ConversationRow[];
}

function loadUnhandledConversationIdTables(db: DatabaseSync): string[] {
  const tables = db
    .prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
       ORDER BY name ASC`,
    )
    .all() as Array<{ name: string }>;
  const unhandled: string[] = [];
  for (const table of tables) {
    const columns = db
      .prepare(`PRAGMA table_info(${quoteSqlIdentifier(table.name)})`)
      .all() as Array<{ name?: string }>;
    if (
      columns.some((column) => column.name === "conversation_id") &&
      !HANDLED_CONVERSATION_ID_TABLES.has(table.name)
    ) {
      unhandled.push(table.name);
    }
  }
  return unhandled;
}

function loadDuplicateRows(
  db: DatabaseSync,
  sql: string,
  conversationIds: number[],
): DuplicateRow[] {
  if (conversationIds.length === 0) return [];
  return db.prepare(sql.replace("__IDS__", placeholders(conversationIds))).all(...conversationIds) as DuplicateRow[];
}

function loadCollisionReasons(db: DatabaseSync, conversationIds: number[]): string[] {
  const duplicateTranscriptEntries = loadDuplicateRows(
    db,
    `SELECT transcript_entry_id AS value, COUNT(*) AS count
     FROM messages
     WHERE conversation_id IN (__IDS__)
       AND transcript_entry_id IS NOT NULL
     GROUP BY transcript_entry_id
     HAVING COUNT(*) > 1`,
    conversationIds,
  );
  const duplicateSummaries = loadDuplicateRows(
    db,
    `SELECT summary_id AS value, COUNT(*) AS count
     FROM summaries
     WHERE conversation_id IN (__IDS__)
     GROUP BY summary_id
     HAVING COUNT(*) > 1`,
    conversationIds,
  );
  const duplicateFiles = loadDuplicateRows(
    db,
    `SELECT file_id AS value, COUNT(*) AS count
     FROM large_files
     WHERE conversation_id IN (__IDS__)
     GROUP BY file_id
     HAVING COUNT(*) > 1`,
    conversationIds,
  );
  const reasons: string[] = [];
  if (duplicateTranscriptEntries.length > 0) {
    reasons.push("duplicate transcript_entry_id");
  }
  if (duplicateSummaries.length > 0) {
    reasons.push("duplicate summary_id");
  }
  if (duplicateFiles.length > 0) {
    reasons.push("duplicate file_id");
  }
  return reasons;
}

function classifySessionKeyGroup(params: {
  db: DatabaseSync;
  sessionKey: string;
  unhandledTables: string[];
}): { safe?: SafeGroup; needsReview?: RolloverSplitReviewGroup } | null {
  if (isIsolatedCronSessionKey(params.sessionKey)) {
    return null;
  }

  const rows = loadConversationRows(params.db, params.sessionKey);
  const sources = rows.filter(
    (row) => row.active === 0 && hasStrandedData(row) && !isDeliberateArchive(row),
  );
  if (sources.length === 0) {
    return null;
  }

  const activeRows = rows.filter((row) => row.active === 1);
  const reasons: string[] = [];
  if (activeRows.length !== 1) {
    reasons.push(`expected exactly one active conversation, found ${activeRows.length}`);
  }
  if (params.unhandledTables.length > 0) {
    reasons.push(`unhandled conversation tables: ${params.unhandledTables.join(", ")}`);
  }

  const target = activeRows[0];
  if (target) {
    for (const source of sources) {
      if (!source.archived_at) {
        reasons.push(`source conversation ${source.conversation_id} is archived without archived_at`);
      }
      if (compareConversationChronology(source, target) >= 0) {
        reasons.push(`source conversation ${source.conversation_id} is not earlier than active target`);
      }
    }
  }

  const candidateConversationIds = target
    ? [...sources.map((row) => row.conversation_id), target.conversation_id]
    : rows.map((row) => row.conversation_id);
  reasons.push(...loadCollisionReasons(params.db, candidateConversationIds));
  if (reasons.length > 0 || !target) {
    return {
      needsReview: {
        sessionKey: params.sessionKey,
        conversationIds: rows.map((row) => row.conversation_id),
        reasons: [...new Set(reasons)],
        ...countsFromRows(sources),
      },
    };
  }

  const orderedSources = sources.slice().sort(compareConversationChronology);
  const counts = countsFromRows(orderedSources);
  return {
    safe: {
      sessionKey: params.sessionKey,
      sourceConversationIds: orderedSources.map((row) => row.conversation_id),
      targetConversationId: target.conversation_id,
      orderedConversationIds: [
        ...orderedSources.map((row) => row.conversation_id),
        target.conversation_id,
      ],
      ...counts,
    },
  };
}

/**
 * Scan the entire database for rollover-split memory groups.
 */
export function scanRolloverSplits(db: DatabaseSync): RolloverSplitScan {
  const unhandledTables = loadUnhandledConversationIdTables(db);
  const safe: RolloverSplitExample[] = [];
  const needsReview: RolloverSplitReviewGroup[] = [];
  let totals: RolloverSplitCounts = { ...EMPTY_COUNTS };

  for (const sessionKey of loadSessionKeysWithMultipleConversations(db)) {
    const classified = classifySessionKeyGroup({ db, sessionKey, unhandledTables });
    if (!classified) {
      continue;
    }
    if (classified.safe) {
      safe.push(classified.safe);
      totals = addCounts(totals, classified.safe);
    }
    if (classified.needsReview) {
      needsReview.push(classified.needsReview);
    }
  }

  return {
    safe,
    needsReview,
    totals: {
      ...totals,
      safeLanes: safe.length,
      needsReviewLanes: needsReview.length,
    },
  };
}

function hasTable(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`)
    .get(tableName) as { found?: number } | undefined;
  return row?.found === 1;
}

function loadSafeGroups(db: DatabaseSync): SafeGroup[] {
  const unhandledTables = loadUnhandledConversationIdTables(db);
  const groups: SafeGroup[] = [];
  for (const sessionKey of loadSessionKeysWithMultipleConversations(db)) {
    const classified = classifySessionKeyGroup({ db, sessionKey, unhandledTables });
    if (classified?.safe) {
      groups.push(classified.safe);
    }
  }
  return groups;
}

function loadOrderedMessageIds(
  db: DatabaseSync,
  group: Pick<SafeGroup, "orderedConversationIds">,
): number[] {
  const conversationRankSql = group.orderedConversationIds
    .map((conversationId, index) => `WHEN ${conversationId} THEN ${index}`)
    .join(" ");
  const rows = db
    .prepare(
      `SELECT message_id
       FROM messages
       WHERE conversation_id IN (${placeholders(group.orderedConversationIds)})
       ORDER BY CASE conversation_id ${conversationRankSql} ELSE 999999 END,
                seq ASC,
                message_id ASC`,
    )
    .all(...group.orderedConversationIds) as Array<{ message_id: number }>;
  return rows.map((row) => row.message_id);
}

function loadOrderedContextRowIds(
  db: DatabaseSync,
  group: Pick<SafeGroup, "orderedConversationIds">,
): number[] {
  const conversationRankSql = group.orderedConversationIds
    .map((conversationId, index) => `WHEN ${conversationId} THEN ${index}`)
    .join(" ");
  const rows = db
    .prepare(
      `SELECT rowid AS row_id
       FROM context_items
       WHERE conversation_id IN (${placeholders(group.orderedConversationIds)})
       ORDER BY CASE conversation_id ${conversationRankSql} ELSE 999999 END,
                ordinal ASC,
                rowid ASC`,
    )
    .all(...group.orderedConversationIds) as Array<{ row_id: number }>;
  return rows.map((row) => row.row_id);
}

function reparentMessages(db: DatabaseSync, group: SafeGroup): void {
  const messageIds = loadOrderedMessageIds(db, group);
  const stage = db.prepare(
    `UPDATE messages
     SET conversation_id = ?, seq = ?
     WHERE message_id = ?`,
  );
  const finalize = db.prepare(`UPDATE messages SET seq = ? WHERE message_id = ?`);

  messageIds.forEach((messageId, index) => {
    stage.run(group.targetConversationId, -(index + 1), messageId);
  });
  messageIds.forEach((messageId, index) => {
    finalize.run(index + 1, messageId);
  });
}

function reparentContextItems(db: DatabaseSync, group: SafeGroup): void {
  const rowIds = loadOrderedContextRowIds(db, group);
  const stage = db.prepare(
    `UPDATE context_items
     SET conversation_id = ?, ordinal = ?
     WHERE rowid = ?`,
  );
  const finalize = db.prepare(`UPDATE context_items SET ordinal = ? WHERE rowid = ?`);

  rowIds.forEach((rowId, index) => {
    stage.run(group.targetConversationId, -(index + 1), rowId);
  });
  rowIds.forEach((rowId, index) => {
    finalize.run(index, rowId);
  });
}

function reparentSimpleConversationTables(db: DatabaseSync, group: SafeGroup): void {
  if (group.sourceConversationIds.length === 0) {
    return;
  }
  const sourcePlaceholders = placeholders(group.sourceConversationIds);
  for (const table of ["summaries", "large_files", "focus_briefs"]) {
    db.prepare(
      `UPDATE ${quoteSqlIdentifier(table)}
       SET conversation_id = ?
       WHERE conversation_id IN (${sourcePlaceholders})`,
    ).run(group.targetConversationId, ...group.sourceConversationIds);
  }
}

// Pending compaction batches are hidden prepared work keyed to per-conversation
// context ordinals and source projection fingerprints. A lane merge rewrites
// conversation ids and resequences context items, which invalidates every batch
// in the lane (sources and target alike), so the repair drops them. Nodes are
// deleted before batches so the delete order is valid even without cascades;
// node link rows cascade off pending_summary_nodes.
function deleteInvalidatedPendingCompactionState(db: DatabaseSync, group: SafeGroup): void {
  if (!hasTable(db, "pending_compaction_batches")) {
    return;
  }
  const idPlaceholders = placeholders(group.orderedConversationIds);
  db.prepare(
    `DELETE FROM pending_summary_nodes
     WHERE conversation_id IN (${idPlaceholders})`,
  ).run(...group.orderedConversationIds);
  db.prepare(
    `DELETE FROM pending_compaction_batches
     WHERE conversation_id IN (${idPlaceholders})`,
  ).run(...group.orderedConversationIds);
}

function clearSourceStateAndMarkTarget(db: DatabaseSync, group: SafeGroup): void {
  const sourcePlaceholders = placeholders(group.sourceConversationIds);
  for (const table of [
    "conversation_bootstrap_state",
    "conversation_compaction_maintenance",
    "conversation_compaction_telemetry",
  ]) {
    if (!hasTable(db, table)) {
      continue;
    }
    db.prepare(
      `DELETE FROM ${quoteSqlIdentifier(table)}
       WHERE conversation_id IN (${sourcePlaceholders})`,
    ).run(...group.sourceConversationIds);
  }

  db.prepare(
    `UPDATE conversations
     SET created_at = (
           SELECT MIN(created_at)
           FROM conversations
           WHERE conversation_id IN (${placeholders(group.orderedConversationIds)})
         ),
         updated_at = datetime('now')
     WHERE conversation_id = ?`,
  ).run(...group.orderedConversationIds, group.targetConversationId);

  db.prepare(
    `INSERT INTO conversation_compaction_maintenance (
       conversation_id,
       pending,
       requested_at,
       reason,
       running,
       updated_at
     ) VALUES (?, 1, datetime('now'), ?, 0, datetime('now'))
     ON CONFLICT(conversation_id) DO UPDATE SET
       pending = 1,
       requested_at = datetime('now'),
       reason = excluded.reason,
       running = 0,
       updated_at = datetime('now')`,
  ).run(group.targetConversationId, ROLLOVER_SPLIT_MAINTENANCE_REASON);
}

function rebuildFtsTables(db: DatabaseSync): void {
  if (hasTable(db, "messages_fts")) {
    db.exec(`DELETE FROM messages_fts`);
    const rows = db
      .prepare(`SELECT message_id, content FROM messages ORDER BY message_id ASC`)
      .all() as Array<{ message_id: number; content: string }>;
    const insertMessageFts = db.prepare(`INSERT INTO messages_fts(rowid, content) VALUES (?, ?)`);
    for (const row of rows) {
      const normalizedContent = normalizeMessageContentForFullTextIndex(row.content);
      if (normalizedContent) {
        insertMessageFts.run(row.message_id, normalizedContent);
      }
    }
  }
  if (hasTable(db, "summaries_fts")) {
    db.exec(`DELETE FROM summaries_fts`);
    db.exec(`INSERT INTO summaries_fts(summary_id, content) SELECT summary_id, content FROM summaries`);
  }
  if (hasTable(db, "summaries_fts_cjk")) {
    db.exec(`DELETE FROM summaries_fts_cjk`);
    db.exec(`INSERT INTO summaries_fts_cjk(summary_id, content) SELECT summary_id, content FROM summaries`);
  }
}

function formatForeignKeyIssueCount(count: number): string {
  return `${count} foreign key issue(s)`;
}

function loadForeignKeyViolationKeys(db: DatabaseSync): string[] {
  const rows = db.prepare(`PRAGMA foreign_key_check`).all() as ForeignKeyViolationRow[];
  return rows
    .map((row) => [row.table ?? "", row.rowid ?? "", row.parent ?? "", row.fkid ?? ""].join("\u0000"))
    .sort();
}

function verifyForeignKeys(db: DatabaseSync, baselineViolations: string[]): string {
  const currentViolations = loadForeignKeyViolationKeys(db);
  if (currentViolations.length === 0) {
    return "clean";
  }

  const baseline = new Set(baselineViolations);
  const newViolations = currentViolations.filter((violation) => !baseline.has(violation));
  if (newViolations.length > 0) {
    return formatForeignKeyIssueCount(currentViolations.length);
  }

  if (currentViolations.length === baselineViolations.length) {
    return `unchanged (${formatForeignKeyIssueCount(currentViolations.length)} pre-existing)`;
  }
  return `improved (${formatForeignKeyIssueCount(currentViolations.length)} remain; no new issues)`;
}

function hasNewForeignKeyViolations(status: string): boolean {
  return (
    status !== "clean" &&
    !status.startsWith("unchanged (") &&
    !status.endsWith("no new issues)")
  );
}

function verifyIntegrity(db: DatabaseSync): string {
  const rows = db.prepare(`PRAGMA integrity_check`).all() as Array<{ integrity_check?: string }>;
  const results = rows.map((row) => row.integrity_check).filter(Boolean);
  return results.length === 1 && results[0] === "ok" ? "ok" : results.join("; ") || "unknown";
}

function assertNoRows(db: DatabaseSync, sql: string, params: SQLInputValue[], message: string): void {
  const rows = db.prepare(sql).all(...params);
  if (rows.length > 0) {
    throw new Error(message);
  }
}

function verifyRepairedTargets(db: DatabaseSync, targetConversationIds: number[]): void {
  if (targetConversationIds.length === 0) {
    return;
  }
  const ids = placeholders(targetConversationIds);
  assertNoRows(
    db,
    `SELECT conversation_id
     FROM messages
     WHERE conversation_id IN (${ids})
     GROUP BY conversation_id
     HAVING COUNT(*) > 0
        AND (MIN(seq) != 1 OR MAX(seq) != COUNT(*) OR COUNT(DISTINCT seq) != COUNT(*))`,
    targetConversationIds,
    "message seq verification failed",
  );
  assertNoRows(
    db,
    `SELECT conversation_id
     FROM context_items
     WHERE conversation_id IN (${ids})
     GROUP BY conversation_id
     HAVING COUNT(*) > 0
        AND (MIN(ordinal) != 0 OR MAX(ordinal) != COUNT(*) - 1 OR COUNT(DISTINCT ordinal) != COUNT(*))`,
    targetConversationIds,
    "context ordinal verification failed",
  );
  assertNoRows(
    db,
    `SELECT ci.conversation_id
     FROM context_items ci
     JOIN messages m ON m.message_id = ci.message_id
     WHERE ci.conversation_id IN (${ids})
       AND ci.item_type = 'message'
       AND m.conversation_id != ci.conversation_id`,
    targetConversationIds,
    "context message reference verification failed",
  );
  assertNoRows(
    db,
    `SELECT ci.conversation_id
     FROM context_items ci
     JOIN summaries s ON s.summary_id = ci.summary_id
     WHERE ci.conversation_id IN (${ids})
       AND ci.item_type = 'summary'
       AND s.conversation_id != ci.conversation_id`,
    targetConversationIds,
    "context summary reference verification failed",
  );
}

function repairSafeGroup(db: DatabaseSync, group: SafeGroup): void {
  deleteInvalidatedPendingCompactionState(db, group);
  reparentMessages(db, group);
  reparentContextItems(db, group);
  reparentSimpleConversationTables(db, group);
  clearSourceStateAndMarkTarget(db, group);
}

export function getRolloverSplitApplyUnavailableReason(databasePath: string): string | null {
  return getFileBackedDatabasePath(databasePath)
    ? null
    : "Rollover split repair requires a file-backed SQLite database so Lossless Claw can create a backup first.";
}

/**
 * Repair every safe rollover split in the database.
 */
export async function applyRolloverSplitRepair(params: {
  db: DatabaseSync;
  databasePath: string;
}): Promise<RolloverSplitApplyResult> {
  const unavailableReason = getRolloverSplitApplyUnavailableReason(params.databasePath);
  if (unavailableReason) {
    return { kind: "unavailable", reason: unavailableReason };
  }

  const before = scanRolloverSplits(params.db);
  if (before.safe.length === 0) {
    return {
      kind: "applied",
      backupPath: "skipped (no safe rollover splits)",
      repairedLanes: 0,
      skippedReviewLanes: before.needsReview.length,
      totals: { ...EMPTY_COUNTS },
      verification: {
        integrity: "not run (no writes)",
        foreignKeys: "not run (no writes)",
      },
    };
  }

  const backupPath = createLcmDatabaseBackup(params.db, {
    databasePath: params.databasePath,
    label: "rollover-split-repair",
  });
  if (!backupPath) {
    return {
      kind: "unavailable",
      reason: "Lossless Claw could not determine a rollover split backup path.",
    };
  }

  const baselineForeignKeyViolations = loadForeignKeyViolationKeys(params.db);
  let verification = { integrity: "unknown", foreignKeys: "unknown" };
  await withDatabaseTransaction(params.db, "BEGIN IMMEDIATE", () => {
    const safeGroups = loadSafeGroups(params.db);
    for (const group of safeGroups) {
      repairSafeGroup(params.db, group);
    }
    rebuildFtsTables(params.db);

    verification = {
      integrity: verifyIntegrity(params.db),
      foreignKeys: verifyForeignKeys(params.db, baselineForeignKeyViolations),
    };
    if (verification.integrity !== "ok") {
      throw new Error(`SQLite integrity_check failed: ${verification.integrity}`);
    }
    if (hasNewForeignKeyViolations(verification.foreignKeys)) {
      throw new Error(`SQLite foreign_key_check failed: ${verification.foreignKeys}`);
    }
    verifyRepairedTargets(
      params.db,
      safeGroups.map((group) => group.targetConversationId),
    );
    if (loadSafeGroups(params.db).length > 0) {
      throw new Error("safe rollover split verification failed: unrepaired safe groups remain");
    }
  });

  return {
    kind: "applied",
    backupPath,
    repairedLanes: before.safe.length,
    skippedReviewLanes: before.needsReview.length,
    totals: before.totals,
    verification,
  };
}
