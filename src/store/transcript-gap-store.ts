import type { DatabaseSync } from "node:sqlite";

/**
 * One run of visible transcript entries that LCM never stored and that sits
 * between two stored rows with nothing stored between them.
 */
export type TranscriptHistoryGap = {
  firstEntryId: string;
  lastEntryId: string;
  /** Visible ordinal (message position + 1) of the first entry in the run. */
  firstVisibleSeq: number;
  /** Visible ordinal of the last entry in the run. */
  lastVisibleSeq: number;
  /** Entries in the run that LCM would have stored. */
  entryCount: number;
  /** Stored row immediately before the run. */
  prevMessageId: number;
  /** Stored row immediately after the run. */
  nextMessageId: number;
};

/** A persisted gap marker; neighbor ids become null if those rows are later deleted. */
export type TranscriptGapRecord = Omit<TranscriptHistoryGap, "prevMessageId" | "nextMessageId"> & {
  prevMessageId: number | null;
  nextMessageId: number | null;
  gapId: number;
  conversationId: number;
  source: string;
  detectedAt: string;
};

/** Database-wide gap totals for status output. */
export type TranscriptGapTotals = {
  conversations: number;
  gaps: number;
  entries: number;
  largestGap: number;
};

const GAP_TABLE = "conversation_transcript_gaps";

type GapRow = {
  gap_id: number;
  conversation_id: number;
  first_entry_id: string;
  last_entry_id: string;
  first_visible_seq: number;
  last_visible_seq: number;
  entry_count: number;
  prev_message_id: number | null;
  next_message_id: number | null;
  source: string;
  detected_at: string;
};

/**
 * Storage for transcript history-gap markers. Writes are insert-only and
 * idempotent per (conversation, first entry, last entry); nothing here ever
 * removes a marker. Reads tolerate databases that predate the table so
 * read-only diagnostics work against older files.
 */
export class TranscriptGapStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Record gaps for a conversation; returns how many markers were new. */
  record(conversationId: number, gaps: readonly TranscriptHistoryGap[], source: string): number {
    const statement = this.db.prepare(
      `INSERT OR IGNORE INTO ${GAP_TABLE} (
         conversation_id, first_entry_id, last_entry_id, first_visible_seq,
         last_visible_seq, entry_count, prev_message_id, next_message_id, source
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let inserted = 0;
    for (const gap of gaps) {
      const result = statement.run(
        conversationId,
        gap.firstEntryId,
        gap.lastEntryId,
        gap.firstVisibleSeq,
        gap.lastVisibleSeq,
        gap.entryCount,
        gap.prevMessageId,
        gap.nextMessageId,
        source,
      );
      inserted += Number(result.changes);
    }
    return inserted;
  }

  /** Every marker of one conversation in transcript order. */
  listForConversation(conversationId: number): TranscriptGapRecord[] {
    if (!this.hasTable()) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT gap_id, conversation_id, first_entry_id, last_entry_id, first_visible_seq,
                last_visible_seq, entry_count, prev_message_id, next_message_id, source, detected_at
         FROM ${GAP_TABLE}
         WHERE conversation_id = ?
         ORDER BY first_visible_seq, gap_id`,
      )
      .all(conversationId) as GapRow[];
    return rows.map(toGapRecord);
  }

  /** Database-wide totals across every conversation. */
  totals(): TranscriptGapTotals {
    if (!this.hasTable()) {
      return { conversations: 0, gaps: 0, entries: 0, largestGap: 0 };
    }
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT conversation_id) AS conversations,
                COUNT(*) AS gaps,
                COALESCE(SUM(entry_count), 0) AS entries,
                COALESCE(MAX(entry_count), 0) AS largestGap
         FROM ${GAP_TABLE}`,
      )
      .get() as TranscriptGapTotals;
    return { ...row };
  }

  // Probe sqlite_master so reads against pre-migration databases return empty.
  private hasTable(): boolean {
    return (
      this.db
        .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(GAP_TABLE) !== undefined
    );
  }
}

// Map a stored marker row to its public shape.
function toGapRecord(row: GapRow): TranscriptGapRecord {
  return {
    gapId: row.gap_id,
    conversationId: row.conversation_id,
    firstEntryId: row.first_entry_id,
    lastEntryId: row.last_entry_id,
    firstVisibleSeq: row.first_visible_seq,
    lastVisibleSeq: row.last_visible_seq,
    entryCount: row.entry_count,
    prevMessageId: row.prev_message_id,
    nextMessageId: row.next_message_id,
    source: row.source,
    detectedAt: row.detected_at,
  };
}
