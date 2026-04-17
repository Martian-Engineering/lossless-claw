import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { withDatabaseTransaction } from "../transaction-mutex.js";
import { sanitizeFts5Query } from "./fts5-sanitize.js";
import { buildLikeSearchPlan, containsCjk, createFallbackSnippet } from "./full-text-fallback.js";
import { buildMessageIdentityHash } from "./message-identity.js";
import { parseUtcTimestamp, parseUtcTimestampOrNull } from "./parse-utc-timestamp.js";
import { buildFtsOrderBy, type SearchSort } from "./full-text-sort.js";

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
  identityHash?: string;
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
  active?: boolean;
  archivedAt?: Date | null;
};

export type ConversationRecord = {
  conversationId: ConversationId;
  sessionId: string;
  sessionKey: string | null;
  active: boolean;
  archivedAt: Date | null;
  title: string | null;
  bootstrappedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type MessageSearchInput = {
  conversationId?: ConversationId;
  query: string;
  mode: "regex" | "full_text";
  since?: Date;
  before?: Date;
  limit?: number;
  sort?: SearchSort;
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
  active: number;
  archived_at: string | null;
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
    active: row.active === 1,
    archivedAt: parseUtcTimestampOrNull(row.archived_at),
    title: row.title,
    bootstrappedAt: parseUtcTimestampOrNull(row.bootstrapped_at),
    createdAt: parseUtcTimestamp(row.created_at),
    updatedAt: parseUtcTimestamp(row.updated_at),
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
    createdAt: parseUtcTimestamp(row.created_at),
  };
}

