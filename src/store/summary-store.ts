import type { DatabaseSync } from "node:sqlite";
import { withDatabaseTransaction } from "../transaction-mutex.js";
import { sanitizeFts5Query } from "./fts5-sanitize.js";
import { buildLikeSearchPlan, containsCjk, createFallbackSnippet } from "./full-text-fallback.js";
import { parseUtcTimestamp, parseUtcTimestampOrNull } from "./parse-utc-timestamp.js";
import { buildFtsOrderBy, type SearchSort } from "./full-text-sort.js";

export type SummaryKind = "leaf" | "condensed";
export type ContextItemType = "message" | "summary";

export type CreateSummaryInput = {
  summaryId: string;
  conversationId: number;
  kind: SummaryKind;
  depth?: number;
  content: string;
  tokenCount: number;
  fileIds?: string[];
  earliestAt?: Date;
  latestAt?: Date;
  descendantCount?: number;
  descendantTokenCount?: number;
  sourceMessageTokenCount?: number;
  model?: string;
};

export type SummaryRecord = {
  summaryId: string;
  conversationId: number;
  kind: SummaryKind;
  depth: number;
  content: string;
  tokenCount: number;
  fileIds: string[];
  earliestAt: Date | null;
  latestAt: Date | null;
  descendantCount: number;
  descendantTokenCount: number;
  sourceMessageTokenCount: number;
  model: string;
  createdAt: Date;
};

export type SummarySubtreeNodeRecord = SummaryRecord & {
  depthFromRoot: number;
  parentSummaryId: string | null;
  path: string;
  childCount: number;
};

export type MessageLeafSummaryLinkRecord = {
  messageId: number;
  summaryId: string;
};

export type ContextItemRecord = {
  conversationId: number;
  ordinal: number;
  itemType: ContextItemType;
  messageId: number | null;
  summaryId: string | null;
  createdAt: Date;
};

export type SummarySearchInput = {
  conversationId?: number;
  query: string;
  mode: "regex" | "full_text";
  since?: Date;
  before?: Date;
  limit?: number;
  sort?: SearchSort;
};

export type SummarySearchResult = {
  summaryId: string;
  conversationId: number;
  kind: SummaryKind;
  snippet: string;
  createdAt: Date;
  rank?: number;
};

export type CreateLargeFileInput = {
  fileId: string;
  conversationId: number;
  fileName?: string;
  mimeType?: string;
  byteSize?: number;
  storageUri: string;
  explorationSummary?: string;
};

export type LargeFileRecord = {
  fileId: string;
  conversationId: number;
  fileName: string | null;
  mimeType: string | null;
  byteSize: number | null;
  storageUri: string;
  explorationSummary: string | null;
  createdAt: Date;
};

export type UpsertConversationBootstrapStateInput = {
  conversationId: number;
  sessionFilePath: string;
  lastSeenSize: number;
  lastSeenMtimeMs: number;
  lastProcessedOffset: number;
  lastProcessedEntryHash?: string | null;
};

export type ConversationBootstrapStateRecord = {
  conversationId: number;
  sessionFilePath: string;
  lastSeenSize: number;
  lastSeenMtimeMs: number;
  lastProcessedOffset: number;
  lastProcessedEntryHash: string | null;
  updatedAt: Date;
};

export type TranscriptGcCandidateRecord = {
  messageId: number;
  conversationId: number;
  seq: number;
  toolCallId: string;
  toolName: string | null;
  externalizedFileId: string | null;
  originalByteSize: number | null;
};

// ── DB row shapes (snake_case) ────────────────────────────────────────────────

interface SummaryRow {
  summary_id: string;
  conversation_id: number;
  kind: SummaryKind;
  depth: number;
  content: string;
  token_count: number;
  file_ids: string;
  earliest_at: string | null;
  latest_at: string | null;
  descendant_count: number | null;
  descendant_token_count: number | null;
  source_message_token_count: number | null;
  model: string | null;
  created_at: string;
}

interface SummarySubtreeRow extends SummaryRow {
  depth_from_root: number;
  parent_summary_id: string | null;
  path: string;
  child_count: number | null;
}

interface ContextItemRow {
  conversation_id: number;
  ordinal: number;
  item_type: ContextItemType;
  message_id: number | null;
  summary_id: string | null;
  created_at: string;
}

interface SummarySearchRow {
  summary_id: string;
  conversation_id: number;
  kind: SummaryKind;
  snippet: string;
  rank: number;
  created_at: string;
}

interface MaxOrdinalRow {
  max_ordinal: number;
}

interface DistinctDepthRow {
  depth: number;
}

interface TokenSumRow {
  total: number;
}

interface MessageIdRow {
  message_id: number;
}

interface MaxDepthRow {
  max_depth: number | null;
}

interface MessageLeafSummaryLinkRow {
  message_id: number;
  summary_id: string;
}

interface LargeFileRow {
  file_id: string;
  conversation_id: number;
  file_name: string | null;
  mime_type: string | null;
  byte_size: number | null;
  storage_uri: string;
  exploration_summary: string | null;
  created_at: string;
}

interface ConversationBootstrapStateRow {
  conversation_id: number;
  session_file_path: string;
  last_seen_size: number;
  last_seen_mtime_ms: number;
  last_processed_offset: number;
  last_processed_entry_hash: string | null;
  updated_at: string;
}

const CJK_QUERY_SEGMENT_RE =
  /[\u2E80-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\uAC00-\uD7AF\u3040-\u309F\u30A0-\u30FF]+/g;
const LATIN_QUERY_TOKEN_RE = /[a-zA-Z0-9][\w./-]*/g;
interface TranscriptGcCandidateRow {
  message_id: number;
  conversation_id: number;
  seq: number;
  tool_call_id: string | null;
  tool_name: string | null;
  metadata: string | null;
}
// ── Row mappers ───────────────────────────────────────────────────────────────

