import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { DbClient } from "../db/db-interface.js";
import { SqliteClient } from "../db/sqlite-client.js";
import { Dialect, type Backend } from "../db/dialect.js";
import { EmbeddingClient, toVectorLiteral, type EmbeddingConfig } from "../embeddings.js";
import { EmbeddingQueue, type QueueableDb } from "../embedding-queue.js";
import { sanitizeFts5Query } from "./fts5-sanitize.js";
import { sanitizeTsQuery } from "./tsquery-sanitize.js";
import { buildLikeSearchPlan, containsCjk, createFallbackSnippet } from "./full-text-fallback.js";

/** Accept either a DbClient or raw DatabaseSync (auto-wraps the latter). */
function ensureDbClient(db: DbClient | DatabaseSync): DbClient {
  if ('run' in db && typeof (db as DbClient).run === 'function') {
    return db as DbClient;
  }
  return new SqliteClient(db as DatabaseSync);
}

export type ConversationId = number;
export type MessageId = number;
export type SummaryId = string;
export type MessageRole = "system" | "user" | "assistant" | "tool";
export type MessagePartType =
  | "text"
  | "reasoning"
  | "tool"
  | "patch"
  | "file"
  | "subtask"
  | "compaction"
  | "step_start"
  | "step_finish"
  | "snapshot"
  | "agent"
  | "retry";

export type CreateMessageInput = {
  conversationId: ConversationId;
  seq: number;
  role: MessageRole;
  content: string;
  tokenCount: number;
};

export type MessageRecord = {
  messageId: MessageId;
  conversationId: ConversationId;
  seq: number;
  role: MessageRole;
  content: string;
  tokenCount: number;
  createdAt: Date;
};

export type CreateMessagePartInput = {
  sessionId: string;
  partType: MessagePartType;
  ordinal: number;
  textContent?: string | null;
  toolCallId?: string | null;
  toolName?: string | null;
  toolInput?: string | null;
  toolOutput?: string | null;
  metadata?: string | null;
};

export type MessagePartRecord = {
  partId: string;
  messageId: MessageId;
  sessionId: string;
  partType: MessagePartType;
  ordinal: number;
  textContent: string | null;
  toolCallId: string | null;
  toolName: string | null;
  toolInput: string | null;
  toolOutput: string | null;
  metadata: string | null;
};

export type CreateConversationInput = {
  sessionId: string;
  sessionKey?: string;
  title?: string;
  agentId?: string;
};

export type ConversationRecord = {
  conversationId: ConversationId;
  sessionId: string;
  sessionKey: string | null;
  agentId: string | null;
  title: string | null;
  bootstrappedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type MessageSearchInput = {
  conversationId?: ConversationId;
  query: string;
  mode: "regex" | "full_text" | "semantic" | "recency_boosted";
  since?: Date;
  before?: Date;
  limit?: number;
  /** Weight for semantic similarity (0-1). Default 0.7. Only used in recency_boosted mode. */
  semanticWeight?: number;
  /** Weight for recency (0-1). Default 0.3. Only used in recency_boosted mode. */
  recencyWeight?: number;
  /** Half-life in days for recency decay. Default 7. Only used in recency_boosted mode. */
  recencyHalfLifeDays?: number;
  /** Agent ID of the caller. Results from this agent's conversations get a ranking boost. */
  callerAgentId?: string;
};

export type MessageSearchResult = {
  messageId: MessageId;
  conversationId: ConversationId;
  role: MessageRole;
  snippet: string;
  createdAt: Date;
  rank?: number;
};

// ── DB row shapes (snake_case) ────────────────────────────────────────────────

interface ConversationRow {
  conversation_id: number;
  session_id: string;
  session_key: string | null;
  agent_id: string | null;
  title: string | null;
  bootstrapped_at: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  message_id: number;
  conversation_id: number;
  seq: number;
  role: MessageRole;
  content: string;
  token_count: number;
  created_at: string;
}

interface MessageSearchRow {
  message_id: number;
  conversation_id: number;
  role: MessageRole;
  snippet: string;
  rank: number;
  created_at: string;
}

interface MessagePartRow {
  part_id: string;
  message_id: number;
  session_id: string;
  part_type: MessagePartType;
  ordinal: number;
  text_content: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  tool_input: string | null;
  tool_output: string | null;
  metadata: string | null;
}

interface CountRow {
  count: number;
}

interface MaxSeqRow {
  max_seq: number;
}

// ── Row mappers ───────────────────────────────────────────────────────────────

function toConversationRecord(row: ConversationRow): ConversationRecord {
  return {
    conversationId: row.conversation_id,
    sessionId: row.session_id,
    sessionKey: row.session_key ?? null,
    agentId: row.agent_id ?? null,
    title: row.title,
    bootstrappedAt: row.bootstrapped_at ? new Date(row.bootstrapped_at) : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function toMessageRecord(row: MessageRow): MessageRecord {
  return {
    messageId: row.message_id,
    conversationId: row.conversation_id,
    seq: row.seq,
    role: row.role,
    content: row.content,
    tokenCount: row.token_count,
    createdAt: new Date(row.created_at),
  };
}

function toSearchResult(row: MessageSearchRow): MessageSearchResult {
  return {
    messageId: row.message_id,
    conversationId: row.conversation_id,
    role: row.role,
    snippet: row.snippet,
    createdAt: new Date(row.created_at),
    rank: row.rank,
  };
}

function toMessagePartRecord(row: MessagePartRow): MessagePartRecord {
  return {
    partId: row.part_id,
    messageId: row.message_id,
    sessionId: row.session_id,
    partType: row.part_type,
    ordinal: row.ordinal,
    textContent: row.text_content,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    toolInput: row.tool_input,
    toolOutput: row.tool_output,
    metadata: row.metadata,
  };
}

function normalizeMessageContentForFullTextIndex(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) {
    return null;
  }

  const isExternalizedReference =
    trimmed.startsWith("[LCM File:") || trimmed.startsWith("[LCM Tool Output:");
  if (!isExternalizedReference) {
    return content;
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return null;
  }

  const header = lines[0] ?? "";
  const summaryLines: string[] = [];
  let inSummary = false;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line === "Exploration Summary:") {
      inSummary = true;
      continue;
    }
    if (line.startsWith("Use lcm_describe")) {
      continue;
    }
    if (inSummary) {
      summaryLines.push(line);
    }
  }

  const normalized = [header, ...summaryLines].filter((line) => line.length > 0).join("\n");
  return normalized || null;
}