function toSearchResult(row: MessageSearchRow): MessageSearchResult {
  return {
    messageId: row.message_id,
    conversationId: row.conversation_id,
    role: row.role,
    snippet: row.snippet,
    createdAt: parseUtcTimestamp(row.created_at),
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
  if (typeof content !== "string") return null;
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

// ── ConversationStore ─────────────────────────────────────────────────────────

export class ConversationStore {
  private readonly fts5Available: boolean;

  constructor(
    private db: DatabaseSync,
    options?: { fts5Available?: boolean },
  ) {
    this.fts5Available = options?.fts5Available ?? true;
  }

  // ── Transaction helpers ──────────────────────────────────────────────────

  async withTransaction<T>(operation: () => Promise<T> | T): Promise<T> {
    return withDatabaseTransaction(this.db, "BEGIN IMMEDIATE", operation);
  }

  // ── Conversation operations ───────────────────────────────────────────────

  async createConversation(input: CreateConversationInput): Promise<ConversationRecord> {
    try {
      const result = this.db
        .prepare(
          `INSERT INTO conversations (session_id, session_key, active, archived_at, title)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.sessionId,
          input.sessionKey ?? null,
          input.active === false ? 0 : 1,
          input.archivedAt?.toISOString() ?? null,
          input.title ?? null,
        );

      const row = this.db
        .prepare(
          `SELECT conversation_id, session_id, session_key, active, archived_at, title, bootstrapped_at, created_at, updated_at
         FROM conversations WHERE conversation_id = ?`,
        )
        .get(Number(result.lastInsertRowid)) as unknown as ConversationRow;

      return toConversationRecord(row);
    } catch (err: unknown) {
      // Handle UNIQUE constraint race: another writer created the conversation first
      if (
        err instanceof Error &&
        /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(err.message)
      ) {
        if (input.sessionKey) {
          const existing = await this.getConversationBySessionKey(input.sessionKey);
          if (existing) return existing;
        }
        const existing = await this.getConversationBySessionId(input.sessionId);
        if (existing) return existing;
      }
      throw err;
    }
  }

  async getConversation(conversationId: ConversationId): Promise<ConversationRecord | null> {
    const row = this.db
      .prepare(
        `SELECT conversation_id, session_id, session_key, active, archived_at, title, bootstrapped_at, created_at, updated_at
       FROM conversations WHERE conversation_id = ?`,
      )
      .get(conversationId) as unknown as ConversationRow | undefined;

    return row ? toConversationRecord(row) : null;
  }

  async getConversationBySessionId(sessionId: string): Promise<ConversationRecord | null> {
    const row = this.db
      .prepare(
        `SELECT conversation_id, session_id, session_key, active, archived_at, title, bootstrapped_at, created_at, updated_at
       FROM conversations
       WHERE session_id = ?
       ORDER BY active DESC, created_at DESC
       LIMIT 1`,
      )
      .get(sessionId) as unknown as ConversationRow | undefined;

    return row ? toConversationRecord(row) : null;
  }

  async getConversationBySessionKey(sessionKey: string): Promise<ConversationRecord | null> {
    const row = this.db
      .prepare(
        `SELECT conversation_id, session_id, session_key, active, archived_at, title, bootstrapped_at, created_at, updated_at
       FROM conversations
       WHERE session_key = ?
         AND active = 1
       ORDER BY created_at DESC
       LIMIT 1`,
      )
      .get(sessionKey) as unknown as ConversationRow | undefined;

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
    titleOrOpts?: string | { title?: string; sessionKey?: string },
  ): Promise<ConversationRecord> {
    const opts = typeof titleOrOpts === "string" ? { title: titleOrOpts } : titleOrOpts ?? {};
    const normalizedSessionKey = opts.sessionKey?.trim();
    if (normalizedSessionKey) {
      const byKey = await this.getConversationBySessionKey(normalizedSessionKey);
      if (byKey) {
        if (byKey.sessionId !== sessionId) {
          this.db
            .prepare(
              `UPDATE conversations SET session_id = ?, updated_at = datetime('now') WHERE conversation_id = ?`,
            )
            .run(sessionId, byKey.conversationId);
          byKey.sessionId = sessionId;
        }
        return byKey;
      }
    }

    const existing = await this.getConversationBySessionId(sessionId);
    if (existing) {
      if (!normalizedSessionKey) {
        return existing;
      }
      if (existing.active && !existing.sessionKey) {
        this.db
          .prepare(
            `UPDATE conversations SET session_key = ?, updated_at = datetime('now') WHERE conversation_id = ?`,
          )
          .run(normalizedSessionKey, existing.conversationId);
        existing.sessionKey = normalizedSessionKey;
        return existing;
      }
      if (existing.active && existing.sessionKey === normalizedSessionKey) {
        return existing;
      }
    }

    return this.createConversation({ sessionId, title: opts.title, sessionKey: normalizedSessionKey });
  }

  async markConversationBootstrapped(conversationId: ConversationId): Promise<void> {
    this.db
      .prepare(
        `UPDATE conversations
       SET bootstrapped_at = COALESCE(bootstrapped_at, datetime('now')),
           updated_at = datetime('now')
       WHERE conversation_id = ?`,
      )
      .run(conversationId);
  }

  async archiveConversation(conversationId: ConversationId): Promise<void> {
    this.db
      .prepare(
        `UPDATE conversations
       SET active = 0,
           archived_at = COALESCE(archived_at, datetime('now')),
           updated_at = datetime('now')
       WHERE conversation_id = ?`,
      )
      .run(conversationId);
  }

  // ── Message operations ────────────────────────────────────────────────────

  async createMessage(input: CreateMessageInput): Promise<MessageRecord> {
    const result = this.db
      .prepare(
        `INSERT INTO messages (conversation_id, seq, role, content, token_count, identity_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.conversationId,
        input.seq,
        input.role,
        input.content,
        input.tokenCount,
        input.identityHash ?? buildMessageIdentityHash(input.role, input.content),
      );

    const messageId = Number(result.lastInsertRowid);

    this.indexMessageForFullText(messageId, input.content);

    const row = this.db
      .prepare(
        `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
       FROM messages WHERE message_id = ?`,
      )
      .get(messageId) as unknown as MessageRow;

    return toMessageRecord(row);
  }

  async createMessagesBulk(inputs: CreateMessageInput[]): Promise<MessageRecord[]> {
    if (inputs.length === 0) {
      return [];
    }
    const insertStmt = this.db.prepare(
      `INSERT INTO messages (conversation_id, seq, role, content, token_count, identity_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const selectStmt = this.db.prepare(
      `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
       FROM messages WHERE message_id = ?`,
    );

    const records: MessageRecord[] = [];
    for (const input of inputs) {
      const result = insertStmt.run(
        input.conversationId,
        input.seq,
        input.role,
        input.content,
        input.tokenCount,
        input.identityHash ?? buildMessageIdentityHash(input.role, input.content),
      );

      const messageId = Number(result.lastInsertRowid);
      this.indexMessageForFullText(messageId, input.content);
      const row = selectStmt.get(messageId) as unknown as MessageRow;
      records.push(toMessageRecord(row));
    }

    return records;
  }

  async getMessages(
    conversationId: ConversationId,
    opts?: { afterSeq?: number; limit?: number },
  ): Promise<MessageRecord[]> {
    const afterSeq = opts?.afterSeq ?? -1;
    const limit = opts?.limit;

    if (limit != null) {
      const rows = this.db
        .prepare(
          `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
         FROM messages
         WHERE conversation_id = ? AND seq > ?
         ORDER BY seq
         LIMIT ?`,
        )
        .all(conversationId, afterSeq, limit) as unknown as MessageRow[];
      return rows.map(toMessageRecord);
    }

    const rows = this.db
      .prepare(
        `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
       FROM messages
       WHERE conversation_id = ? AND seq > ?
       ORDER BY seq`,
      )
      .all(conversationId, afterSeq) as unknown as MessageRow[];
    return rows.map(toMessageRecord);
  }

  async getLastMessage(conversationId: ConversationId): Promise<MessageRecord | null> {
    const row = this.db
      .prepare(
        `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
       FROM messages
       WHERE conversation_id = ?
       ORDER BY seq DESC
       LIMIT 1`,
      )
      .get(conversationId) as unknown as MessageRow | undefined;

    return row ? toMessageRecord(row) : null;
  }

  async hasMessage(
    conversationId: ConversationId,
    role: MessageRole,
    content: string,
  ): Promise<boolean> {
    const identityHash = buildMessageIdentityHash(role, content);
    const row = this.db
      .prepare(
        `SELECT 1 AS count
       FROM messages
       WHERE conversation_id = ? AND identity_hash = ? AND role = ? AND content = ?
       LIMIT 1`,
      )
      .get(conversationId, identityHash, role, content) as unknown as CountRow | undefined;

    return row?.count === 1;
  }

  async countMessagesByIdentity(
    conversationId: ConversationId,
    role: MessageRole,
    content: string,
  ): Promise<number> {
    const identityHash = buildMessageIdentityHash(role, content);
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
       FROM messages
       WHERE conversation_id = ? AND identity_hash = ? AND role = ? AND content = ?`,
      )
      .get(conversationId, identityHash, role, content) as unknown as CountRow | undefined;

    return row?.count ?? 0;
  }

  async getMessageById(messageId: MessageId): Promise<MessageRecord | null> {
    const row = this.db
      .prepare(
        `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
       FROM messages WHERE message_id = ?`,
      )
      .get(messageId) as unknown as MessageRow | undefined;
    return row ? toMessageRecord(row) : null;
  }

  async createMessageParts(messageId: MessageId, parts: CreateMessagePartInput[]): Promise<void> {
    if (parts.length === 0) {
      return;
    }

    const stmt = this.db.prepare(
      `INSERT INTO message_parts (
         part_id,
         message_id,
         session_id,
         part_type,
         ordinal,
         text_content,
         tool_call_id,
         tool_name,
         tool_input,
         tool_output,
         metadata
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const part of parts) {
      stmt.run(
        randomUUID(),
        messageId,
        part.sessionId,
        part.partType,
        part.ordinal,
        part.textContent ?? null,
        part.toolCallId ?? null,
        part.toolName ?? null,
        part.toolInput ?? null,
        part.toolOutput ?? null,
        part.metadata ?? null,
      );
    }
  }

  async getMessageParts(messageId: MessageId): Promise<MessagePartRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT
         part_id,
         message_id,
         session_id,
         part_type,
         ordinal,
         text_content,
         tool_call_id,
         tool_name,
         tool_input,
         tool_output,
         metadata
       FROM message_parts
       WHERE message_id = ?
       ORDER BY ordinal`,
      )
      .all(messageId) as unknown as MessagePartRow[];

    return rows.map(toMessagePartRecord);
  }

  async getMessageCount(conversationId: ConversationId): Promise<number> {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?`)
      .get(conversationId) as unknown as CountRow;
    return row?.count ?? 0;
  }

  async getMaxSeq(conversationId: ConversationId): Promise<number> {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) AS max_seq
       FROM messages WHERE conversation_id = ?`,
      )
      .get(conversationId) as unknown as MaxSeqRow;
    return row?.max_seq ?? 0;
  }

  // ── Deletion ──────────────────────────────────────────────────────────────

  /**
   * Delete messages and their associated records (context_items, FTS, message_parts).
   *
   * Skips messages referenced in summary_messages (already compacted) to avoid
   * breaking the summary DAG. Returns the count of actually deleted messages.
   */
  async deleteMessages(messageIds: MessageId[]): Promise<number> {
    if (messageIds.length === 0) {
      return 0;
    }

    let deleted = 0;
    for (const messageId of messageIds) {
      // Skip if referenced by a summary (ON DELETE RESTRICT would fail anyway)
      const refRow = this.db
        .prepare(`SELECT 1 AS found FROM summary_messages WHERE message_id = ? LIMIT 1`)
        .get(messageId) as unknown as { found: number } | undefined;
      if (refRow) {
        continue;
      }

      // Remove from context_items first (RESTRICT constraint)
      this.db
        .prepare(`DELETE FROM context_items WHERE item_type = 'message' AND message_id = ?`)
        .run(messageId);

      this.deleteMessageFromFullText(messageId);

      // Delete the message (message_parts cascade via ON DELETE CASCADE)
      this.db.prepare(`DELETE FROM messages WHERE message_id = ?`).run(messageId);

      deleted += 1;
    }

    return deleted;
  }

  // ── Search ────────────────────────────────────────────────────────────────

  async searchMessages(input: MessageSearchInput): Promise<MessageSearchResult[]> {
    const limit = input.limit ?? 50;

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

  private indexMessageForFullText(messageId: MessageId, content: string): void {
    if (!this.fts5Available) {
      return;
    }
    const normalizedContent = normalizeMessageContentForFullTextIndex(content);
    if (!normalizedContent) {
      return;
    }
    try {
      this.db
        .prepare(`INSERT INTO messages_fts(rowid, content) VALUES (?, ?)`)
        .run(messageId, normalizedContent);
    } catch {
      // Full-text indexing is optional. Message persistence must still succeed.
    }
  }

  private deleteMessageFromFullText(messageId: MessageId): void {
    if (!this.fts5Available) {
      return;
    }
    try {
      this.db.prepare(`DELETE FROM messages_fts WHERE rowid = ?`).run(messageId);
    } catch {
      // Ignore FTS cleanup failures; the source row deletion is authoritative.
    }
  }

  private searchFullText(
    query: string,
    limit: number,
    conversationId?: ConversationId,
    since?: Date,
    before?: Date,
    sort?: SearchSort,
  ): MessageSearchResult[] {
    const where: string[] = ["messages_fts MATCH ?"];
    const args: Array<string | number> = [sanitizeFts5Query(query)];
    if (conversationId != null) {
      where.push("m.conversation_id = ?");
      args.push(conversationId);
    }
    if (since) {
      where.push("julianday(m.created_at) >= julianday(?)");
      args.push(since.toISOString());
    }
    if (before) {
      where.push("julianday(m.created_at) < julianday(?)");
      args.push(before.toISOString());
    }
    args.push(limit);
    const orderBy = buildFtsOrderBy(sort, "m.created_at");

    const sql = `SELECT
         m.message_id,
         m.conversation_id,
         m.role,
         snippet(messages_fts, 0, '', '', '...', 32) AS snippet,
         rank,
         m.created_at
       FROM messages_fts
       JOIN messages m ON m.message_id = messages_fts.rowid
       WHERE ${where.join(" AND ")}
       ORDER BY ${orderBy}
       LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args) as unknown as MessageSearchRow[];
    return rows.map(toSearchResult);
  }

  private searchLike(
    query: string,
    limit: number,
    conversationId?: ConversationId,
    since?: Date,
    before?: Date,
  ): MessageSearchResult[] {
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
        `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
         FROM messages
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...args) as unknown as MessageRow[];

    return rows
      .map((row) => {
        const normalizedContent = normalizeMessageContentForFullTextIndex(row.content) ?? row.content;
        const haystack = normalizedContent.toLowerCase();
        const matchesAllTerms = plan.terms.every((term) => haystack.includes(term));
        if (!matchesAllTerms) {
          return null;
        }
        return {
          messageId: row.message_id,
          conversationId: row.conversation_id,
          role: row.role,
          snippet: createFallbackSnippet(normalizedContent, plan.terms),
          createdAt: parseUtcTimestamp(row.created_at),
          rank: 0,
        };
      })
      .filter((row): row is MessageSearchResult => row !== null);
  }

  private searchRegex(
    pattern: string,
    limit: number,
    conversationId?: ConversationId,
    since?: Date,
    before?: Date,
  ): MessageSearchResult[] {
    // SQLite has no native POSIX regex; fetch candidates and filter in JS
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
        `SELECT message_id, conversation_id, seq, role, content, token_count, created_at
         FROM messages
         ${whereClause}
         ORDER BY created_at DESC`,
      )
      .all(...args) as unknown as MessageRow[];

    const MAX_ROW_SCAN = 10_000;
    const results: MessageSearchResult[] = [];
    let scanned = 0;
    for (const row of rows) {
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
          createdAt: parseUtcTimestamp(row.created_at),
          rank: 0,
        });
      }
    }
    return results;
  }
}
