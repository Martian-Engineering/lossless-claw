import * as crypto from "node:crypto";
import { estimateTokens } from "./estimate-tokens.js";
import { withDatabaseTransaction } from "./transaction-mutex.js";
import {
  addDays,
  assertValidPlainDate,
  getLocalDateKey,
  getLocalDayBoundsForDateKey,
  getUtcDateForZonedMidnight,
} from "./timezone-windows.js";
import type {
  LeafSummaryForDayRow,
  RollupRow,
  RollupStateRow,
  RollupStore,
} from "./store/rollup-store.js";

export { getLocalDateKey, getLocalDayBounds } from "./timezone-windows.js";

const DEFAULT_DAILY_TARGET_TOKENS = 5_000;
// Default storage caps follow the user's design math: daily 40K → weekly
// 140K (≈20K avg per day × 7) → monthly 560K (≈4 weeks × 140K). These are
// STORAGE caps; the per-call response size is bounded separately by
// lcm_recent's detailLevel + maxOutputTokens so the agent's prompt stays
// well under the model's context window.
const DEFAULT_DAILY_MAX_TOKENS = 40_000;
const DEFAULT_WEEKLY_MAX_TOKENS = 140_000;
const DEFAULT_MONTHLY_MAX_TOKENS = 560_000;
const TIMELINE_SENTENCE_LIMIT = 3;
const TIMELINE_MAX_CHARS = 500;
const DAY_PERIOD_KIND = "day";
const WEEK_PERIOD_KIND = "week";
const MONTH_PERIOD_KIND = "month";

export interface RollupBuilderConfig {
  timezone: string;
  dailyTargetTokens?: number;
  dailyMaxTokens?: number;
  weeklyMaxTokens?: number;
  monthlyMaxTokens?: number;
}

export interface BuildResult {
  built: number;
  skipped: number;
  errors: string[];
}

export interface BuildAggregateRollupsOptions {
  daysBack?: number;
}

type RollupSourceRecord = {
  type: "summary" | "rollup";
  id: string;
  ordinal: number;
};

type SummaryRecord = {
  summaryId: string;
  content: string;
  tokenCount: number;
  earliestAt: Date | null;
  latestAt: Date | null;
  createdAt: Date;
  updatedAt: Date | null;
  sourceMessageCount: number;
  sourceMessageTokenCount: number;
  kind: "leaf" | "condensed";
};

type TimelineEntry = {
  summaryId: string;
  timeLabel: string;
  content: string;
  tokenCount: number;
  sourceCreatedAt: Date;
};

type RollupDraft = {
  content: string;
  summaryTokenCount: number;
  omittedEntries: number;
};

export class RollupBuilder {
  private readonly dailyMaxTokens: number;
  private readonly weeklyMaxTokens: number;
  private readonly monthlyMaxTokens: number;

  constructor(private store: RollupStore, private config: RollupBuilderConfig) {
    const dailyTargetTokens = normalizePositiveInt(
      config.dailyTargetTokens,
      DEFAULT_DAILY_TARGET_TOKENS
    );
    this.dailyMaxTokens = Math.max(
      dailyTargetTokens,
      normalizePositiveInt(config.dailyMaxTokens, DEFAULT_DAILY_MAX_TOKENS)
    );
    this.weeklyMaxTokens = normalizePositiveInt(
      config.weeklyMaxTokens,
      DEFAULT_WEEKLY_MAX_TOKENS
    );
    this.monthlyMaxTokens = normalizePositiveInt(
      config.monthlyMaxTokens,
      DEFAULT_MONTHLY_MAX_TOKENS
    );
  }