// Column list constants to avoid repetition
const CONV_COLS = "conversation_id, session_id, session_key, agent_id, title, bootstrapped_at, created_at, updated_at";
const MSG_COLS = "message_id, conversation_id, seq, role, content, token_count, created_at";
const PART_COLS = "part_id, message_id, session_id, part_type, ordinal, text_content, tool_call_id, tool_name, tool_input, tool_output, metadata";

// ── ConversationStore ─────────────────────────────────────────────────────────

export class ConversationStore {
  private readonly fullTextAvailable: boolean;
  private readonly d: Dialect;
  private readonly embeddingClient: EmbeddingClient | null;
  private readonly embeddingQueue: EmbeddingQueue | null;
  /**
   * Root (non-transactional) database client.
   * Query methods use the `db` getter which returns the transaction-scoped
   * client from AsyncLocalStorage when inside a transaction, falling back
   * to this root client otherwise.
   */
  private readonly _rootDb: DbClient;
  private readonly _txStore = new AsyncLocalStorage<DbClient>();

  /** Active DB client — transaction-scoped if inside withTransaction/withClient, else root. */
  private get db(): DbClient {
    return this._txStore.getStore() ?? this._rootDb;
  }

  constructor(
    db: DbClient | DatabaseSync,
    options?: { fullTextAvailable?: boolean; fts5Available?: boolean; backend?: Backend; embeddingConfig?: EmbeddingConfig },
  ) {
    this._rootDb = ensureDbClient(db);
    this.fullTextAvailable = options?.fullTextAvailable ?? options?.fts5Available ?? true;
    this.d = new Dialect(options?.backend ?? "sqlite");

    if (this.d.pg && options?.embeddingConfig) {
      const client = new EmbeddingClient(options.embeddingConfig);
      this.embeddingClient = client.isConfigured() ? client : null;
    } else {
      this.embeddingClient = null;
    }

    // Set up batched embedding queue (replaces fire-and-forget embedOnInsert)
    if (this.embeddingClient) {
      this.embeddingQueue = new EmbeddingQueue(this.embeddingClient, db as QueueableDb, {
        log: (msg) => console.error(`[lcm:conv-embedding-queue] ${msg}`),
      });
      this.embeddingQueue.start();
      console.error(`[lcm:conv-store] embedding queue started (batch=2s, retry=5x)`);
    } else {
      this.embeddingQueue = null;
      console.error(`[lcm:conv-store] embedding queue NOT started (no embedding client)`);
    }
  }

  /** Flush all pending embeddings without stopping the queue timer. */
  async drainEmbeddingQueue(): Promise<void> {
    if (this.embeddingQueue) await this.embeddingQueue.drain();
  }

  /** Gracefully stop the embedding queue (drain + stop timer). Call on shutdown. */
  async stopEmbeddingQueue(): Promise<void> {
    if (this.embeddingQueue) await this.embeddingQueue.stop();
  }

  // ── Transaction helpers ──────────────────────────────────────────────────

  /**
   * Execute an operation within a database transaction.
   *
   * Uses AsyncLocalStorage to scope the transaction client to this async
   * call chain. All queries within the callback automatically use the
   * transaction-scoped client via the `db` getter — no instance field swap,
   * so concurrent sessions sharing this store singleton are safe.
   */
  async withTransaction<T>(operation: () => Promise<T> | T): Promise<T> {
    return this.withTransactionClient(() => operation());
  }

