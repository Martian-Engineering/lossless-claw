import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { digest, repairState, type RepairPlan } from "../gap-repair.js";
import { normalizeMessageContentForFullTextIndex } from "../store/conversation-store.js";

type Row = Record<string, any>;
function insert(db: DatabaseSync, table: string, row: Row) {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table}(${columns.map(c => '"' + c + '"').join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map(c => row[c] as SQLInputValue));
}
/** Verify chronological once-only raw coverage, including every summary edge.
 * Does not infer completeness of unavailable host history. */
export function validateGapCoverage(db: DatabaseSync, cid: number) {
  const state = repairState(db, cid);
  const bySummary = new Map(state.summaries.map(s => [s.summary_id, s]));
  const grouped = (rows: Row[], key: string) => {
    const result = new Map<string, Row[]>();
    for (const row of rows) { const values = result.get(row[key]) ?? []; values.push(row); result.set(row[key], values); }
    for (const values of result.values()) values.sort((a,b) => a.ordinal-b.ordinal);
    return result;
  };
  const links = grouped(state.links, "summary_id"), parentsById = grouped(state.parents, "summary_id");
  const visit = (id: string, path: Set<string>): number[] => {
    if (path.has(id) || !bySummary.has(id)) throw new Error("Invalid staged summary graph.");
    const next = new Set(path); next.add(id);
    const direct = links.get(id) ?? [];
    const parents = parentsById.get(id) ?? [];
    if ((!direct.length && !parents.length) || (direct.length && parents.length)) throw new Error("Invalid staged summary coverage.");
    return direct.length ? direct.map(r => r.message_id) : parents.flatMap(r => visit(r.parent_summary_id, next));
  };
  const covered = state.frontier.flatMap(r => r.item_type === "message" ? [r.message_id] : visit(r.summary_id, new Set()));
  if (digest(covered) !== digest(state.messages.map(m => m.message_id))) throw new Error("Staged coverage is not chronological and once-only.");
  return state;
}
/** Synchronous publication: no await/model/network while live SQLite is in a
 * transaction. Rebase repair-owned integer IDs around unrelated live writes. */
export function publishGapRecovery(db: DatabaseSync, staged: DatabaseSync, plan: RepairPlan, backupPath: string) {
  const cid = plan.evidence.conversationId;
  const prepared = validateGapCoverage(staged, cid);
  db.exec("BEGIN IMMEDIATE");
  try {
    const before = repairState(db, cid);
    if (digest(before) !== plan.before) throw new Error("Target changed; preview again. No repair committed.");
    const originalById = new Map(before.messages.map(m => [m.message_id, m]));
    const originals = new Set(originalById.keys());
    const originalSummaries = new Set(before.summaries.map(s => s.summary_id));
    // Preparation is append-only: it may replace frontier pointers, never old evidence.
    for (const name of ["summaries", "parts", "links", "parents"] as const) {
      const hashes = new Set(prepared[name].map(digest));
      for (const row of before[name]) if (!hashes.has(digest(row)))
        throw new Error(`Preparation changed original ${name} evidence.`);
    }
    const added = prepared.messages.filter(m => !originals.has(m.message_id));
    let high = Number((db.prepare("SELECT COALESCE(max(message_id),0) AS n FROM messages").get() as any).n);
    const remap = new Map<number, number>(before.messages.map(m => [m.message_id, m.message_id]));
    for (const row of added) remap.set(row.message_id, ++high);
    const id = (n: number) => { const mapped = remap.get(n); if (mapped === undefined) throw new Error("Missing staged identity mapping."); return mapped; };
    const offset = [...before.messages, ...prepared.messages].reduce((n,m) => Math.max(n,m.seq),0) + 1;
    db.prepare("UPDATE messages SET seq=seq+? WHERE conversation_id=?").run(offset, cid);
    for (const row of prepared.messages) {
      if (originals.has(row.message_id)) {
        const old = originalById.get(row.message_id)!;
        if (digest({ ...old, seq: row.seq }) !== digest(row)) throw new Error("Preparation changed raw history.");
        db.prepare("UPDATE messages SET seq=? WHERE message_id=?").run(row.seq, row.message_id);
      } else {
        insert(db, "messages", { ...row, message_id: id(row.message_id) });
        const text = normalizeMessageContentForFullTextIndex(row.content);
        if (text) db.prepare("INSERT INTO messages_fts(rowid,content) VALUES(?,?)").run(id(row.message_id), text);
      }
    }
    for (const row of prepared.parts.filter(r => !originals.has(r.message_id)))
      insert(db, "message_parts", { ...row, message_id: id(row.message_id), part_id: randomUUID() });
    for (const row of prepared.trust.filter(r => !originals.has(r.message_id)))
      insert(db, "message_transcript_anchor_trust", { ...row, message_id: id(row.message_id) });
    const replayIds = new Set(added.map(m => m.transcript_entry_id));
    for (const row of prepared.replay.filter(r => replayIds.has(r.transcript_entry_id))) {
      db.prepare("DELETE FROM transcript_user_replay_keys WHERE conversation_id=? AND transcript_entry_id=?").run(cid, row.transcript_entry_id);
      insert(db, "transcript_user_replay_keys", row);
    }
    for (const row of prepared.summaries.filter(s => !originalSummaries.has(s.summary_id))) {
      insert(db, "summaries", row);
      db.prepare("INSERT INTO summaries_fts(summary_id,content) VALUES(?,?)").run(row.summary_id, row.content);
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='summaries_fts_cjk'").get())
        db.prepare("INSERT INTO summaries_fts_cjk(summary_id,content) VALUES(?,?)").run(row.summary_id, row.content);
    }
    for (const row of prepared.links.filter(r => !originalSummaries.has(r.summary_id)))
      insert(db, "summary_messages", { ...row, message_id: id(row.message_id) });
    for (const row of prepared.parents.filter(r => !originalSummaries.has(r.summary_id))) insert(db, "summary_parents", row);
    db.prepare("DELETE FROM context_items WHERE conversation_id=?").run(cid);
    for (const row of prepared.frontier) insert(db, "context_items", { ...row, message_id: row.message_id == null ? null : id(row.message_id) });
    validateGapCoverage(db, cid);
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Repair foreign-key validation failed.");
    db.exec(`CREATE TABLE IF NOT EXISTS conversation_gap_recovery_audit (
      recovery_id TEXT PRIMARY KEY, conversation_id INTEGER NOT NULL, gap_ids TEXT NOT NULL,
      disposition TEXT NOT NULL, before_hash TEXT NOT NULL, after_hash TEXT NOT NULL,
      source_hash TEXT NOT NULL, backup_path TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    insert(db, "conversation_gap_recovery_audit", { recovery_id: plan.id, conversation_id: cid,
      gap_ids: JSON.stringify(plan.evidence.groups.map(g => g.gapId)), disposition: "exact-host-visible-span-recovered",
      before_hash: plan.before, after_hash: digest(repairState(db, cid)), source_hash: digest(plan.evidence), backup_path: backupPath });
    db.exec("COMMIT");
    return { inserted: added.length, recoveryId: plan.id };
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