  async buildWeeklyMonthlyRollups(
    conversationId: number,
    options: BuildAggregateRollupsOptions = {}
  ): Promise<BuildResult> {
    const result: BuildResult = { built: 0, skipped: 0, errors: [] };
    const weeklyErrorStart = result.errors.length;
    const weeks = this.collectAggregateKeys(
      conversationId,
      WEEK_PERIOD_KIND,
      options
    );
    for (const weekKey of weeks) {
      try {
        (await this.buildAggregateRollup(
          conversationId,
          WEEK_PERIOD_KIND,
          weekKey
        ))
          ? (result.built += 1)
          : (result.skipped += 1);
      } catch (error) {
        result.errors.push(
          `week ${weekKey}: build failed: ${formatError(error)}`
        );
      }
    }
    const weeklySucceeded = result.errors.length === weeklyErrorStart;

    const monthlyErrorStart = result.errors.length;
    const months = this.collectAggregateKeys(
      conversationId,
      MONTH_PERIOD_KIND,
      options
    );
    for (const monthKey of months) {
      try {
        (await this.buildAggregateRollup(
          conversationId,
          MONTH_PERIOD_KIND,
          monthKey
        ))
          ? (result.built += 1)
          : (result.skipped += 1);
      } catch (error) {
        result.errors.push(
          `month ${monthKey}: build failed: ${formatError(error)}`
        );
      }
    }
    const monthlySucceeded = result.errors.length === monthlyErrorStart;

    const builtAt = new Date().toISOString();
    this.store.upsertState(conversationId, {
      timezone: this.config.timezone,
      ...(weeklySucceeded ? { last_weekly_build_at: builtAt } : {}),
      ...(monthlySucceeded ? { last_monthly_build_at: builtAt } : {}),
      last_rollup_check_at: builtAt,
      ...(result.errors.length > 0 ? { pending_rebuild: 1 } : {}),
    });

    return result;
  }

  async buildWeeklyRollup(
    conversationId: number,
    weekKey: string
  ): Promise<boolean> {
    const canonicalWeekKey = startOfWeekKey(weekKey, this.config.timezone);
    if (weekKey !== canonicalWeekKey) {
      throw new Error(
        `Week key must be a Monday calendar week start: ${canonicalWeekKey}`
      );
    }
    return this.buildAggregateRollup(conversationId, WEEK_PERIOD_KIND, weekKey);
  }

  async buildMonthlyRollup(
    conversationId: number,
    monthKey: string
  ): Promise<boolean> {
    return this.buildAggregateRollup(
      conversationId,
      MONTH_PERIOD_KIND,
      monthKey
    );
  }

  private collectAggregateKeys(
    conversationId: number,
    periodKind: "week" | "month",
    options: BuildAggregateRollupsOptions = {}
  ): string[] {
    const windowStart = this.getAggregateWindowStart(options);
    const overlapsWindow = (rollup: RollupRow): boolean =>
      !windowStart || new Date(rollup.period_end) > windowStart;
    const dayRollups = this.store.listRollups(
      conversationId,
      DAY_PERIOD_KIND,
      null
    );
    const keys = new Set<string>();
    for (const rollup of this.store.listRollups(
      conversationId,
      periodKind,
      null
    )) {
      if (
        rollup.timezone === this.config.timezone &&
        overlapsWindow(rollup)
      ) {
        keys.add(rollup.period_key);
      }
    }
    for (const rollup of dayRollups) {
      if (!overlapsWindow(rollup)) {
        continue;
      }
      if (rollup.status !== "ready" && rollup.status !== "stale") {
        continue;
      }
      const key =
        periodKind === WEEK_PERIOD_KIND
          ? startOfWeekKey(
              rollup.period_key,
              rollup.timezone || this.config.timezone
            )
          : rollup.period_key.slice(0, 7);
      keys.add(key);
    }
    return [...keys].sort();
  }

  private getAggregateWindowStart(
    options: BuildAggregateRollupsOptions
  ): Date | null {
    if (options.daysBack == null) {
      return null;
    }
    const daysBack = Math.max(1, Math.floor(options.daysBack));
    const currentDay = getLocalDateKey(new Date(), this.config.timezone);
    const startKey = addDays(currentDay, -(daysBack - 1));
    return getLocalDayBoundsForDateKey(startKey, this.config.timezone).start;
  }

