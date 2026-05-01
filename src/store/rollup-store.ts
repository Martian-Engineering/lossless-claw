import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { withDatabaseTransaction } from "../transaction-mutex.js";

export interface RollupRow {
  rollup_id: string;
  conversation_id: number;
  period_kind: "day" | "week" | "month";
  period_key: string;
  period_start: string;
  period_end: string;
  timezone: string;
  content: string;
  token_count: number;
  source_summary_ids: string;
  source_message_count: number;
  source_token_count: number;
  status: "building" | "ready" | "stale" | "failed";
  coverage_start: string | null;
  coverage_end: string | null;
  summarizer_model: string | null;
  source_fingerprint: string | null;
  built_at: string;
  invalidated_at: string | null;
  error_text: string | null;
}

export interface RollupStateRow {
  conversation_id: number;
  timezone: string;
  last_message_at: string | null;
  last_rollup_check_at: string | null;
  last_daily_build_at: string | null;
  last_weekly_build_at: string | null;
  last_monthly_build_at: string | null;
  pending_rebuild: number;
  updated_at: string;
}

export interface RollupSourceRow {
  source_type: string;
  source_id: string;
  ordinal: number;
}

export interface RollupSourceInput {
  type: "summary" | "rollup";
  id: string;
  ordinal: number;
}

const ROLLUP_STATUSES = new Set(["building", "ready", "stale", "failed"]);

export interface LeafSummaryForDayRow {
  summary_id: string;
  content: string;
  token_count: number;
  source_message_token_count: number;
  earliest_at: string | null;
  latest_at: string | null;
  created_at: string;
  updated_at: string | null;
  source_message_count: number;
}

export class RollupStore {
  constructor(public db: DatabaseSync) {}

  upsertRollup(
    input: Omit<RollupRow, "built_at" | "invalidated_at" | "error_text">
  ): void {
    const rollupId = input.rollup_id || randomUUID();
    if (!ROLLUP_STATUSES.has(input.status)) {
      throw new Error(`Invalid rollup status: ${input.status}`);
    }

    this.db
      .prepare(
        `INSERT INTO lcm_rollups (
          rollup_id,
          conversation_id,
          period_kind,
          period_key,
          period_start,
          period_end,
          timezone,
          content,
          token_count,
          source_summary_ids,
          source_message_count,
          source_token_count,
          status,
          coverage_start,
          coverage_end,
          summarizer_model,
          source_fingerprint,
          built_at,
          invalidated_at,
          error_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), NULL, NULL)
        ON CONFLICT(conversation_id, period_kind, timezone, period_key) DO UPDATE SET
          period_start = excluded.period_start,
          period_end = excluded.period_end,
          timezone = excluded.timezone,
          content = excluded.content,
          token_count = excluded.token_count,
          source_summary_ids = excluded.source_summary_ids,
          source_message_count = excluded.source_message_count,
          source_token_count = excluded.source_token_count,
          status = excluded.status,
          coverage_start = excluded.coverage_start,
          coverage_end = excluded.coverage_end,
          summarizer_model = excluded.summarizer_model,
          source_fingerprint = excluded.source_fingerprint,
          built_at = datetime('now'),
          invalidated_at = NULL,
          error_text = NULL`
      )
      .run(
        rollupId,
        input.conversation_id,
        input.period_kind,
        input.period_key,
        input.period_start,
        input.period_end,
        input.timezone,
        input.content,
        input.token_count,
        input.source_summary_ids,
        input.source_message_count,
        input.source_token_count,
        input.status,
        input.coverage_start,
        input.coverage_end,
        input.summarizer_model,
        input.source_fingerprint
      );
  }

