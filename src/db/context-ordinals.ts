import type { DatabaseSync } from "node:sqlite";

/** Resequence within the caller's transaction, preserving context order. */
export function resequenceContextItemsInTransaction(
  db: DatabaseSync,
  conversationId: number,
): void {
  // Pre-compute ranks from a SELECT, then apply a 2-pass UPDATE loop using
  // negative temps to avoid UNIQUE constraint violations.
  const items = db
    .prepare(
      `SELECT ordinal FROM context_items
       WHERE conversation_id = ?
       ORDER BY ordinal`,
    )
    .all(conversationId) as unknown as { ordinal: number }[];

  if (items.length > 0 && items.some((item, i) => item.ordinal !== i)) {
    const updateStmt = db.prepare(
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

/** Keep prepared payloads, but prevent work based on obsolete positions from running. */
export function invalidatePendingContextPositions(db: DatabaseSync, conversationId: number): void {
  db.prepare(
    `UPDATE pending_compaction_batches
     SET status = 'stale',
         failure_summary = 'context item positions changed',
         updated_at = datetime('now')
     WHERE conversation_id = ?
       AND status IN ('planning', 'ready', 'publishing')`,
  ).run(conversationId);
}