function toSummaryRecord(row: SummaryRow): SummaryRecord {
  let fileIds: string[] = [];
  try {
    fileIds = JSON.parse(row.file_ids);
  } catch {
    // ignore malformed JSON
  }
  return {
    summaryId: row.summary_id,
    conversationId: row.conversation_id,
    kind: row.kind,
    depth: row.depth,
    content: row.content,
    tokenCount: row.token_count,
    fileIds,
    earliestAt: parseUtcTimestampOrNull(row.earliest_at),
    latestAt: parseUtcTimestampOrNull(row.latest_at),
    descendantCount:
      typeof row.descendant_count === "number" &&
      Number.isFinite(row.descendant_count) &&
      row.descendant_count >= 0
        ? Math.floor(row.descendant_count)
        : 0,
    descendantTokenCount:
      typeof row.descendant_token_count === "number" &&
      Number.isFinite(row.descendant_token_count) &&
      row.descendant_token_count >= 0
        ? Math.floor(row.descendant_token_count)
        : 0,
    sourceMessageTokenCount:
      typeof row.source_message_token_count === "number" &&
      Number.isFinite(row.source_message_token_count) &&
      row.source_message_token_count >= 0
        ? Math.floor(row.source_message_token_count)
        : 0,
    model: typeof row.model === "string" ? row.model : "unknown",
    createdAt: parseUtcTimestamp(row.created_at),
  };
}

function toContextItemRecord(row: ContextItemRow): ContextItemRecord {
  return {
    conversationId: row.conversation_id,
    ordinal: row.ordinal,
    itemType: row.item_type,
    messageId: row.message_id,
    summaryId: row.summary_id,
    createdAt: parseUtcTimestamp(row.created_at),
  };
}

function toSearchResult(row: SummarySearchRow): SummarySearchResult {
  return {
    summaryId: row.summary_id,
    conversationId: row.conversation_id,
    kind: row.kind,
    snippet: row.snippet,
    createdAt: parseUtcTimestamp(row.created_at),
    rank: row.rank,
  };
}

function toLargeFileRecord(row: LargeFileRow): LargeFileRecord {
  return {
    fileId: row.file_id,
    conversationId: row.conversation_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    storageUri: row.storage_uri,
    explorationSummary: row.exploration_summary,
    createdAt: parseUtcTimestamp(row.created_at),
  };
}

function toConversationBootstrapStateRecord(
  row: ConversationBootstrapStateRow,
): ConversationBootstrapStateRecord {
  return {
    conversationId: row.conversation_id,
    sessionFilePath: row.session_file_path,
    lastSeenSize: row.last_seen_size,
    lastSeenMtimeMs: row.last_seen_mtime_ms,
    lastProcessedOffset: row.last_processed_offset,
    lastProcessedEntryHash: row.last_processed_entry_hash,
    updatedAt: parseUtcTimestamp(row.updated_at),
  };
}

function toTranscriptGcCandidateRecord(
  row: TranscriptGcCandidateRow,
): TranscriptGcCandidateRecord | null {
  if (typeof row.tool_call_id !== "string" || row.tool_call_id.length === 0) {
    return null;
  }

  let metadata: Record<string, unknown> | null = null;
  try {
    metadata =
      typeof row.metadata === "string" && row.metadata.length > 0
        ? (JSON.parse(row.metadata) as Record<string, unknown>)
        : null;
  } catch {
    metadata = null;
  }

  if (!metadata || metadata.toolOutputExternalized !== true) {
    return null;
  }

  return {
    messageId: row.message_id,
    conversationId: row.conversation_id,
    seq: row.seq,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    externalizedFileId:
      typeof metadata.externalizedFileId === "string" ? metadata.externalizedFileId : null,
    originalByteSize:
      typeof metadata.originalByteSize === "number" && Number.isFinite(metadata.originalByteSize)
        ? Math.max(0, Math.floor(metadata.originalByteSize))
        : null,
  };
}

// ── SummaryStore ──────────────────────────────────────────────────────────────

export class SummaryStore {
  private readonly fts5Available: boolean;

  constructor(
    private db: DatabaseSync,
    options?: { fts5Available?: boolean },
  ) {
    this.fts5Available = options?.fts5Available ?? true;
  }

  // ── Summary CRUD ──────────────────────────────────────────────────────────

