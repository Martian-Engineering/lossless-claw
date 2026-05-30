import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { withDatabaseTransaction } from "../transaction-mutex.js";
import { parseUtcTimestampOrNull } from "./parse-utc-timestamp.js";

export type FocusBriefStatus = "draft" | "active" | "superseded" | "failed" | "inactive";
export type FocusBriefSourceRole = "active_input" | "cited" | "expanded" | "irrelevant";

/** Persisted focus brief metadata and content. */
export type FocusBriefRecord = {
  briefId: string;
  conversationId: number;
  sessionKey: string | null;
  prompt: string;
  content: string;
  status: FocusBriefStatus;
  tokenCount: number;
  targetTokens: number;
  coveredLatestAt: Date | null;
  coveredMessageSeq: number | null;
  sourceContextHash: string;
  generatorRunId: string | null;
  generatorSessionKey: string | null;
  rawResultJson: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  supersededAt: Date | null;
};

/** Relationship between a focus brief and a summary it masked, cited, or expanded. */
export type FocusBriefSourceRecord = {
  briefId: string;
  summaryId: string;
  ordinal: number | null;
  role: FocusBriefSourceRole;
  createdAt: Date;
};

/** Freshness and source-state diagnostics for a persisted focus brief. */
export type FocusBriefDiagnostics = {
  postFocusMessageCount: number;
  postFocusSummaryCount: number;
  postFocusTokenCount: number;
  sourceContextChanged: boolean;
  stale: boolean;
  truncated: boolean;
};

/** Active summary context item used as focus generator input. */
export type ActiveFocusSummaryRecord = {
  ordinal: number;
  summaryId: string;
  kind: string;
  depth: number;
  tokenCount: number;
  createdAt: string;
  latestAt: string | null;
  maxSourceSeq: number | null;
  content: string;
};

/** Input for creating a focus brief generation record. */
export type CreateFocusBriefInput = {
  conversationId: number;
  sessionKey?: string | null;
  prompt: string;
  content: string;
  status: FocusBriefStatus;
  tokenCount?: number;
  targetTokens?: number;
  coveredLatestAt?: string | null;
  coveredMessageSeq?: number | null;
  sourceContextHash?: string;
  generatorRunId?: string | null;
  generatorSessionKey?: string | null;
  rawResultJson?: string | null;
  error?: string | null;
  sources?: Array<{
    summaryId: string;
    ordinal?: number | null;
    role: FocusBriefSourceRole;
  }>;
  /** Supersede any current focus row after a new successful focus is ready. */
  supersedeCurrentDrafts?: boolean;
};

type FocusBriefRow = {
  brief_id: string;
  conversation_id: number;
  session_key: string | null;
  prompt: string;
  content: string;
  status: FocusBriefStatus;
  token_count: number;
  target_tokens: number;
  covered_latest_at: string | null;
  covered_message_seq: number | null;
  source_context_hash: string;
  generator_run_id: string | null;
  generator_session_key: string | null;
  raw_result_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  superseded_at: string | null;
};

type FocusBriefSourceRow = {
  brief_id: string;
  summary_id: string;
  ordinal: number | null;
  role: FocusBriefSourceRole;
  created_at: string;
};

type ActiveFocusSummaryRow = {
  ordinal: number;
  summary_id: string;
  kind: string;
  depth: number;
  token_count: number;
  created_at: string;
  latest_at: string | null;
  max_source_seq: number | null;
  content: string;
};

type CountAndTokenRow = {
  count: number;
  tokens: number;
};

function toFocusBriefRecord(row: FocusBriefRow): FocusBriefRecord {
  return {
    briefId: row.brief_id,
    conversationId: row.conversation_id,
    sessionKey: row.session_key,
    prompt: row.prompt,
    content: row.content,
    status: row.status,
    tokenCount: row.token_count,
    targetTokens: row.target_tokens,
    coveredLatestAt: parseUtcTimestampOrNull(row.covered_latest_at),
    coveredMessageSeq: row.covered_message_seq,
    sourceContextHash: row.source_context_hash,
    generatorRunId: row.generator_run_id,
    generatorSessionKey: row.generator_session_key,
    rawResultJson: row.raw_result_json,
    error: row.error,
    createdAt: parseUtcTimestampOrNull(row.created_at) ?? new Date(0),
    updatedAt: parseUtcTimestampOrNull(row.updated_at) ?? new Date(0),
    supersededAt: parseUtcTimestampOrNull(row.superseded_at),
  };
}

