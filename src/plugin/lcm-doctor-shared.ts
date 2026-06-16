import type { DatabaseSync } from "node:sqlite";
import {
  FALLBACK_DIRECTIVE_SUMMARY_MARKER,
  FALLBACK_SUMMARY_MARKER,
} from "../summary-fallback.js";

export { FALLBACK_SUMMARY_MARKER };
export const TRUNCATED_SUMMARY_PREFIX = "[Truncated from ";
export const BARE_EMERGENCY_TRUNCATION_MARKER = "[Truncated for context management]";
export const EMERGENCY_FALLBACK_MODEL = "emergency-fallback";
export const TRUNCATED_SUMMARY_WINDOW = 40;
export const FALLBACK_SUMMARY_WINDOW = 80;

export type DoctorMarkerKind = "old" | "new" | "fallback" | "emergency";

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
  emergency: number;
};

export type DoctorSummaryStats = {
  candidates: DoctorSummaryCandidate[];
  total: number;
  old: number;
  truncated: number;
  fallback: number;
  emergency: number;
  byConversation: Map<number, DoctorConversationCounts>;
};

/** Repeated high-token message identity cluster reported by doctor. */
export type DoctorReplayResidueCluster = {
  conversationId: number;
  sessionId: string;
  sessionKey: string | null;
  role: string;
  identityHash: string | null;
  repeatCount: number;
  totalTokenCount: number;
  tokenPressure: number;
  representativeMessageIds: number[];
};

/** Aggregate stats for duplicate transcript replay residue diagnostics. */
export type DoctorReplayResidueStats = {
  clusters: DoctorReplayResidueCluster[];
  clusterCount: number;
  repeatedMessageCount: number;
  tokenPressure: number;
};

export type DoctorTargetRecord = {
  conversationId: number;
  summaryId: string;
  kind: string;
  depth: number;
  tokenCount: number;
  content: string;
  model: string;
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
  model: string;
  created_at: string;
  child_count: number | null;
};

type DoctorReplayResidueClusterRow = {
  conversation_id: number;
  session_id: string;
  session_key: string | null;
  role: string;
  identity_hash: string | null;
  content: string;
  repeat_count: number;
  total_token_count: number;
  max_token_count: number;
};

type DoctorReplayResidueMessageIdRow = {
  message_id: number;
};

const DOCTOR_REPLAY_MIN_REPEAT_COUNT = 2;
const DOCTOR_REPLAY_MIN_MESSAGE_TOKENS = 1_000;
const DOCTOR_REPLAY_MAX_CLUSTERS = 10;
const DOCTOR_REPLAY_MAX_REPRESENTATIVE_IDS = 5;

/**
 * Detect broken summary markers that doctor should flag or repair.
 */
