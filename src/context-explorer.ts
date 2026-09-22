import packageJson from "../package.json" with { type: "json" };
import type { DatabaseSync } from "node:sqlite";
import type { OpenClawPluginApi } from "./openclaw-bridge.js";
import { detectDoctorMarkerForRow, getDoctorSummaryStats, type DoctorMarkerKind } from "./plugin/lcm-doctor-shared.js";
import { withExclusiveDatabaseLock } from "./transaction-mutex.js";

export type ExplorerSummary = {
  summaryId: string; ordinal: number; kind: string; depth: number;
  tokenCount: number; preview: string; earliestAt: string | null;
  latestAt: string | null; createdAt: string; descendantCount: number;
  sourceMessageTokenCount: number; quality: DoctorMarkerKind | null;
};
export type ExplorerSnapshot = {
  basis: "stored-active-context"; capturedAt: string; conversationId: number | null;
  summaryCount: number; messageCount: number; summaryTokens: number; messageTokens: number;
  conversationTokens: number; compressedTokens: number; compressionRatio: number | null;
  version: string; databaseBytes: number;
  summaries: ExplorerSummary[]; nextOffset: number | null;
};
export type ExplorerDetail = {
  summaryId: string; content: string; quality: DoctorMarkerKind | null; nextOffset: number | null;
  sourceMessages: number; children: ExplorerSummary[];
  childrenTruncated: boolean;
};

export type ExplorerHealth = {
  checkedAt: string; total: number; fallback: number; truncated: number; emergency: number;
  summaries: ExplorerSummary[]; revealIds: string[]; nextOffset: number | null;
};

type SummaryRow = Omit<ExplorerSummary, "quality"> & { content: string; model: string };
function withQuality(row: SummaryRow): ExplorerSummary {
  const { content, model, ...summary } = row;
  return { ...summary, quality: detectDoctorMarkerForRow({ content, model }) };
}

function boundedOffset(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 10_000_000) {
    throw new Error("Invalid offset");
  }
  return value as number;
}