  /**
   * Execute an operation within this store's transaction scope and expose the
   * underlying transaction client so other stores can join the same database
   * transaction.
   */
  async withTransactionClient<T>(
    operation: (client: DbClient) => Promise<T> | T,
  ): Promise<T> {
    if (this._txStore.getStore()) {
      return operation(this._txStore.getStore()!);
    }
    return this._rootDb.transaction(async (txClient) => {
      return this._txStore.run(txClient, () => operation(txClient));
    });
  }

  // ── Conversation operations ───────────────────────────────────────────────

  async createConversation(input: CreateConversationInput): Promise<ConversationRecord> {
    const d = this.d.reset();
    const result = await this.db.run(
      `INSERT INTO conversations (session_id, session_key, agent_id, title)
       VALUES (${d.p()}, ${d.p()}, ${d.p()}, ${d.p()}) RETURNING conversation_id`,
      [input.sessionId, input.sessionKey ?? null, input.agentId ?? null, input.title ?? null],
    );
    const conversationId = result.lastInsertId!;

    d.reset();
    const row = await this.db.queryOne<ConversationRow>(
      `SELECT ${CONV_COLS} FROM conversations WHERE conversation_id = ${d.p()}`,
      [conversationId],
    );
    if (!row) {
      throw new Error(`Failed to retrieve created conversation with ID ${conversationId}`);
    }
    return toConversationRecord(row);
  }

  async getConversation(conversationId: ConversationId): Promise<ConversationRecord | null> {
    const d = this.d.reset();
    const row = await this.db.queryOne<ConversationRow>(
      `SELECT ${CONV_COLS} FROM conversations WHERE conversation_id = ${d.p()}`,
      [conversationId],
    );
    return row ? toConversationRecord(row) : null;
  }

  async getConversationBySessionId(sessionId: string): Promise<ConversationRecord | null> {
    const d = this.d.reset();
    const row = await this.db.queryOne<ConversationRow>(
      `SELECT ${CONV_COLS} FROM conversations
       WHERE session_id = ${d.p()}
       ORDER BY created_at DESC LIMIT 1`,
      [sessionId],
    );
    return row ? toConversationRecord(row) : null;
  }

  async getConversationBySessionKey(sessionKey: string): Promise<ConversationRecord | null> {
    const d = this.d.reset();
    const row = await this.db.queryOne<ConversationRow>(
      `SELECT ${CONV_COLS} FROM conversations
       WHERE session_key = ${d.p()}
       LIMIT 1`,
      [sessionKey],
    );
    return row ? toConversationRecord(row) : null;
  }

  /** Resolve a conversation by stable session identity. */
  async getConversationForSession(input: {
    sessionId?: string;
    sessionKey?: string;
  }): Promise<ConversationRecord | null> {
    const normalizedSessionKey = input.sessionKey?.trim();
    if (normalizedSessionKey) {
      const byKey = await this.getConversationBySessionKey(normalizedSessionKey);
      if (byKey) {
        return byKey;
      }
    }

    const normalizedSessionId = input.sessionId?.trim();
    if (!normalizedSessionId) {
      return null;
    }

    return this.getConversationBySessionId(normalizedSessionId);
  }

  async getOrCreateConversation(
    sessionId: string,
    titleOrOpts?: string | { title?: string; sessionKey?: string; agentId?: string },
  ): Promise<ConversationRecord> {
    const opts = typeof titleOrOpts === "string" ? { title: titleOrOpts } : titleOrOpts ?? {};
    if (opts.sessionKey) {
      const byKey = await this.getConversationBySessionKey(opts.sessionKey);
      if (byKey) {
        if (byKey.sessionId !== sessionId) {
          const d = this.d.reset();
          await this.db.run(
            `UPDATE conversations SET session_id = ${d.p()}, updated_at = ${d.now()} WHERE conversation_id = ${d.p()}`,
            [sessionId, byKey.conversationId],
          );
          byKey.sessionId = sessionId;
        }
        return byKey;
      }
    }

    const existing = await this.getConversationBySessionId(sessionId);
    if (existing) {
      if (opts.sessionKey && !existing.sessionKey) {
        const d = this.d.reset();
        await this.db.run(
          `UPDATE conversations SET session_key = ${d.p()}, updated_at = ${d.now()} WHERE conversation_id = ${d.p()}`,
          [opts.sessionKey, existing.conversationId],
        );
        existing.sessionKey = opts.sessionKey;
      }
      // Backfill agent_id if it was missing and we now know it
      if (!existing.agentId && opts.agentId) {
        const d = this.d.reset();
        await this.db.run(
          `UPDATE conversations SET agent_id = ${d.p()}, updated_at = ${d.now()} WHERE conversation_id = ${d.p()}`,
          [opts.agentId, existing.conversationId],
        );
        existing.agentId = opts.agentId;
      }
      return existing;
    }

    return this.createConversation({ sessionId, title: opts.title, sessionKey: opts.sessionKey, agentId: opts.agentId });
  }