  getRollup(
    conversationId: number,
    periodKind: string,
    periodKey: string,
    timezone?: string
  ): RollupRow | null {
    const timezoneClause = timezone == null ? "" : "AND timezone = ?";
    const args =
      timezone == null
        ? [conversationId, periodKind, periodKey]
        : [conversationId, periodKind, periodKey, timezone];
    const row = this.db
      .prepare(
        `SELECT
          rollup_id,
          conversation_id,
          period_kind,
          period_key,
          period_start,
          period_end,
          timezone,
          content,
          token_count,
          source_summary_ids,
          source_message_count,
          source_token_count,
          status,
          coverage_start,
          coverage_end,
          summarizer_model,
          source_fingerprint,
          built_at,
          invalidated_at,
          error_text
        FROM lcm_rollups
        WHERE conversation_id = ?
          AND period_kind = ?
          AND period_key = ?
          ${timezoneClause}
        ORDER BY built_at DESC
        LIMIT 1`
      )
      .get(...args) as RollupRow | undefined;

    return row ?? null;
  }

  getRollupById(rollupId: string): RollupRow | null {
    const row = this.db
      .prepare(
        `SELECT
          rollup_id,
          conversation_id,
          period_kind,
          period_key,
          period_start,
          period_end,
          timezone,
          content,
          token_count,
          source_summary_ids,
          source_message_count,
          source_token_count,
          status,
          coverage_start,
          coverage_end,
          summarizer_model,
          source_fingerprint,
          built_at,
          invalidated_at,
          error_text
        FROM lcm_rollups
        WHERE rollup_id = ?`
      )
      .get(rollupId) as RollupRow | undefined;

    return row ?? null;
  }

  listRollups(
    conversationId: number,
    periodKind?: string,
    limit: number | null = 50
  ): RollupRow[] {
    const normalizedLimit =
      limit == null
        ? null
        : Number.isFinite(limit) && limit > 0
          ? Math.floor(limit)
          : 50;
    const limitClause = normalizedLimit == null ? "" : "LIMIT ?";
    const sql = periodKind
      ? `SELECT
           rollup_id,
           conversation_id,
           period_kind,
           period_key,
           period_start,
           period_end,
           timezone,
           content,
           token_count,
           source_summary_ids,
           source_message_count,
           source_token_count,
           status,
           coverage_start,
           coverage_end,
           summarizer_model,
           source_fingerprint,
           built_at,
           invalidated_at,
           error_text
         FROM lcm_rollups
         WHERE conversation_id = ?
           AND period_kind = ?
         ORDER BY period_start DESC
         ${limitClause}`
      : `SELECT
           rollup_id,
           conversation_id,
           period_kind,
           period_key,
           period_start,
           period_end,
           timezone,
           content,
           token_count,
           source_summary_ids,
           source_message_count,
           source_token_count,
           status,
           coverage_start,
           coverage_end,
           summarizer_model,
           source_fingerprint,
           built_at,
           invalidated_at,
           error_text
         FROM lcm_rollups
         WHERE conversation_id = ?
         ORDER BY period_start DESC
         ${limitClause}`;

    if (periodKind) {
      const args =
        normalizedLimit == null
          ? [conversationId, periodKind]
          : [conversationId, periodKind, normalizedLimit];
      return this.db.prepare(sql).all(...args) as unknown as RollupRow[];
    }
    const args =
      normalizedLimit == null ? [conversationId] : [conversationId, normalizedLimit];
    return this.db.prepare(sql).all(...args) as unknown as RollupRow[];
  }

  listRollupsInRange(
    conversationId: number,
    periodKind: string,
    start: string,
    end: string
  ): RollupRow[] {
    return this.db
      .prepare(
        `SELECT
          rollup_id,
          conversation_id,
          period_kind,
          period_key,
          period_start,
          period_end,
          timezone,
          content,
          token_count,
          source_summary_ids,
          source_message_count,
          source_token_count,
          status,
          coverage_start,
          coverage_end,
          summarizer_model,
          source_fingerprint,
          built_at,
          invalidated_at,
          error_text
         FROM lcm_rollups
         WHERE conversation_id = ?
           AND period_kind = ?
           AND period_start >= ?
           AND period_start < ?
         ORDER BY period_start ASC`
      )
      .all(conversationId, periodKind, start, end) as unknown as RollupRow[];
  }

