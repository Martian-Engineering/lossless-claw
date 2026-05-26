import type { DatabaseSync } from "node:sqlite";

// Wave-4 Auditor #18 P0 fix: the v4.1 fallback marker text was tightened
// (was "[LCM fallback summary; truncated for context management]" — a
// trailing-suffix on truncated content only; under-cap content was
// silently shipped UNMARKED). New v4.1 markers are explicit prefixes that
// land on every fallback. Doctor still detects the legacy text on old
// DBs to support clean upgrade migration, plus the new prefix forms.
export const FALLBACK_SUMMARY_MARKER = "[LCM fallback summary; truncated for context management]";
export const FALLBACK_SUMMARY_MARKER_V41_TRUNC =
  "[LCM fallback summary — model unavailable; raw source truncated for context management]";
export const FALLBACK_SUMMARY_MARKER_V41_FULL =
  "[LCM fallback summary — model unavailable; raw source preserved verbatim below]";
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
 *
 * Marker classification:
 * - `"old"` — startsWith the legacy FALLBACK_SUMMARY_MARKER. Practically
 *   unreachable: pre-Wave-4 summarize.ts emitted the legacy marker as a
 *   trailing SUFFIX on truncated content, never as a prefix. Kept for
 *   defense-in-depth in case any future code path emits the legacy
 *   marker as a prefix; legacy data is detected via the trailing-suffix
 *   `fallbackIndex` branch below and classified `"fallback"`.
 * - `"fallback"` — legacy SUFFIX marker on truncated content (pre-Wave-4
 *   data) OR new v4.1 PREFIX markers (both truncated + full variants
 *   from Wave-4). Both classifications collapse to "fallback" because
 *   the repair semantics are identical (re-summarize the source).
 * - `"new"` — TRUNCATED_SUMMARY_PREFIX trailing-suffix marker (different
 *   condition: "summary was emitted but content was truncated for size",
 *   distinct from "summarizer fell back").
 *
 * Wave-5 P3 clarification: the comment-vs-code intent gap noted by the
 * Wave-5 audit; the "old" branch was historically dead code for legitimate
 * data, but the v4.1 prefix markers MAY trigger it (start-of-string check
 * is correct for them — but they take the v4.1 branch first since it
 * checks for the LONGER prefix).
 */
export function detectDoctorMarker(content: string): DoctorMarkerKind | null {
  // v4.1 fallback markers: always at start (prefix form). Check FIRST
  // because the v4.1 truncated marker prefix is longer than the legacy
  // marker — though the strings differ at "; truncated" vs " — model"
  // so there's no actual collision; this ordering is just for clarity.
  if (
    content.startsWith(FALLBACK_SUMMARY_MARKER_V41_TRUNC) ||
    content.startsWith(FALLBACK_SUMMARY_MARKER_V41_FULL)
  ) {
    return "fallback";
  }
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
  // Wave-4 Auditor #18 P0 fix: include the new v4.1 fallback markers in
  // the INSTR pre-filter so doctor still finds rows with the new prefix
  // form on a freshly-summarized DB. Detection still uses
  // detectDoctorMarker per-row for severity classification.
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
            OR INSTR(COALESCE(s.content, ''), ?) > 0
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
             OR INSTR(COALESCE(s.content, ''), ?) > 0
             OR INSTR(COALESCE(s.content, ''), ?) > 0
           )
         ORDER BY COALESCE(s.depth, 0) ASC, s.created_at ASC, s.summary_id ASC`,
      );

  const rows = (conversationId === undefined
    ? statement.all(
        FALLBACK_SUMMARY_MARKER,
        FALLBACK_SUMMARY_MARKER_V41_TRUNC,
        FALLBACK_SUMMARY_MARKER_V41_FULL,
        TRUNCATED_SUMMARY_PREFIX,
      )
    : statement.all(
        conversationId,
        FALLBACK_SUMMARY_MARKER,
        FALLBACK_SUMMARY_MARKER_V41_TRUNC,
        FALLBACK_SUMMARY_MARKER_V41_FULL,
        TRUNCATED_SUMMARY_PREFIX,
      )) as DoctorTargetRow[];

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