  async markConversationBootstrapped(conversationId: ConversationId): Promise<void> {
    const d = this.d.reset();
    await this.db.run(
      `UPDATE conversations
       SET bootstrapped_at = COALESCE(bootstrapped_at, ${d.now()}),
           updated_at = ${d.now()}
       WHERE conversation_id = ${d.p()}`,
      [conversationId],
    );
  }

  // ── Message operations ────────────────────────────────────────────────────

  async createMessage(input: CreateMessageInput): Promise<MessageRecord> {
    const d = this.d.reset();
    const result = await this.db.run(
      `INSERT INTO messages (conversation_id, seq, role, content, token_count)
       VALUES (${d.p()}, ${d.p()}, ${d.p()}, ${d.p()}, ${d.p()}) RETURNING message_id`,
      [input.conversationId, input.seq, input.role, input.content, input.tokenCount],
    );
    const messageId = result.lastInsertId!;

    await this.indexMessageForFullText(messageId, input.content);
    if (this.embeddingQueue) {
      this.embeddingQueue.enqueue("messages", messageId, input.content);
    }

    d.reset();
    const row = await this.db.queryOne<MessageRow>(
      `SELECT ${MSG_COLS} FROM messages WHERE message_id = ${d.p()}`,
      [messageId],
    );
    if (!row) {
      throw new Error(`Failed to retrieve created message with ID ${messageId}`);
    }
    return toMessageRecord(row);
  }

  async createMessagesBulk(inputs: CreateMessageInput[]): Promise<MessageRecord[]> {
    if (inputs.length === 0) return [];

    const records: MessageRecord[] = [];
    for (const input of inputs) {
      const d = this.d.reset();
      const result = await this.db.run(
        `INSERT INTO messages (conversation_id, seq, role, content, token_count)
         VALUES (${d.p()}, ${d.p()}, ${d.p()}, ${d.p()}, ${d.p()}) RETURNING message_id`,
        [input.conversationId, input.seq, input.role, input.content, input.tokenCount],
      );
      const messageId = result.lastInsertId!;

      await this.indexMessageForFullText(messageId, input.content);
      if (this.embeddingQueue) {
        this.embeddingQueue.enqueue("messages", messageId, input.content);
      }

      d.reset();
      const row = await this.db.queryOne<MessageRow>(
        `SELECT ${MSG_COLS} FROM messages WHERE message_id = ${d.p()}`,
        [messageId],
      );
      if (row) records.push(toMessageRecord(row));
    }
    return records;
  }

  async getMessageById(messageId: MessageId): Promise<MessageRecord | null> {
    const d = this.d.reset();
    const row = await this.db.queryOne<MessageRow>(
      `SELECT ${MSG_COLS} FROM messages WHERE message_id = ${d.p()}`,
      [messageId],
    );
    return row ? toMessageRecord(row) : null;
  }

  async getMessages(
    conversationId: ConversationId,
    options?: { limit?: number; before?: number; after?: number },
  ): Promise<MessageRecord[]> {
    const d = this.d.reset();
    const where: string[] = [`conversation_id = ${d.p()}`];
    const args: Array<string | number> = [conversationId];

    if (options?.before != null) {
      where.push(`seq < ${d.p()}`);
      args.push(options.before);
    }
    if (options?.after != null) {
      where.push(`seq > ${d.p()}`);
      args.push(options.after);
    }

    let limitClause = "";
    if (options?.limit != null) {
      limitClause = `LIMIT ${d.p()}`;
      args.push(options.limit);
    }

    const result = await this.db.query<MessageRow>(
      `SELECT ${MSG_COLS} FROM messages
       WHERE ${where.join(" AND ")}
       ORDER BY seq ${limitClause}`,
      args,
    );
    return result.rows.map(toMessageRecord);
  }

  async getLastMessage(conversationId: ConversationId): Promise<MessageRecord | null> {
    const results = await this.getLatestMessages(conversationId, 1);
    return results.length > 0 ? results[0] : null;
  }

  async hasMessage(
    conversationId: ConversationId,
    role: string,
    content: string,
  ): Promise<boolean> {
    const d = this.d.reset();
    const result = await this.db.query<{ "1": number }>(
      `SELECT 1 FROM messages
       WHERE conversation_id = ${d.p()} AND role = ${d.p()} AND content = ${d.p()} LIMIT 1`,
      [conversationId, role, content],
    );
    return result.rows.length > 0;
  }

  async countMessagesByIdentity(
    conversationId: ConversationId,
    role: string,
    content: string,
  ): Promise<number> {
    const d = this.d.reset();
    const result = await this.db.query<{ count: number }>(
      `SELECT ${d.countInt("count")} FROM messages
       WHERE conversation_id = ${d.p()} AND role = ${d.p()} AND content = ${d.p()}`,
      [conversationId, role, content],
    );
    return result.rows[0]?.count ?? 0;
  }

  async getLatestMessages(conversationId: ConversationId, count: number): Promise<MessageRecord[]> {
    const d = this.d.reset();
    const result = await this.db.query<MessageRow>(
      `SELECT ${MSG_COLS} FROM messages
       WHERE conversation_id = ${d.p()}
       ORDER BY seq DESC LIMIT ${d.p()}`,
      [conversationId, count],
    );
    return result.rows.map(toMessageRecord).reverse(); // Return chronological order
  }

