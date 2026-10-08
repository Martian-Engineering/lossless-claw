import type { DatabaseSync } from "node:sqlite";

/** Mode marker for conversations that ingest only through the visible delta. */
export const TRANSCRIPT_CURSOR_MODE = "cursor_v1";

/** How a conversation entered cursor mode; recorded for diagnostics only. */
export type TranscriptCursorOrigin = "fresh" | "legacy-migration";

/** Persisted watermark into OpenClaw's visible transcript delta. */
export type TranscriptCursorRecord = {
  conversationId: number;
  mode: typeof TRANSCRIPT_CURSOR_MODE;
  /** Opaque host cursor; stored and returned unchanged. */
  cursor: string;
  /** Entry id of the last visible message the cursor has passed. */
  frontierEntryId: string | null;
  /** Visible ordinal (message position + 1) of that entry. */
  frontierSeq: number | null;
  origin: TranscriptCursorOrigin;
};

/** One stored row as seen by bulk resync reconciliation. */
export type StoredTranscriptRow = {
  messageId: number;
  seq: number;
  identityHash: string | null;
  transcriptEntryId: string | null;
};

type CursorRow = {
  conversation_id: number;
  mode: typeof TRANSCRIPT_CURSOR_MODE;
  cursor: string;
  frontier_entry_id: string | null;
  frontier_seq: number | null;
  origin: TranscriptCursorOrigin;
};

type StoredRow = {
  message_id: number;
  seq: number;
  identity_hash: string | null;
  transcript_entry_id: string | null;
};

/**
 * Storage for per-conversation transcript cursors and the bulk row lookups
 * that cursor resync needs. Every query here is a single set-oriented
 * statement so resync cost does not grow with per-entry round trips.
 */
export class TranscriptCursorStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Return the cursor row for a conversation, or null for legacy/unknown conversations. */
  get(conversationId: number): TranscriptCursorRecord | null {
    const row = this.db
      .prepare(
        `SELECT conversation_id, mode, cursor, frontier_entry_id, frontier_seq, origin
         FROM conversation_transcript_cursors
         WHERE conversation_id = ?`,
      )
      .get(conversationId) as CursorRow | undefined;
    if (!row) {
      return null;
    }
    return {
      conversationId: row.conversation_id,
      mode: row.mode,
      cursor: row.cursor,
      frontierEntryId: row.frontier_entry_id,
      frontierSeq: row.frontier_seq,
      origin: row.origin,
    };
  }

  /**
   * Insert or advance a conversation's cursor. `origin` is only written on
   * insert so the first entry into cursor mode stays visible in diagnostics.
   */
  upsert(input: {
    conversationId: number;
    cursor: string;
    frontierEntryId: string | null;
    frontierSeq: number | null;
    origin: TranscriptCursorOrigin;
  }): void {
    this.db
      .prepare(
        `INSERT INTO conversation_transcript_cursors (
           conversation_id, mode, cursor, frontier_entry_id, frontier_seq, origin
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (conversation_id) DO UPDATE SET
           cursor = excluded.cursor,
           frontier_entry_id = excluded.frontier_entry_id,
           frontier_seq = excluded.frontier_seq,
           updated_at = datetime('now')`,
      )
      .run(
        input.conversationId,
        TRANSCRIPT_CURSOR_MODE,
        input.cursor,
        input.frontierEntryId,
        input.frontierSeq,
        input.origin,
      );
  }

  /** Map every stamped transcript entry id of a conversation to its row. */
  listStampedRows(conversationId: number): Map<string, StoredTranscriptRow> {
    const rows = this.db
      .prepare(
        `SELECT message_id, seq, identity_hash, transcript_entry_id
         FROM messages
         WHERE conversation_id = ? AND transcript_entry_id IS NOT NULL`,
      )
      .all(conversationId) as StoredRow[];
    const byEntryId = new Map<string, StoredTranscriptRow>();
    for (const row of rows) {
      byEntryId.set(row.transcript_entry_id!, toStoredTranscriptRow(row));
    }
    return byEntryId;
  }

  /** List rows after `afterSeq` in conversation order, for suffix content matching. */
  listRowsAfterSeq(conversationId: number, afterSeq: number): StoredTranscriptRow[] {
    const rows = this.db
      .prepare(
        `SELECT message_id, seq, identity_hash, transcript_entry_id
         FROM messages
         WHERE conversation_id = ? AND seq > ?
         ORDER BY seq`,
      )
      .all(conversationId, afterSeq) as StoredRow[];
    return rows.map(toStoredTranscriptRow);
  }
}

function toStoredTranscriptRow(row: StoredRow): StoredTranscriptRow {
  return {
    messageId: row.message_id,
    seq: row.seq,
    identityHash: row.identity_hash,
    transcriptEntryId: row.transcript_entry_id,
  };
}