function toFocusBriefSourceRecord(row: FocusBriefSourceRow): FocusBriefSourceRecord {
  return {
    briefId: row.brief_id,
    summaryId: row.summary_id,
    ordinal: row.ordinal,
    role: row.role,
    createdAt: parseUtcTimestampOrNull(row.created_at) ?? new Date(0),
  };
}

function toActiveFocusSummaryRecord(row: ActiveFocusSummaryRow): ActiveFocusSummaryRecord {
  return {
    ordinal: row.ordinal,
    summaryId: row.summary_id,
    kind: row.kind,
    depth: row.depth,
    tokenCount: row.token_count,
    createdAt: row.created_at,
    latestAt: row.latest_at,
    maxSourceSeq: row.max_source_seq,
    content: row.content,
  };
}

function createFocusBriefId(): string {
  return `focus_${randomBytes(8).toString("hex")}`;
}

function formatSqliteUtcTimestamp(value: Date): string {
  return value.toISOString().slice(0, 19).replace("T", " ");
}

function parseFocusBriefTruncated(rawResultJson: string | null): boolean {
  if (!rawResultJson?.trim()) {
    return false;
  }
  try {
    const parsed = JSON.parse(rawResultJson) as { truncated?: unknown };
    return parsed.truncated === true;
  } catch {
    return false;
  }
}

/** Compute a stable fingerprint for the active summary context behind a brief. */
export function hashFocusSourceContext(summaries: ActiveFocusSummaryRecord[]): string {
  const hash = createHash("sha256");
  for (const summary of summaries) {
    hash.update(`${summary.ordinal}\0${summary.summaryId}\0${summary.tokenCount}\0${summary.latestAt ?? ""}\n`);
  }
  return hash.digest("hex");
}

/**
 * Persist and query focus briefs without writing to the canonical summary DAG.
 */