  // ── Message parts operations ──────────────────────────────────────────────

  async createMessageParts(messageId: MessageId, parts: CreateMessagePartInput[]): Promise<void> {
    if (parts.length === 0) {
      return;
    }

    let hasToolParts = false;
    for (const input of parts) {
      const partId = randomUUID();
      const d = this.d.reset();
      await this.db.run(
        `INSERT INTO message_parts
         (part_id, message_id, session_id, part_type, ordinal, text_content,
          tool_call_id, tool_name, tool_input, tool_output, metadata)
         VALUES (${d.p()}, ${d.p()}, ${d.p()}, ${d.p()}, ${d.p()}, ${d.p()},
                 ${d.p()}, ${d.p()}, ${d.p()}, ${d.p()}, ${d.p()})`,
        [
          partId, messageId, input.sessionId, input.partType, input.ordinal,
          input.textContent, input.toolCallId, input.toolName, input.toolInput, input.toolOutput, input.metadata,
        ],
      );
      if (input.partType === "tool") hasToolParts = true;
    }

    // Re-enqueue for embedding if this message has tool parts.
    // createMessage enqueues immediately but with empty content for tool-only
    // turns. The queue may flush before parts exist, so re-enqueue now that
    // parts are persisted and available for synthesis.
    if (hasToolParts && this.embeddingQueue) {
      this.embeddingQueue.enqueue("messages", messageId, "");
    }
  }

  async getMessageParts(messageId: MessageId): Promise<MessagePartRecord[]> {
    const d = this.d.reset();
    const result = await this.db.query<MessagePartRow>(
      `SELECT ${PART_COLS} FROM message_parts WHERE message_id = ${d.p()} ORDER BY ordinal`,
      [messageId],
    );
    return result.rows.map(toMessagePartRecord);
  }

  async getMessageCount(conversationId: ConversationId): Promise<number> {
    const d = this.d.reset();
    const row = await this.db.queryOne<CountRow>(
      `SELECT ${d.countInt("count")} FROM messages WHERE conversation_id = ${d.p()}`,
      [conversationId],
    );
    return row?.count ?? 0;
  }

  async getMaxSeq(conversationId: ConversationId): Promise<number> {
    const d = this.d.reset();
    const row = await this.db.queryOne<MaxSeqRow>(
      `SELECT COALESCE(MAX(seq), 0) AS max_seq FROM messages WHERE conversation_id = ${d.p()}`,
      [conversationId],
    );
    return row?.max_seq ?? 0;
  }

  // ── Deletion ──────────────────────────────────────────────────────────────

  async deleteMessages(messageIds: MessageId[]): Promise<number> {
    if (messageIds.length === 0) return 0;

    return this.withTransaction(async () => {
      let deleted = 0;
      for (const messageId of messageIds) {
        const d = this.d.reset();
        const refRow = await this.db.queryOne<{ found: number }>(
          `SELECT 1 AS found FROM summary_messages WHERE message_id = ${d.p()} LIMIT 1`,
          [messageId],
        );
        if (refRow) continue;

        d.reset();
        await this.db.run(
          `DELETE FROM context_items WHERE item_type = 'message' AND message_id = ${d.p()}`,
          [messageId],
        );

        await this.deleteMessageFromFullText(messageId);

        d.reset();
        await this.db.run(
          `DELETE FROM messages WHERE message_id = ${d.p()}`,
          [messageId],
        );
        deleted += 1;
      }
      return deleted;
    });
  }

  // ── Search ────────────────────────────────────────────────────────────────

  async searchMessages(input: MessageSearchInput): Promise<MessageSearchResult[]> {
    const limit = input.limit ?? 50;

    if (input.mode === "recency_boosted") {
      try {
        return await this.searchRecencyBoosted(
          input.query, limit, input.conversationId, input.since, input.before,
          input.semanticWeight, input.recencyWeight, input.recencyHalfLifeDays,
          input.callerAgentId,
        );
      } catch (err) {
        console.warn(
          `[lcm:conv-store] recency_boosted search failed, falling back to semantic: ${err instanceof Error ? err.message : String(err)}`,
        );
        return this.searchMessages({ ...input, mode: "semantic" });
      }
    }

    if (input.mode === "semantic") {
      try {
        return await this.searchSemantic(
          input.query, limit, input.conversationId, input.since, input.before,
          input.callerAgentId,
        );
      } catch (err) {
        console.warn(
          `[lcm:conv-store] semantic search failed, falling back to full_text: ${err instanceof Error ? err.message : String(err)}`,
        );
        return this.searchMessages({ ...input, mode: "full_text" });
      }
    }

    if (input.mode === "full_text") {
      // FTS5 unicode61 can return incomplete matches for CJK text, so route
      // those queries through the existing LIKE fallback path immediately.
      if (containsCjk(input.query)) {
        return this.searchLike(
          input.query,
          limit,
          input.conversationId,
          input.since,
          input.before,
        );
      }
      if (this.fullTextAvailable) {
        try {
          return await this.searchFullText(
            input.query, limit, input.conversationId, input.since, input.before,
          );
        } catch {
          return await this.searchLike(
            input.query, limit, input.conversationId, input.since, input.before,
          );
        }
      }
      return await this.searchLike(input.query, limit, input.conversationId, input.since, input.before);
    }
    return await this.searchRegex(input.query, limit, input.conversationId, input.since, input.before);
  }