  private async buildAggregateRollup(
    conversationId: number,
    periodKind: "week" | "month",
    periodKey: string
  ): Promise<boolean> {
    const bounds =
      periodKind === WEEK_PERIOD_KIND
        ? getWeekBounds(periodKey, this.config.timezone)
        : getMonthBounds(periodKey, this.config.timezone);
    const sourceRollups = this.store
      .listRollupsInRange(
        conversationId,
        DAY_PERIOD_KIND,
        bounds.start.toISOString(),
        bounds.end.toISOString()
      )
      .filter(
        (rollup) =>
          rollup.timezone === this.config.timezone && rollup.status === "ready"
      )
      .sort((left, right) => left.period_key.localeCompare(right.period_key));

    const existing = this.store.getRollup(
      conversationId,
      periodKind,
      periodKey,
      this.config.timezone
    );
    if (sourceRollups.length === 0) {
      if (existing) {
        this.store.deleteRollup(existing.rollup_id);
        return true;
      }
      return false;
    }
    const expectedDayKeys = getAggregateDayKeys(periodKind, periodKey);
    const sourceDayKeys = new Set(
      sourceRollups.map((rollup) => rollup.period_key)
    );
    const missingActiveDayKeys = expectedDayKeys.filter((key) => {
      if (sourceDayKeys.has(key)) {
        return false;
      }
      const dayBounds = getLocalDayBoundsForDateKey(key, this.config.timezone);
      return this.getLeafSummariesForDay(
        conversationId,
        dayBounds.start,
        dayBounds.end
      ).some((summary) => summary.kind === "leaf");
    });
    if (missingActiveDayKeys.length > 0) {
      if (existing) {
        this.store.deleteRollup(existing.rollup_id);
      }
      return false;
    }

    const sourceTokens = sourceRollups.reduce(
      (sum, rollup) => sum + safeTokenCount(rollup.source_token_count),
      0
    );
    const fingerprint = computeFingerprint(
      sourceRollups.map((rollup) => ({
        id: rollup.rollup_id,
        tokenCount: rollup.source_token_count,
        content: rollup.content,
        earliestAt: rollup.coverage_start,
        latestAt: rollup.coverage_end,
        sourceCount: rollup.source_message_count,
        sourceTokenCount: rollup.source_token_count,
        sourceFingerprint: rollup.source_fingerprint,
      }))
    );
    if (existing?.source_fingerprint === fingerprint && existing.status === "ready") {
      return false;
    }

    const draft = buildAggregateRollupContent({
      periodKind,
      periodKey,
      sourceRollups,
      maxTokens:
        periodKind === WEEK_PERIOD_KIND
          ? this.weeklyMaxTokens
          : this.monthlyMaxTokens,
    });
    const rollupId =
      existing?.rollup_id ?? buildRollupId(periodKind, periodKey);
    const sourceSummaryIds = uniqueStrings(
      sourceRollups.flatMap((rollup) =>
        parseJsonStringArray(rollup.source_summary_ids)
      )
    );
    const sourceMessageCount = sourceRollups.reduce(
      (sum, rollup) => sum + safeTokenCount(rollup.source_message_count),
      0
    );

    await withDatabaseTransaction(
      this.store.db,
      "BEGIN IMMEDIATE",
      async () => {
        this.store.upsertRollup({
          rollup_id: rollupId,
          conversation_id: conversationId,
          period_kind: periodKind,
          period_key: periodKey,
          period_start: bounds.start.toISOString(),
          period_end: bounds.end.toISOString(),
          timezone: this.config.timezone,
          content: draft.content,
          token_count: draft.summaryTokenCount,
          source_summary_ids: JSON.stringify(sourceSummaryIds),
          source_message_count: sourceMessageCount,
          source_token_count: sourceTokens,
          status: "ready",
          coverage_start:
            sourceRollups[0]?.coverage_start ??
            sourceRollups[0]?.period_start ??
            null,
          coverage_end:
            sourceRollups[sourceRollups.length - 1]?.coverage_end ??
            sourceRollups[sourceRollups.length - 1]?.period_end ??
            null,
          summarizer_model: "rollup-concat-v1",
          source_fingerprint: fingerprint,
        });

        await this.store.replaceRollupSources(
          rollupId,
          sourceRollups.map((rollup, index) => ({
            type: "rollup",
            id: rollup.rollup_id,
            ordinal: index,
          }))
        );
      }
    );

    return true;
  }

