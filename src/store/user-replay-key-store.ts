import type { DatabaseSync } from "node:sqlite";

/** Replay identity observed on one transcript user entry. */
export type TranscriptUserReplayKey = {
  entryId: string;
  /** Host replay key; '' when the entry carried none or left the projection. */
  idempotencyKey: string;
  /** Digest of the entry's live-coverage signature; '' when there is no key. */
  signature: string;
};

/** Replay-key state of one raw user context item anchored to a transcript entry. */
export type RawUserReplayKeyState = {
  entryId: string;
  /** Observed replay identity, or null when the entry was never observed. */
  observed: { idempotencyKey: string; signature: string } | null;
};

/**
 * Storage for the host replay keys of visible transcript user entries, so
 * assembly can restore raw user replay identity without reading the whole
 * visible transcript every turn.
 */
export class UserReplayKeyStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Insert or overwrite the observed replay identity of transcript entries. */
  record(conversationId: number, keys: Iterable<TranscriptUserReplayKey>): void {
    const statement = this.db.prepare(
      `INSERT INTO transcript_user_replay_keys (
         conversation_id, transcript_entry_id, idempotency_key, entry_signature
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT (conversation_id, transcript_entry_id) DO UPDATE SET
         idempotency_key = excluded.idempotency_key,
         entry_signature = excluded.entry_signature,
         updated_at = datetime('now')
       WHERE idempotency_key IS NOT excluded.idempotency_key
          OR entry_signature IS NOT excluded.entry_signature`,
    );
    for (const key of keys) {
      statement.run(conversationId, key.entryId, key.idempotencyKey, key.signature);
    }
  }

  /** Replay-key state for every raw user context item that carries a transcript entry id. */
  listRawUserContextKeys(conversationId: number): RawUserReplayKeyState[] {
    const rows = this.db
      .prepare(
        `SELECT m.transcript_entry_id AS entry_id,
                k.idempotency_key AS idempotency_key,
                k.entry_signature AS entry_signature
         FROM context_items ci
         JOIN messages m ON m.message_id = ci.message_id
         LEFT JOIN transcript_user_replay_keys k
           ON k.conversation_id = m.conversation_id
          AND k.transcript_entry_id = m.transcript_entry_id
         WHERE ci.conversation_id = ?
           AND ci.item_type = 'message'
           AND m.role = 'user'
           AND m.transcript_entry_id IS NOT NULL`,
      )
      .all(conversationId) as Array<{
      entry_id: string;
      idempotency_key: string | null;
      entry_signature: string | null;
    }>;
    return rows.map((row) => ({
      entryId: row.entry_id,
      observed:
        row.idempotency_key === null
          ? null
          : { idempotencyKey: row.idempotency_key, signature: row.entry_signature ?? "" },
    }));
  }
}
