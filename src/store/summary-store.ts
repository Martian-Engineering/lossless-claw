import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import type { DbClient } from "../db/db-interface.js";
import { SqliteClient } from "../db/sqlite-client.js";
import { Dialect, type Backend } from "../db/dialect.js";
import { sanitizeFts5Query } from "./fts5-sanitize.js";
import { sanitizeTsQuery } from "./tsquery-sanitize.js";
import { buildLikeSearchPlan, createFallbackSnippet } from "./full-text-fallback.js";

/** Accept either a DbClient or raw DatabaseSync (auto-wraps the latter). */
function ensureDbClient(db: DbClient | DatabaseSync): DbClient {
  if ('run' in db && typeof (db as DbClient).run === 'function') {
    return db as DbClient;
  }
  return new SqliteClient(db as DatabaseSync);
}

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
  createdAt: Date;
};

export type SummarySubtreeNodeRecord = SummaryRecord & {
  depthFromRoot: number;
  parentSummaryId: string | null;
  path: string;
  childCount: number;
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

// ── Row mappers ───────────────────────────────────────────────────────────────

function safeNonNeg(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

function toSummaryRecord(row: SummaryRow): SummaryRecord {
  let fileIds: string[] = [];
  try { fileIds = JSON.parse(row.file_ids); } catch { /* ignore */ }
  return {
    summaryId: row.summary_id,
    conversationId: row.conversation_id,
    kind: row.kind,
    depth: row.depth,
    content: row.content,
    tokenCount: row.token_count,
    fileIds,
    earliestAt: row.earliest_at ? new Date(row.earliest_at) : null,
    latestAt: row.latest_at ? new Date(row.latest_at) : null,
    descendantCount: safeNonNeg(row.descendant_count),
    descendantTokenCount: safeNonNeg(row.descendant_token_count),
    sourceMessageTokenCount: safeNonNeg(row.source_message_token_count),
    createdAt: new Date(row.created_at),
  };
}

function toContextItemRecord(row: ContextItemRow): ContextItemRecord {
  return {
    conversationId: row.conversation_id,
    ordinal: row.ordinal,
    itemType: row.item_type,
    messageId: row.message_id,
    summaryId: row.summary_id,
    createdAt: new Date(row.created_at),
  };
}

function toSearchResult(row: SummarySearchRow): SummarySearchResult {
  return {
    summaryId: row.summary_id,
    conversationId: row.conversation_id,
    kind: row.kind,
    snippet: row.snippet,
    createdAt: new Date(row.created_at),
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
    createdAt: new Date(row.created_at),
  };
}

// Column list constants
const SUM_COLS = `summary_id, conversation_id, kind, depth, content, token_count, file_ids,
  earliest_at, latest_at, descendant_count, descendant_token_count,
  source_message_token_count, created_at`;

const FILE_COLS = "file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary, created_at";

// ── SummaryStore ──────────────────────────────────────────────────────────────

export class SummaryStore {
  private readonly fullTextAvailable: boolean;
  private readonly d: Dialect;
  /** Root (non-transactional) database client. */
  private readonly _rootDb: DbClient;
  private readonly _txStore = new AsyncLocalStorage<DbClient>();

  /** Active DB client — transaction-scoped if inside withTransaction/withClient, else root. */
  private get db(): DbClient {
    return this._txStore.getStore() ?? this._rootDb;
  }

  constructor(
    db: DbClient | DatabaseSync,
    options?: { fullTextAvailable?: boolean; fts5Available?: boolean; backend?: Backend },
  ) {
    this._rootDb = ensureDbClient(db);
    this.fullTextAvailable = options?.fullTextAvailable ?? options?.fts5Available ?? true;
    this.d = new Dialect(options?.backend ?? "sqlite");
  }

  // ── Transaction helpers ──────────────────────────────────────────────────

  async withTransaction<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this._txStore.getStore()) {
      return operation();
    }
    return this._rootDb.transaction(async (txClient) => {
      return this._txStore.run(txClient, operation);
    });
  }

  /**
   * Run an operation against an explicit database client.
   *
   * This lets engine-level flows share a transaction-scoped client across
   * multiple stores when one store opens the transaction.
   */
  async withClient<T>(client: DbClient, operation: () => Promise<T> | T): Promise<T> {
    return this._txStore.run(client, operation);
  }

  // ── Summary CRUD ──────────────────────────────────────────────────────────

  async insertSummary(input: CreateSummaryInput): Promise<SummaryRecord> {
    const fileIds = JSON.stringify(input.fileIds ?? []);
    const earliestAt = input.earliestAt instanceof Date ? input.earliestAt.toISOString() : null;
    const latestAt = input.latestAt instanceof Date ? input.latestAt.toISOString() : null;
    const descendantCount = safeNonNeg(input.descendantCount);
    const descendantTokenCount = safeNonNeg(input.descendantTokenCount);
    const sourceMessageTokenCount = safeNonNeg(input.sourceMessageTokenCount);
    const depth = (typeof input.depth === "number" && Number.isFinite(input.depth) && input.depth >= 0)
      ? Math.floor(input.depth)
      : (input.kind === "leaf" ? 0 : 1);

    const d = this.d.reset();
    await this.db.run(
      `INSERT INTO summaries (
         summary_id, conversation_id, kind, depth, content, token_count,
         file_ids, earliest_at, latest_at, descendant_count,
         descendant_token_count, source_message_token_count
       ) VALUES (${d.p()}, ${d.p()}, ${d.p()}, ${d.p()}, ${d.p()}, ${d.p()},
                 ${d.p()}, ${d.p()}, ${d.p()}, ${d.p()}, ${d.p()}, ${d.p()})`,
      [input.summaryId, input.conversationId, input.kind, depth, input.content,
       input.tokenCount, fileIds, earliestAt, latestAt, descendantCount,
       descendantTokenCount, sourceMessageTokenCount],
    );

    d.reset();
    const row = await this.db.queryOne<SummaryRow>(
      `SELECT ${SUM_COLS} FROM summaries WHERE summary_id = ${d.p()}`,
      [input.summaryId],
    );
    if (!row) {
      throw new Error(`Failed to retrieve inserted summary ${input.summaryId}`);
    }

    // Index in FTS5 (SQLite only; Postgres uses generated tsvector column)
    if (this.fullTextAvailable && !this.d.pg) {
      try {
        await this.db.run(`INSERT INTO summaries_fts(summary_id, content) VALUES (?, ?)`, [
          input.summaryId, input.content,
        ]);
      } catch { /* FTS indexing is best-effort */ }
    }

    return toSummaryRecord(row);
  }

  async getSummary(summaryId: string): Promise<SummaryRecord | null> {
    const d = this.d.reset();
    const row = await this.db.queryOne<SummaryRow>(
      `SELECT ${SUM_COLS} FROM summaries WHERE summary_id = ${d.p()}`,
      [summaryId],
    );
    return row ? toSummaryRecord(row) : null;
  }

  async getSummariesByConversation(conversationId: number): Promise<SummaryRecord[]> {
    const d = this.d.reset();
    const result = await this.db.query<SummaryRow>(
      `SELECT ${SUM_COLS} FROM summaries WHERE conversation_id = ${d.p()} ORDER BY created_at`,
      [conversationId],
    );
    return result.rows.map(toSummaryRecord);
  }

  // ── Lineage ───────────────────────────────────────────────────────────────

  async linkSummaryToMessages(summaryId: string, messageIds: number[]): Promise<void> {
    if (messageIds.length === 0) return;
    for (let idx = 0; idx < messageIds.length; idx++) {
      const d = this.d.reset();
      await this.db.run(
        `INSERT INTO summary_messages (summary_id, message_id, ordinal)
         VALUES (${d.p()}, ${d.p()}, ${d.p()})
         ON CONFLICT (summary_id, message_id) DO NOTHING`,
        [summaryId, messageIds[idx], idx],
      );
    }
  }

  async linkSummaryToParents(summaryId: string, parentSummaryIds: string[]): Promise<void> {
    if (parentSummaryIds.length === 0) return;
    for (let idx = 0; idx < parentSummaryIds.length; idx++) {
      const d = this.d.reset();
      await this.db.run(
        `INSERT INTO summary_parents (summary_id, parent_summary_id, ordinal)
         VALUES (${d.p()}, ${d.p()}, ${d.p()})
         ON CONFLICT (summary_id, parent_summary_id) DO NOTHING`,
        [summaryId, parentSummaryIds[idx], idx],
      );
    }
  }

  async getSummaryMessages(summaryId: string): Promise<number[]> {
    const d = this.d.reset();
    const result = await this.db.query<MessageIdRow>(
      `SELECT message_id FROM summary_messages WHERE summary_id = ${d.p()} ORDER BY ordinal`,
      [summaryId],
    );
    return result.rows.map((r) => r.message_id);
  }

  async getSummaryChildren(parentSummaryId: string): Promise<SummaryRecord[]> {
    const d = this.d.reset();
    const result = await this.db.query<SummaryRow>(
      `SELECT s.summary_id, s.conversation_id, s.kind, s.depth, s.content, s.token_count,
              s.file_ids, s.earliest_at, s.latest_at, s.descendant_count,
              s.descendant_token_count, s.source_message_token_count, s.created_at
       FROM summaries s
       JOIN summary_parents sp ON sp.summary_id = s.summary_id
       WHERE sp.parent_summary_id = ${d.p()}
       ORDER BY sp.ordinal`,
      [parentSummaryId],
    );
    return result.rows.map(toSummaryRecord);
  }

  // NOTE: historical naming is confusing here.
  // getSummaryParents(summaryId) returns the source summaries compacted into
  // `summaryId`. Expansion should use this direction for replay.
  async getSummaryParents(summaryId: string): Promise<SummaryRecord[]> {
    const d = this.d.reset();
    const result = await this.db.query<SummaryRow>(
      `SELECT s.summary_id, s.conversation_id, s.kind, s.depth, s.content, s.token_count,
              s.file_ids, s.earliest_at, s.latest_at, s.descendant_count,
              s.descendant_token_count, s.source_message_token_count, s.created_at
       FROM summaries s
       JOIN summary_parents sp ON sp.parent_summary_id = s.summary_id
       WHERE sp.summary_id = ${d.p()}
       ORDER BY sp.ordinal`,
      [summaryId],
    );
    return result.rows.map(toSummaryRecord);
  }

  async getSummarySubtree(summaryId: string): Promise<SummarySubtreeNodeRecord[]> {
    const d = this.d.reset();
    const result = await this.db.query<SummarySubtreeRow>(
      `WITH RECURSIVE subtree(summary_id, parent_summary_id, depth_from_root, path) AS (
         SELECT ${d.p()}, NULL, 0, ''
         UNION ALL
         SELECT
           sp.summary_id,
           sp.parent_summary_id,
           subtree.depth_from_root + 1,
           CASE
             WHEN subtree.path = '' THEN ${d.zeroPad("sp.ordinal", 4)}
             ELSE subtree.path || '.' || ${d.zeroPad("sp.ordinal", 4)}
           END
         FROM summary_parents sp
         JOIN subtree ON sp.parent_summary_id = subtree.summary_id
       )
       SELECT
         s.summary_id, s.conversation_id, s.kind, s.depth, s.content, s.token_count,
         s.file_ids, s.earliest_at, s.latest_at, s.descendant_count,
         s.descendant_token_count, s.source_message_token_count, s.created_at,
         subtree.depth_from_root, subtree.parent_summary_id, subtree.path,
         (SELECT ${d.countInt()} FROM summary_parents sp2 WHERE sp2.parent_summary_id = s.summary_id) AS child_count
       FROM subtree
       JOIN summaries s ON s.summary_id = subtree.summary_id
       ORDER BY subtree.depth_from_root ASC, subtree.path ASC, s.created_at ASC`,
      [summaryId],
    );

    const seen = new Set<string>();
    const output: SummarySubtreeNodeRecord[] = [];
    for (const row of result.rows) {
      if (seen.has(row.summary_id)) continue;
      seen.add(row.summary_id);
      output.push({
        ...toSummaryRecord(row),
        depthFromRoot: Math.max(0, Math.floor(row.depth_from_root ?? 0)),
        parentSummaryId: row.parent_summary_id ?? null,
        path: typeof row.path === "string" ? row.path : "",
        childCount: safeNonNeg(row.child_count),
      });
    }
    return output;
  }

  // ── Context items ─────────────────────────────────────────────────────────

  async getContextItems(conversationId: number): Promise<ContextItemRecord[]> {
    const d = this.d.reset();
    const result = await this.db.query<ContextItemRow>(
      `SELECT conversation_id, ordinal, item_type, message_id, summary_id, created_at
       FROM context_items WHERE conversation_id = ${d.p()} ORDER BY ordinal`,
      [conversationId],
    );
    return result.rows.map(toContextItemRecord);
  }

  async getDistinctDepthsInContext(
    conversationId: number,
    options?: { maxOrdinalExclusive?: number },
  ): Promise<number[]> {
    const maxOrd = options?.maxOrdinalExclusive;
    const useBound = typeof maxOrd === "number" && Number.isFinite(maxOrd) && maxOrd !== Infinity;

    const d = this.d.reset();
    const where = [
      `ci.conversation_id = ${d.p()}`,
      "ci.item_type = 'summary'",
    ];
    const args: unknown[] = [conversationId];

    if (useBound) {
      where.push(`ci.ordinal < ${d.p()}`);
      args.push(Math.floor(maxOrd!));
    }

    const result = await this.db.query<DistinctDepthRow>(
      `SELECT DISTINCT s.depth FROM context_items ci
       JOIN summaries s ON s.summary_id = ci.summary_id
       WHERE ${where.join(" AND ")}
       ORDER BY s.depth ASC`,
      args,
    );
    return result.rows.map((row) => row.depth);
  }

  private async nextOrdinal(conversationId: number): Promise<number> {
    const d = this.d.reset();
    const row = await this.db.queryOne<MaxOrdinalRow>(
      `SELECT COALESCE(MAX(ordinal), -1) AS max_ordinal FROM context_items WHERE conversation_id = ${d.p()}`,
      [conversationId],
    );
    return (row?.max_ordinal ?? -1) + 1;
  }

  async appendContextMessage(conversationId: number, messageId: number): Promise<void> {
    const ordinal = await this.nextOrdinal(conversationId);
    const d = this.d.reset();
    await this.db.run(
      `INSERT INTO context_items (conversation_id, ordinal, item_type, message_id)
       VALUES (${d.p()}, ${d.p()}, 'message', ${d.p()})`,
      [conversationId, ordinal, messageId],
    );
  }

  async appendContextMessages(conversationId: number, messageIds: number[]): Promise<void> {
    if (messageIds.length === 0) return;
    const baseOrdinal = await this.nextOrdinal(conversationId);
    for (let idx = 0; idx < messageIds.length; idx++) {
      const d = this.d.reset();
      await this.db.run(
        `INSERT INTO context_items (conversation_id, ordinal, item_type, message_id)
         VALUES (${d.p()}, ${d.p()}, 'message', ${d.p()})`,
        [conversationId, baseOrdinal + idx, messageIds[idx]],
      );
    }
  }

  async appendContextSummary(conversationId: number, summaryId: string): Promise<void> {
    const ordinal = await this.nextOrdinal(conversationId);
    const d = this.d.reset();
    await this.db.run(
      `INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id)
       VALUES (${d.p()}, ${d.p()}, 'summary', ${d.p()})`,
      [conversationId, ordinal, summaryId],
    );
  }

  async replaceContextRangeWithSummary(input: {
    conversationId: number;
    startOrdinal: number;
    endOrdinal: number;
    summaryId: string;
  }): Promise<void> {
    const { conversationId, startOrdinal, endOrdinal, summaryId } = input;

    return this.withTransaction(async () => {
      // 1. Delete context items in range [startOrdinal, endOrdinal]
      const d1 = this.d.reset();
      await this.db.run(
        `DELETE FROM context_items
         WHERE conversation_id = ${d1.p()} AND ordinal >= ${d1.p()} AND ordinal <= ${d1.p()}`,
        [conversationId, startOrdinal, endOrdinal],
      );

      // 2. Insert replacement summary at startOrdinal
      const d2 = this.d.reset();
      await this.db.run(
        `INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id)
         VALUES (${d2.p()}, ${d2.p()}, 'summary', ${d2.p()})`,
        [conversationId, startOrdinal, summaryId],
      );

      // 3. Resequence ordinals for contiguity (avoid gaps from deletion)
      const d3 = this.d.reset();
      const result = await this.db.query<{ ordinal: number }>(
        `SELECT ordinal FROM context_items WHERE conversation_id = ${d3.p()} ORDER BY ordinal`,
        [conversationId],
      );
      const items = result.rows;

      // Use negative temp ordinals to avoid unique constraint conflicts
      for (let i = 0; i < items.length; i++) {
        const du = this.d.reset();
        await this.db.run(
          `UPDATE context_items SET ordinal = ${du.p()}
           WHERE conversation_id = ${du.p()} AND ordinal = ${du.p()}`,
          [-(i + 1), conversationId, items[i].ordinal],
        );
      }
      for (let i = 0; i < items.length; i++) {
        const du = this.d.reset();
        await this.db.run(
          `UPDATE context_items SET ordinal = ${du.p()}
           WHERE conversation_id = ${du.p()} AND ordinal = ${du.p()}`,
          [i, conversationId, -(i + 1)],
        );
      }
    });
  }

  async getContextTokenCount(conversationId: number): Promise<number> {
    const d = this.d.reset();
    // Postgres $N params can be reused; SQLite ? cannot.
    // Use a subquery approach that works for both.
    const convParam = d.p();
    const convParam2 = this.d.pg ? convParam : d.p();
    const params = this.d.pg ? [conversationId] : [conversationId, conversationId];

    const row = await this.db.queryOne<TokenSumRow>(
      `SELECT COALESCE(SUM(token_count), 0) AS total FROM (
         SELECT m.token_count FROM context_items ci
         JOIN messages m ON m.message_id = ci.message_id
         WHERE ci.conversation_id = ${convParam} AND ci.item_type = 'message'
         UNION ALL
         SELECT s.token_count FROM context_items ci
         JOIN summaries s ON s.summary_id = ci.summary_id
         WHERE ci.conversation_id = ${convParam2} AND ci.item_type = 'summary'
       ) sub`,
      params,
    );
    return row?.total ?? 0;
  }

  // ── Search ────────────────────────────────────────────────────────────────

  async searchSummaries(input: SummarySearchInput): Promise<SummarySearchResult[]> {
    const limit = input.limit ?? 50;

    if (input.mode === "full_text") {
      if (this.fullTextAvailable) {
        try {
          return await this.searchFullText(input.query, limit, input.conversationId, input.since, input.before);
        } catch {
          return await this.searchLike(input.query, limit, input.conversationId, input.since, input.before);
        }
      }
      return await this.searchLike(input.query, limit, input.conversationId, input.since, input.before);
    }
    return await this.searchRegex(input.query, limit, input.conversationId, input.since, input.before);
  }

  // ── Full-text search ─────────────────────────────────────────────────────

  private async searchFullText(
    query: string, limit: number, conversationId?: number, since?: Date, before?: Date,
  ): Promise<SummarySearchResult[]> {
    return this.d.pg
      ? this.searchFullTextPostgres(query, limit, conversationId, since, before)
      : this.searchFullTextSqlite(query, limit, conversationId, since, before);
  }

  private async searchFullTextSqlite(
    query: string, limit: number, conversationId?: number, since?: Date, before?: Date,
  ): Promise<SummarySearchResult[]> {
    const where: string[] = ["summaries_fts MATCH ?"];
    const args: Array<string | number> = [sanitizeFts5Query(query)];
    if (conversationId != null) { where.push("s.conversation_id = ?"); args.push(conversationId); }
    if (since) { where.push("s.created_at >= ?"); args.push(since.toISOString()); }
    if (before) { where.push("s.created_at < ?"); args.push(before.toISOString()); }
    args.push(limit);

    const result = await this.db.query<SummarySearchRow>(
      `SELECT summaries_fts.summary_id, s.conversation_id, s.kind,
              snippet(summaries_fts, 1, '', '', '...', 32) AS snippet,
              rank, s.created_at
       FROM summaries_fts
       JOIN summaries s ON s.summary_id = summaries_fts.summary_id
       WHERE ${where.join(" AND ")}
       ORDER BY s.created_at DESC LIMIT ?`,
      args,
    );
    return result.rows.map(toSearchResult);
  }

  private async searchFullTextPostgres(
    query: string, limit: number, conversationId?: number, since?: Date, before?: Date,
  ): Promise<SummarySearchResult[]> {
    const d = this.d.reset();
    const tsq = `websearch_to_tsquery('english', ${d.p()})`;
    const where: string[] = [`content_tsv @@ ${tsq}`];
    const args: Array<string | number> = [sanitizeTsQuery(query)];

    if (conversationId != null) { where.push(`conversation_id = ${d.p()}`); args.push(conversationId); }
    if (since) { where.push(`created_at >= ${d.p()}`); args.push(since.toISOString()); }
    if (before) { where.push(`created_at < ${d.p()}`); args.push(before.toISOString()); }

    const sql = `SELECT summary_id, conversation_id, kind,
         ts_headline('english', content, websearch_to_tsquery('english', $1), 'MaxWords=32') AS snippet,
         ts_rank(content_tsv, websearch_to_tsquery('english', $1)) AS rank,
         created_at
       FROM summaries
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC LIMIT ${d.p()}`;

    args.push(limit);
    const result = await this.db.query<SummarySearchRow>(sql, args);
    return result.rows.map(toSearchResult);
  }

  // ── LIKE search ──────────────────────────────────────────────────────────

  private async searchLike(
    query: string, limit: number, conversationId?: number, since?: Date, before?: Date,
  ): Promise<SummarySearchResult[]> {
    const plan = buildLikeSearchPlan("content", query);
    if (plan.terms.length === 0) return [];

    const d = this.d.reset();
    let where: string[];
    const args: Array<string | number> = [...plan.args];

    if (d.pg) {
      where = plan.where.map((clause) => clause.replace(/\?/g, () => d.p()));
    } else {
      where = [...plan.where];
      for (let i = 0; i < plan.args.length; i++) d.p(); // advance counter
    }

    if (conversationId != null) { where.push(`conversation_id = ${d.p()}`); args.push(conversationId); }
    if (since) { where.push(`created_at >= ${d.p()}`); args.push(since.toISOString()); }
    if (before) { where.push(`created_at < ${d.p()}`); args.push(before.toISOString()); }
    args.push(limit);

    const result = await this.db.query<SummaryRow>(
      `SELECT ${SUM_COLS} FROM summaries
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC LIMIT ${d.p()}`,
      args,
    );
    return result.rows.map((row) => ({
      summaryId: row.summary_id,
      conversationId: row.conversation_id,
      kind: row.kind,
      snippet: createFallbackSnippet(row.content, plan.terms),
      createdAt: new Date(row.created_at),
      rank: 0,
    }));
  }

  // ── Regex search ─────────────────────────────────────────────────────────

  private async searchRegex(
    pattern: string, limit: number, conversationId?: number, since?: Date, before?: Date,
  ): Promise<SummarySearchResult[]> {
    // Guard against ReDoS: reject patterns with nested quantifiers or excessive length
    if (pattern.length > 500 || /(\+|\*|\?)\)(\+|\*|\?|\{\d)/.test(pattern)) {
      return [];
    }
    try {
      new RegExp(pattern);
    } catch {
      return [];
    }
    if (this.d.pg) {
      return this.searchRegexPostgres(pattern, limit, conversationId, since, before);
    }
    return this.searchRegexSqlite(pattern, limit, conversationId, since, before);
  }

  private async searchRegexSqlite(
    pattern: string, limit: number, conversationId?: number, since?: Date, before?: Date,
  ): Promise<SummarySearchResult[]> {
    const re = new RegExp(pattern);
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (conversationId != null) { where.push("conversation_id = ?"); args.push(conversationId); }
    if (since) { where.push("created_at >= ?"); args.push(since.toISOString()); }
    if (before) { where.push("created_at < ?"); args.push(before.toISOString()); }

    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const result = await this.db.query<SummaryRow>(
      `SELECT ${SUM_COLS} FROM summaries ${whereClause} ORDER BY created_at DESC`,
      args,
    );

    const MAX_ROW_SCAN = 10_000;
    const results: SummarySearchResult[] = [];
    let scanned = 0;
    for (const row of result.rows) {
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
          createdAt: new Date(row.created_at),
          rank: 0,
        });
      }
    }
    return results;
  }

  private async searchRegexPostgres(
    pattern: string, limit: number, conversationId?: number, since?: Date, before?: Date,
  ): Promise<SummarySearchResult[]> {
    const d = this.d.reset();
    const where: string[] = [`content ~ ${d.p()}`];
    const args: Array<string | number> = [pattern];
    if (conversationId != null) { where.push(`conversation_id = ${d.p()}`); args.push(conversationId); }
    if (since) { where.push(`created_at >= ${d.p()}`); args.push(since.toISOString()); }
    if (before) { where.push(`created_at < ${d.p()}`); args.push(before.toISOString()); }

    const result = await this.db.query<SummaryRow>(
      `SELECT ${SUM_COLS} FROM summaries
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC LIMIT ${d.p()}`,
      [...args, limit],
    );
    return result.rows.map((row) => {
      const re = new RegExp(pattern);
      const match = re.exec(row.content);
      return {
        summaryId: row.summary_id,
        conversationId: row.conversation_id,
        kind: row.kind,
        snippet: match ? match[0] : row.content.substring(0, 100),
        createdAt: new Date(row.created_at),
        rank: 0,
      };
    });
  }

  // ── Large files ───────────────────────────────────────────────────────────

  async insertLargeFile(input: CreateLargeFileInput): Promise<LargeFileRecord> {
    const d = this.d.reset();
    await this.db.run(
      `INSERT INTO large_files (file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary)
       VALUES (${d.p()}, ${d.p()}, ${d.p()}, ${d.p()}, ${d.p()}, ${d.p()}, ${d.p()})`,
      [input.fileId, input.conversationId, input.fileName ?? null, input.mimeType ?? null,
       input.byteSize ?? null, input.storageUri, input.explorationSummary ?? null],
    );

    d.reset();
    const row = await this.db.queryOne<LargeFileRow>(
      `SELECT ${FILE_COLS} FROM large_files WHERE file_id = ${d.p()}`,
      [input.fileId],
    );
    if (!row) {
      throw new Error(`Failed to retrieve inserted large file ${input.fileId}`);
    }
    return toLargeFileRecord(row);
  }

  async getLargeFile(fileId: string): Promise<LargeFileRecord | null> {
    const d = this.d.reset();
    const row = await this.db.queryOne<LargeFileRow>(
      `SELECT ${FILE_COLS} FROM large_files WHERE file_id = ${d.p()}`,
      [fileId],
    );
    return row ? toLargeFileRecord(row) : null;
  }

  async getLargeFilesByConversation(conversationId: number): Promise<LargeFileRecord[]> {
    const d = this.d.reset();
    const result = await this.db.query<LargeFileRow>(
      `SELECT ${FILE_COLS} FROM large_files WHERE conversation_id = ${d.p()} ORDER BY created_at`,
      [conversationId],
    );
    return result.rows.map(toLargeFileRecord);
  }

}