  async buildDailyRollups(
    conversationId: number,
    options: { forceCurrentDay?: boolean; daysBack?: number } = {}
  ): Promise<BuildResult> {
    const result: BuildResult = { built: 0, skipped: 0, errors: [] };
    const daysBack = normalizePositiveInt(options.daysBack, 7);
    const forceCurrentDay = options.forceCurrentDay === true;
    const now = new Date();
    const todayKey = getLocalDateKey(now, this.config.timezone);

    let state: RollupStateRow | null;
    try {
      state = this.store.getState(conversationId);
    } catch (error) {
      result.errors.push(`state lookup failed: ${formatError(error)}`);
      return result;
    }

    if (state && state.pending_rebuild === 0 && !forceCurrentDay) {
      result.skipped += daysBack;
      return result;
    }

    const scannedAt = new Date();
    let scanFingerprint: string;
    try {
      scanFingerprint = this.store.getLeafSummarySweepFingerprint(conversationId);
    } catch (error) {
      result.errors.push(`leaf summary fingerprint failed: ${formatError(error)}`);
      return result;
    }

    for (let offset = 0; offset < daysBack; offset += 1) {
      const dateKey = addDays(todayKey, -offset);
      if (!forceCurrentDay && dateKey === todayKey) {
        result.skipped += 1;
        continue;
      }

      const { start, end } = getLocalDayBoundsForDateKey(
        dateKey,
        this.config.timezone
      );
      let summaries: SummaryRecord[];
      try {
        summaries = this.getLeafSummariesForDay(conversationId, start, end);
      } catch (error) {
        result.errors.push(
          `${dateKey}: leaf summary lookup failed: ${formatError(error)}`
        );
        continue;
      }

      const leafSummaries = summaries
        .filter((summary) => summary.kind === "leaf")
        .sort(compareSummariesChronologically);
      if (leafSummaries.length === 0) {
        try {
          const existing = this.store.getRollup(
            conversationId,
            DAY_PERIOD_KIND,
            dateKey,
            this.config.timezone
          );
          if (existing) {
            this.store.deleteRollup(existing.rollup_id);
            result.built += 1;
            continue;
          }
          result.skipped += 1;
        } catch (error) {
          result.errors.push(
            `${dateKey}: empty-day cleanup failed: ${formatError(error)}`
          );
        }
        continue;
      }

      const fingerprint = computeFingerprint(
        leafSummaries.map((summary) => ({
          id: summary.summaryId,
          tokenCount: summary.tokenCount,
          content: summary.content,
          updatedAt: summary.updatedAt,
          createdAt: summary.createdAt,
          earliestAt: summary.earliestAt,
          latestAt: summary.latestAt,
          sourceCount: summary.sourceMessageCount,
          sourceTokenCount: summary.sourceMessageTokenCount,
        }))
      );

      let existing: RollupRow | null = null;
      try {
        existing = this.store.getRollup(
          conversationId,
          DAY_PERIOD_KIND,
          dateKey,
          this.config.timezone
        );
      } catch (error) {
        result.errors.push(
          `${dateKey}: existing rollup lookup failed: ${formatError(error)}`
        );
        continue;
      }

      if (existing?.source_fingerprint === fingerprint && existing.status === "ready") {
        result.skipped += 1;
        continue;
      }

      try {
        const built = await this.buildDayRollup(conversationId, dateKey);
        if (built) {
          result.built += 1;
        } else {
          result.skipped += 1;
        }
      } catch (error) {
        result.errors.push(`${dateKey}: build failed: ${formatError(error)}`);
      }
    }

    try {
      const finishedAt = new Date();
      const latestState = this.store.getState(conversationId);
      const latestSummaryCreatedAt =
        this.store.getLatestLeafSummaryCreatedAt(conversationId);
      const latestSummaryFingerprint =
        this.store.getLeafSummarySweepFingerprint(conversationId);
      const shouldClearPending =
        result.errors.length === 0 &&
        isTimestampAtOrBefore(latestState?.last_message_at, scannedAt) &&
        isTimestampAtOrBefore(latestSummaryCreatedAt, scannedAt) &&
        latestSummaryFingerprint === scanFingerprint;
      this.store.upsertState(conversationId, {
        timezone: this.config.timezone,
        last_rollup_check_at: laterDate(
          finishedAt,
          latestState?.last_rollup_check_at
        ).toISOString(),
        pending_rebuild:
          result.errors.length === 0 && shouldClearPending ? 0 : 1,
      });
    } catch (error) {
      result.errors.push(`final sweep state update failed: ${formatError(error)}`);
    }

    return result;
  }