export class FocusBriefStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Run a focus brief storage operation in the repository transaction mutex. */
  async withTransaction<T>(operation: () => Promise<T> | T): Promise<T> {
    return withDatabaseTransaction(this.db, "BEGIN", operation);
  }

  /** Return active summary context items for a conversation in assembly order. */
  async getActiveContextSummaries(conversationId: number): Promise<ActiveFocusSummaryRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT
           ci.ordinal,
           s.summary_id,
           COALESCE(s.kind, '') AS kind,
           COALESCE(s.depth, 0) AS depth,
           COALESCE(s.token_count, 0) AS token_count,
           COALESCE(s.created_at, '') AS created_at,
           s.latest_at,
           MAX(m.seq) AS max_source_seq,
           COALESCE(s.content, '') AS content
         FROM context_items ci
         JOIN summaries s ON s.summary_id = ci.summary_id
         LEFT JOIN summary_messages sm ON sm.summary_id = s.summary_id
         LEFT JOIN messages m ON m.message_id = sm.message_id
         WHERE ci.conversation_id = ?
           AND ci.item_type = 'summary'
         GROUP BY ci.ordinal, s.summary_id
         ORDER BY ci.ordinal`,
      )
      .all(conversationId) as ActiveFocusSummaryRow[];
    return rows.map(toActiveFocusSummaryRecord);
  }

  /** Return the latest source-message watermark covered by active summary context. */
  async getCoveredWatermark(conversationId: number): Promise<{
    coveredLatestAt: string | null;
    coveredMessageSeq: number | null;
  }> {
    const row = this.db
      .prepare(
        `WITH RECURSIVE covered(summary_id) AS (
           SELECT ci.summary_id
           FROM context_items ci
           WHERE ci.conversation_id = ?
             AND ci.item_type = 'summary'
             AND ci.summary_id IS NOT NULL
           UNION
           SELECT sp.parent_summary_id
           FROM summary_parents sp
           JOIN covered parent ON parent.summary_id = sp.summary_id
         )
         SELECT
           MAX(COALESCE(s.latest_at, m.created_at)) AS covered_latest_at,
           MAX(m.seq) AS covered_message_seq
         FROM covered c
         JOIN summaries s ON s.summary_id = c.summary_id
         LEFT JOIN summary_messages sm ON sm.summary_id = s.summary_id
         LEFT JOIN messages m ON m.message_id = sm.message_id`,
      )
      .get(conversationId) as
      | { covered_latest_at: string | null; covered_message_seq: number | null }
      | undefined;
    return {
      coveredLatestAt: row?.covered_latest_at ?? null,
      coveredMessageSeq: row?.covered_message_seq ?? null,
    };
  }

  /** Persist one focus brief and its source summary roles. */
  async createFocusBrief(input: CreateFocusBriefInput): Promise<FocusBriefRecord> {
    const briefId = createFocusBriefId();
    await this.withTransaction(() => {
      if (input.supersedeCurrentDrafts === true) {
        this.db
          .prepare(
            `UPDATE focus_briefs
             SET status = 'superseded',
                 superseded_at = datetime('now'),
                 updated_at = datetime('now')
             WHERE conversation_id = ?
               AND status IN ('draft', 'active')`,
          )
          .run(input.conversationId);
      }

      this.db
        .prepare(
          `INSERT INTO focus_briefs (
             brief_id,
             conversation_id,
             session_key,
             prompt,
             content,
             status,
             token_count,
             target_tokens,
             covered_latest_at,
             covered_message_seq,
             source_context_hash,
             generator_run_id,
             generator_session_key,
             raw_result_json,
             error
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          briefId,
          input.conversationId,
          input.sessionKey ?? null,
          input.prompt,
          input.content,
          input.status,
          Math.max(0, Math.floor(input.tokenCount ?? 0)),
          Math.max(0, Math.floor(input.targetTokens ?? 0)),
          input.coveredLatestAt ?? null,
          input.coveredMessageSeq ?? null,
          input.sourceContextHash ?? "",
          input.generatorRunId ?? null,
          input.generatorSessionKey ?? null,
          input.rawResultJson ?? null,
          input.error ?? null,
        );

      const stmt = this.db.prepare(
        `INSERT INTO focus_brief_sources (brief_id, summary_id, ordinal, role)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(brief_id, summary_id, role) DO UPDATE SET
           ordinal = excluded.ordinal`,
      );
      for (const source of input.sources ?? []) {
        stmt.run(briefId, source.summaryId, source.ordinal ?? null, source.role);
      }
    });

    const created = await this.getFocusBrief(briefId);
    if (!created) {
      throw new Error(`Focus brief ${briefId} was not persisted`);
    }
    return created;
  }

  /** Load a focus brief by ID. */
  async getFocusBrief(briefId: string): Promise<FocusBriefRecord | null> {
    const row = this.db
      .prepare(
        `SELECT
           brief_id,
           conversation_id,
           session_key,
           prompt,
           content,
           status,
           token_count,
           target_tokens,
           covered_latest_at,
           covered_message_seq,
           source_context_hash,
           generator_run_id,
           generator_session_key,
           raw_result_json,
           error,
           created_at,
           updated_at,
           superseded_at
         FROM focus_briefs
         WHERE brief_id = ?`,
      )
      .get(briefId) as FocusBriefRow | undefined;
    return row ? toFocusBriefRecord(row) : null;
  }

  /** Load the newest focus brief record for a conversation. */
  async getLatestFocusBrief(conversationId: number): Promise<FocusBriefRecord | null> {
    const row = this.db
      .prepare(
        `SELECT
           brief_id,
           conversation_id,
           session_key,
           prompt,
           content,
           status,
           token_count,
           target_tokens,
           covered_latest_at,
           covered_message_seq,
           source_context_hash,
           generator_run_id,
           generator_session_key,
           raw_result_json,
           error,
           created_at,
           updated_at,
           superseded_at
	         FROM focus_briefs
	         WHERE conversation_id = ?
	         ORDER BY created_at DESC, rowid DESC
	         LIMIT 1`,
      )
      .get(conversationId) as FocusBriefRow | undefined;
    return row ? toFocusBriefRecord(row) : null;
  }

  /** Load the current active focus overlay for a conversation, if one exists. */
  async getActiveFocusBrief(conversationId: number): Promise<FocusBriefRecord | null> {
    const row = this.db
      .prepare(
        `SELECT
           brief_id,
           conversation_id,
           session_key,
           prompt,
           content,
           status,
           token_count,
           target_tokens,
           covered_latest_at,
           covered_message_seq,
           source_context_hash,
           generator_run_id,
           generator_session_key,
           raw_result_json,
           error,
           created_at,
           updated_at,
           superseded_at
         FROM focus_briefs
         WHERE conversation_id = ?
           AND status = 'active'
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(conversationId) as FocusBriefRow | undefined;
    return row ? toFocusBriefRecord(row) : null;
  }

  /** Deactivate active focus overlays for a conversation without deleting history. */
  async deactivateActiveFocusBriefs(conversationId: number): Promise<number> {
    const result = await this.withTransaction(() =>
      this.db
        .prepare(
          `UPDATE focus_briefs
           SET status = 'inactive',
               updated_at = datetime('now')
           WHERE conversation_id = ?
             AND status = 'active'`,
        )
        .run(conversationId),
    );
    return Number(result.changes ?? 0);
  }

  /** List recent focus briefs for a conversation, newest first. */
  async listFocusBriefs(conversationId: number, limit = 20): Promise<FocusBriefRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT
           brief_id,
           conversation_id,
           session_key,
           prompt,
           content,
           status,
           token_count,
           target_tokens,
           covered_latest_at,
           covered_message_seq,
           source_context_hash,
           generator_run_id,
           generator_session_key,
           raw_result_json,
           error,
           created_at,
           updated_at,
           superseded_at
	         FROM focus_briefs
	         WHERE conversation_id = ?
	         ORDER BY created_at DESC, rowid DESC
	         LIMIT ?`,
      )
      .all(conversationId, Math.max(1, Math.floor(limit))) as FocusBriefRow[];
    return rows.map(toFocusBriefRecord);
  }

  /** Return summary source/citation rows recorded for a focus brief. */
  async getFocusBriefSources(briefId: string): Promise<FocusBriefSourceRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT brief_id, summary_id, ordinal, role, created_at
         FROM focus_brief_sources
         WHERE brief_id = ?
         ORDER BY role, ordinal, summary_id`,
      )
      .all(briefId) as FocusBriefSourceRow[];
    return rows.map(toFocusBriefSourceRecord);
  }

  /** Return post-focus drift and source-obsolescence diagnostics for a brief. */
  async getFocusBriefDiagnostics(brief: FocusBriefRecord): Promise<FocusBriefDiagnostics> {
    let postFocusMessageCount = 0;
    let postFocusMessageTokens = 0;
    if (brief.coveredMessageSeq !== null) {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS count, COALESCE(SUM(token_count), 0) AS tokens
           FROM messages
           WHERE conversation_id = ?
             AND seq > ?`,
        )
        .get(brief.conversationId, brief.coveredMessageSeq) as CountAndTokenRow | undefined;
      postFocusMessageCount = Math.max(0, Math.floor(row?.count ?? 0));
      postFocusMessageTokens = Math.max(0, Math.floor(row?.tokens ?? 0));
    }

    let postFocusSummaryCount = 0;
    let postFocusSummaryTokens = 0;
    const summaryWatermark = formatSqliteUtcTimestamp(brief.coveredLatestAt ?? brief.createdAt);
    const summaryPredicate =
      brief.coveredLatestAt !== null
        ? "latest_at IS NOT NULL AND datetime(latest_at) > datetime(?)"
        : "datetime(created_at) > datetime(?)";
    const summaryRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(token_count), 0) AS tokens
         FROM summaries
         WHERE conversation_id = ?
           AND ${summaryPredicate}`,
      )
      .get(brief.conversationId, summaryWatermark) as CountAndTokenRow | undefined;
    postFocusSummaryCount = Math.max(0, Math.floor(summaryRow?.count ?? 0));
    postFocusSummaryTokens = Math.max(0, Math.floor(summaryRow?.tokens ?? 0));

    const activeSummaries = await this.getActiveContextSummaries(brief.conversationId);
    const activeSourceContextHash = hashFocusSourceContext(activeSummaries);
    const sourceContextChanged =
      brief.sourceContextHash.trim() !== "" &&
      activeSourceContextHash.trim() !== "" &&
      activeSourceContextHash !== brief.sourceContextHash;
    const postFocusTokenCount = postFocusMessageTokens + postFocusSummaryTokens;
    return {
      postFocusMessageCount,
      postFocusSummaryCount,
      postFocusTokenCount,
      sourceContextChanged,
      stale: postFocusMessageCount > 0 || postFocusSummaryCount > 0 || sourceContextChanged,
      truncated: parseFocusBriefTruncated(brief.rawResultJson),
    };
  }
}
