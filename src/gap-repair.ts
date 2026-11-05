import { assertMaintenanceConnection } from "./db/connection.js";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { AgentMessage } from "./openclaw-bridge.js";
import { ContextAssembler } from "./assembler.js";
import { SummaryStore } from "./store/summary-store.js";
import { ConversationStore } from "./store/conversation-store.js";
import { UserReplayKeyStore } from "./store/user-replay-key-store.js";
import { observeUserReplayIdentity } from "./user-replay.js";
import { buildMessageParts, toStoredMessage } from "./message-content.js";
import { extractOpenClawSenderMetadata } from "./openclaw-sender-metadata.js";
import { extractStableEventKey } from "./stable-event-key.js";
import { isGapEligibleMessage } from "./transcript-gap-eligibility.js";
import { resolveTranscriptMessageCreatedAt } from "./transcript.js";

export const digest = (x: unknown): string =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
type Row = Record<string, any>;
export type RepairEvidence = {
  conversationId: number;
  tokenBudget: number;
  /** Exact ordered, publicly revalidated messages, including trusted __openclaw.id. */
  groups: {
    gapId: number;
    messages: AgentMessage[];
    sha256: string[];
    sourceOrder: {
      namespace: "gateway-public-seq" | "host-visible-seq";
      before: { id: string; seq: number; sha256?: string };
      after: { id: string; seq: number; sha256?: string };
      entries: { id: string; seq: number }[];
    };
  }[];
};
export type RepairPlan = {
  version: 1;
  nonce: string;
  evidence: RepairEvidence;
  before: string;
  id: string;
};
function check(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error(reason);
}
function rows(db: DatabaseSync, sql: string, ...args: SQLInputValue[]): Row[] {
  return db.prepare(sql).all(...args);
}
export function repairState(db: DatabaseSync, cid: number) {
  const query = (table: string, order: string) =>
    rows(
      db,
      `SELECT * FROM ${table} WHERE conversation_id=? ORDER BY ${order}`,
      cid
    );
  return {
    conversation: query("conversations", "conversation_id"),
    messages: query("messages", "seq"),
    frontier: query("context_items", "ordinal"),
    gaps: query("conversation_transcript_gaps", "gap_id"),
    summaries: query("summaries", "summary_id"),
    parts: rows(
      db,
      "SELECT p.* FROM message_parts p JOIN messages m USING(message_id) WHERE m.conversation_id=? ORDER BY part_id",
      cid
    ),
    links: rows(
      db,
      "SELECT sm.* FROM summary_messages sm JOIN summaries s USING(summary_id) WHERE s.conversation_id=? ORDER BY sm.summary_id,sm.ordinal",
      cid
    ),
    parents: rows(
      db,
      "SELECT sp.* FROM summary_parents sp JOIN summaries s USING(summary_id) WHERE s.conversation_id=? ORDER BY sp.summary_id,sp.ordinal",
      cid
    ),
    trust: query("message_transcript_anchor_trust", "message_id"),
    replay: query("transcript_user_replay_keys", "transcript_entry_id"),
    cursors: query("conversation_transcript_cursors", "conversation_id"),
  };
}
function prepare(db: DatabaseSync, e: RepairEvidence) {
  check(
    Number.isSafeInteger(e.conversationId) && e.conversationId > 0,
    "Invalid conversation"
  );
  check(
    Number.isSafeInteger(e.tokenBudget) && e.tokenBudget > 0,
    "Explicit positive token budget required"
  );
  const s = repairState(db, e.conversationId);
  check(
    s.conversation.length === 1 && s.messages.length,
    "Missing conversation/raw evidence"
  );
  check(
    e.groups.length &&
      new Set(e.groups.map((g) => g.gapId)).size === e.groups.length,
    "Empty or duplicate gaps"
  );
  const byId = new Map(s.messages.map((m) => [m.message_id, m]));
  const ids = new Set(
    s.messages.map((m) => m.transcript_entry_id).filter(Boolean)
  );
  const keys = new Set(
    s.messages.map((m) => m.stable_event_key).filter(Boolean)
  );
  const inserts = new Map<number, AgentMessage[]>();
  for (const g of e.groups) {
    const gap = s.gaps.find((r) => r.gap_id === g.gapId);
    check(
      gap &&
        g.messages.length === gap.entry_count &&
        g.sha256.length === g.messages.length,
      "Gap count mismatch"
    );
    const prev = byId.get(gap.prev_message_id),
      next = byId.get(gap.next_message_id);
    check(
      prev && next && next.seq === prev.seq + 1,
      "Gap boundaries no longer adjacent"
    );
    check(!inserts.has(next.message_id), "Overlapping gap boundaries");
    const order = g.sourceOrder;
    check(
      (order?.namespace === "gateway-public-seq" || order?.namespace === "host-visible-seq") &&
        order.before.id === prev.transcript_entry_id &&
        order.after.id === next.transcript_entry_id,
      "Source boundary identity mismatch"
    );
    check(
      order.entries.length === g.messages.length,
      "Source order count mismatch"
    );
    const sourceSpan = [order.before, ...order.entries, order.after];
    check(
      sourceSpan.every(
        (r, i) =>
          Number.isSafeInteger(r.seq) && (!i || sourceSpan[i - 1].seq < r.seq)
      ),
      "Nonchronological public source order"
    );
    check(
      order.entries.every(
        (r, i) => r.id === (g.messages[i] as any).__openclaw?.id
      ),
      "Source order identity mismatch"
    );
    for (let i = 0; i < g.messages.length; i++) {
      const m = g.messages[i],
        id = (m as any).__openclaw?.id;
      check(
        typeof id === "string" && id.length && isGapEligibleMessage(m),
        "Unproven source identity/eligibility"
      );
      check(digest(m) === g.sha256[i], "Source hash mismatch");
      check(!ids.has(id), "Source already stored or duplicated");
      ids.add(id);
      const key = extractStableEventKey(m);
      if (key) {
        check(
          !keys.has(key),
          "Stable-event collision; alias resolution is not authorized"
        );
        keys.add(key);
      }
      const timestamp = resolveTranscriptMessageCreatedAt(m);
      check(
        timestamp !== undefined &&
          Number.isFinite(new Date(timestamp).getTime()),
        "Source timestamp missing/invalid"
      );
    }
    check(
      (g.messages[0] as any).__openclaw.id === gap.first_entry_id &&
        (g.messages.at(-1) as any).__openclaw.id === gap.last_entry_id,
      "Source endpoints mismatch"
    );
    inserts.set(next.message_id, g.messages);
  }
  const cache = new Map<string, number[]>();
  function coverage(id: string, stack = new Set<string>()): number[] {
    if (cache.has(id)) return cache.get(id)!;
    check(!stack.has(id), "Summary graph cycle");
    const direct = s.links
      .filter((r) => r.summary_id === id)
      .map((r) => r.message_id);
    const children = s.parents
      .filter((r) => r.summary_id === id)
      .map((r) => r.parent_summary_id);
    check(!(direct.length && children.length), "Mixed summary coverage");
    const raw = direct.length
      ? direct
      : children.flatMap((c) => coverage(c, new Set(stack).add(id)));
    check(
      raw.length && new Set(raw).size === raw.length,
      "Missing/duplicate summary evidence"
    );
    check(
      raw.every(
        (r, i) =>
          byId.has(r) && (!i || byId.get(raw[i - 1])!.seq < byId.get(r)!.seq)
      ),
      "Nonchronological summary"
    );
    cache.set(id, raw);
    return raw;
  }
  for (const sum of s.summaries) coverage(sum.summary_id);
  const flatten = (items: Row[]) =>
    items.flatMap((i) =>
      i.item_type === "message" ? [i.message_id] : coverage(i.summary_id)
    );
  check(
    digest(flatten(s.frontier)) === digest(s.messages.map((m) => m.message_id)),
    "Frontier must cover every raw row exactly once in order"
  );
  const cuts = [...inserts.keys()].map((id) => byId.get(id)!.seq);
  function expand(i: Row): Row[] {
    if (i.item_type === "message") return [i];
    const raw = coverage(i.summary_id);
    if (
      !cuts.some(
        (c) => byId.get(raw[0])!.seq < c && c <= byId.get(raw.at(-1)!)!.seq
      )
    )
      return [i];
    const children = s.parents.filter((r) => r.summary_id === i.summary_id);
    return children.length
      ? children.flatMap((c) =>
          expand({
            item_type: "summary",
            summary_id: c.parent_summary_id,
            message_id: null,
          })
        )
      : raw.map((id) => ({
          item_type: "message",
          message_id: id,
          summary_id: null,
        }));
  }
  return { s, inserts, expanded: s.frontier.flatMap(expand), flatten };
}
export function planRepair(
  db: DatabaseSync,
  evidence: RepairEvidence
): RepairPlan {
  const { s } = prepare(db, evidence);
  const data = {
    version: 1 as const,
    nonce: randomUUID(),
    evidence,
    before: digest(s),
  };
  return { ...data, id: digest(data) };
}
function auditSchema(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS transcript_gap_repair_audit (
    event_id INTEGER PRIMARY KEY, plan_id TEXT NOT NULL, action TEXT NOT NULL,
    evidence_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(plan_id, action))`);
}
function replaceFrontier(
  db: DatabaseSync,
  cid: number,
  items: Row[],
  preserveOrdinals = false
) {
  db.prepare("DELETE FROM context_items WHERE conversation_id=?").run(cid);
  const insert = db.prepare(
    "INSERT INTO context_items(conversation_id,ordinal,item_type,message_id,summary_id,created_at) VALUES(?,?,?,?,?,?)"
  );
  items.forEach((i, n) =>
    insert.run(
      cid,
      preserveOrdinals ? i.ordinal : n,
      i.item_type,
      i.message_id ?? null,
      i.summary_id ?? null,
      i.created_at ?? new Date().toISOString()
    )
  );
}
/** Caller MUST hold the exclusive lifetime lease, never pass a live engine handle. */
export async function applyRepair(
  db: DatabaseSync,
  plan: RepairPlan,
  failAfter = Infinity,
  preparationOnly = false
) {
  assertMaintenanceConnection(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    const { id, ...data } = plan;
    check(
      id === digest(data) && plan.version === 1,
      "Invalid plan digest/version"
    );
    auditSchema(db);
    const prior = rows(
      db,
      "SELECT * FROM transcript_gap_repair_audit WHERE plan_id=?",
      id
    );
    if (prior.length) {
      check(
        !prior.some((r) => r.action === "undo"),
        "Plan already undone; prepare a fresh plan"
      );
      const receipt = JSON.parse(prior[0].evidence_json);
      check(
        digest(repairState(db, plan.evidence.conversationId)) === receipt.after,
        "Replayed plan poststate changed"
      );
      db.exec("COMMIT");
      return { id, replay: true, inserted: receipt.inserted.length };
    }
    const { s, inserts, expanded, flatten } = prepare(db, plan.evidence),
      cid = plan.evidence.conversationId;
    check(digest(s) === plan.before, "Stale plan");
    const store = new ConversationStore(db, { fts5Available: true });
    const replay = new UserReplayKeyStore(db);
    const added: number[] = [],
      order: number[] = [];
    const shift =
      s.messages.at(-1)!.seq +
      plan.evidence.groups.reduce((n, g) => n + g.messages.length, 0) +
      1;
    db.prepare("UPDATE messages SET seq=seq+? WHERE conversation_id=?").run(
      shift,
      cid
    );
    let seq = 0;
    for (const old of s.messages) {
      for (const m of inserts.get(old.message_id) ?? []) {
        const stored = toStoredMessage(m),
          entryId = (m as any).__openclaw.id;
        const r = await store.createMessage({
          conversationId: cid,
          seq: seq++,
          ...stored,
          transcriptEntryId: entryId,
          stableEventKey: extractStableEventKey(m),
          createdAt: resolveTranscriptMessageCreatedAt(m),
          openClawSenderMetadata: extractOpenClawSenderMetadata(m),
          skipReplayTimestampFloodGuard: true,
        });
        await store.createMessageParts(
          r.messageId,
          buildMessageParts({
            sessionId: s.conversation[0].session_id,
            message: m,
            fallbackContent: stored.content,
          })
        );
        await store.upsertMessageTranscriptAnchorTrust({
          messageId: r.messageId,
          conversationId: cid,
          transcriptEntryId: entryId,
          trustState: "repaired",
          source: "gap-repair",
          reason: id,
          verifiedAt: new Date(),
        });
        if (stored.role === "user") {
          const identity = observeUserReplayIdentity(m);
          replay.record(cid, [{ entryId, ...identity }]);
        }
        added.push(r.messageId);
        order.push(r.messageId);
        if (added.length === failAfter)
          throw new Error("Injected repair failure");
      }
      db.prepare("UPDATE messages SET seq=? WHERE message_id=?").run(
        seq++,
        old.message_id
      );
      order.push(old.message_id);
    }
    const position = new Map(order.map((id, n) => [id, n]));
    const frontier = [
      ...expanded,
      ...added.map((id) => ({
        item_type: "message",
        message_id: id,
        summary_id: null,
      })),
    ];
    frontier.sort(
      (a, b) => position.get(flatten([a])[0])! - position.get(flatten([b])[0])!
    );
    check(
      digest(flatten(frontier)) === digest(order),
      "Repaired coverage mismatch"
    );
    replaceFrontier(db, cid, frontier);
    check(!rows(db, "PRAGMA foreign_key_check").length, "Foreign key failure");
    const assembly = await new ContextAssembler(
      store,
      new SummaryStore(db, { fts5Available: true }),
      "UTC"
    ).assemble({
      conversationId: cid,
      tokenBudget: plan.evidence.tokenBudget,
      freshTailCount: 32,
      freshTailMaxTokens: 24000,
    });
    check(
      preparationOnly || (assembly.estimatedTokens <= plan.evidence.tokenBudget &&
        assembly.debug?.selectionMode === "full-fit"),
      "Repair frontier does not fully fit explicit budget"
    );
    const receipt = {
      before: s,
      after: digest(repairState(db, cid)),
      inserted: added,
      plan,
      assembly: {
        estimatedTokens: assembly.estimatedTokens,
        stats: assembly.stats,
        selectionMode: assembly.debug?.selectionMode,
      },
    };
    db.prepare(
      "INSERT INTO transcript_gap_repair_audit(plan_id,action,evidence_json) VALUES(?,?,?)"
    ).run(id, "apply", JSON.stringify(receipt));
    db.exec("COMMIT");
    return { id, replay: false, inserted: added.length };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
/** Retains apply and undo evidence. Refuses affected-conversation writes after apply.
 * Other conversations may advance: this never restores a whole database file. */
export function undoRepair(db: DatabaseSync, id: string) {
  assertMaintenanceConnection(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    const audit = rows(
      db,
      "SELECT * FROM transcript_gap_repair_audit WHERE plan_id=? ORDER BY event_id",
      id
    );
    check(
      audit.length === 1 && audit[0].action === "apply",
      "No reversible apply"
    );
    const r = JSON.parse(audit[0].evidence_json),
      cid = r.plan.evidence.conversationId;
    check(
      digest(repairState(db, cid)) === r.after,
      "Poststate changed; undo refused to preserve later writes"
    );
    db.prepare("DELETE FROM context_items WHERE conversation_id=?").run(cid);
    for (const messageId of r.inserted) {
      const m = rows(
        db,
        "SELECT transcript_entry_id FROM messages WHERE message_id=?",
        messageId
      )[0];
      db.prepare(
        "DELETE FROM transcript_user_replay_keys WHERE conversation_id=? AND transcript_entry_id=?"
      ).run(cid, m.transcript_entry_id);
      for (const table of ["message_parts", "message_transcript_anchor_trust"])
        db.prepare(`DELETE FROM ${table} WHERE message_id=?`).run(messageId);
      db.prepare("DELETE FROM messages_fts WHERE rowid=?").run(messageId);
      db.prepare("DELETE FROM messages WHERE message_id=?").run(messageId);
    }
    const current = rows(
      db,
      "SELECT max(seq) AS maximum FROM messages WHERE conversation_id=?",
      cid
    )[0].maximum;
    db.prepare("UPDATE messages SET seq=seq+? WHERE conversation_id=?").run(
      current + 1,
      cid
    );
    for (const m of r.before.messages)
      db.prepare("UPDATE messages SET seq=? WHERE message_id=?").run(
        m.seq,
        m.message_id
      );
    // Transcript scanning can have recorded replay keys even for a missing raw row.
    // Restore their original bytes/timestamps; do not treat them as repair-owned.
    const entryIds = new Set(
      r.plan.evidence.groups.flatMap((g: any) =>
        g.messages.map((m: any) => m.__openclaw.id)
      )
    );
    for (const original of r.before.replay.filter((k: any) =>
      entryIds.has(k.transcript_entry_id)
    )) {
      const columns = Object.keys(original);
      db.prepare(
        `INSERT INTO transcript_user_replay_keys(${columns.join(
          ","
        )}) VALUES(${columns.map(() => "?").join(",")})`
      ).run(...columns.map((k) => original[k]));
    }
    replaceFrontier(db, cid, r.before.frontier, true);
    check(
      digest(repairState(db, cid)) === r.plan.before,
      "Inverse did not restore canonical state"
    );
    db.prepare(
      "INSERT INTO transcript_gap_repair_audit(plan_id,action,evidence_json) VALUES(?,?,?)"
    ).run(id, "undo", JSON.stringify({ after: digest(repairState(db, cid)) }));
    db.exec("COMMIT");
    return { id, undone: true };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