  // ── Full-text search (backend-specific) ─────────────────────────────────

  private async indexMessageForFullText(messageId: MessageId, content: string): Promise<void> {
    if (!this.fullTextAvailable || this.d.pg) return; // Postgres uses generated tsvector column
    const normalizedContent = normalizeMessageContentForFullTextIndex(content);
    if (!normalizedContent) {
      return;
    }
    try {
      await this.db.run(`INSERT INTO messages_fts(rowid, content) VALUES (?, ?)`, [messageId, normalizedContent]);
    } catch {
      // Full-text indexing is optional. Message persistence must still succeed.
    }
  }

  private async deleteMessageFromFullText(messageId: MessageId): Promise<void> {
    if (!this.fullTextAvailable || this.d.pg) return; // Postgres tsvector auto-deletes with row
    try {
      await this.db.run(`DELETE FROM messages_fts WHERE rowid = ?`, [messageId]);
    } catch {
      // Ignore FTS cleanup failures.
    }
  }

  private async searchFullText(
    query: string,
    limit: number,
    conversationId?: ConversationId,
    since?: Date,
    before?: Date,
  ): Promise<MessageSearchResult[]> {
    if (this.d.pg) {
      return this.searchFullTextPostgres(query, limit, conversationId, since, before);
    }
    return this.searchFullTextSqlite(query, limit, conversationId, since, before);
  }

  private async searchFullTextSqlite(
    query: string,
    limit: number,
    conversationId?: ConversationId,
    since?: Date,
    before?: Date,
  ): Promise<MessageSearchResult[]> {
    const where: string[] = ["messages_fts MATCH ?"];
    const args: Array<string | number> = [sanitizeFts5Query(query)];

    if (conversationId != null) { where.push("conversation_id = ?"); args.push(conversationId); }
    if (since) { where.push("created_at >= ?"); args.push(since.toISOString()); }
    if (before) { where.push("created_at < ?"); args.push(before.toISOString()); }
    args.push(limit);

    const sql = `SELECT
         m.message_id, m.conversation_id, m.role,
         snippet(messages_fts, 0, '', '', '...', 32) AS snippet,
         bm25(messages_fts) AS rank, m.created_at
       FROM messages_fts
       JOIN messages m ON m.message_id = messages_fts.rowid
       WHERE ${where.join(" AND ")}
       ORDER BY m.created_at DESC LIMIT ?`;

    const result = await this.db.query<MessageSearchRow>(sql, args);
    return result.rows.map(toSearchResult);
  }

  private async searchFullTextPostgres(
    query: string,
    limit: number,
    conversationId?: ConversationId,
    since?: Date,
    before?: Date,
  ): Promise<MessageSearchResult[]> {
    const d = this.d.reset();
    const tsq = `websearch_to_tsquery('english', ${d.p()})`;
    const where: string[] = [`content_tsv @@ ${tsq}`];
    const args: Array<string | number> = [sanitizeTsQuery(query)];

    if (conversationId != null) { where.push(`conversation_id = ${d.p()}`); args.push(conversationId); }
    if (since) { where.push(`created_at >= ${d.p()}`); args.push(since.toISOString()); }
    if (before) { where.push(`created_at < ${d.p()}`); args.push(before.toISOString()); }

    const sql = `SELECT
         message_id, conversation_id, role,
         ts_headline('english', content, websearch_to_tsquery('english', $1), 'MaxWords=32') AS snippet,
         ts_rank(content_tsv, websearch_to_tsquery('english', $1)) AS rank,
         created_at
       FROM messages
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC LIMIT ${d.p()}`;

    args.push(limit);
    const result = await this.db.query<MessageSearchRow>(sql, args);
    return result.rows.map(toSearchResult);
  }

  // ── LIKE search (both backends) ──────────────────────────────────────────