  async insertSummary(input: CreateSummaryInput): Promise<SummaryRecord> {
    const fileIds = JSON.stringify(input.fileIds ?? []);
    const earliestAt = input.earliestAt instanceof Date ? input.earliestAt.toISOString() : null;
    const latestAt = input.latestAt instanceof Date ? input.latestAt.toISOString() : null;
    const descendantCount =
      typeof input.descendantCount === "number" &&
      Number.isFinite(input.descendantCount) &&
      input.descendantCount >= 0
        ? Math.floor(input.descendantCount)
        : 0;
    const descendantTokenCount =
      typeof input.descendantTokenCount === "number" &&
      Number.isFinite(input.descendantTokenCount) &&
      input.descendantTokenCount >= 0
        ? Math.floor(input.descendantTokenCount)
        : 0;
    const sourceMessageTokenCount =
      typeof input.sourceMessageTokenCount === "number" &&
      Number.isFinite(input.sourceMessageTokenCount) &&
      input.sourceMessageTokenCount >= 0
        ? Math.floor(input.sourceMessageTokenCount)
        : 0;
    const depth =
      typeof input.depth === "number" && Number.isFinite(input.depth) && input.depth >= 0
        ? Math.floor(input.depth)
        : input.kind === "leaf"
          ? 0
          : 1;

    this.db
      .prepare(
        `INSERT INTO summaries (
          summary_id,
          conversation_id,
          kind,
          depth,
          content,
          token_count,
          file_ids,
          earliest_at,
          latest_at,
          descendant_count,
          descendant_token_count,
          source_message_token_count,
          model
        )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.summaryId,
        input.conversationId,
        input.kind,
        depth,
        input.content,
        input.tokenCount,
        fileIds,
        earliestAt,
        latestAt,
        descendantCount,
        descendantTokenCount,
        sourceMessageTokenCount,
        input.model ?? "unknown",
      );

    const row = this.db
      .prepare(
        `SELECT summary_id, conversation_id, kind, depth, content, token_count, file_ids,
                earliest_at, latest_at, descendant_count, created_at
                , descendant_token_count, source_message_token_count, model
       FROM summaries WHERE summary_id = ?`,
      )
      .get(input.summaryId) as unknown as SummaryRow;

    // Index in FTS5 as best-effort; compaction flow must continue even if
    // FTS indexing fails for any reason.
    if (!this.fts5Available) {
      return toSummaryRecord(row);
    }

    try {
      this.db
        .prepare(`INSERT INTO summaries_fts(summary_id, content) VALUES (?, ?)`)
        .run(input.summaryId, input.content);
    } catch {
      // FTS indexing failed — search won't find this summary but
      // compaction and assembly will still work correctly.
    }

    // Also index into the CJK trigram FTS table for CJK substring search.
    try {
      this.db
        .prepare(
          `INSERT INTO summaries_fts_cjk(summary_id, content) VALUES (?, ?)`,
        )
        .run(input.summaryId, input.content);
    } catch {
      // CJK trigram FTS table may not exist yet (pre-migration); ignore.
    }

    return toSummaryRecord(row);
  }

  async getSummary(summaryId: string): Promise<SummaryRecord | null> {
    const row = this.db
      .prepare(
        `SELECT summary_id, conversation_id, kind, depth, content, token_count, file_ids,
                earliest_at, latest_at, descendant_count, created_at
                , descendant_token_count, source_message_token_count, model
       FROM summaries WHERE summary_id = ?`,
      )
      .get(summaryId) as unknown as SummaryRow | undefined;
    return row ? toSummaryRecord(row) : null;
  }

  async getSummariesByConversation(conversationId: number): Promise<SummaryRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT summary_id, conversation_id, kind, depth, content, token_count, file_ids,
                earliest_at, latest_at, descendant_count, created_at
                , descendant_token_count, source_message_token_count, model
       FROM summaries
       WHERE conversation_id = ?
       ORDER BY created_at`,
      )
      .all(conversationId) as unknown as SummaryRow[];
    return rows.map(toSummaryRecord);
  }

  // ── Lineage ───────────────────────────────────────────────────────────────

  async linkSummaryToMessages(summaryId: string, messageIds: number[]): Promise<void> {
    if (messageIds.length === 0) {
      return;
    }

    const stmt = this.db.prepare(
      `INSERT INTO summary_messages (summary_id, message_id, ordinal)
       VALUES (?, ?, ?)
       ON CONFLICT (summary_id, message_id) DO NOTHING`,
    );

    for (let idx = 0; idx < messageIds.length; idx++) {
      stmt.run(summaryId, messageIds[idx], idx);
    }
  }

  async linkSummaryToParents(summaryId: string, parentSummaryIds: string[]): Promise<void> {
    if (parentSummaryIds.length === 0) {
      return;
    }

    const stmt = this.db.prepare(
      `INSERT INTO summary_parents (summary_id, parent_summary_id, ordinal)
       VALUES (?, ?, ?)
       ON CONFLICT (summary_id, parent_summary_id) DO NOTHING`,
    );

    for (let idx = 0; idx < parentSummaryIds.length; idx++) {
      stmt.run(summaryId, parentSummaryIds[idx], idx);
    }
  }

  async getSummaryMessages(summaryId: string): Promise<number[]> {
    const rows = this.db
      .prepare(
        `SELECT message_id FROM summary_messages
       WHERE summary_id = ?
       ORDER BY ordinal`,
      )
      .all(summaryId) as unknown as MessageIdRow[];
    return rows.map((r) => r.message_id);
  }

  /**
   * Return the deepest persisted summary depth for a conversation.
   */
  async getConversationMaxSummaryDepth(conversationId: number): Promise<number | null> {
    const row = this.db
      .prepare(
        `SELECT MAX(depth) AS max_depth
         FROM summaries
         WHERE conversation_id = ?`,
      )
      .get(conversationId) as unknown as MaxDepthRow | undefined;
    return typeof row?.max_depth === "number" ? row.max_depth : null;
  }