  markStale(rollupId: string): void {
    this.db
      .prepare(
        `UPDATE lcm_rollups
         SET status = 'stale',
             invalidated_at = datetime('now')
         WHERE rollup_id = ?`
      )
      .run(rollupId);
  }

  deleteRollup(rollupId: string): void {
    this.db
      .prepare(`DELETE FROM lcm_rollups WHERE rollup_id = ?`)
      .run(rollupId);
  }

  async replaceRollupSources(
    rollupId: string,
    sources: RollupSourceInput[]
  ): Promise<void> {
    await withDatabaseTransaction(this.db, "BEGIN", () => {
      this.db
        .prepare(`DELETE FROM lcm_rollup_sources WHERE rollup_id = ?`)
        .run(rollupId);

      if (sources.length === 0) {
        return;
      }

      const insert = this.db.prepare(
        `INSERT INTO lcm_rollup_sources (rollup_id, source_type, source_id, ordinal)
         VALUES (?, ?, ?, ?)`
      );

      for (const source of sources) {
        insert.run(rollupId, source.type, source.id, source.ordinal);
      }
    });
  }

  getRollupSources(
    rollupId: string
  ): Array<{ source_type: string; source_id: string; ordinal: number }> {
    return this.db
      .prepare(
        `SELECT source_type, source_id, ordinal
         FROM lcm_rollup_sources
         WHERE rollup_id = ?
         ORDER BY ordinal ASC`
      )
      .all(rollupId) as unknown as RollupSourceRow[];
  }

  getState(conversationId: number): RollupStateRow | null {
    const row = this.db
      .prepare(
        `SELECT
          conversation_id,
          timezone,
          last_message_at,
          last_rollup_check_at,
          last_daily_build_at,
          last_weekly_build_at,
          last_monthly_build_at,
          pending_rebuild,
          updated_at
         FROM lcm_rollup_state
         WHERE conversation_id = ?`
      )
      .get(conversationId) as RollupStateRow | undefined;

    return row ?? null;
  }

  getLatestLeafSummaryCreatedAt(conversationId: number): string | null {
    const row = this.db
      .prepare(
        `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', MAX(julianday(created_at))) AS latest_created_at
         FROM summaries
         WHERE conversation_id = ?
           AND kind = 'leaf'`
      )
      .get(conversationId) as { latest_created_at: string | null } | undefined;

    return row?.latest_created_at ?? null;
  }

  getLeafSummarySweepFingerprint(conversationId: number): string {
    const rows = this.db
      .prepare(
        `SELECT
          summary_id,
          content,
          token_count,
          source_message_token_count,
          strftime('%Y-%m-%dT%H:%M:%fZ', earliest_at) AS earliest_at,
          strftime('%Y-%m-%dT%H:%M:%fZ', latest_at) AS latest_at,
          strftime('%Y-%m-%dT%H:%M:%fZ', created_at) AS created_at
         FROM summaries
         WHERE conversation_id = ?
           AND kind = 'leaf'
         ORDER BY summary_id ASC`
      )
      .all(conversationId) as Array<{
        summary_id: string;
        content: string;
        token_count: number;
        source_message_token_count: number;
        earliest_at: string | null;
        latest_at: string | null;
        created_at: string;
      }>;
    const hash = createHash("sha256");
    for (const row of rows) {
      hash.update(JSON.stringify(row));
      hash.update("\n");
    }
    return hash.digest("hex");
  }

