import type { DatabaseSync } from "node:sqlite";

export const FALLBACK_SUMMARY_MARKER = "[LCM fallback summary; truncated for context management]";
export const TRUNCATED_SUMMARY_PREFIX = "[Truncated from ";
export const TRUNCATED_SUMMARY_WINDOW = 40;
export const FALLBACK_SUMMARY_WINDOW = 80;

export type DoctorMarkerKind = "old" | "new" | "fallback";

export type DoctorSummaryCandidate = {
  conversationId: number;
  summaryId: string;
  markerKind: DoctorMarkerKind;
};

export type DoctorConversationCounts = {
  total: number;
  old: number;
  truncated: number;
  fallback: number;
};

export type DoctorSummaryStats = {
  candidates: DoctorSummaryCandidate[];
  total: number;
  old: number;
  truncated: number;
  fallback: number;
  byConversation: Map<number, DoctorConversationCounts>;
};

export type DoctorTargetRecord = {
  conversationId: number;
  summaryId: string;
  kind: string;
  depth: number;
  tokenCount: number;
  content: string;
  createdAt: string;
  childCount: number;
  markerKind: DoctorMarkerKind;
};

type DoctorTargetRow = {
  conversation_id: number;
  summary_id: string;
  kind: string;
  depth: number;
  token_count: number;
  content: string;
  created_at: string;
  child_count: number | null;
};

/**
 * Detect broken summary markers that doctor should flag or repair.
 */
export function detectDoctorMarker(content: string): DoctorMarkerKind | null {
  if (content.startsWith(FALLBACK_SUMMARY_MARKER)) {
    return "old";
  }

  const truncatedIndex = content.indexOf(TRUNCATED_SUMMARY_PREFIX);
  if (truncatedIndex >= 0 && content.length - truncatedIndex < TRUNCATED_SUMMARY_WINDOW) {
    return "new";
  }

  const fallbackIndex = content.indexOf(FALLBACK_SUMMARY_MARKER);
  if (fallbackIndex >= 0 && content.length - fallbackIndex < FALLBACK_SUMMARY_WINDOW) {
    return "fallback";
  }

  return null;
}

/**
 * Load doctor targets for one conversation or the whole DB.
 */
export function loadDoctorTargets(
  db: DatabaseSync,
  conversationId?: number,
): DoctorTargetRecord[] {
  const statement = conversationId === undefined
    ? db.prepare(
        `SELECT
           s.conversation_id,
           s.summary_id,
           s.kind,
           COALESCE(s.depth, 0) AS depth,
           COALESCE(s.token_count, 0) AS token_count,
           COALESCE(s.content, '') AS content,
           COALESCE(s.created_at, '') AS created_at,
           COALESCE(spc.child_count, 0) AS child_count
         FROM summaries s
         LEFT JOIN (
           SELECT summary_id, COUNT(*) AS child_count
           FROM summary_parents
           GROUP BY summary_id
         ) spc ON spc.summary_id = s.summary_id
         WHERE INSTR(COALESCE(s.content, ''), ?) > 0
            OR INSTR(COALESCE(s.content, ''), ?) > 0
         ORDER BY s.conversation_id ASC, COALESCE(s.depth, 0) ASC, s.created_at ASC, s.summary_id ASC`,
      )
    : db.prepare(
        `SELECT
           s.conversation_id,
           s.summary_id,
           s.kind,
           COALESCE(s.depth, 0) AS depth,
           COALESCE(s.token_count, 0) AS token_count,
           COALESCE(s.content, '') AS content,
           COALESCE(s.created_at, '') AS created_at,
           COALESCE(spc.child_count, 0) AS child_count
         FROM summaries s
         LEFT JOIN (
           SELECT summary_id, COUNT(*) AS child_count
           FROM summary_parents
           GROUP BY summary_id
         ) spc ON spc.summary_id = s.summary_id
         WHERE s.conversation_id = ?
           AND (
             INSTR(COALESCE(s.content, ''), ?) > 0
             OR INSTR(COALESCE(s.content, ''), ?) > 0
           )
         ORDER BY COALESCE(s.depth, 0) ASC, s.created_at ASC, s.summary_id ASC`,
      );

  const rows = (conversationId === undefined
    ? statement.all(FALLBACK_SUMMARY_MARKER, TRUNCATED_SUMMARY_PREFIX)
    : statement.all(conversationId, FALLBACK_SUMMARY_MARKER, TRUNCATED_SUMMARY_PREFIX)) as DoctorTargetRow[];

  const targets: DoctorTargetRecord[] = [];
  for (const row of rows) {
    const markerKind = detectDoctorMarker(row.content);
    if (!markerKind) {
      continue;
    }
    targets.push({
      conversationId: row.conversation_id,
      summaryId: row.summary_id,
      kind: row.kind,
      depth: Math.max(0, Math.floor(row.depth ?? 0)),
      tokenCount: Math.max(0, Math.floor(row.token_count ?? 0)),
      content: row.content,
      createdAt: row.created_at,
      childCount:
        typeof row.child_count === "number" && Number.isFinite(row.child_count)
          ? Math.max(0, Math.floor(row.child_count))
          : 0,
      markerKind,
    });
  }
  return targets;
}

/**
 * Aggregate doctor counts from target rows.
 */
export function getDoctorSummaryStats(
  db: DatabaseSync,
  conversationId?: number,
): DoctorSummaryStats {
  const targets = loadDoctorTargets(db, conversationId);
  const candidates: DoctorSummaryCandidate[] = [];
  const byConversation = new Map<number, DoctorConversationCounts>();
  let old = 0;
  let truncated = 0;
  let fallback = 0;

  for (const target of targets) {
    const current = byConversation.get(target.conversationId) ?? {
      total: 0,
      old: 0,
      truncated: 0,
      fallback: 0,
    };
    current.total += 1;

    switch (target.markerKind) {
      case "old":
        old += 1;
        current.old += 1;
        break;
      case "new":
        truncated += 1;
        current.truncated += 1;
        break;
      case "fallback":
        fallback += 1;
        current.fallback += 1;
        break;
    }

    byConversation.set(target.conversationId, current);
    candidates.push({
      conversationId: target.conversationId,
      summaryId: target.summaryId,
      markerKind: target.markerKind,
    });
  }

  return {
    candidates,
    total: candidates.length,
    old,
    truncated,
    fallback,
    byConversation,
  };
}