  /**
   * Resolve raw message hits back to their linked leaf summaries.
   */
  async getLeafSummaryLinksForMessageIds(
    conversationId: number,
    messageIds: number[],
  ): Promise<MessageLeafSummaryLinkRecord[]> {
    const normalizedMessageIds = Array.from(
      new Set(
        messageIds.filter(
          (messageId): messageId is number => Number.isInteger(messageId) && messageId > 0,
        ),
      ),
    );
    if (normalizedMessageIds.length === 0) {
      return [];
    }

    const placeholders = normalizedMessageIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT sm.message_id, sm.summary_id
         FROM summary_messages sm
         JOIN summaries s ON s.summary_id = sm.summary_id
         WHERE s.conversation_id = ?
           AND s.kind = 'leaf'
           AND sm.message_id IN (${placeholders})
         ORDER BY sm.ordinal ASC, s.created_at ASC`,
      )
      .all(conversationId, ...normalizedMessageIds) as unknown as MessageLeafSummaryLinkRow[];

    const summaryIdsByMessageId = new Map<number, string[]>();
    for (const row of rows) {
      const existing = summaryIdsByMessageId.get(row.message_id) ?? [];
      if (!existing.includes(row.summary_id)) {
        existing.push(row.summary_id);
        summaryIdsByMessageId.set(row.message_id, existing);
      }
    }

    const orderedLinks: MessageLeafSummaryLinkRecord[] = [];
    for (const messageId of normalizedMessageIds) {
      for (const summaryId of summaryIdsByMessageId.get(messageId) ?? []) {
        orderedLinks.push({
          messageId,
          summaryId,
        });
      }
    }
    return orderedLinks;
  }
  /**
   * Return summarized tool-result messages that are safe candidates for
   * transcript GC because they are no longer present as raw context items.
   */
  async listTranscriptGcCandidates(
    conversationId: number,
    options?: { limit?: number },
  ): Promise<TranscriptGcCandidateRecord[]> {
    const limit =
      typeof options?.limit === "number" && Number.isFinite(options.limit) && options.limit > 0
        ? Math.max(1, Math.floor(options.limit))
        : 25;

    const rows = this.db
      .prepare(
        `SELECT
           m.message_id,
           m.conversation_id,
           m.seq,
           mp.tool_call_id,
           mp.tool_name,
           mp.metadata
         FROM messages m
         JOIN message_parts mp
           ON mp.message_id = m.message_id
         WHERE m.conversation_id = ?
           AND m.role = 'tool'
           AND mp.part_type = 'tool'
           AND mp.tool_call_id IS NOT NULL
           AND mp.tool_call_id != ''
           AND EXISTS (
             SELECT 1
             FROM summary_messages sm
             WHERE sm.message_id = m.message_id
           )
           AND NOT EXISTS (
             SELECT 1
             FROM context_items ci
             WHERE ci.conversation_id = m.conversation_id
               AND ci.item_type = 'message'
               AND ci.message_id = m.message_id
           )
         ORDER BY m.seq ASC, mp.ordinal ASC`,
      )
      .all(conversationId) as unknown as TranscriptGcCandidateRow[];

    const seenMessageIds = new Set<number>();
    const candidates: TranscriptGcCandidateRecord[] = [];
    for (const row of rows) {
      if (seenMessageIds.has(row.message_id)) {
        continue;
      }
      const candidate = toTranscriptGcCandidateRecord(row);
      if (!candidate) {
        continue;
      }
      seenMessageIds.add(candidate.messageId);
      candidates.push(candidate);
      if (candidates.length >= limit) {
        break;
      }
    }

    return candidates;
  }
  async getSummaryChildren(parentSummaryId: string): Promise<SummaryRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT s.summary_id, s.conversation_id, s.kind, s.depth, s.content, s.token_count,
                s.file_ids, s.earliest_at, s.latest_at, s.descendant_count, s.created_at
                , s.descendant_token_count, s.source_message_token_count, s.model
       FROM summaries s
       JOIN summary_parents sp ON sp.summary_id = s.summary_id
       WHERE sp.parent_summary_id = ?
       ORDER BY sp.ordinal`,
      )
      .all(parentSummaryId) as unknown as SummaryRow[];
    return rows.map(toSummaryRecord);
  }

  // NOTE: historical naming is confusing here.
  // getSummaryParents(summaryId) returns the source summaries compacted into
  // `summaryId`. Expansion should use this direction for replay.
  async getSummaryParents(summaryId: string): Promise<SummaryRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT s.summary_id, s.conversation_id, s.kind, s.depth, s.content, s.token_count,
                s.file_ids, s.earliest_at, s.latest_at, s.descendant_count, s.created_at
                , s.descendant_token_count, s.source_message_token_count, s.model
       FROM summaries s
       JOIN summary_parents sp ON sp.parent_summary_id = s.summary_id
       WHERE sp.summary_id = ?
       ORDER BY sp.ordinal`,
      )
      .all(summaryId) as unknown as SummaryRow[];
    return rows.map(toSummaryRecord);
  }

  async getSummarySubtree(summaryId: string): Promise<SummarySubtreeNodeRecord[]> {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE subtree(summary_id, parent_summary_id, depth_from_root, path) AS (
           SELECT ?, NULL, 0, ''
           UNION ALL
           SELECT
             sp.summary_id,
             sp.parent_summary_id,
             subtree.depth_from_root + 1,
             CASE
               WHEN subtree.path = '' THEN printf('%04d', sp.ordinal)
               ELSE subtree.path || '.' || printf('%04d', sp.ordinal)
             END
           FROM summary_parents sp
           JOIN subtree ON sp.parent_summary_id = subtree.summary_id
         )
         SELECT
           s.summary_id,
           s.conversation_id,
           s.kind,
           s.depth,
           s.content,
           s.token_count,
           s.file_ids,
           s.earliest_at,
           s.latest_at,
           s.descendant_count,
           s.descendant_token_count,
           s.source_message_token_count,
           s.model,
           s.created_at,
           subtree.depth_from_root,
           subtree.parent_summary_id,
           subtree.path,
           (
             SELECT COUNT(*) FROM summary_parents sp2
             WHERE sp2.parent_summary_id = s.summary_id
           ) AS child_count
         FROM subtree
         JOIN summaries s ON s.summary_id = subtree.summary_id
         ORDER BY subtree.depth_from_root ASC, subtree.path ASC, s.created_at ASC`,
      )
      .all(summaryId) as unknown as SummarySubtreeRow[];

    const seen = new Set<string>();
    const output: SummarySubtreeNodeRecord[] = [];
    for (const row of rows) {
      if (seen.has(row.summary_id)) {
        continue;
      }
      seen.add(row.summary_id);
      output.push({
        ...toSummaryRecord(row),
        depthFromRoot: Math.max(0, Math.floor(row.depth_from_root ?? 0)),
        parentSummaryId: row.parent_summary_id ?? null,
        path: typeof row.path === "string" ? row.path : "",
        childCount:
          typeof row.child_count === "number" && Number.isFinite(row.child_count)
            ? Math.max(0, Math.floor(row.child_count))
            : 0,
      });
    }
    return output;
  }

  // ── Context items ─────────────────────────────────────────────────────────

  async getContextItems(conversationId: number): Promise<ContextItemRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT conversation_id, ordinal, item_type, message_id, summary_id, created_at
       FROM context_items
       WHERE conversation_id = ?
       ORDER BY ordinal`,
      )
      .all(conversationId) as unknown as ContextItemRow[];
    return rows.map(toContextItemRecord);
  }

  async getDistinctDepthsInContext(
    conversationId: number,
    options?: { maxOrdinalExclusive?: number },
  ): Promise<number[]> {
    const maxOrdinalExclusive = options?.maxOrdinalExclusive;
    const useOrdinalBound =
      typeof maxOrdinalExclusive === "number" &&
      Number.isFinite(maxOrdinalExclusive) &&
      maxOrdinalExclusive !== Infinity;

    const sql = useOrdinalBound
      ? `SELECT DISTINCT s.depth
         FROM context_items ci
         JOIN summaries s ON s.summary_id = ci.summary_id
         WHERE ci.conversation_id = ?
           AND ci.item_type = 'summary'
           AND ci.ordinal < ?
         ORDER BY s.depth ASC`
      : `SELECT DISTINCT s.depth
         FROM context_items ci
         JOIN summaries s ON s.summary_id = ci.summary_id
         WHERE ci.conversation_id = ?
           AND ci.item_type = 'summary'
         ORDER BY s.depth ASC`;

    const rows = useOrdinalBound
      ? (this.db
          .prepare(sql)
          .all(conversationId, Math.floor(maxOrdinalExclusive)) as unknown as DistinctDepthRow[])
      : (this.db.prepare(sql).all(conversationId) as unknown as DistinctDepthRow[]);

    return rows.map((row) => row.depth);
  }

  /** Serialize a multi-step summary write sequence on the shared database. */
  async withTransaction<T>(operation: () => Promise<T> | T): Promise<T> {
    return withDatabaseTransaction(this.db, "BEGIN", operation);
  }

  async pruneForNewSession(conversationId: number, retainDepth: number): Promise<void> {
    if (Number.isFinite(retainDepth) && retainDepth < 0) {
      return;
    }

    this.db
      .prepare(
        `DELETE FROM context_items
       WHERE conversation_id = ?
         AND item_type = 'message'`,
      )
      .run(conversationId);

    if (!Number.isFinite(retainDepth)) {
      this.db
        .prepare(
          `DELETE FROM context_items
         WHERE conversation_id = ?
           AND item_type = 'summary'`,
        )
        .run(conversationId);
      return;
    }

    this.db
      .prepare(
        `DELETE FROM context_items
       WHERE conversation_id = ?
         AND item_type = 'summary'
         AND summary_id IN (
           SELECT summary_id
           FROM summaries
           WHERE conversation_id = ?
             AND depth < ?
         )`,
      )
      .run(conversationId, conversationId, Math.floor(retainDepth));
  }

  async appendContextMessage(conversationId: number, messageId: number): Promise<void> {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(ordinal), -1) AS max_ordinal
       FROM context_items WHERE conversation_id = ?`,
      )
      .get(conversationId) as unknown as MaxOrdinalRow;

    this.db
      .prepare(
        `INSERT INTO context_items (conversation_id, ordinal, item_type, message_id)
       VALUES (?, ?, 'message', ?)`,
      )
      .run(conversationId, row.max_ordinal + 1, messageId);
  }

  async appendContextMessages(conversationId: number, messageIds: number[]): Promise<void> {
    if (messageIds.length === 0) {
      return;
    }

    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(ordinal), -1) AS max_ordinal
       FROM context_items WHERE conversation_id = ?`,
      )
      .get(conversationId) as unknown as MaxOrdinalRow;
    const baseOrdinal = row.max_ordinal + 1;

    const stmt = this.db.prepare(
      `INSERT INTO context_items (conversation_id, ordinal, item_type, message_id)
       VALUES (?, ?, 'message', ?)`,
    );
    for (let idx = 0; idx < messageIds.length; idx++) {
      stmt.run(conversationId, baseOrdinal + idx, messageIds[idx]);
    }
  }

  async appendContextSummary(conversationId: number, summaryId: string): Promise<void> {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(ordinal), -1) AS max_ordinal
       FROM context_items WHERE conversation_id = ?`,
      )
      .get(conversationId) as unknown as MaxOrdinalRow;

    this.db
      .prepare(
        `INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id)
       VALUES (?, ?, 'summary', ?)`,
      )
      .run(conversationId, row.max_ordinal + 1, summaryId);
  }

  async replaceContextRangeWithSummary(input: {
    conversationId: number;
    startOrdinal: number;
    endOrdinal: number;
    summaryId: string;
  }): Promise<void> {
    await this.withTransaction(() => {
      this.replaceContextRangeWithSummaryInTransaction(input);
    });
  }

  // Update the context slice in-place while the caller already owns the txn.
  private replaceContextRangeWithSummaryInTransaction(input: {
    conversationId: number;
    startOrdinal: number;
    endOrdinal: number;
    summaryId: string;
  }): void {
    const { conversationId, startOrdinal, endOrdinal, summaryId } = input;

    // 1. Delete context items in the range [startOrdinal, endOrdinal]
    this.db
      .prepare(
        `DELETE FROM context_items
         WHERE conversation_id = ?
           AND ordinal >= ?
           AND ordinal <= ?`,
      )
      .run(conversationId, startOrdinal, endOrdinal);

    // 2. Insert the replacement summary item at startOrdinal
    this.db
      .prepare(
        `INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id)
         VALUES (?, ?, 'summary', ?)`,
      )
      .run(conversationId, startOrdinal, summaryId);

    // 3. Resequence all ordinals to maintain contiguity (no gaps).
    //    Pre-compute ranks from a SELECT (safe snapshot), then apply
    //    via 2-pass UPDATE loop using negative temps to avoid UNIQUE
    //    constraint violations. The SELECT reads post-delete/insert
    //    state and provides a consistent snapshot for resequencing.
    const items = this.db
      .prepare(
        `SELECT ordinal FROM context_items
         WHERE conversation_id = ?
         ORDER BY ordinal`,
      )
      .all(conversationId) as unknown as { ordinal: number }[];

    if (items.length > 0 && items.some((item, i) => item.ordinal !== i)) {
      const updateStmt = this.db.prepare(
        `UPDATE context_items SET ordinal = ?
         WHERE conversation_id = ? AND ordinal = ?`,
      );
      for (let i = 0; i < items.length; i++) {
        updateStmt.run(-(i + 1), conversationId, items[i].ordinal);
      }
      for (let i = 0; i < items.length; i++) {
        updateStmt.run(i, conversationId, -(i + 1));
      }
    }
  }

  async getContextTokenCount(conversationId: number): Promise<number> {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(token_count), 0) AS total
       FROM (
         SELECT m.token_count
         FROM context_items ci
         JOIN messages m ON m.message_id = ci.message_id
         WHERE ci.conversation_id = ?
           AND ci.item_type = 'message'

         UNION ALL

         SELECT s.token_count
         FROM context_items ci
         JOIN summaries s ON s.summary_id = ci.summary_id
         WHERE ci.conversation_id = ?
           AND ci.item_type = 'summary'
       ) sub`,
      )
      .get(conversationId, conversationId) as unknown as TokenSumRow;
    return row?.total ?? 0;
  }

  // ── Search ────────────────────────────────────────────────────────────────

  async searchSummaries(input: SummarySearchInput): Promise<SummarySearchResult[]> {
    const limit = input.limit ?? 50;

    if (input.mode === "full_text") {
      // FTS5 unicode61 cannot segment CJK ideographs, so CJK queries route
      // through the trigram FTS table first, then fall back to LIKE with OR
      // semantics (instead of the original AND logic which fails when the
      // user's phrasing doesn't exactly match the summary text).
      if (containsCjk(input.query)) {
        const cjkSegments = this.extractCjkSegments(input.query);
        const hasShortCjkSegment = cjkSegments.some((segment) => segment.length < 3);
        if (!hasShortCjkSegment) {
          try {
            const trigramResults = this.searchCjkTrigram(
              input.query,
              limit,
              input.conversationId,
              input.since,
              input.before,
            );
            if (trigramResults.length > 0) {
              return trigramResults;
            }
          } catch {
            // trigram table may not exist; fall through to LIKE OR
          }
        }
        return this.searchLikeCjk(
          input.query,
          limit,
          input.conversationId,
          input.since,
          input.before,
        );
      }
      if (this.fts5Available) {
        try {
          return this.searchFullText(
            input.query,
            limit,
            input.conversationId,
            input.since,
            input.before,
            input.sort,
          );
        } catch {
          return this.searchLike(
            input.query,
            limit,
            input.conversationId,
            input.since,
            input.before,
          );
        }
      }
      return this.searchLike(input.query, limit, input.conversationId, input.since, input.before);
    }
    return this.searchRegex(input.query, limit, input.conversationId, input.since, input.before);
  }

  private searchFullText(
    query: string,
    limit: number,
    conversationId?: number,
    since?: Date,
    before?: Date,
    sort?: SearchSort,
  ): SummarySearchResult[] {
    const where: string[] = ["summaries_fts MATCH ?"];
    const args: Array<string | number> = [sanitizeFts5Query(query)];
    if (conversationId != null) {
      where.push("s.conversation_id = ?");
      args.push(conversationId);
    }
    if (since) {
      where.push("julianday(s.created_at) >= julianday(?)");
      args.push(since.toISOString());
    }
    if (before) {
      where.push("julianday(s.created_at) < julianday(?)");
      args.push(before.toISOString());
    }
    args.push(limit);
    const orderBy = buildFtsOrderBy(sort, "s.created_at");

    const sql = `SELECT
         summaries_fts.summary_id,
         s.conversation_id,
         s.kind,
         snippet(summaries_fts, 1, '', '', '...', 32) AS snippet,
         rank,
         s.created_at
       FROM summaries_fts
       JOIN summaries s ON s.summary_id = summaries_fts.summary_id
       WHERE ${where.join(" AND ")}
       ORDER BY ${orderBy}
       LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args) as unknown as SummarySearchRow[];
    return rows.map(toSearchResult);
  }

  private searchLike(
    query: string,
    limit: number,
    conversationId?: number,
    since?: Date,
    before?: Date,
  ): SummarySearchResult[] {
    const plan = buildLikeSearchPlan("content", query);
    if (plan.terms.length === 0) {
      return [];
    }

    const where: string[] = [...plan.where];
    const args: Array<string | number> = [...plan.args];
    if (conversationId != null) {
      where.push("conversation_id = ?");
      args.push(conversationId);
    }
    if (since) {
      where.push("julianday(created_at) >= julianday(?)");
      args.push(since.toISOString());
    }
    if (before) {
      where.push("julianday(created_at) < julianday(?)");
      args.push(before.toISOString());
    }
    args.push(limit);

    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT summary_id, conversation_id, kind, depth, content, token_count, file_ids,
                earliest_at, latest_at, descendant_count, descendant_token_count,
                source_message_token_count, model, created_at
         FROM summaries
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...args) as unknown as SummaryRow[];

    return rows.map((row) => ({
      summaryId: row.summary_id,
      conversationId: row.conversation_id,
      kind: row.kind,
      snippet: createFallbackSnippet(row.content, plan.terms),
      createdAt: parseUtcTimestamp(row.created_at),
      rank: 0,
    }));
  }

  private extractCjkSegments(query: string): string[] {
    return query.match(CJK_QUERY_SEGMENT_RE) ?? [];
  }

  private extractLatinTokens(query: string): string[] {
    const tokens = query.match(LATIN_QUERY_TOKEN_RE) ?? [];
    return [...new Set(tokens.map((token) => token.toLowerCase()))];
  }

  private escapeLikeTerm(term: string): string {
    return term.replace(/([\\%_])/g, "\\$1");
  }

  // ── CJK trigram FTS search ──────────────────────────────────────────────
  // Each CJK segment of 3+ chars is split into overlapping 4-char chunks for
  // trigram MATCH with OR semantics within the segment. Segment groups are
  // combined with AND, and Latin tokens are applied as LIKE filters so mixed
  // queries still require every part of the user's intent.

  /**
   * Split a CJK string into overlapping chunks of `size` characters.
   * E.g. "端到端测试结果" with size=4 →
   *   ["端到端测", "到端测试", "端测试结", "测试结果"]
   */
  private splitCjkChunks(text: string, size: number): string[] {
    const chunks: string[] = [];
    for (let i = 0; i <= text.length - size; i++) {
      const chunk = text.slice(i, i + size);
      if (!chunks.includes(chunk)) {
        chunks.push(chunk);
      }
    }
    return chunks;
  }

  private searchCjkTrigram(
    query: string,
    limit: number,
    conversationId?: number,
    since?: Date,
    before?: Date,
  ): SummarySearchResult[] {
    const cjkSegments = this.extractCjkSegments(query).filter((segment) => segment.length >= 3);
    if (cjkSegments.length === 0) {
      return [];
    }
    const latinTokens = this.extractLatinTokens(query);

    // Build one OR group per CJK segment, then require every segment group and
    // every Latin token to match so mixed queries preserve full-intent search.
    const cjkGroups: string[] = [];
    for (const segment of cjkSegments) {
      const segmentTerms =
        segment.length <= 4 ? [segment] : this.splitCjkChunks(segment, 4);
      const groupExpr = [...new Set(segmentTerms)]
        .map((term) => `"${term.replace(/"/g, '""')}"`)
        .join(" OR ");
      cjkGroups.push(`(${groupExpr})`);
    }

    const where: string[] = ["summaries_fts_cjk MATCH ?"];
    const args: Array<string | number> = [cjkGroups.join(" AND ")];
    for (const token of latinTokens) {
      where.push("LOWER(s.content) LIKE ? ESCAPE '\\'");
      args.push(`%${this.escapeLikeTerm(token)}%`);
    }
    if (conversationId != null) {
      where.push("s.conversation_id = ?");
      args.push(conversationId);
    }
    if (since) {
      where.push("julianday(s.created_at) >= julianday(?)");
      args.push(since.toISOString());
    }
    if (before) {
      where.push("julianday(s.created_at) < julianday(?)");
      args.push(before.toISOString());
    }
    args.push(limit);

    const sql = `SELECT
         f.summary_id,
         s.conversation_id,
         s.kind,
         snippet(summaries_fts_cjk, 1, '', '', '...', 32) AS snippet,
         rank,
         s.created_at
       FROM summaries_fts_cjk f
       JOIN summaries s ON s.summary_id = f.summary_id
       WHERE ${where.join(" AND ")}
       ORDER BY rank
       LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args) as unknown as SummarySearchRow[];
    return rows.map(toSearchResult);
  }

  // ── CJK LIKE fallback ────────────────────────────────────────────────────
  // When the trigram table is unavailable, split each CJK segment into
  // sliding-window terms so partial matches still work. Terms within a single
  // segment are ORed together, but each segment and Latin token still has to
  // match so mixed queries keep full-intent semantics.

  private searchLikeCjk(
    query: string,
    limit: number,
    conversationId?: number,
    since?: Date,
    before?: Date,
  ): SummarySearchResult[] {
    const cjkSegments = this.extractCjkSegments(query);
    const latinTokens = this.extractLatinTokens(query);
    if (cjkSegments.length === 0 && latinTokens.length === 0) {
      return [];
    }

    const cjkTerms: string[] = [];
    const cjkClauses: string[] = [];
    const cjkArgs: string[] = [];
    for (const segment of cjkSegments) {
      const segmentTerms =
        segment.length === 1
          ? [segment]
          : segment.length === 2
            ? [segment]
            : this.splitCjkChunks(segment, 2);
      const uniqueTerms = [...new Set(segmentTerms)];
      cjkTerms.push(...uniqueTerms);
      cjkClauses.push(
        `(${uniqueTerms.map(() => `LOWER(content) LIKE ? ESCAPE '\\'`).join(" OR ")})`,
      );
      cjkArgs.push(
        ...uniqueTerms.map((term) => `%${this.escapeLikeTerm(term.toLowerCase())}%`),
      );
    }

    const latinClauses = latinTokens.map(() => `LOWER(content) LIKE ? ESCAPE '\\'`);
    const latinArgs = latinTokens.map((token) => `%${this.escapeLikeTerm(token)}%`);

    const where: string[] = [...cjkClauses, ...latinClauses];
    const args: Array<string | number> = [...cjkArgs, ...latinArgs];
    if (conversationId != null) {
      where.push("conversation_id = ?");
      args.push(conversationId);
    }
    if (since) {
      where.push("julianday(created_at) >= julianday(?)");
      args.push(since.toISOString());
    }
    if (before) {
      where.push("julianday(created_at) < julianday(?)");
      args.push(before.toISOString());
    }
    args.push(limit);

    const rows = this.db
      .prepare(
        `SELECT summary_id, conversation_id, kind, depth, content, token_count, file_ids,
                earliest_at, latest_at, descendant_count, descendant_token_count,
                source_message_token_count, model, created_at
         FROM summaries
         WHERE ${where.join(" AND ")}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...args) as unknown as SummaryRow[];

    const snippetTerms = cjkTerms.length > 0 ? [...new Set([...cjkTerms, ...latinTokens])] : latinTokens;
    return rows.map((row) => ({
      summaryId: row.summary_id,
      conversationId: row.conversation_id,
      kind: row.kind,
      snippet: createFallbackSnippet(row.content, snippetTerms),
      createdAt: new Date(row.created_at),
      rank: 0,
    }));
  }

  private searchRegex(
    pattern: string,
    limit: number,
    conversationId?: number,
    since?: Date,
    before?: Date,
  ): SummarySearchResult[] {
    // Guard against ReDoS: reject patterns with nested quantifiers or excessive length
    if (pattern.length > 500 || /(\+|\*|\?)\)(\+|\*|\?|\{\d)/.test(pattern)) {
      return [];
    }
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch {
      return [];
    }

    const where: string[] = [];
    const args: Array<string | number> = [];
    if (conversationId != null) {
      where.push("conversation_id = ?");
      args.push(conversationId);
    }
    if (since) {
      where.push("julianday(created_at) >= julianday(?)");
      args.push(since.toISOString());
    }
    if (before) {
      where.push("julianday(created_at) < julianday(?)");
      args.push(before.toISOString());
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT summary_id, conversation_id, kind, depth, content, token_count, file_ids,
                earliest_at, latest_at, descendant_count, descendant_token_count,
                source_message_token_count, model, created_at
         FROM summaries
         ${whereClause}
         ORDER BY created_at DESC`,
      )
      .all(...args) as unknown as SummaryRow[];

    const MAX_ROW_SCAN = 10_000;
    const results: SummarySearchResult[] = [];
    let scanned = 0;
    for (const row of rows) {
      if (results.length >= limit || scanned >= MAX_ROW_SCAN) {
        break;
      }
      scanned++;
      const match = re.exec(row.content);
      if (match) {
        results.push({
          summaryId: row.summary_id,
          conversationId: row.conversation_id,
          kind: row.kind,
          snippet: match[0],
          createdAt: parseUtcTimestamp(row.created_at),
          rank: 0,
        });
      }
    }
    return results;
  }

  // ── Large files ───────────────────────────────────────────────────────────

  async insertLargeFile(input: CreateLargeFileInput): Promise<LargeFileRecord> {
    this.db
      .prepare(
        `INSERT INTO large_files (file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.fileId,
        input.conversationId,
        input.fileName ?? null,
        input.mimeType ?? null,
        input.byteSize ?? null,
        input.storageUri,
        input.explorationSummary ?? null,
      );

    const row = this.db
      .prepare(
        `SELECT file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary, created_at
       FROM large_files WHERE file_id = ?`,
      )
      .get(input.fileId) as unknown as LargeFileRow;

    return toLargeFileRecord(row);
  }

  async getLargeFile(fileId: string): Promise<LargeFileRecord | null> {
    const row = this.db
      .prepare(
        `SELECT file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary, created_at
       FROM large_files WHERE file_id = ?`,
      )
      .get(fileId) as unknown as LargeFileRow | undefined;
    return row ? toLargeFileRecord(row) : null;
  }

  async getLargeFilesByConversation(conversationId: number): Promise<LargeFileRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary, created_at
       FROM large_files
       WHERE conversation_id = ?
       ORDER BY created_at`,
      )
      .all(conversationId) as unknown as LargeFileRow[];
    return rows.map(toLargeFileRecord);
  }

  // ── Bootstrap state ──────────────────────────────────────────────────────

  async getConversationBootstrapState(
    conversationId: number,
  ): Promise<ConversationBootstrapStateRecord | null> {
    const row = this.db
      .prepare(
        `SELECT conversation_id, session_file_path, last_seen_size, last_seen_mtime_ms,
                last_processed_offset, last_processed_entry_hash, updated_at
         FROM conversation_bootstrap_state
         WHERE conversation_id = ?`,
      )
      .get(conversationId) as unknown as ConversationBootstrapStateRow | undefined;
    return row ? toConversationBootstrapStateRecord(row) : null;
  }

  async upsertConversationBootstrapState(
    input: UpsertConversationBootstrapStateInput,
  ): Promise<ConversationBootstrapStateRecord> {
    this.db
      .prepare(
        `INSERT INTO conversation_bootstrap_state (
           conversation_id,
           session_file_path,
           last_seen_size,
           last_seen_mtime_ms,
           last_processed_offset,
           last_processed_entry_hash
         )
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (conversation_id) DO UPDATE SET
           session_file_path = excluded.session_file_path,
           last_seen_size = excluded.last_seen_size,
           last_seen_mtime_ms = excluded.last_seen_mtime_ms,
           last_processed_offset = excluded.last_processed_offset,
           last_processed_entry_hash = excluded.last_processed_entry_hash,
           updated_at = datetime('now')`,
      )
      .run(
        input.conversationId,
        input.sessionFilePath,
        Math.max(0, Math.floor(input.lastSeenSize)),
        Math.max(0, Math.floor(input.lastSeenMtimeMs)),
        Math.max(0, Math.floor(input.lastProcessedOffset)),
        input.lastProcessedEntryHash ?? null,
      );

    const row = this.db
      .prepare(
        `SELECT conversation_id, session_file_path, last_seen_size, last_seen_mtime_ms,
                last_processed_offset, last_processed_entry_hash, updated_at
         FROM conversation_bootstrap_state
         WHERE conversation_id = ?`,
      )
      .get(input.conversationId) as unknown as ConversationBootstrapStateRow;

    return toConversationBootstrapStateRecord(row);
  }
}