  upsertState(
    conversationId: number,
    updates: Partial<
      Pick<
        RollupStateRow,
        | "timezone"
        | "last_message_at"
        | "last_rollup_check_at"
        | "last_daily_build_at"
        | "last_weekly_build_at"
        | "last_monthly_build_at"
        | "pending_rebuild"
      >
    >
  ): void {
    const timezone = updates.timezone ?? null;
    const lastMessageAt = updates.last_message_at ?? null;
    const lastRollupCheckAt = updates.last_rollup_check_at ?? null;
    const lastDailyBuildAt = updates.last_daily_build_at ?? null;
    const lastWeeklyBuildAt = updates.last_weekly_build_at ?? null;
    const lastMonthlyBuildAt = updates.last_monthly_build_at ?? null;
    const pendingRebuild = updates.pending_rebuild ?? null;

    this.db
      .prepare(
        `INSERT INTO lcm_rollup_state (
          conversation_id,
          timezone,
          last_message_at,
          last_rollup_check_at,
          last_daily_build_at,
          last_weekly_build_at,
          last_monthly_build_at,
          pending_rebuild,
          updated_at
        ) VALUES (?, COALESCE(?, 'UTC'), ?, ?, ?, ?, ?, COALESCE(?, 0), datetime('now'))
        ON CONFLICT(conversation_id) DO UPDATE SET
          timezone = CASE WHEN ? IS NULL THEN lcm_rollup_state.timezone ELSE excluded.timezone END,
          last_message_at = CASE WHEN ? IS NULL THEN lcm_rollup_state.last_message_at ELSE excluded.last_message_at END,
          last_rollup_check_at = CASE WHEN ? IS NULL THEN lcm_rollup_state.last_rollup_check_at ELSE excluded.last_rollup_check_at END,
          last_daily_build_at = CASE WHEN ? IS NULL THEN lcm_rollup_state.last_daily_build_at ELSE excluded.last_daily_build_at END,
          last_weekly_build_at = CASE WHEN ? IS NULL THEN lcm_rollup_state.last_weekly_build_at ELSE excluded.last_weekly_build_at END,
          last_monthly_build_at = CASE WHEN ? IS NULL THEN lcm_rollup_state.last_monthly_build_at ELSE excluded.last_monthly_build_at END,
          pending_rebuild = CASE WHEN ? IS NULL THEN lcm_rollup_state.pending_rebuild ELSE excluded.pending_rebuild END,
          updated_at = datetime('now')`
      )
      .run(
        conversationId,
        timezone,
        lastMessageAt,
        lastRollupCheckAt,
        lastDailyBuildAt,
        lastWeeklyBuildAt,
        lastMonthlyBuildAt,
        pendingRebuild,
        timezone,
        lastMessageAt,
        lastRollupCheckAt,
        lastDailyBuildAt,
        lastWeeklyBuildAt,
        lastMonthlyBuildAt,
        pendingRebuild
      );
  }

  getLeafSummariesForDay(
    conversationId: number,
    dayStart: string,
    dayEnd: string
  ): LeafSummaryForDayRow[] {
    return this.db
      .prepare(
        `SELECT
          summary_id,
          content,
          token_count,
          source_message_token_count,
          strftime('%Y-%m-%dT%H:%M:%fZ', earliest_at) AS earliest_at,
          strftime('%Y-%m-%dT%H:%M:%fZ', latest_at) AS latest_at,
          strftime('%Y-%m-%dT%H:%M:%fZ', created_at) AS created_at,
          NULL AS updated_at,
          COALESCE(
            NULLIF(
              (
                SELECT COUNT(*)
                FROM summary_messages sm
                WHERE sm.summary_id = summaries.summary_id
              ),
              0
            ),
            1
          ) AS source_message_count
         FROM summaries
         WHERE conversation_id = ?
           AND kind = 'leaf'
           AND julianday(coalesce(earliest_at, latest_at, created_at)) < julianday(?)
           AND julianday(coalesce(latest_at, earliest_at, created_at)) >= julianday(?)
         ORDER BY julianday(coalesce(earliest_at, latest_at, created_at)) ASC, created_at ASC`
      )
      .all(
        conversationId,
        dayEnd,
        dayStart
      ) as unknown as LeafSummaryForDayRow[];
  }
}