  async buildDayRollup(
    conversationId: number,
    dateKey: string
  ): Promise<boolean> {
    const { start, end } = getLocalDayBoundsForDateKey(
      dateKey,
      this.config.timezone
    );
    const summaries = this.getLeafSummariesForDay(conversationId, start, end)
      .filter((summary) => summary.kind === "leaf")
      .sort(compareSummariesChronologically);

    if (summaries.length === 0) {
      const existing = this.store.getRollup(
        conversationId,
        DAY_PERIOD_KIND,
        dateKey,
        this.config.timezone
      );
      if (existing) {
        this.store.deleteRollup(existing.rollup_id);
        return true;
      }
      return false;
    }

    const totalSourceTokens = summaries.reduce(
      (sum, summary) => sum + safeTokenCount(summary.sourceMessageTokenCount),
      0
    );
    const sourceMessageCount = summaries.reduce(
      (sum, summary) => sum + Math.max(1, summary.sourceMessageCount),
      0
    );
    const fingerprint = computeFingerprint(
      summaries.map((summary) => ({
        id: summary.summaryId,
        tokenCount: summary.tokenCount,
        content: summary.content,
        updatedAt: summary.updatedAt,
        createdAt: summary.createdAt,
        earliestAt: summary.earliestAt,
        latestAt: summary.latestAt,
        sourceCount: summary.sourceMessageCount,
        sourceTokenCount: summary.sourceMessageTokenCount,
      }))
    );
    const draft = buildDailyRollupContent({
      dateKey,
      summaries,
      timezone: this.config.timezone,
      maxTokens: this.dailyMaxTokens,
    });
    const builtAt = new Date();
    const coverage = getCoverageBounds(summaries);

    await withDatabaseTransaction(
      this.store.db,
      "BEGIN IMMEDIATE",
      async () => {
        const existing = this.store.getRollup(
          conversationId,
          DAY_PERIOD_KIND,
          dateKey,
          this.config.timezone
        );
        const rollupId =
          existing?.rollup_id ?? buildRollupId(DAY_PERIOD_KIND, dateKey);

        this.store.upsertRollup({
          rollup_id: rollupId,
          conversation_id: conversationId,
          period_kind: DAY_PERIOD_KIND,
          period_key: dateKey,
          period_start: start.toISOString(),
          period_end: end.toISOString(),
          timezone: this.config.timezone,
          content: draft.content,
          token_count: draft.summaryTokenCount,
          source_summary_ids: JSON.stringify(
            summaries.map((summary) => summary.summaryId)
          ),
          source_message_count: sourceMessageCount,
          source_token_count: totalSourceTokens,
          status: "ready",
          coverage_start: coverage.start?.toISOString() ?? null,
          coverage_end: coverage.end?.toISOString() ?? null,
          summarizer_model: "concatenation-v1",
          source_fingerprint: fingerprint,
        });

        await this.store.replaceRollupSources(
          rollupId,
          summaries.map((summary, index) => ({
            type: "summary",
            id: summary.summaryId,
            ordinal: index,
          }))
        );

        this.store.upsertState(conversationId, {
          timezone: this.config.timezone,
          last_daily_build_at: builtAt.toISOString(),
          last_rollup_check_at: builtAt.toISOString(),
        });
      }
    );

    return true;
  }

  private getLeafSummariesForDay(
    conversationId: number,
    start: Date,
    end: Date
  ): SummaryRecord[] {
    return this.store
      .getLeafSummariesForDay(
        conversationId,
        start.toISOString(),
        end.toISOString()
      )
      .map((summary: LeafSummaryForDayRow) => ({
        summaryId: summary.summary_id,
        content: summary.content,
        tokenCount: summary.token_count,
        sourceMessageTokenCount: summary.source_message_token_count,
        earliestAt: summary.earliest_at ? new Date(summary.earliest_at) : null,
        latestAt: summary.latest_at ? new Date(summary.latest_at) : null,
        createdAt: new Date(summary.created_at),
        updatedAt: summary.updated_at ? new Date(summary.updated_at) : null,
        sourceMessageCount: summary.source_message_count,
        kind: "leaf",
      }));
  }
}

type FingerprintSource = {
  id: string;
  tokenCount?: number | null;
  content?: string | null;
  updatedAt?: string | Date | null;
  createdAt?: string | Date | null;
  earliestAt?: string | Date | null;
  latestAt?: string | Date | null;
  sourceCount?: number | null;
  sourceTokenCount?: number | null;
  sourceFingerprint?: string | null;
};