/** SELECT-only view of the current conversation, never archived/session-family history. */
export function readContextExplorer(db: DatabaseSync, sessionKey: string, input: Record<string, unknown> = {}): ExplorerSnapshot | ExplorerDetail | ExplorerHealth {
  const offset = boundedOffset(input.offset);
  const conversation = db.prepare(`SELECT conversation_id FROM conversations
    WHERE session_key = ? AND active = 1 ORDER BY created_at DESC, conversation_id DESC LIMIT 1`)
    .get(sessionKey) as { conversation_id: number } | undefined;
  const id = conversation?.conversation_id;
  if (input.check === true) {
    if (!id) throw new Error("No active Lossless conversation for this session");
    const stats = getDoctorSummaryStats(db, id);
    const ids = stats.candidates.slice(offset, offset + 50).map(c => c.summaryId);
    const summaries = ids.map(summaryId => withQuality(db.prepare(`SELECT summary_id AS summaryId,
      0 AS ordinal, kind, depth, content, model, token_count AS tokenCount, substr(content, 1, 220) AS preview,
      earliest_at AS earliestAt, latest_at AS latestAt, created_at AS createdAt,
      descendant_count AS descendantCount, source_message_token_count AS sourceMessageTokenCount
      FROM summaries WHERE conversation_id = ? AND summary_id = ?`).get(id, summaryId) as SummaryRow));
    const revealIds = new Set<string>();
    for (const summaryId of ids) {
      const ancestors = db.prepare(`WITH RECURSIVE ancestors(id) AS (
        SELECT summary_id FROM summaries WHERE summary_id = ? AND conversation_id = ?
        UNION SELECT p.summary_id FROM summary_parents p JOIN ancestors a ON p.parent_summary_id = a.id
        JOIN summaries s ON s.summary_id = p.summary_id WHERE s.conversation_id = ?)
        SELECT id FROM ancestors`).all(summaryId, id, id) as { id: string }[];
      for (const ancestor of ancestors) revealIds.add(ancestor.id);
    }
    return { checkedAt: new Date().toISOString(), total: stats.total,
      fallback: stats.old + stats.fallback, truncated: stats.truncated, emergency: stats.emergency,
      summaries, revealIds: [...revealIds], nextOffset: offset + 50 < stats.total ? offset + 50 : null };
  }
  if (typeof input.summaryId === "string") {
    if (!id) throw new Error("No active Lossless conversation for this session");
    // A caller cannot use a guessed summary id to read another conversation.
    const row = db.prepare(`SELECT summary_id AS summaryId, substr(content, ?, 24000) AS content,
      length(content) AS length, content AS fullContent, model FROM summaries WHERE conversation_id = ? AND summary_id = ?`)
      .get(offset + 1, id, input.summaryId) as { summaryId: string; content: string; length: number; fullContent: string; model: string } | undefined;
    if (!row) throw new Error("Summary not found in this session");
    const children = db.prepare(`SELECT s.summary_id AS summaryId, p.ordinal, s.kind, s.depth,
      s.content, s.model, s.token_count AS tokenCount, substr(s.content, 1, 220) AS preview,
      s.earliest_at AS earliestAt, s.latest_at AS latestAt, s.created_at AS createdAt,
      s.descendant_count AS descendantCount, s.source_message_token_count AS sourceMessageTokenCount
      FROM summary_parents p JOIN summaries s ON s.summary_id = p.parent_summary_id
      WHERE p.summary_id = ? AND s.conversation_id = ? ORDER BY p.ordinal LIMIT 101`)
      .all(row.summaryId, id) as SummaryRow[];
    const source = db.prepare(`SELECT count(*) AS count FROM summary_messages sm
      JOIN messages m ON m.message_id = sm.message_id
      WHERE sm.summary_id = ? AND m.conversation_id = ?`).get(row.summaryId, id) as { count: number };
    return { summaryId: row.summaryId, content: row.content,
      quality: detectDoctorMarkerForRow({ content: row.fullContent, model: row.model }),
      nextOffset: offset + 24000 < row.length ? offset + 24000 : null,
      sourceMessages: source.count, children: children.slice(0, 100).map(withQuality), childrenTruncated: children.length > 100 };
  }
  const empty: ExplorerSnapshot = { basis: "stored-active-context", capturedAt: new Date().toISOString(),
    version: packageJson.version,
    databaseBytes: (db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count
      * (db.prepare("PRAGMA page_size").get() as { page_size: number }).page_size,
    conversationId: id ?? null, summaryCount: 0, messageCount: 0, summaryTokens: 0,
    messageTokens: 0, conversationTokens: 0, compressedTokens: 0, compressionRatio: null, summaries: [], nextOffset: null };
  if (!id) return empty;
  const totals = db.prepare(`SELECT
    coalesce(sum(c.item_type = 'summary'), 0) AS summaryCount,
    coalesce(sum(c.item_type = 'message'), 0) AS messageCount,
    coalesce(sum(s.token_count), 0) AS summaryTokens,
    coalesce(sum(m.token_count), 0) AS messageTokens,
    coalesce(sum(coalesce(s.source_message_token_count, 0) + coalesce(s.descendant_token_count, 0)), 0) AS compressedTokens
    FROM context_items c
    LEFT JOIN summaries s ON s.summary_id = c.summary_id AND s.conversation_id = c.conversation_id
    LEFT JOIN messages m ON m.message_id = c.message_id AND m.conversation_id = c.conversation_id
    WHERE c.conversation_id = ?`).get(id) as Pick<ExplorerSnapshot, "summaryCount" | "messageCount" | "summaryTokens" | "messageTokens" | "compressedTokens">;
  const conversationTokens = (db.prepare("SELECT coalesce(sum(token_count), 0) AS tokens FROM messages WHERE conversation_id = ?")
    .get(id) as { tokens: number }).tokens;
  // Match /lcm doctor: source + descendant-summary tokens over the active frontier,
  // rounded and floored at 1. This is distinct from raw conversation/context size.
  const contextTokens = totals.summaryTokens + totals.messageTokens;
  const compressionRatio = contextTokens > 0 && totals.compressedTokens > 0
    ? Math.max(1, Math.round(totals.compressedTokens / contextTokens)) : null;
  const rows = db.prepare(`SELECT s.summary_id AS summaryId, c.ordinal, s.kind, s.depth,
    s.content, s.model, s.token_count AS tokenCount, substr(s.content, 1, 220) AS preview,
    s.earliest_at AS earliestAt, s.latest_at AS latestAt, s.created_at AS createdAt,
    s.descendant_count AS descendantCount, s.source_message_token_count AS sourceMessageTokenCount
    FROM context_items c JOIN summaries s ON s.summary_id = c.summary_id AND s.conversation_id = c.conversation_id
    WHERE c.conversation_id = ? AND c.item_type = 'summary' ORDER BY c.ordinal LIMIT 51 OFFSET ?`)
    .all(id, offset) as SummaryRow[];
  return { ...empty, ...totals, conversationTokens, compressionRatio, summaries: rows.slice(0, 50).map(withQuality), nextOffset: rows.length > 50 ? offset + 50 : null };
}

export function registerContextExplorer(api: OpenClawPluginApi, getDb: () => Promise<DatabaseSync>): void {
  api.session?.controls?.registerSessionAction?.({
    id: "context-explorer", description: "Read this session's active Lossless summaries and metadata.",
    requiredScopes: ["operator.read"],
    schema: { type: "object", additionalProperties: false, properties: {
      check: { type: "boolean" },
      summaryId: { type: "string", minLength: 1, maxLength: 200 },
      offset: { type: "integer", minimum: 0, maximum: 10000000 },
    } },
    handler: async (ctx) => {
      if (!ctx.sessionKey?.trim()) return { ok: false, error: "Select a session first" };
      try {
        const db = await getDb();
        const result = await withExclusiveDatabaseLock(db, { timeoutMs: 2000 }, () => {
          // A deferred read transaction gives all totals and rows the same snapshot,
          // including when a second process compacts the WAL concurrently.
          db.exec("BEGIN");
          try { const value = readContextExplorer(db, ctx.sessionKey!, ctx.payload); db.exec("COMMIT"); return value; }
          catch (error) { db.exec("ROLLBACK"); throw error; }
        });
        return { ok: true, result };
      } catch {
        return { ok: false, error: "Context unavailable. Refresh to retry; the summary may no longer belong to this session." };
      }
    },
  });
}
