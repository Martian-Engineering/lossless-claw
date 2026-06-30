import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { withDatabaseTransaction } from "../transaction-mutex.js";
import { appendConversationScopeConstraint } from "./conversation-scope.js";
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
  /**
   * Optional historical message timestamp, used by transcript recovery imports.
   * Runtime ingests omit this and keep the store's current timestamp behavior.
   */
  createdAt?: Date | string;
  /**
   * Stable JSONL envelope id of the transcript entry this message was
   * imported from. Enforced unique per conversation (partial index), so
   * transcript replays cannot duplicate rows. Null/undefined for runtime
   * ingests and envelope-less transcripts.
   */
  transcriptEntryId?: string | null;
  // Use only when the caller is intentionally importing a fresh transcript epoch.
  skipReplayTimestampFloodGuard?: boolean;
};

type PreparedMessageInsert = CreateMessageInput & {
  createdAt: string;
  identityHash: string;
};

type ExternalReplayFloodGroup = {
  scope: "external";
  conversationId: ConversationId;
  role: "user";
  createdAt: string;
  candidateCount: number;
};

type InternalReplayFloodGroup = {
  scope: "internal";
  conversationId: ConversationId;
  role: Exclude<MessageRole, "user">;
  content: string;
  identityHash: string;
  createdAt: string;
  candidateCount: number;
};

type ReplayFloodGroup = ExternalReplayFloodGroup | InternalReplayFloodGroup;