export function computeFingerprint(sources: FingerprintSource[]): string {
  const normalized = [...sources]
    .map((source) => ({
      id: source.id,
      tokenCount: safeTokenCount(source.tokenCount ?? 0),
      contentHash: crypto
        .createHash("sha256")
        .update(source.content ?? "")
        .digest("hex")
        .slice(0, 16),
      updatedAt: normalizeFingerprintDate(source.updatedAt),
      createdAt: normalizeFingerprintDate(source.createdAt),
      earliestAt: normalizeFingerprintDate(source.earliestAt),
      latestAt: normalizeFingerprintDate(source.latestAt),
      sourceCount: safeTokenCount(source.sourceCount ?? 0),
      sourceTokenCount: safeTokenCount(source.sourceTokenCount ?? 0),
      sourceFingerprint: source.sourceFingerprint ?? "",
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex")
    .slice(0, 16);
}

function normalizeFingerprintDate(value: string | Date | null | undefined): string {
  if (value == null) {
    return "";
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function isTimestampAtOrBefore(
  value: string | null | undefined,
  boundary: Date
): boolean {
  if (!value) {
    return true;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) || parsed <= boundary;
}

function laterDate(left: Date, right: string | null | undefined): Date {
  if (!right) {
    return left;
  }
  const parsed = new Date(right);
  if (Number.isNaN(parsed.getTime())) {
    return left;
  }
  return parsed > left ? parsed : left;
}

function buildRollupId(periodKind: string, periodKey: string): string {
  return `rollup_${periodKind}_${periodKey}_${crypto.randomUUID().slice(0, 8)}`;
}

function buildAggregateRollupContent(params: {
  periodKind: "week" | "month";
  periodKey: string;
  sourceRollups: RollupRow[];
  maxTokens: number;
}): RollupDraft {
  let rollups = [...params.sourceRollups];
  let omittedEntries = 0;
  let content = renderAggregateRollup(
    params.periodKind,
    params.periodKey,
    rollups,
    omittedEntries
  );
  while (rollups.length > 1 && estimateTokens(content) > params.maxTokens) {
    rollups = rollups.slice(1);
    omittedEntries += 1;
    content = renderAggregateRollup(
      params.periodKind,
      params.periodKey,
      rollups,
      omittedEntries
    );
  }
  return {
    content,
    summaryTokenCount: estimateTokens(content),
    omittedEntries,
  };
}

function renderAggregateRollup(
  periodKind: "week" | "month",
  periodKey: string,
  rollups: RollupRow[],
  omittedEntries: number
): string {
  const title =
    periodKind === WEEK_PERIOD_KIND ? "Weekly Summary" : "Monthly Summary";
  const lines: string[] = [`# ${title}: ${periodKey}`, ""];
  if (omittedEntries > 0) {
    lines.push(
      `(${omittedEntries} earlier daily rollups omitted to fit budget)`,
      "",
    );
  }
  // Embed each day's FULL rollup content. Per-day truncation has been
  // replaced by a total-budget cap in buildAggregateRollupContent's outer
  // trim loop — when the budget is exceeded it drops oldest days entirely
  // instead of stripping per-day detail. This produces a real aggregate
  // (~10-20K per day × N days) rather than a 200-char-per-day TOC.
  for (const rollup of rollups) {
    lines.push(`## ${rollup.period_key}`);
    lines.push("");
    lines.push(rollup.content.trim());
    lines.push("");
  }
  lines.push("---", "## Statistics");
  lines.push(`- Source daily rollups: ${rollups.length}`);
  lines.push(
    `- Total source tokens: ${rollups.reduce(
      (sum, rollup) => sum + safeTokenCount(rollup.source_token_count),
      0
    )}`
  );
  return lines.join("\n");
}

function buildDailyRollupContent(params: {
  dateKey: string;
  summaries: SummaryRecord[];
  timezone: string;
  maxTokens: number;
}): RollupDraft {
  const entries = params.summaries.map((summary) =>
    buildTimelineEntry(summary, params.timezone)
  );
  const keyItems = extractKeyItems(params.summaries);
  const stats = buildStatistics(params.summaries, params.timezone);

  let timelineEntries = [...entries];
  let retainedKeyItems = keyItems;
  let omittedEntries = 0;
  let content = renderDailyRollup({
    dateKey: params.dateKey,
    entries: timelineEntries,
    omittedEntries,
    keyItems: retainedKeyItems,
    stats,
  });

  while (
    timelineEntries.length > 0 &&
    estimateTokens(content) > params.maxTokens
  ) {
    timelineEntries = timelineEntries.slice(1);
    omittedEntries += 1;
    content = renderDailyRollup({
      dateKey: params.dateKey,
      entries: timelineEntries,
      omittedEntries,
      keyItems: retainedKeyItems,
      stats,
    });
  }

  if (
    timelineEntries.length === 0 &&
    estimateTokens(content) > params.maxTokens
  ) {
    while (
      countKeyItems(retainedKeyItems) > 0 &&
      estimateTokens(content) > params.maxTokens
    ) {
      retainedKeyItems = trimLargestKeyItemBucket(retainedKeyItems);
      content = renderDailyRollup({
        dateKey: params.dateKey,
        entries: [],
        omittedEntries: entries.length,
        keyItems: retainedKeyItems,
        stats,
      });
    }
  }

  return {
    content,
    summaryTokenCount: estimateTokens(content),
    omittedEntries,
  };
}

function renderDailyRollup(params: {
  dateKey: string;
  entries: TimelineEntry[];
  omittedEntries: number;
  keyItems: { decisions: string[]; completed: string[]; blockers: string[] };
  stats: { leafSummaries: number; timeSpan: string; totalSourceTokens: number };
}): string {
  const timelineLines: string[] = [];
  if (params.omittedEntries > 0) {
    timelineLines.push(`- (${params.omittedEntries} earlier entries omitted)`);
  }
  if (params.entries.length === 0) {
    timelineLines.push("- No retained timeline entries.");
  } else {
    for (const entry of params.entries) {
      timelineLines.push(`- [${entry.timeLabel}] ${entry.content}`);
    }
  }

  return [
    `# Daily Summary: ${params.dateKey}`,
    "",
    "## Activity Timeline",
    ...timelineLines,
    "",
    "## Key Items",
    `- Decisions: ${formatList(params.keyItems.decisions)}`,
    `- Completed: ${formatList(params.keyItems.completed)}`,
    `- Blockers: ${formatList(params.keyItems.blockers)}`,
    "",
    "## Statistics",
    `- Leaf summaries: ${params.stats.leafSummaries}`,
    `- Time span: ${params.stats.timeSpan}`,
    `- Total source tokens: ${params.stats.totalSourceTokens}`,
  ].join("\n");
}

function buildTimelineEntry(
  summary: SummaryRecord,
  timezone: string
): TimelineEntry {
  const sourceCreatedAt = summary.earliestAt ?? summary.createdAt;
  return {
    summaryId: summary.summaryId,
    timeLabel: formatTime(sourceCreatedAt, timezone),
    content: summariseTimelineContent(summary.content),
    tokenCount: safeTokenCount(summary.tokenCount),
    sourceCreatedAt,
  };
}

function summariseTimelineContent(content: string): string {
  const normalized = normalizeWhitespace(content);
  if (!normalized) {
    return "(empty summary content)";
  }

  const sentences = splitIntoSentences(normalized).slice(
    0,
    TIMELINE_SENTENCE_LIMIT
  );
  const summary = sentences.length > 0 ? sentences.join(" ") : normalized;
  if (summary.length <= TIMELINE_MAX_CHARS) {
    return summary;
  }
  return `${summary.slice(0, TIMELINE_MAX_CHARS - 1).trimEnd()}…`;
}

function extractKeyItems(summaries: SummaryRecord[]): {
  decisions: string[];
  completed: string[];
  blockers: string[];
} {
  const buckets = {
    decisions: collectMatchingLines(
      summaries,
      /\b(decided|decision|chose|agreed)\b/i
    ),
    completed: collectMatchingLines(
      summaries,
      /\b(completed|done|finished|shipped|merged|deployed)\b/i
    ),
    blockers: collectMatchingLines(
      summaries,
      /\b(blocked|failed|error|issue|broken)\b/i
    ),
  };
  return buckets;
}

type KeyItems = {
  decisions: string[];
  completed: string[];
  blockers: string[];
};

function countKeyItems(items: KeyItems): number {
  return items.decisions.length + items.completed.length + items.blockers.length;
}

function trimLargestKeyItemBucket(items: KeyItems): KeyItems {
  const next: KeyItems = {
    decisions: [...items.decisions],
    completed: [...items.completed],
    blockers: [...items.blockers],
  };
  const largestBucket = (Object.keys(next) as Array<keyof KeyItems>).sort(
    (left, right) => next[right].length - next[left].length
  )[0];
  next[largestBucket] = next[largestBucket].slice(1);
  return next;
}

function collectMatchingLines(
  summaries: SummaryRecord[],
  pattern: RegExp
): string[] {
  const seen = new Set<string>();
  const matches: string[] = [];
  for (const summary of summaries) {
    const lines = summary.content
      .split(/\r?\n+/)
      .map((line) => normalizeWhitespace(line))
      .filter(Boolean);
    for (const line of lines) {
      if (!pattern.test(line)) {
        continue;
      }
      const cleaned = stripBulletPrefix(line);
      const key = cleaned.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      matches.push(cleaned);
    }
  }
  return matches;
}

function buildStatistics(
  summaries: SummaryRecord[],
  timezone: string
): { leafSummaries: number; timeSpan: string; totalSourceTokens: number } {
  const orderedTimes = summaries
    .map((summary) => summary.earliestAt ?? summary.createdAt)
    .filter((value): value is Date => value instanceof Date)
    .sort((left, right) => left.getTime() - right.getTime());
  const latestTimes = summaries
    .map((summary) => summary.latestAt ?? summary.createdAt)
    .filter((value): value is Date => value instanceof Date)
    .sort((left, right) => left.getTime() - right.getTime());

  const start = orderedTimes[0] ?? summaries[0]?.createdAt ?? new Date();
  const end =
    latestTimes[latestTimes.length - 1] ??
    summaries[summaries.length - 1]?.createdAt ??
    start;

  return {
    leafSummaries: summaries.length,
    timeSpan: `${formatTime(start, timezone)} — ${formatTime(end, timezone)}`,
    totalSourceTokens: summaries.reduce(
      (sum, summary) => sum + safeTokenCount(summary.sourceMessageTokenCount),
      0
    ),
  };
}

function compareSummariesChronologically(
  left: SummaryRecord,
  right: SummaryRecord
): number {
  const leftTime = (left.earliestAt ?? left.createdAt).getTime();
  const rightTime = (right.earliestAt ?? right.createdAt).getTime();
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return left.summaryId.localeCompare(right.summaryId);
}

function getCoverageBounds(
  summaries: SummaryRecord[]
): { start: Date | null; end: Date | null } {
  const starts = summaries
    .map((summary) => summary.earliestAt ?? summary.createdAt)
    .filter((value): value is Date => value instanceof Date)
    .sort((left, right) => left.getTime() - right.getTime());
  const ends = summaries
    .map((summary) => summary.latestAt ?? summary.createdAt)
    .filter((value): value is Date => value instanceof Date)
    .sort((left, right) => left.getTime() - right.getTime());
  return {
    start: starts[0] ?? null,
    end: ends[ends.length - 1] ?? null,
  };
}

function formatTime(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatList(items: string[]): string {
  return items.length > 0 ? items.join("; ") : "None";
}

function safeTokenCount(value: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function normalizePositiveInt(
  value: number | undefined,
  fallback: number
): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function splitIntoSentences(value: string): string[] {
  const matches = value.match(/[^.!?\n]+(?:[.!?]+|$)/g);
  return matches?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
}

function stripBulletPrefix(value: string): string {
  return value.replace(/^[-*•\d.)\s]+/, "").trim();
}

function parseJsonStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function startOfWeekKey(dayKey: string, timezone: string): string {
  void timezone;
  assertValidDateKey(dayKey);
  const [year, month, day] = dayKey
    .split("-")
    .map((part) => Number.parseInt(part, 10));
  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  const weekday = date.getUTCDay();
  const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
  return addDays(dayKey, mondayOffset);
}

function getWeekBounds(
  weekKey: string,
  timezone: string
): { start: Date; end: Date } {
  assertValidDateKey(weekKey);
  return {
    start: getUtcDateForZonedMidnight(weekKey, timezone),
    end: getUtcDateForZonedMidnight(addDays(weekKey, 7), timezone),
  };
}

function getAggregateDayKeys(
  periodKind: "week" | "month",
  periodKey: string
): string[] {
  const startKey = periodKind === WEEK_PERIOD_KIND ? periodKey : `${periodKey}-01`;
  const endKey =
    periodKind === WEEK_PERIOD_KIND
      ? addDays(periodKey, 7)
      : getNextMonthStartKey(periodKey);
  const keys: string[] = [];
  for (let key = startKey, guard = 0; key < endKey && guard < 370; guard += 1) {
    keys.push(key);
    key = addDays(key, 1);
  }
  return keys;
}

function getNextMonthStartKey(monthKey: string): string {
  if (!/^\d{4}-\d{2}$/.test(monthKey)) {
    throw new Error(`Invalid month key: ${monthKey}`);
  }
  const [year, month] = monthKey
    .split("-")
    .map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(year) || month < 1 || month > 12) {
    throw new Error(`Invalid month key: ${monthKey}`);
  }
  return month === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 1).padStart(2, "0")}-01`;
}

function getMonthBounds(
  monthKey: string,
  timezone: string
): { start: Date; end: Date } {
  if (!/^\d{4}-\d{2}$/.test(monthKey)) {
    throw new Error(`Invalid month key: ${monthKey}`);
  }
  const [year, month] = monthKey
    .split("-")
    .map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(year) || month < 1 || month > 12) {
    throw new Error(`Invalid month key: ${monthKey}`);
  }
  const nextMonth = getNextMonthStartKey(monthKey);
  return {
    start: getUtcDateForZonedMidnight(`${monthKey}-01`, timezone),
    end: getUtcDateForZonedMidnight(nextMonth, timezone),
  };
}

function assertValidDateKey(dateKey: string): void {
  assertValidPlainDate(dateKey, "Invalid date key");
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
