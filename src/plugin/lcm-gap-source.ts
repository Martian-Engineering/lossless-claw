import { GapRepairError } from "../gap-repair-error.js";
import type { DatabaseSync } from "node:sqlite";
import type { AgentMessage } from "../openclaw-bridge.js";
import type { LcmDependencies, VisibleSessionTranscriptMessageEntry } from "../types.js";
import { digest, type RepairEvidence } from "../gap-repair.js";
import { toStoredMessage } from "../message-content.js";
import { isGapEligibleMessage } from "../transcript-gap-eligibility.js";

export type GapTarget = { conversationId: number; sessionId: string; sessionKey: string };
/** Uses only the existing host's branch-safe visible projection, never raw events
 * or session database access. Public sequence spaces are never mixed with LCM seq. */
export async function discoverGapEvidence(db: DatabaseSync, deps: LcmDependencies, target: GapTarget, tokenBudget: number) {
  if (!deps.readSessionTranscriptVisibleMessageDelta) throw new GapRepairError("Host visible-history reader unavailable; no repair ran.");
  const entries: VisibleSessionTranscriptMessageEntry[] = [];
  let cursor: string | undefined;
  let totalBytes = 0, maxBytes = 2 * 1024 * 1024;
  const seenCursors = new Set<string>();
  for (let pageNumber = 0; ; pageNumber++) {
    if (pageNumber >= 256) throw new GapRepairError("Host visible history exceeds the repair scan limit.");
    const page = await deps.readSessionTranscriptVisibleMessageDelta({ ...target, cursor, maxMessages: 512, maxBytes });
    if (page.kind !== "page") throw new GapRepairError("Host visible history changed or is unavailable; preview again.");
    if (!page.entries.length && page.hasMore) {
      maxBytes = Math.max(maxBytes * 2, page.requiredBytes ?? 0);
      if (maxBytes > 16 * 1024 * 1024) throw new GapRepairError("Host visible entry exceeds the repair byte limit.");
      continue;
    }
    totalBytes += page.serializedBytes;
    if (!Number.isFinite(totalBytes) || totalBytes > 64 * 1024 * 1024 || entries.length + page.entries.length > 100_000)
      throw new GapRepairError("Host visible history exceeds the repair scan limit.");
    entries.push(...page.entries);
    if (!page.hasMore) break;
    if (!page.cursor || seenCursors.has(page.cursor)) throw new GapRepairError("Host visible history did not advance.");
    seenCursors.add(page.cursor); cursor = page.cursor;
  }
  if (entries.length > 100_000) throw new GapRepairError("History exceeds bounded repair scan; no repair ran.");
  const ids = new Set<string>();
  for (const [i, entry] of entries.entries()) {
    if (entry.role !== entry.message.role || !entry.entryId || ids.has(entry.entryId) || !Number.isSafeInteger(entry.seq) || (i > 0 && entries[i - 1].seq >= entry.seq))
      throw new GapRepairError("Host visible history has ambiguous identities/order.");
    ids.add(entry.entryId);
  }
  const gaps = db.prepare(`SELECT g.*, p.transcript_entry_id AS before_id, n.transcript_entry_id AS after_id, p.role AS before_role, p.content AS before_content, n.role AS after_role, n.content AS after_content, p.seq AS before_seq, n.seq AS after_seq
    FROM conversation_transcript_gaps g JOIN messages p ON p.message_id=g.prev_message_id
    JOIN messages n ON n.message_id=g.next_message_id WHERE g.conversation_id=? ORDER BY g.gap_id`).all(target.conversationId) as any[];
  const completed = new Set<number>();
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='conversation_gap_recovery_audit'").get()) {
    for (const row of db.prepare("SELECT gap_ids FROM conversation_gap_recovery_audit WHERE conversation_id=?").all(target.conversationId) as any[])
      for (const id of JSON.parse(row.gap_ids)) completed.add(id);
  }
  const evidence: RepairEvidence = { conversationId: target.conversationId, tokenBudget, groups: [] };
  const unresolved: number[] = [];
  for (const gap of gaps) {
    if (completed.has(gap.gap_id)) continue;
    const left = entries.findIndex(e => e.entryId === gap.before_id), right = entries.findIndex(e => e.entryId === gap.after_id);
    if (left < 0 || right <= left || gap.after_seq !== gap.before_seq + 1) { unresolved.push(gap.gap_id); continue; }
    const before = project(entries[left]), after = project(entries[right]);
    const storedBefore = toStoredMessage(before), storedAfter = toStoredMessage(after);
    if (storedBefore.role !== gap.before_role || storedBefore.content !== gap.before_content ||
        storedAfter.role !== gap.after_role || storedAfter.content !== gap.after_content) { unresolved.push(gap.gap_id); continue; }
    const span = entries.slice(left + 1, right).filter(e => isGapEligibleMessage(e.message));
    if (span.length !== gap.entry_count || span[0]?.entryId !== gap.first_entry_id || span.at(-1)?.entryId !== gap.last_entry_id) {
      unresolved.push(gap.gap_id); continue;
    }
    const messages = span.map(project);
    const order = (e: VisibleSessionTranscriptMessageEntry) => ({ id: e.entryId, seq: e.seq });
    evidence.groups.push({ gapId: gap.gap_id, messages, sha256: messages.map(digest), sourceOrder: {
      namespace: "host-visible-seq", before: { ...order(entries[left]), sha256: digest(before) }, after: { ...order(entries[right]), sha256: digest(after) }, entries: span.map(order),
    } });
  }
  return { evidence, unresolved };
}
function project(entry: VisibleSessionTranscriptMessageEntry): AgentMessage {
  const message = structuredClone(entry.message) as any;
  if (message.__openclaw?.id && message.__openclaw.id !== entry.entryId) throw new GapRepairError("Host projected identity mismatch.");
  message.__openclaw = { ...message.__openclaw, id: entry.entryId };
  if (!message.timestamp && entry.createdAt) message.timestamp = entry.createdAt;
  return message;
}