export type MessageRecord = {
  messageId: MessageId;
  conversationId: ConversationId;
  seq: number;
  role: MessageRole;
  content: string;
  tokenCount: number;
  createdAt: Date;
  /**
   * v4.2 §B — non-null when the row has been stratified into a
   * stubbable payload via lcm-blob-migrate.mjs. Stores the externalized
   * `file_xxx` id (in `large_files`); the assembler reads this to
   * decide whether an evictable tool result can be replaced with a
   * compact `[LCM Tool Output: file_xxx | …]` reference.
   */
  largeContent: string | null;
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

/** Normalized provenance for a conversation archive, set at the archive funnel. */
export type ArchiveCause =
  | "manual-reset"
  | "session-deleted"
  | "session-end"
  | "rollover-fallback"
  | "cron-rotation";

// Causes the rollover-split doctor must never auto-restore. Ships with
// `manual-reset` only: a deliberate operator wipe is rock-solid intent. The other
// causes are recorded but stay merge-eligible because the safe direction is
// over-restore (today's behavior); promoting `session-deleted` once the host
// deletion contract is confirmed is a one-line follow-up.
export const DELIBERATE_ARCHIVE_CAUSES: ReadonlySet<ArchiveCause> = new Set(["manual-reset"]);

export type MessageSearchInput = {
  conversationId?: ConversationId;
  conversationIds?: ConversationId[];
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
  // v4.2 §B — sidecar fileId column. Optional in row shape because not
  // every SELECT projects it; mappers tolerate undefined → null.
  large_content?: string | null;
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

interface TimestampRow {
  created_at: string;
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

function formatMessageCreatedAt(value: Date | string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value instanceof Date) {
    return Number.isFinite(value.getTime())
      ? value.toISOString().slice(0, 19).replace("T", " ")
      : undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = parseUtcTimestampOrNull(trimmed);
  if (parsed && Number.isFinite(parsed.getTime())) {
    return parsed.toISOString().slice(0, 19).replace("T", " ");
  }
  return undefined;
}

function toMessageRecord(row: MessageRow): MessageRecord {
  return {
    largeContent: row.large_content ?? null,
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

/** Normalize persisted message text before indexing it in the message FTS table. */
export function normalizeMessageContentForFullTextIndex(content: string): string | null {
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
    // Filter both legacy "Use lcm_describe …" and v4.2 "Call lcm_describe(…)"
    // hint lines so they don't pollute the FTS index for unrelated queries.
    if (line.startsWith("Use lcm_describe") || line.startsWith("Call lcm_describe")) {
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
  private readonly replayFloodThresholdExternal: number;
  private readonly replayFloodThresholdInternal: number;

  constructor(
    private db: DatabaseSync,
    options?: {
      fts5Available?: boolean;
      /**
       * Anti-replay threshold for EXTERNAL-input roles (currently `user`).
       * Defaults to 3 (legacy behaviour).
       */
      replayFloodThresholdExternal?: number;
      /**
       * Anti-replay threshold for INTERNAL-runtime roles
       * (`tool` | `assistant` | `system`). Defaults to 32 to absorb legitimate
       * fast-burst idempotent retries (e.g. cron sub-agent making many tool
       * calls returning identical results within the same SQLite-second).
       */
      replayFloodThresholdInternal?: number;
    },
  ) {
    this.fts5Available = options?.fts5Available ?? true;
    this.replayFloodThresholdExternal = options?.replayFloodThresholdExternal ?? 3;
    this.replayFloodThresholdInternal = options?.replayFloodThresholdInternal ?? 32;
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
        const existing = await this.getActiveConversationBySessionId(input.sessionId);
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

  private async getActiveConversationBySessionId(
    sessionId: string,
  ): Promise<ConversationRecord | null> {
    const row = this.db
      .prepare(
        `SELECT conversation_id, session_id, session_key, active, archived_at, title, bootstrapped_at, created_at, updated_at
       FROM conversations
       WHERE session_id = ?
         AND active = 1
       ORDER BY created_at DESC
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

  async getConversationFamilyIds(input: {
    conversationId?: ConversationId;
    sessionId?: string;
    sessionKey?: string;
  }): Promise<ConversationId[]> {
    const baseConversation =
      input.conversationId != null
        ? await this.getConversation(input.conversationId)
        : await this.getConversationForSession({
            sessionId: input.sessionId,
            sessionKey: input.sessionKey,
          });
    if (!baseConversation) {
      return [];
    }

    const normalizedSessionKey = baseConversation.sessionKey?.trim();
    if (normalizedSessionKey) {
      const rows = this.db
        .prepare(
          `SELECT conversation_id
           FROM conversations
           WHERE session_key = ?
           ORDER BY active DESC, created_at DESC, conversation_id DESC`,
        )
        .all(normalizedSessionKey) as Array<{ conversation_id: number }>;
      return rows.map((row) => row.conversation_id);
    }

    const rows = this.db
      .prepare(
        `SELECT conversation_id
         FROM conversations
         WHERE session_id = ?
         ORDER BY active DESC, created_at DESC, conversation_id DESC`,
      )
      .all(baseConversation.sessionId) as Array<{ conversation_id: number }>;
    return rows.map((row) => row.conversation_id);
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

    return this.getActiveConversationBySessionId(normalizedSessionId);
  }

  /** List active conversations that may own live session storage. */
  async listActiveConversations(limit?: number): Promise<ConversationRecord[]> {
    const normalizedLimit =
      typeof limit === "number" && Number.isFinite(limit) && limit > 0
        ? Math.floor(limit)
        : 1000;
    const rows = this.db
      .prepare(
        `SELECT conversation_id, session_id, session_key, active, archived_at, title, bootstrapped_at, created_at, updated_at
         FROM conversations
         WHERE active = 1
         ORDER BY updated_at DESC, conversation_id DESC
         LIMIT ?`,
      )
      .all(normalizedLimit) as unknown as ConversationRow[];

    return rows.map(toConversationRecord);
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

    const existing = await this.getActiveConversationBySessionId(sessionId);
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

  // Single archive funnel: deliberate archives must flow through here with their
  // cause. The direct-insert archived-row path (createConversation active:false)
  // leaves archive_cause NULL = merge-eligible by design.
  async archiveConversation(conversationId: ConversationId, cause: ArchiveCause): Promise<void> {
    this.db
      .prepare(
        `UPDATE conversations
       SET active = 0,
           archived_at = COALESCE(archived_at, datetime('now')),
           archive_cause = COALESCE(archive_cause, ?),
           updated_at = datetime('now')
       WHERE conversation_id = ?`,
      )
      .run(cause, conversationId);
  }

  async rebindConversationSession(
    conversationId: ConversationId,
    sessionId: string,
    sessionKey?: string | null,
  ): Promise<ConversationRecord | null> {
    const normalizedSessionId = sessionId.trim();
    const normalizedSessionKey = sessionKey?.trim() || null;
    if (!normalizedSessionId) {
      return this.getConversation(conversationId);
    }
    this.db
      .prepare(
        `UPDATE conversations
         SET session_id = ?,
             session_key = COALESCE(?, session_key),
             active = 1,
             archived_at = NULL,
             updated_at = datetime('now')
         WHERE conversation_id = ?`,
      )
      .run(normalizedSessionId, normalizedSessionKey, conversationId);
    return this.getConversation(conversationId);
  }

  // ── Message operations ────────────────────────────────────────────────────

  async createMessage(input: CreateMessageInput): Promise<MessageRecord> {
    const prepared = this.prepareMessageInsert(input);
    if (!prepared.skipReplayTimestampFloodGuard) {
      this.assertNoReplayTimestampFlood([prepared]);
    }

    const result = this.db
      .prepare(
        `INSERT INTO messages (conversation_id, seq, role, content, token_count, identity_hash, transcript_entry_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        prepared.conversationId,
        prepared.seq,
        prepared.role,
        prepared.content,
        prepared.tokenCount,
        prepared.identityHash,
        prepared.transcriptEntryId ?? null,
        prepared.createdAt,
      );

    const messageId = Number(result.lastInsertRowid);

    this.indexMessageForFullText(messageId, input.content);

    const row = this.db
      .prepare(
        `SELECT message_id, conversation_id, seq, role, content, token_count, created_at, large_content
       FROM messages WHERE message_id = ?`,
      )
      .get(messageId) as unknown as MessageRow;

    return toMessageRecord(row);
  }

  async createMessagesBulk(inputs: CreateMessageInput[]): Promise<MessageRecord[]> {
    if (inputs.length === 0) {
      return [];
    }
    const createdAt = this.currentSqliteTimestamp();
    const preparedInputs = inputs.map((input) => this.prepareMessageInsert(input, createdAt));
    this.assertNoReplayTimestampFlood(
      preparedInputs.filter((input) => !input.skipReplayTimestampFloodGuard),
    );

    const insertStmt = this.db.prepare(
      `INSERT INTO messages (conversation_id, seq, role, content, token_count, identity_hash, transcript_entry_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const selectStmt = this.db.prepare(
      `SELECT message_id, conversation_id, seq, role, content, token_count, created_at, large_content
       FROM messages WHERE message_id = ?`,
    );

    const records: MessageRecord[] = [];
    for (const input of preparedInputs) {
      const result = insertStmt.run(
        input.conversationId,
        input.seq,
        input.role,
        input.content,
        input.tokenCount,
        input.identityHash,
        input.transcriptEntryId ?? null,
        input.createdAt,
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
          `SELECT message_id, conversation_id, seq, role, content, token_count, created_at, large_content
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
        `SELECT message_id, conversation_id, seq, role, content, token_count, created_at, large_content
       FROM messages
       WHERE conversation_id = ? AND seq > ?
       ORDER BY seq`,
      )
      .all(conversationId, afterSeq) as unknown as MessageRow[];
    return rows.map(toMessageRecord);
  }

  /** Last `count` messages in seq order (oldest of the tail first). */
  async getLastMessages(conversationId: ConversationId, count: number): Promise<MessageRecord[]> {
    if (count <= 0) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT message_id, conversation_id, seq, role, content, token_count, created_at, large_content
       FROM messages
       WHERE conversation_id = ?
       ORDER BY seq DESC
       LIMIT ?`,
      )
      .all(conversationId, Math.floor(count)) as unknown as MessageRow[];
    return rows.reverse().map(toMessageRecord);
  }

  async getLastMessage(conversationId: ConversationId): Promise<MessageRecord | null> {
    const row = this.db
      .prepare(
        `SELECT message_id, conversation_id, seq, role, content, token_count, created_at, large_content
       FROM messages
       WHERE conversation_id = ?
       ORDER BY seq DESC
       LIMIT 1`,
      )
      .get(conversationId) as unknown as MessageRow | undefined;

    return row ? toMessageRecord(row) : null;
  }

  /** Return the persisted identity hash for the newest message in a conversation. */
  async getLastMessageIdentityHash(conversationId: ConversationId): Promise<string | null> {
    const row = this.db
      .prepare(
        `SELECT identity_hash FROM messages
       WHERE conversation_id = ?
       ORDER BY seq DESC
       LIMIT 1`,
      )
      .get(conversationId) as { identity_hash: string | null } | undefined;
    return row?.identity_hash ?? null;
  }

  /** Return the newest `limit` persisted identity hashes in ascending seq order. */
  async getRecentMessageIdentityHashes(
    conversationId: ConversationId,
    limit: number,
  ): Promise<string[]> {
    const rows = this.db
      .prepare(
        `SELECT identity_hash FROM messages
       WHERE conversation_id = ?
       ORDER BY seq DESC
       LIMIT ?`,
      )
      .all(conversationId, limit) as { identity_hash: string | null }[];
    return rows
      .map((r) => r.identity_hash)
      .filter((h): h is string => h !== null)
      .reverse();
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

  async hasMessageByTranscriptEntryId(
    conversationId: ConversationId,
    transcriptEntryId: string,
  ): Promise<boolean> {
    const row = this.db
      .prepare(
        `SELECT 1 AS count
       FROM messages
       WHERE conversation_id = ? AND transcript_entry_id = ?
       LIMIT 1`,
      )
      .get(conversationId, transcriptEntryId) as unknown as CountRow | undefined;

    return row?.count === 1;
  }

  /**
   * Stamp a transcript entry id onto the earliest identity-matching row that
   * has none. Heals rows persisted from the runtime array (flush lag) or
   * before the entry-id migration when the transcript later delivers the
   * same message with its envelope id, instead of importing a duplicate.
   * Returns true when a row was adopted.
   */
  async adoptTranscriptEntryId(
    conversationId: ConversationId,
    role: MessageRole,
    content: string,
    transcriptEntryId: string,
  ): Promise<boolean> {
    const identityHash = buildMessageIdentityHash(role, content);
    const result = this.db
      .prepare(
        `UPDATE messages
       SET transcript_entry_id = ?
       WHERE message_id = (
         SELECT message_id
         FROM messages
         WHERE conversation_id = ?
           AND transcript_entry_id IS NULL
           AND identity_hash = ?
           AND role = ?
           AND content = ?
         ORDER BY seq
         LIMIT 1
       )`,
      )
      .run(transcriptEntryId, conversationId, identityHash, role, content);
    return result.changes > 0;
  }

  /**
   * List identity-matching rows that already carry a transcript entry id,
   * oldest first. The engine compares these ids against the transcript's
   * current leaf path to find rows stranded by a host history rewrite
   * (rewriteTranscriptEntries re-appends the suffix under new ids).
   */
  async listTranscriptEntryIdsByIdentity(
    conversationId: ConversationId,
    role: MessageRole,
    content: string,
  ): Promise<Array<{ messageId: number; transcriptEntryId: string }>> {
    const identityHash = buildMessageIdentityHash(role, content);
    const rows = this.db
      .prepare(
        `SELECT message_id, transcript_entry_id
       FROM messages
       WHERE conversation_id = ?
         AND transcript_entry_id IS NOT NULL
         AND identity_hash = ?
         AND role = ?
         AND content = ?
       ORDER BY seq`,
      )
      .all(conversationId, identityHash, role, content) as unknown as Array<{
      message_id: number;
      transcript_entry_id: string;
    }>;
    return rows.map((row) => ({
      messageId: row.message_id,
      transcriptEntryId: row.transcript_entry_id,
    }));
  }

  /**
   * Replace a row's stale transcript entry id with the id the host re-issued
   * for the same message. Returns false when the new id already exists for
   * the conversation (unique-index race: another path imported it first).
   */
  async restampTranscriptEntryId(
    messageId: number,
    transcriptEntryId: string,
  ): Promise<boolean> {
    try {
      const result = this.db
        .prepare(`UPDATE messages SET transcript_entry_id = ? WHERE message_id = ?`)
        .run(transcriptEntryId, messageId);
      return result.changes > 0;
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
        return false;
      }
      throw error;
    }
  }

  /** Return the subset of `entryIds` that already exist for the conversation. */
  async filterExistingTranscriptEntryIds(
    conversationId: ConversationId,
    entryIds: readonly string[],
  ): Promise<Set<string>> {
    const existing = new Set<string>();
    const chunkSize = 400;
    for (let start = 0; start < entryIds.length; start += chunkSize) {
      const chunk = entryIds.slice(start, start + chunkSize);
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.db
        .prepare(
          `SELECT transcript_entry_id
         FROM messages
         WHERE conversation_id = ? AND transcript_entry_id IN (${placeholders})`,
        )
        .all(conversationId, ...chunk) as unknown as Array<{ transcript_entry_id: string }>;
      for (const row of rows) {
        existing.add(row.transcript_entry_id);
      }
    }
    return existing;
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

  /** Newest persisted transcript entry id (by seq), or null when none. */
  async getNewestTranscriptEntryId(conversationId: ConversationId): Promise<string | null> {
    const row = this.db
      .prepare(
        `SELECT transcript_entry_id AS id
       FROM messages
       WHERE conversation_id = ? AND transcript_entry_id IS NOT NULL
       ORDER BY seq DESC
       LIMIT 1`,
      )
      .get(conversationId) as unknown as { id?: string } | undefined;
    return row?.id ?? null;
  }

  /**
   * Whether an identity-matching row WITHIN THE TAIL WINDOW exists that has
   * NOT been stamped with a transcript entry id — i.e. a flush-lagged
   * runtime row (persisted moments ago, always tail-adjacent) that a
   * transcript catch-up entry should adopt instead of importing a
   * duplicate. Legacy pre-migration rows deeper in history also lack entry
   * ids but are NOT flush lag; matching them would defer every repeated
   * content and mis-target adoption.
   */
  async hasRecentUnstampedMessageByIdentity(
    conversationId: ConversationId,
    role: MessageRole,
    content: string,
    tailWindow: number,
  ): Promise<boolean> {
    const identityHash = buildMessageIdentityHash(role, content);
    const row = this.db
      .prepare(
        `SELECT 1 AS found
       FROM (
         SELECT message_id, transcript_entry_id, identity_hash, role, content
         FROM messages
         WHERE conversation_id = ?
         ORDER BY seq DESC
         LIMIT ?
       )
       WHERE transcript_entry_id IS NULL
         AND identity_hash = ?
         AND role = ?
         AND content = ?
       LIMIT 1`,
      )
      .get(conversationId, Math.max(1, Math.floor(tailWindow)), identityHash, role, content) as unknown as
      | { found?: number }
      | undefined;
    return row?.found === 1;
  }

  /**
   * Whether the newest persisted row has the same identity hash and preserved
   * reasoning content. Used to dedup adjacent delivery-mirror messages whose
   * text content is already covered by the immediately preceding response entry.
   */
  async hasPreviousReasonedMessageByIdentity(
    conversationId: ConversationId,
    role: MessageRole,
    content: string,
  ): Promise<boolean> {
    const identityHash = buildMessageIdentityHash(role, content);
    const row = this.db
      .prepare(
        `SELECT 1 AS found
       FROM (
         SELECT message_id, identity_hash, role, content
         FROM messages
         WHERE conversation_id = ?
         ORDER BY seq DESC
         LIMIT 1
       ) AS newest
       WHERE newest.identity_hash = ?
         AND newest.role = ?
         AND newest.content = ?
         AND EXISTS (
           SELECT 1
           FROM message_parts AS part
           WHERE part.message_id = newest.message_id
             AND (
               part.part_type = 'reasoning'
               OR (
                 part.metadata IS NOT NULL
                 AND json_valid(part.metadata)
                 AND json_extract(part.metadata, '$.topLevelReasoningField') = 'reasoning_content'
                 AND json_type(part.metadata, '$.topLevelReasoningContent') = 'text'
                 AND length(json_extract(part.metadata, '$.topLevelReasoningContent')) > 0
               )
             )
         )
       LIMIT 1`,
      )
      .get(conversationId, identityHash, role, content) as unknown as { found?: number } | undefined;
    return row?.found === 1;
  }

  async countMessagesByIdentityHash(
    conversationId: ConversationId,
    role: MessageRole,
    identityHash: string,
  ): Promise<number> {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
       FROM messages
       WHERE conversation_id = ? AND identity_hash = ? AND role = ?`,
      )
      .get(conversationId, identityHash, role) as unknown as CountRow | undefined;

    return row?.count ?? 0;
  }

  async countMessagesByIdentityBeforeTimestamp(params: {
    conversationId: ConversationId;
    role: MessageRole;
    content: string;
    beforeCreatedAt: string;
  }): Promise<number> {
    return this.countMessagesByIdentityBeforeTimestampSync(params);
  }

  private countMessagesByIdentityBeforeTimestampSync(params: {
    conversationId: ConversationId;
    role: MessageRole;
    content: string;
    beforeCreatedAt: string;
  }): number {
    const identityHash = buildMessageIdentityHash(params.role, params.content);
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
       FROM messages
       WHERE conversation_id = ?
         AND identity_hash = ?
         AND role = ?
         AND content = ?
         AND created_at < ?`,
      )
      .get(
        params.conversationId,
        identityHash,
        params.role,
        params.content,
        params.beforeCreatedAt,
      ) as unknown as CountRow | undefined;

    return row?.count ?? 0;
  }

  async getMessageById(messageId: MessageId): Promise<MessageRecord | null> {
    const row = this.db
      .prepare(
        `SELECT message_id, conversation_id, seq, role, content, token_count, created_at, large_content
       FROM messages WHERE message_id = ?`,
      )
      .get(messageId) as unknown as MessageRow | undefined;
    return row ? toMessageRecord(row) : null;
  }

  /** Return the most recent message whose `large_content` sidecar references the given file id. */
  async getMessageByLargeContent(fileId: string): Promise<MessageRecord | null> {
    const row = this.db
      .prepare(
        `SELECT message_id, conversation_id, seq, role, content, token_count, created_at, large_content
       FROM messages
       WHERE large_content = ?
       ORDER BY seq DESC
       LIMIT 1`,
      )
      .get(fileId) as unknown as MessageRow | undefined;
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
          input.conversationIds,
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
            input.conversationIds,
            input.since,
            input.before,
            input.sort,
          );
        } catch {
          return this.searchLike(
            input.query,
            limit,
            input.conversationId,
            input.conversationIds,
            input.since,
            input.before,
          );
        }
      }
      return this.searchLike(
        input.query,
        limit,
        input.conversationId,
        input.conversationIds,
        input.since,
        input.before,
      );
    }
    return this.searchRegex(
      input.query,
      limit,
      input.conversationId,
      input.conversationIds,
      input.since,
      input.before,
    );
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

  private currentSqliteTimestamp(): string {
    const row = this.db
      .prepare(`SELECT datetime('now') AS created_at`)
      .get() as unknown as TimestampRow;
    return row.created_at;
  }

  private prepareMessageInsert(
    input: CreateMessageInput,
    createdAt = this.currentSqliteTimestamp(),
  ): PreparedMessageInsert {
    return {
      ...input,
      createdAt: formatMessageCreatedAt(input.createdAt) ?? createdAt,
      identityHash: input.identityHash ?? buildMessageIdentityHash(input.role, input.content),
    };
  }

  /**
   * Count already-persisted replay rows for one exact message identity at a
   * timestamp. The guard's threshold is per identical message tuple, not per
   * role-wide same-second burst.
   */
  private countExistingReplayRowsAtTimestampForIdentity(
    conversationId: ConversationId,
    role: MessageRole,
    identityHash: string,
    content: string,
    createdAt: string,
  ): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
       FROM messages AS m
       WHERE m.conversation_id = ?
         AND m.role = ?
         AND m.identity_hash = ?
         AND m.content = ?
         AND m.created_at = ?
         AND length(m.content) > 0
         AND EXISTS (
           SELECT 1
           FROM messages AS prior
           WHERE prior.conversation_id = m.conversation_id
             AND prior.identity_hash = m.identity_hash
             AND prior.role = m.role
             AND prior.content = m.content
             AND prior.created_at < m.created_at
         )`,
      )
      .get(conversationId, role, identityHash, content, createdAt) as unknown as
        | CountRow
        | undefined;
    return row?.count ?? 0;
  }

  /**
   * Count already-persisted replay rows across one role and timestamp. This is
   * used only for external user input so distinct rebroadcasted user messages
   * share the same replay budget.
   */
  private countExistingReplayRowsAtTimestampForRole(
    conversationId: ConversationId,
    role: "user",
    createdAt: string,
  ): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
       FROM messages AS m
       WHERE m.conversation_id = ?
         AND m.role = ?
         AND m.created_at = ?
         AND length(m.content) > 0
         AND EXISTS (
           SELECT 1
           FROM messages AS prior
           WHERE prior.conversation_id = m.conversation_id
             AND prior.identity_hash = m.identity_hash
             AND prior.role = m.role
             AND prior.content = m.content
             AND prior.created_at < m.created_at
         )`,
      )
      .get(conversationId, role, createdAt) as unknown as CountRow | undefined;
    return row?.count ?? 0;
  }

  /**
   * Anti-replay guard against floods of identical messages at the same SQLite
   * `created_at` second. SQLite's `datetime('now')` has second-level
   * granularity, so legitimate fast bursts can collide with malicious replays
   * on the raw (conversation, content, created_at) tuple.
   *
   * Role-aware policy (#639 fix):
   *   - role=user        → EXTERNAL input, threshold `replayFloodThresholdExternal`
   *                        (default 3). Preserves classic defense against
   *                        webhook/input rebroadcast attacks.
   *   - role=tool|assistant|system → INTERNAL runtime output, threshold
   *                        `replayFloodThresholdInternal` (default 32).
   *                        Tool results and assistant deltas can legitimately
   *                        repeat (idempotent retries, status pings, etc.) and
   *                        are not vulnerable to third-party rebroadcast.
   *
   * External user input keeps an aggregate role/timestamp budget to preserve
   * replay defense. Internal runtime output uses exact message identity so
   * distinct same-second tool results do not consume each other's budget.
   */
  private assertNoReplayTimestampFlood(inputs: PreparedMessageInsert[]): void {
    if (inputs.length === 0) {
      return;
    }

    const replicatedByGroup = new Map<string, ReplayFloodGroup>();
    for (const input of inputs) {
      if (input.content.length === 0) {
        continue;
      }
      const priorCount = this.countMessagesByIdentityBeforeTimestampSync({
        conversationId: input.conversationId,
        role: input.role,
        content: input.content,
        beforeCreatedAt: input.createdAt,
      });
      if (priorCount === 0) {
        continue;
      }
      const key = input.role === "user"
        ? JSON.stringify([input.conversationId, input.role, input.createdAt])
        : JSON.stringify([
            input.conversationId,
            input.role,
            input.identityHash,
            input.content,
            input.createdAt,
          ]);
      const group = replicatedByGroup.get(key);
      if (group) {
        group.candidateCount += 1;
      } else if (input.role === "user") {
        replicatedByGroup.set(key, {
          scope: "external",
          conversationId: input.conversationId,
          role: input.role,
          createdAt: input.createdAt,
          candidateCount: 1,
        });
      } else {
        replicatedByGroup.set(key, {
          scope: "internal",
          conversationId: input.conversationId,
          role: input.role,
          content: input.content,
          identityHash: input.identityHash,
          createdAt: input.createdAt,
          candidateCount: 1,
        });
      }
    }

    for (const group of replicatedByGroup.values()) {
      const existingCount = group.scope === "external"
        ? this.countExistingReplayRowsAtTimestampForRole(
            group.conversationId,
            group.role,
            group.createdAt,
          )
        : this.countExistingReplayRowsAtTimestampForIdentity(
            group.conversationId,
            group.role,
            group.identityHash,
            group.content,
            group.createdAt,
          );
      const replicatedCount = existingCount + group.candidateCount;
      const threshold = this.replayFloodThresholdForRole(group.role);
      if (replicatedCount >= threshold) {
        throw new Error(
          `[lcm] refused replay-like message batch: conversation=${group.conversationId} role=${group.role} createdAt=${group.createdAt} replicatedRows=${replicatedCount} threshold=${threshold}`,
        );
      }
    }
  }

  private replayFloodThresholdForRole(role: string): number {
    // External-input role: user messages are the rebroadcast surface.
    if (role === "user") return this.replayFloodThresholdExternal;
    // Internal-runtime roles: tool, assistant, system.
    return this.replayFloodThresholdInternal;
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
    conversationIds?: ConversationId[],
    since?: Date,
    before?: Date,
    sort?: SearchSort,
  ): MessageSearchResult[] {
    const where: string[] = ["messages_fts MATCH ?"];
    const args: Array<string | number> = [sanitizeFts5Query(query)];
    appendConversationScopeConstraint({
      where,
      args,
      columnExpr: "m.conversation_id",
      conversationId,
      conversationIds,
    });
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
    conversationIds?: ConversationId[],
    since?: Date,
    before?: Date,
  ): MessageSearchResult[] {
    const plan = buildLikeSearchPlan("content", query);
    if (plan.terms.length === 0) {
      return [];
    }

    const where: string[] = [...plan.where];
    const args: Array<string | number> = [...plan.args];
    appendConversationScopeConstraint({
      where,
      args,
      columnExpr: "conversation_id",
      conversationId,
      conversationIds,
    });
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
        `SELECT message_id, conversation_id, seq, role, content, token_count, created_at, large_content
         FROM messages
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(...args) as unknown as MessageRow[];

    return rows
      .map((row): MessageSearchResult | null => {
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
    conversationIds?: ConversationId[],
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
    appendConversationScopeConstraint({
      where,
      args,
      columnExpr: "conversation_id",
      conversationId,
      conversationIds,
    });
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
        `SELECT message_id, conversation_id, seq, role, content, token_count, created_at, large_content
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
