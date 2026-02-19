import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { sanitizeFts5Query } from "./fts5-sanitize.js";

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
  title?: string;
};

export type ConversationRecord = {
  conversationId: ConversationId;
  sessionId: string;
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

// ── ConversationStore ─────────────────────────────────────────────────────────

export class ConversationStore {
  constructor(private db: DatabaseSync) {}

  // ── Transaction helpers ──────────────────────────────────────────────────

  async withTransaction<T>(operation: () => Promise<T> | T): Promise<T> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = await operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // ── Conversation operations ───────────────────────────────────────────────

  async createConversation(input: CreateConversationInput): Promise<ConversationRecord> {
    const result = this.db
      .prepare(`INSERT INTO conversations (session_id, title) VALUES (?, ?)`)
      .run(input.sessionId, input.title ?? null);

    const row = this.db
      .prepare(
        `SELECT conversation_id, session_id, title, bootstrapped_at, created_at, updated_at
       FROM conversations WHERE conversation_id = ?`,
      )
      .get(Number(result.lastInsertRowid)) as unknown as ConversationRow;

    return toConversationRecord(row);
  }

  async getConversation(conversationId: ConversationId): Promise<ConversationRecord | null> {
    const row = this.db
      .prepare(
        `SELECT conversation_id, session_id, title, bootstrapped_at, created_at, updated_at
       FROM conversations WHERE conversation_id = ?`,
      )
      .get(conversationId) as unknown as ConversationRow | undefined;

    return row ? toConversationRecord(row) : null;
  }

  async getConversationBySessionId(sessionId: string): Promise<ConversationRecord | null> {
    const row = this.db
      .prepare(
        `SELECT conversation_id, session_id, title, bootstrapped_at, created_at, updated_at
       FROM conversations
       WHERE session_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      )
      .get(sessionId) as unknown as ConversationRow | undefined;

    return row ? toConversationRecord(row) : null;
  }

  async getOrCreateConversation(sessionId: string, title?: string): Promise<ConversationRecord> {
    const existing = await this.getConversationBySessionId(sessionId);
    if (existing) {
      return existing;
    }
    return this.createConversation({ sessionId, title });
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

  // ── Message operations ────────────────────────────────────────────────────

  async createMessage(input: CreateMessageInput): Promise<MessageRecord> {
    const result = this.db
      .prepare(
        `INSERT INTO messages (conversation_id, seq, role, content, token_count)
       VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.conversationId, input.seq, input.role, input.content, input.tokenCount);

    const messageId = Number(result.lastInsertRowid);

    // Index in FTS5
    this.db
      .prepare(`INSERT INTO messages_fts(rowid, content) VALUES (?, ?)`)
      .run(messageId, input.content);

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
      `INSERT INTO messages (conversation_id, seq, role, content, token_count)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertFtsStmt = this.db.prepare(`INSERT INTO messages_fts(rowid, content) VALUES (?, ?)`);
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
      );

      const messageId = Number(result.lastInsertRowid);
      insertFtsStmt.run(messageId, input.content);
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
    const row = this.db
      .prepare(
        `SELECT 1 AS count
       FROM messages
       WHERE conversation_id = ? AND role = ? AND content = ?
       LIMIT 1`,
      )
      .get(conversationId, role, content) as unknown as CountRow | undefined;

    return row?.count === 1;
  }

  async countMessagesByIdentity(
    conversationId: ConversationId,
    role: MessageRole,
    content: string,
  ): Promise<number> {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
       FROM messages
       WHERE conversation_id = ? AND role = ? AND content = ?`,
      )
      .get(conversationId, role, content) as unknown as CountRow | undefined;

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

      // Remove from FTS index
      this.db.prepare(`DELETE FROM messages_fts WHERE rowid = ?`).run(messageId);

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
      return this.searchFullText(
        input.query,
        limit,
        input.conversationId,
        input.since,
        input.before,
      );
    }
    return this.searchRegex(input.query, limit, input.conversationId, input.since, input.before);
  }

  private searchFullText(
    query: string,
    limit: number,
    conversationId?: ConversationId,
    since?: Date,
    before?: Date,
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
       ORDER BY m.created_at DESC
       LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args) as unknown as MessageSearchRow[];
    return rows.map(toSearchResult);
  }

  private searchRegex(
    pattern: string,
    limit: number,
    conversationId?: ConversationId,
    since?: Date,
    before?: Date,
  ): MessageSearchResult[] {
    // SQLite has no native POSIX regex; fetch candidates and filter in JS
    const re = new RegExp(pattern);

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

    const results: MessageSearchResult[] = [];
    for (const row of rows) {
      if (results.length >= limit) {
        break;
      }
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
}