export function detectDoctorMarker(content: string): DoctorMarkerKind | null {
  if (content.startsWith(FALLBACK_DIRECTIVE_SUMMARY_MARKER)) {
    return "fallback";
  }

  if (content.startsWith(FALLBACK_SUMMARY_MARKER)) {
    return "old";
  }

  const directiveFallbackIndex = content.indexOf(FALLBACK_DIRECTIVE_SUMMARY_MARKER);
  if (directiveFallbackIndex >= 0) {
    return "fallback";
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

function detectDoctorMarkerForRow(row: { content: string; model?: string }): DoctorMarkerKind | null {
  const markerKind = detectDoctorMarker(row.content);
  if (markerKind) {
    return markerKind;
  }

  const model = row.model?.trim();
  if (model === EMERGENCY_FALLBACK_MODEL) {
    return "emergency";
  }
  if (model === "unknown" && row.content.includes(BARE_EMERGENCY_TRUNCATION_MARKER)) {
    return "emergency";
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
           COALESCE(s.model, '') AS model,
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
            OR COALESCE(s.model, '') = ?
            OR (
              COALESCE(s.model, '') = 'unknown'
              AND INSTR(COALESCE(s.content, ''), ?) > 0
            )
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
           COALESCE(s.model, '') AS model,
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
             OR COALESCE(s.model, '') = ?
             OR (
               COALESCE(s.model, '') = 'unknown'
               AND INSTR(COALESCE(s.content, ''), ?) > 0
             )
           )
         ORDER BY COALESCE(s.depth, 0) ASC, s.created_at ASC, s.summary_id ASC`,
      );

  const rows = (conversationId === undefined
    ? statement.all(
        FALLBACK_SUMMARY_MARKER,
        TRUNCATED_SUMMARY_PREFIX,
        FALLBACK_DIRECTIVE_SUMMARY_MARKER,
        EMERGENCY_FALLBACK_MODEL,
        BARE_EMERGENCY_TRUNCATION_MARKER,
      )
    : statement.all(
        conversationId,
        FALLBACK_SUMMARY_MARKER,
        TRUNCATED_SUMMARY_PREFIX,
        FALLBACK_DIRECTIVE_SUMMARY_MARKER,
        EMERGENCY_FALLBACK_MODEL,
        BARE_EMERGENCY_TRUNCATION_MARKER,
      )) as DoctorTargetRow[];

  const targets: DoctorTargetRecord[] = [];
  for (const row of rows) {
    const markerKind = detectDoctorMarkerForRow(row);
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
      model: row.model,
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
  let emergency = 0;

  for (const target of targets) {
    const current = byConversation.get(target.conversationId) ?? {
      total: 0,
      old: 0,
      truncated: 0,
      fallback: 0,
      emergency: 0,
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
      case "emergency":
        emergency += 1;
        current.emergency += 1;
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
    emergency,
    byConversation,
  };
}

/**
 * Scan one conversation for repeated high-token message identities.
 */
export function getDoctorReplayResidueStats(
  db: DatabaseSync,
  conversationId: number,
): DoctorReplayResidueStats {
  // Group by exact role/content plus the stored identity hash so hash
  // collisions cannot merge unrelated persisted messages.
  const rows = db
    .prepare(
      `SELECT
         m.conversation_id,
         c.session_id,
         c.session_key,
         m.role,
         NULLIF(m.identity_hash, '') AS identity_hash,
         m.content,
         COUNT(*) AS repeat_count,
         COALESCE(SUM(CASE WHEN m.token_count > 0 THEN m.token_count ELSE 0 END), 0) AS total_token_count,
         COALESCE(MAX(CASE WHEN m.token_count > 0 THEN m.token_count ELSE 0 END), 0) AS max_token_count
       FROM messages m
       JOIN conversations c ON c.conversation_id = m.conversation_id
       WHERE m.conversation_id = ?
         AND LENGTH(m.content) > 0
       GROUP BY
         m.conversation_id,
         c.session_id,
         c.session_key,
         m.role,
         COALESCE(m.identity_hash, ''),
         m.content
       HAVING repeat_count >= ?
          AND max_token_count >= ?
       ORDER BY
         (total_token_count - max_token_count) DESC,
         repeat_count DESC,
         m.conversation_id ASC
       LIMIT ?`,
    )
    .all(
      conversationId,
      DOCTOR_REPLAY_MIN_REPEAT_COUNT,
      DOCTOR_REPLAY_MIN_MESSAGE_TOKENS,
      DOCTOR_REPLAY_MAX_CLUSTERS,
    ) as DoctorReplayResidueClusterRow[];

  const idStatement = db.prepare(
    `SELECT message_id
     FROM messages
     WHERE conversation_id = ?
       AND role = ?
       AND COALESCE(identity_hash, '') = COALESCE(?, '')
       AND content = ?
     ORDER BY message_id ASC
     LIMIT ?`,
  );

  const clusters = rows.map((row): DoctorReplayResidueCluster => {
    const totalTokenCount = Math.max(0, Math.floor(row.total_token_count ?? 0));
    const maxTokenCount = Math.max(0, Math.floor(row.max_token_count ?? 0));
    // Keep large payloads out of the user-facing report; ids are enough for
    // maintainers to inspect the exact rows from an offline database copy.
    const representativeRows = idStatement.all(
      row.conversation_id,
      row.role,
      row.identity_hash,
      row.content,
      DOCTOR_REPLAY_MAX_REPRESENTATIVE_IDS,
    ) as DoctorReplayResidueMessageIdRow[];
    return {
      conversationId: row.conversation_id,
      sessionId: row.session_id,
      sessionKey: row.session_key ?? null,
      role: row.role,
      identityHash: row.identity_hash ?? null,
      repeatCount: Math.max(0, Math.floor(row.repeat_count ?? 0)),
      totalTokenCount,
      tokenPressure: Math.max(0, totalTokenCount - maxTokenCount),
      representativeMessageIds: representativeRows.map((message) => message.message_id),
    };
  });

  return {
    clusters,
    clusterCount: clusters.length,
    repeatedMessageCount: clusters.reduce((sum, cluster) => sum + cluster.repeatCount, 0),
    tokenPressure: clusters.reduce((sum, cluster) => sum + cluster.tokenPressure, 0),
  };
}