  private async searchLike(
    query: string,
    limit: number,
    conversationId?: ConversationId,
    since?: Date,
    before?: Date,
  ): Promise<MessageSearchResult[]> {
    const plan = buildLikeSearchPlan("content", query);
    if (plan.terms.length === 0) return [];

    const d = this.d.reset();
    let where: string[];
    const args: Array<string | number> = [...plan.args];

    if (d.pg) {
      // Renumber plan placeholders from ? to $N
      where = plan.where.map((clause) => clause.replace(/\?/g, () => d.p()));
    } else {
      where = [...plan.where];
      // Advance the dialect param counter to match plan args
      for (let i = 0; i < plan.args.length; i++) d.p();
    }

    if (conversationId != null) { where.push(`conversation_id = ${d.p()}`); args.push(conversationId); }
    if (since) { where.push(`created_at >= ${d.p()}`); args.push(since.toISOString()); }
    if (before) { where.push(`created_at < ${d.p()}`); args.push(before.toISOString()); }
    args.push(limit);

    const sql = `SELECT ${MSG_COLS} FROM messages
                 WHERE ${where.join(" AND ")}
                 ORDER BY created_at DESC LIMIT ${d.p()}`;

    const result = await this.db.query<MessageRow>(sql, args);
    return result.rows.map((row) => ({
      messageId: row.message_id,
      conversationId: row.conversation_id,
      role: row.role,
      snippet: createFallbackSnippet(row.content, plan.terms),
      createdAt: new Date(row.created_at),
      rank: 0,
    }));
  }

  // ── Regex search (backend-specific) ──────────────────────────────────────

  private async searchRegex(
    pattern: string,
    limit: number,
    conversationId?: ConversationId,
    since?: Date,
    before?: Date,
  ): Promise<MessageSearchResult[]> {
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
    pattern: string,
    limit: number,
    conversationId?: ConversationId,
    since?: Date,
    before?: Date,
  ): Promise<MessageSearchResult[]> {
    const re = new RegExp(pattern);
    const where: string[] = [];
    const args: Array<string | number> = [];

    if (conversationId != null) { where.push("conversation_id = ?"); args.push(conversationId); }
    if (since) { where.push("created_at >= ?"); args.push(since.toISOString()); }
    if (before) { where.push("created_at < ?"); args.push(before.toISOString()); }

    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const result = await this.db.query<MessageRow>(
      `SELECT ${MSG_COLS} FROM messages ${whereClause} ORDER BY created_at DESC`,
      args,
    );

    const MAX_ROW_SCAN = 10_000;
    const results: MessageSearchResult[] = [];
    let scanned = 0;
    for (const row of result.rows) {
      if (results.length >= limit || scanned >= MAX_ROW_SCAN) {
        break;
      }
      scanned++;
      const match = re.exec(row.content);
      if (match) {
        results.push({
          messageId: row.message_id,
          conversationId: row.conversation_id,
          role: row.role,
          snippet: match[0],
          createdAt: new Date(row.created_at),
          rank: 0,
        });
      }
    }
    return results;
  }

  private async searchRegexPostgres(
    pattern: string,
    limit: number,
    conversationId?: ConversationId,
    since?: Date,
    before?: Date,
  ): Promise<MessageSearchResult[]> {
    const d = this.d.reset();
    const where: string[] = [`content ~ ${d.p()}`];
    const args: Array<string | number> = [pattern];

    if (conversationId != null) { where.push(`conversation_id = ${d.p()}`); args.push(conversationId); }
    if (since) { where.push(`created_at >= ${d.p()}`); args.push(since.toISOString()); }
    if (before) { where.push(`created_at < ${d.p()}`); args.push(before.toISOString()); }

    const sql = `SELECT ${MSG_COLS} FROM messages
                 WHERE ${where.join(" AND ")}
                 ORDER BY created_at DESC LIMIT ${d.p()}`;
    args.push(limit);

    const result = await this.db.query<MessageRow>(sql, args);
    return result.rows.map((row) => {
      const re = new RegExp(pattern);
      const match = re.exec(row.content);
      return {
        messageId: row.message_id,
        conversationId: row.conversation_id,
        role: row.role,
        snippet: match ? match[0] : row.content.substring(0, 100),
        createdAt: new Date(row.created_at),
        rank: 0,
      };
    });
  }

  // ── Embedding helpers ──────────────────────────────────────────────────

  private async embedOnInsert(messageId: MessageId, content: string): Promise<void> {
    if (!this.embeddingClient || !this.d.pg) return;
    if (!content || content.trim().length === 0) return;

    const embedding = await this.embeddingClient.embedOne(content);
    await this.db.run(
      `UPDATE messages SET embedding = $1 WHERE message_id = $2`,
      [toVectorLiteral(embedding), messageId],
    );
  }

  async searchSemantic(
    query: string, limit: number,
    conversationId?: ConversationId, since?: Date, before?: Date,
    callerAgentId?: string,
  ): Promise<MessageSearchResult[]> {
    if (!this.d.pg || !this.embeddingClient) {
      throw new Error("Semantic search requires PostgreSQL with pgvector and a configured embedding API key");
    }

    const queryEmbedding = await this.embeddingClient.embedOne(query);
    const vectorLiteral = toVectorLiteral(queryEmbedding);

    const d = this.d.reset();
    const where: string[] = ["m.embedding IS NOT NULL"];
    const params: unknown[] = [];

    if (conversationId !== undefined) { where.push(`m.conversation_id = ${d.p()}`); params.push(conversationId); }
    if (since) { where.push(`m.created_at >= ${d.p()}`); params.push(since.toISOString()); }
    if (before) { where.push(`m.created_at < ${d.p()}`); params.push(before.toISOString()); }

    const vecParam = d.p();
    const candidateLimit = d.p();
    const finalLimit = d.p();
    params.push(vectorLiteral, limit * 3, limit);

    // Agent affinity: boost results from caller's own conversations by 1.3x
    let agentBoostExpr = "1.0";
    if (callerAgentId) {
      const agentParam = d.p();
      params.push(callerAgentId);
      agentBoostExpr = `CASE WHEN c.agent_id = ${agentParam} THEN 1.3 ELSE 1.0 END`;
    }

    const result = await this.db.query<MessageRow & { rank: number }>(
      `WITH candidates AS (
         SELECT m.message_id, m.conversation_id, m.role, m.content, m.created_at,
           1 - (m.embedding <=> ${vecParam}::vector) AS similarity
         FROM messages m
         WHERE ${where.join(" AND ")}
         ORDER BY m.embedding <=> ${vecParam}::vector
         LIMIT ${candidateLimit}
       )
       SELECT cd.message_id, cd.conversation_id, cd.role, cd.content, cd.created_at,
         cd.similarity * ${agentBoostExpr} AS rank
       FROM candidates cd
       JOIN conversations c ON c.conversation_id = cd.conversation_id
       ORDER BY rank DESC
       LIMIT ${finalLimit}`,
      params,
    );

    return result.rows.map((row) => ({
      messageId: row.message_id,
      conversationId: row.conversation_id,
      role: row.role,
      snippet: row.content.substring(0, 200),
      createdAt: new Date(row.created_at),
      rank: row.rank,
    }));
  }

  /**
   * Recency-boosted semantic search.
   *
   * Blends cosine similarity with an exponential time-decay factor:
   *   score = semanticWeight * similarity + recencyWeight * exp(-ln(2) * age_days / halfLife)
   *
   * Recent messages get a natural lift. The half-life controls how fast
   * the recency bonus decays (default 7 days = score halves every week).
   */
  async searchRecencyBoosted(
    query: string, limit: number,
    conversationId?: ConversationId, since?: Date, before?: Date,
    semanticWeight = 0.7, recencyWeight = 0.3, halfLifeDays = 7,
    callerAgentId?: string,
  ): Promise<MessageSearchResult[]> {
    if (!this.d.pg || !this.embeddingClient) {
      throw new Error("Recency-boosted search requires PostgreSQL with pgvector and a configured embedding API key");
    }

    const queryEmbedding = await this.embeddingClient.embedOne(query);
    const vectorLiteral = toVectorLiteral(queryEmbedding);

    const d = this.d.reset();
    const where: string[] = ["m.embedding IS NOT NULL"];
    const params: unknown[] = [];

    if (conversationId !== undefined) { where.push(`m.conversation_id = ${d.p()}`); params.push(conversationId); }
    if (since) { where.push(`m.created_at >= ${d.p()}`); params.push(since.toISOString()); }
    if (before) { where.push(`m.created_at < ${d.p()}`); params.push(before.toISOString()); }

    const vecParam = d.p();
    const swParam = d.p();
    const rwParam = d.p();
    const hlParam = d.p();
    const candidateLimit = d.p();
    const finalLimit = d.p();
    params.push(vectorLiteral, semanticWeight, recencyWeight, halfLifeDays, limit * 3, limit);

    // Agent affinity: boost results from caller's own conversations by 1.3x
    let agentBoostExpr = "1.0";
    if (callerAgentId) {
      const agentParam = d.p();
      params.push(callerAgentId);
      agentBoostExpr = `CASE WHEN c.agent_id = ${agentParam} THEN 1.3 ELSE 1.0 END`;
    }

    // Use HNSW index for initial candidate retrieval (ORDER BY distance),
    // then re-rank with blended score + agent affinity.
    const result = await this.db.query<MessageRow & { rank: number }>(
      `WITH candidates AS (
         SELECT m.message_id, m.conversation_id, m.role, m.content, m.created_at,
           1 - (m.embedding <=> ${vecParam}::vector) AS similarity,
           EXP(-LN(2) * EXTRACT(EPOCH FROM (NOW() - m.created_at)) / 86400.0 / ${hlParam}) AS recency
         FROM messages m
         WHERE ${where.join(" AND ")}
         ORDER BY m.embedding <=> ${vecParam}::vector
         LIMIT ${candidateLimit}
       )
       SELECT cd.message_id, cd.conversation_id, cd.role, cd.content, cd.created_at,
         (${swParam} * cd.similarity + ${rwParam} * cd.recency) * ${agentBoostExpr} AS rank
       FROM candidates cd
       JOIN conversations c ON c.conversation_id = cd.conversation_id
       ORDER BY rank DESC
       LIMIT ${finalLimit}`,
      params,
    );

    return result.rows.map((row) => ({
      messageId: row.message_id,
      conversationId: row.conversation_id,
      role: row.role,
      snippet: row.content.substring(0, 200),
      createdAt: new Date(row.created_at),
      rank: row.rank,
    }));
  }

  get embeddingsAvailable(): boolean {
    return this.embeddingClient !== null && this.d.pg;
  }
}
