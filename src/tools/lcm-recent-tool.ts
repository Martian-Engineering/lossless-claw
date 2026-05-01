import { Type } from "@sinclair/typebox";
import type { DatabaseSync } from "node:sqlite";
import { formatTimestamp } from "../compaction.js";
import { estimateTokens } from "../estimate-tokens.js";
import type { LcmContextEngine } from "../engine.js";
import type { RollupStore } from "../store/rollup-store.js";
import {
  addDays,
  assertValidPlainDate,
  getUtcDateForZonedLocalTime,
  getUtcDateForZonedMidnight,
  getZonedDayString,
} from "../timezone-windows.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { resolveLcmConversationScope } from "./lcm-conversation-scope.js";

const DEFAULT_RECENT_OUTPUT_TOKENS = 24_000;
const DEFAULT_RECENT_GLOBAL_MAX_TOKENS = 180_000;
const ABSOLUTE_RECENT_GLOBAL_MAX_TOKENS = 300_000;
const FALLBACK_SQL_LIMIT = 1_000;
const DETAIL_LEVEL_TOKEN_HINTS = new Map<number, number>([
  [0, 12_000],
  [1, 24_000],
  [2, 80_000],
  [3, 180_000],
]);

const LcmRecentSchema = Type.Object({
  period: Type.String({
    description:
      'Time period: "today", "yesterday", "7d", "week", "month", "30d", "date:YYYY-MM-DD", or a deterministic local-time window such as "yesterday 4-8pm", "today morning", "date:2026-04-27 14:00-16:30", "last 3h", or "last 90m"',
  }),
  conversationId: Type.Optional(
    Type.Number({
      description: "Conversation ID. Defaults to current session.",
    })
  ),
  allConversations: Type.Optional(
    Type.Boolean({
      description: "Search all conversations.",
    })
  ),
  includeSources: Type.Optional(
    Type.Boolean({
      description: "Include source summary IDs.",
    })
  ),
  maxOutputTokens: Type.Optional(
    Type.Number({
      description:
        "Requested maximum output tokens for this call. Defaults to a GPT-5.4 Mini-safe compact budget; clamped by globalMaxOutputTokens.",
    })
  ),
  globalMaxOutputTokens: Type.Optional(
    Type.Number({
      description:
        "Global ceiling for this recall response. Use to reserve room for the caller's answer/output budget.",
    })
  ),
  detailLevel: Type.Optional(
    Type.Number({
      description:
        "Retrieval detail level: 0 compact rollup, 1 standard, 2 expanded source summaries, 3 deep source-summary bundle within budget.",
    })
  ),
  maxSourceSummaries: Type.Optional(
    Type.Number({
      description:
        "Maximum leaf summaries to include when using source-summary fallback/detail layers.",
    })
  ),
});

type RollupStatus = "building" | "ready" | "stale" | "failed";
type RollupPeriodKind = "day" | "week" | "month";

type RollupRecord = {
  rollupId: string;
  conversationId: number;
  periodKind: RollupPeriodKind;
  periodKey: string;
  periodStart: Date;
  periodEnd: Date;
  timezone: string;
  content: string;
  tokenCount: number;
  sourceSummaryIds: string[];
  sourceMessageCount: number;
  sourceTokenCount: number;
  status: RollupStatus;
  coverageStart: Date | null;
  coverageEnd: Date | null;
  summarizerModel: string | null;
  sourceFingerprint: string | null;
  builtAt: Date;
  invalidatedAt: Date | null;
  errorText: string | null;
};

type RecentSummaryFallbackRow = {
  summary_id: string;
  kind: string;
  content: string;
  token_count: number;
  source_message_token_count: number;
  created_at: string;
  effective_time: string;
};

type RecentSummaryFallbackResult = {
  summaries: RecentSummaryFallbackRow[];
  availableCount: number;
  sqlTruncated: boolean;
};

type RecallBudget = {
  requestedOutputTokens: number;
  globalMaxOutputTokens: number;
  effectiveOutputTokens: number;
  detailLevel: number;
  maxSourceSummaries: number;
};

type RecallAccounting = {
  outputTokens: number;
  sourceSummaryTokens: number;
  sourceMessageTokens: number;
  summariesIncluded: number;
  summariesAvailable: number;
  summariesOmitted: number;
  truncated: boolean;
};

type PeriodResolution = {
  label: string;
  kind?: RollupPeriodKind;
  periodKey?: string;
  start: Date;
  end: Date;
  window?: {
    day?: string;
    name?: string;
    startMinutes?: number;
    endMinutes?: number;
    relative?: boolean;
  };
};

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

function formatDisplayTime(
  value: Date | string | number | null | undefined,
  timezone: string
): string {
  if (value == null) {
    return "-";
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return formatTimestamp(date, timezone);
}

function getLcmRollupStore(
  lcm: LcmContextEngine,
  inputStore?: RollupStore
): RollupStore {
  const store = inputStore ?? lcm.getRollupStore?.();
  if (store?.db) {
    return store;
  }
  throw new Error("LCM rollup database is unavailable.");
}

function startOfWeekDayString(dayString: string): string {
  const [year, month, day] = dayString.split("-").map((part) => Number(part));
  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  const weekday = date.getUTCDay();
  const mondayOffset = weekday === 0 ? -6 : 1 - weekday;
  return addDays(dayString, mondayOffset);
}

function startOfMonthDayString(dayString: string): string {
  const [year, month] = dayString.split("-");
  return `${year}-${month}-01`;
}

function isEndOfDayClockToken(raw: string): boolean {
  return /^24(?::00)?$/.test(raw.trim().toLowerCase().replace(/\s+/g, ""));
}

function parseClockToken(
  raw: string,
  options: { allowEndOfDay?: boolean } = {}
): number | null {
  const token = raw.trim().toLowerCase().replace(/\s+/g, "");
  const match = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(token);
  if (!match) {
    return null;
  }

  let hour = Number(match[1]);
  const minute = match[2] == null ? 0 : Number(match[2]);
  const meridiem = match[3];
  if (minute < 0 || minute > 59) {
    return null;
  }
  if (meridiem) {
    if (hour < 1 || hour > 12) {
      return null;
    }
    if (meridiem === "am") {
      hour = hour === 12 ? 0 : hour;
    } else {
      hour = hour === 12 ? 12 : hour + 12;
    }
  } else if (hour === 24 && minute === 0 && options.allowEndOfDay) {
    return 24 * 60;
  } else if (hour < 0 || hour > 23) {
    return null;
  }

  return hour * 60 + minute;
}

function inferWindowMeridiems(
  startRaw: string,
  endRaw: string
): { start: string; end: string } {
  const start = startRaw.trim().toLowerCase();
  const end = endRaw.trim().toLowerCase();
  const startMeridiem = /(am|pm)\b/.exec(start)?.[1];
  const endMeridiem = /(am|pm)\b/.exec(end)?.[1];
  if (startMeridiem && !endMeridiem && !isEndOfDayClockToken(end)) {
    return { start, end: `${end}${startMeridiem}` };
  }
  if (!startMeridiem && endMeridiem) {
    return { start: `${start}${endMeridiem}`, end };
  }
  return { start, end };
}

function parseNamedWindow(
  name: string
): { startMinutes: number; endMinutes: number; name: string } | null {
  switch (name.trim().toLowerCase()) {
    case "morning":
      return { name: "morning", startMinutes: 6 * 60, endMinutes: 12 * 60 };
    case "afternoon":
      return { name: "afternoon", startMinutes: 12 * 60, endMinutes: 17 * 60 };
    case "evening":
      return { name: "evening", startMinutes: 17 * 60, endMinutes: 22 * 60 };
    case "night":
      return { name: "night", startMinutes: 22 * 60, endMinutes: 24 * 60 };
    default:
      return null;
  }
}

function parseExplicitWindow(
  windowText: string
): { startMinutes: number; endMinutes: number; label: string } | null {
  const match = /^(.+?)\s*(?:-|–|—|to)\s*(.+)$/.exec(
    windowText.trim().toLowerCase()
  );
  if (!match) {
    return null;
  }

  const displayStartRaw = match[1].trim();
  const displayEndRaw = match[2].trim();
  const { start: startRaw, end: endRaw } = inferWindowMeridiems(
    displayStartRaw,
    displayEndRaw
  );
  const startMinutes = parseClockToken(startRaw);
  const endMinutes = parseClockToken(endRaw, { allowEndOfDay: true });
  if (
    startMinutes == null ||
    endMinutes == null ||
    endMinutes <= startMinutes
  ) {
    return null;
  }

  return {
    startMinutes,
    endMinutes,
    label: `${displayStartRaw}-${displayEndRaw}`,
  };
}

function parseBaseDay(
  baseText: string,
  today: string
): { day: string; label: string } | null {
  const base = baseText.trim().toLowerCase();
  if (base === "today") {
    return { day: today, label: "today" };
  }
  if (base === "yesterday") {
    return { day: addDays(today, -1), label: "yesterday" };
  }
  if (base.startsWith("date:")) {
    const day = base.slice(5).trim();
    assertValidPlainDate(day);
    return { day, label: day };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(base)) {
    assertValidPlainDate(base);
    return { day: base, label: base };
  }
  return null;
}

function resolveWindowPeriod(
  normalized: string,
  timezone: string,
  today: string
): PeriodResolution | null {
  const relative =
    /^last\s+(\d+)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)$/.exec(
      normalized
    );
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const minutes = unit.startsWith("h") ? amount * 60 : amount;
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return null;
    }
    const end = new Date();
    const start = new Date(end.getTime() - minutes * 60_000);
    return {
      label: `last ${amount}${unit.startsWith("h") ? "h" : "m"}`,
      start,
      end,
      window: { relative: true },
    };
  }

  const windowMatch =
    /^(today|yesterday|date:\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2})\s+(.+)$/.exec(
      normalized
    );
  if (!windowMatch) {
    return null;
  }

  const base = parseBaseDay(windowMatch[1], today);
  if (!base) {
    return null;
  }

  const windowText = windowMatch[2].trim();
  const named = parseNamedWindow(windowText);
  const explicit = named ?? parseExplicitWindow(windowText);
  if (!explicit) {
    return null;
  }

  const start = getUtcDateForZonedLocalTime(
    base.day,
    timezone,
    explicit.startMinutes
  );
  const end = getUtcDateForZonedLocalTime(
    base.day,
    timezone,
    explicit.endMinutes
  );
  const windowLabel = "name" in explicit ? explicit.name : explicit.label;
  return {
    label: `${base.label} ${windowLabel}`,
    kind: "day",
    periodKey: base.day,
    start,
    end,
    window: {
      day: base.day,
      name: windowLabel,
      startMinutes: explicit.startMinutes,
      endMinutes: explicit.endMinutes,
    },
  };
}

function resolvePeriod(period: string, timezone: string): PeriodResolution {
  const normalized = period.trim().toLowerCase().replace(/\s+/g, " ");
  const now = new Date();
  const today = getZonedDayString(now, timezone);
  const windowPeriod = resolveWindowPeriod(normalized, timezone, today);
  if (windowPeriod) {
    return windowPeriod;
  }

  if (normalized === "today") {
    const start = getUtcDateForZonedMidnight(today, timezone);
    const end = getUtcDateForZonedMidnight(addDays(today, 1), timezone);
    return { label: "today", kind: "day", periodKey: today, start, end };
  }

  if (normalized === "yesterday") {
    const day = addDays(today, -1);
    const start = getUtcDateForZonedMidnight(day, timezone);
    const end = getUtcDateForZonedMidnight(today, timezone);
    return { label: "yesterday", kind: "day", periodKey: day, start, end };
  }

  if (normalized.startsWith("date:")) {
    const day = normalized.slice(5);
    try {
      assertValidPlainDate(day);
    } catch {
      throw new Error('period date must be in the form "date:YYYY-MM-DD" with a real calendar date.');
    }
    const start = getUtcDateForZonedMidnight(day, timezone);
    const end = getUtcDateForZonedMidnight(addDays(day, 1), timezone);
    return { label: day, kind: "day", periodKey: day, start, end };
  }

  if (normalized === "7d") {
    const startDay = addDays(today, -6);
    return {
      label: "last 7 days",
      kind: "day",
      start: getUtcDateForZonedMidnight(startDay, timezone),
      end: getUtcDateForZonedMidnight(addDays(today, 1), timezone),
    };
  }

  if (normalized === "30d") {
    const startDay = addDays(today, -29);
    return {
      label: "last 30 days",
      kind: "day",
      start: getUtcDateForZonedMidnight(startDay, timezone),
      end: getUtcDateForZonedMidnight(addDays(today, 1), timezone),
    };
  }

  if (normalized === "week") {
    const weekStartDay = startOfWeekDayString(today);
    const start = getUtcDateForZonedMidnight(weekStartDay, timezone);
    const end = getUtcDateForZonedMidnight(addDays(weekStartDay, 7), timezone);
    return {
      label: `week of ${weekStartDay}`,
      kind: "week",
      periodKey: weekStartDay,
      start,
      end,
    };
  }

  if (normalized === "month") {
    const monthStartDay = startOfMonthDayString(today);
    const [year, month] = monthStartDay.split("-").map((part) => Number(part));
    const nextMonthStartDay = `${month === 12 ? year + 1 : year}-${String(
      month === 12 ? 1 : month + 1
    ).padStart(2, "0")}-01`;
    return {
      label: `${monthStartDay.slice(0, 7)}`,
      kind: "month",
      periodKey: monthStartDay.slice(0, 7),
      start: getUtcDateForZonedMidnight(monthStartDay, timezone),
      end: getUtcDateForZonedMidnight(nextMonthStartDay, timezone),
    };
  }

  throw new Error(
    'period must be one of "today", "yesterday", "7d", "week", "month", "30d", "date:YYYY-MM-DD", "today morning", "yesterday 4-8pm", "date:YYYY-MM-DD 14:00-16:30", "last Nh", or "last Nm".'
  );
}

function formatSourcesLine(
  sourceIds: string[],
  includeSources: boolean
): string {
  if (!includeSources) {
    return "*Sources: omitted*";
  }
  if (sourceIds.length === 0) {
    return "*Sources: none*";
  }
  return `*Sources: ${sourceIds.join(", ")}*`;
}

function formatDrilldownHint(
  includeSources: boolean,
  confidence: "none" | "low" | "medium" | "high"
): string {
  if (confidence === "high") {
    return includeSources
      ? "*Confidence: high for recap coverage. For proof/exact wording, use lcm_expand_query with summary IDs. message:<id> entries identify inline raw messages in this recap and are not lcm_describe targets.*"
      : "*Confidence: high for recap coverage. Re-run with includeSources=true if exact proof is needed.*";
  }
  return includeSources
    ? "*Confidence: partial. Dive deeper with lcm_expand_query on summary IDs, use the same time window for raw-message evidence, or request a larger maxOutputTokens/detailLevel. message:<id> entries are not lcm_describe targets.*"
    : "*Confidence: partial. Re-run with includeSources=true, higher detailLevel, or a larger maxOutputTokens to inspect source summaries.*";
}

function resolveRecallBudget(params: Record<string, unknown>): RecallBudget {
  const detailLevel = clampInt(params.detailLevel, 1, 0, 3);
  const requestedFromDetail =
    DETAIL_LEVEL_TOKEN_HINTS.get(detailLevel) ?? DEFAULT_RECENT_OUTPUT_TOKENS;
  const requestedOutputTokens = clampInt(
    params.maxOutputTokens,
    requestedFromDetail,
    1,
    ABSOLUTE_RECENT_GLOBAL_MAX_TOKENS
  );
  const globalMaxOutputTokens = clampInt(
    params.globalMaxOutputTokens,
    DEFAULT_RECENT_GLOBAL_MAX_TOKENS,
    1,
    ABSOLUTE_RECENT_GLOBAL_MAX_TOKENS
  );
  const maxSourceSummariesDefault = detailLevel >= 3 ? 500 : detailLevel >= 2 ? 120 : 40;
  return {
    requestedOutputTokens,
    globalMaxOutputTokens,
    effectiveOutputTokens: Math.min(requestedOutputTokens, globalMaxOutputTokens),
    detailLevel,
    maxSourceSummaries: clampInt(
      params.maxSourceSummaries,
      maxSourceSummariesDefault,
      1,
      1_000
    ),
  };
}

function clampInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : fallback;
}

function confidenceForAccounting(
  accounting: RecallAccounting,
  status: "ready" | "stale" | "fallback"
): "none" | "low" | "medium" | "high" {
  if (accounting.summariesAvailable === 0) {
    return "none";
  }
  if (accounting.summariesIncluded === 0) {
    return "low";
  }
  if (accounting.truncated || accounting.summariesOmitted > 0 || status === "fallback") {
    return accounting.summariesIncluded > 0 ? "medium" : "low";
  }
  return status === "stale" ? "medium" : "high";
}

function formatBudgetLines(budget: RecallBudget, accounting: RecallAccounting): string[] {
  return [
    `**Budget:** requested=${budget.requestedOutputTokens} global=${budget.globalMaxOutputTokens} effective=${budget.effectiveOutputTokens} detailLevel=${budget.detailLevel}`,
    `**Ingested:** output≈${accounting.outputTokens} tokens; source items=${accounting.summariesIncluded}/${accounting.summariesAvailable}; source-summary tokens=${accounting.sourceSummaryTokens}; source-message tokens=${accounting.sourceMessageTokens}; omitted=${accounting.summariesOmitted}`,
  ];
}

function isRawMessageFallbackSource(summary: RecentSummaryFallbackRow): boolean {
  return summary.summary_id.startsWith("message:");
}

function getFallbackSummaryIds(summaries: RecentSummaryFallbackRow[]): string[] {
  return summaries
    .filter((summary) => !isRawMessageFallbackSource(summary))
    .map((summary) => summary.summary_id);
}

function getFallbackSourceIds(summaries: RecentSummaryFallbackRow[]): string[] {
  return summaries.map((summary) => summary.summary_id);
}

function buildAccounting(
  text: string,
  summaries: RecentSummaryFallbackRow[],
  availableCount: number,
  truncated: boolean
): RecallAccounting {
  const summariesIncluded = summaries.length;
  return {
    outputTokens: estimateTokens(text),
    sourceSummaryTokens: summaries.reduce(
      (sum, summary) => sum + safeTokenCount(summary.token_count),
      0
    ),
    sourceMessageTokens: summaries.reduce(
      (sum, summary) => sum + safeTokenCount(summary.source_message_token_count),
      0
    ),
    summariesIncluded,
    summariesAvailable: availableCount,
    summariesOmitted: Math.max(0, availableCount - summariesIncluded),
    truncated,
  };
}

function combineRollups(rollups: RollupRecord[], budget: RecallBudget): {
  content: string;
  tokenCount: number;
  status: "ready" | "stale";
  sourceSummaryIds: string[];
  sourceSummaryTokens: number;
  sourceMessageTokens: number;
  sourceCount: number;
  omittedRollups: number;
  truncated: boolean;
} {
  let retained = [...rollups];
  let omittedRollups = 0;
  let content = retained
    .map((rollup) => `### ${rollup.periodKey}\n\n${rollup.content.trim()}`)
    .join("\n\n");
  while (retained.length > 1 && estimateTokens(content) > budget.effectiveOutputTokens) {
    retained = retained.slice(1);
    omittedRollups += 1;
    content = retained
      .map((rollup) => `### ${rollup.periodKey}\n\n${rollup.content.trim()}`)
      .join("\n\n");
  }
  if (omittedRollups > 0) {
    content = `(${omittedRollups} earlier rollups omitted to fit budget)\n\n${content}`;
  }
  const exceededBudget = estimateTokens(content) > budget.effectiveOutputTokens;
  if (exceededBudget) {
    content = truncateToEstimatedTokens(content, budget.effectiveOutputTokens);
  }
  const tokenCount = estimateTokens(content);
  const sourceSummaryIds = [
    ...new Set(retained.flatMap((rollup) => rollup.sourceSummaryIds)),
  ];
  const status = retained.every((rollup) => rollup.status === "ready")
    ? "ready"
    : "stale";
  return {
    content,
    tokenCount,
    status,
    sourceSummaryIds,
    sourceSummaryTokens: retained.reduce((sum, rollup) => sum + rollup.tokenCount, 0),
    sourceMessageTokens: retained.reduce((sum, rollup) => sum + rollup.sourceTokenCount, 0),
    sourceCount: retained.reduce((sum, rollup) => sum + rollup.sourceSummaryIds.length, 0),
    omittedRollups,
    truncated: omittedRollups > 0 || exceededBudget,
  };
}

function renderFallbackRollupSection(
  label: string,
  fallback: RecentSummaryFallbackResult,
  timezone: string,
  budget: RecallBudget,
  includeSources: boolean
): {
  content: string;
  summaryIds: string[];
  sourceIds: string[];
  retainedSummaries: RecentSummaryFallbackRow[];
  accounting: RecallAccounting;
} {
  const rendered = renderFallbackContent(
    label,
    fallback.summaries,
    timezone,
    budget,
    includeSources
  );
  return {
    content: rendered.content,
    summaryIds: getFallbackSummaryIds(rendered.retainedSummaries),
    sourceIds: getFallbackSourceIds(rendered.retainedSummaries),
    retainedSummaries: rendered.retainedSummaries,
    accounting: buildAccounting(
      rendered.content,
      rendered.retainedSummaries,
      fallback.availableCount,
      rendered.truncated || fallback.sqlTruncated
    ),
  };
}

function renderFallbackContent(
  label: string,
  summaries: RecentSummaryFallbackRow[],
  timezone: string,
  budget: RecallBudget,
  includeSources: boolean
): { content: string; retainedSummaries: RecentSummaryFallbackRow[]; truncated: boolean } {
  const retainedSummaries = summaries.slice(0, budget.maxSourceSummaries);
  let truncated = retainedSummaries.length < summaries.length;
  let lines = buildFallbackLines(
    label,
    retainedSummaries,
    timezone,
    truncated ? summaries.length - retainedSummaries.length : 0,
    includeSources
  );
  while (retainedSummaries.length > 1 && estimateTokens(lines.join("\n")) > budget.effectiveOutputTokens) {
    retainedSummaries.pop();
    truncated = true;
    lines = buildFallbackLines(
      label,
      retainedSummaries,
      timezone,
      summaries.length - retainedSummaries.length,
      includeSources
    );
  }
  let content = lines.join("\n");
  if (estimateTokens(content) > budget.effectiveOutputTokens) {
    content = truncateToEstimatedTokens(content, budget.effectiveOutputTokens);
    truncated = true;
  }
  return { content, retainedSummaries, truncated };
}

function buildFallbackLines(
  label: string,
  summaries: RecentSummaryFallbackRow[],
  timezone: string,
  omitted: number,
  includeSources: boolean
): string[] {
  const lines = [`### ${label} (source evidence layer)`];
  if (omitted > 0) {
    lines.push(`- (${omitted} source items omitted to fit budget)`);
  }
  if (summaries.length === 0) {
    lines.push("- No leaf summaries or unsummarized raw messages captured.");
  } else {
    for (const summary of summaries) {
      const prefix = includeSources
        ? `[${summary.summary_id}] `
        : "";
      lines.push(
        `- ${prefix}(${summary.kind}, ${formatDisplayTime(
          summary.effective_time,
          timezone
        )}, summaryTokens=${summary.token_count}, sourceTokens=${summary.source_message_token_count}): ${summary.content.replace(/\n/g, " ").trim()}`
      );
    }
  }
  return lines;
}

function safeTokenCount(value: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function truncateToEstimatedTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) {
    return text;
  }
  const suffix = "\n…(truncated to requested budget)";
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (estimateTokens(`${text.slice(0, mid)}${suffix}`) <= maxTokens) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return `${text.slice(0, low).trimEnd()}${suffix}`;
}

function enforceResponseBudget(
  text: string,
  budget: RecallBudget
): { text: string; tokenCount: number; truncated: boolean } {
  const tokenCount = estimateTokens(text);
  if (tokenCount <= budget.effectiveOutputTokens) {
    return { text, tokenCount, truncated: false };
  }
  const truncated = truncateToEstimatedTokens(text, budget.effectiveOutputTokens);
  return {
    text: truncated,
    tokenCount: estimateTokens(truncated),
    truncated: true,
  };
}

function getExpectedDayKeys(
  start: Date,
  end: Date,
  timezone: string
): string[] {
  if (end <= start) {
    return [];
  }
  const keys: string[] = [];
  let cursor = getZonedDayString(start, timezone);
  const lastKey = getZonedDayString(new Date(end.getTime() - 1), timezone);
  for (let guard = 0; guard < 370; guard += 1) {
    keys.push(cursor);
    if (cursor === lastKey) {
      return keys;
    }
    cursor = addDays(cursor, 1);
  }
  return keys;
}

function getRecentSummaryFallback(
  db: DatabaseSync,
  conversationId: number | undefined,
  start: Date,
  end: Date
): RecentSummaryFallbackResult {
  const scopeClause = conversationId == null ? "" : "conversation_id = ? AND";
  const args: Array<string | number> =
    conversationId == null
      ? [end.toISOString(), start.toISOString()]
      : [conversationId, end.toISOString(), start.toISOString()];
  const messageScopeClause = conversationId == null ? "" : "m.conversation_id = ? AND";

  const summaryRows = db
    .prepare(
      `SELECT
        summary_id,
        kind,
        content,
        token_count,
        source_message_token_count,
        strftime('%Y-%m-%dT%H:%M:%fZ', created_at) AS created_at,
        strftime('%Y-%m-%dT%H:%M:%fZ', coalesce(latest_at, earliest_at, created_at)) AS effective_time
       FROM summaries
       WHERE ${scopeClause}
         kind = 'leaf'
         AND julianday(coalesce(earliest_at, latest_at, created_at)) < julianday(?)
         AND julianday(coalesce(latest_at, earliest_at, created_at)) >= julianday(?)
       ORDER BY julianday(coalesce(latest_at, earliest_at, created_at)) DESC
       LIMIT ${FALLBACK_SQL_LIMIT + 1}`
    )
    .all(...args) as unknown as RecentSummaryFallbackRow[];
  const messageRows = db
    .prepare(
      `SELECT
        'message:' || m.message_id AS summary_id,
        'message:' || m.role AS kind,
        m.content,
        m.token_count,
        m.token_count AS source_message_token_count,
        strftime('%Y-%m-%dT%H:%M:%fZ', m.created_at) AS created_at,
        strftime('%Y-%m-%dT%H:%M:%fZ', m.created_at) AS effective_time
       FROM messages m
       WHERE ${messageScopeClause}
         julianday(m.created_at) < julianday(?)
         AND julianday(m.created_at) >= julianday(?)
         AND NOT EXISTS (
           SELECT 1
           FROM summary_messages sm
           WHERE sm.message_id = m.message_id
         )
       ORDER BY julianday(m.created_at) DESC
       LIMIT ${FALLBACK_SQL_LIMIT + 1}`
    )
    .all(...args) as unknown as RecentSummaryFallbackRow[];
  const combinedRows = [...summaryRows, ...messageRows].sort(
    (left, right) =>
      new Date(right.effective_time).getTime() -
      new Date(left.effective_time).getTime()
  );
  const sqlTruncated =
    summaryRows.length > FALLBACK_SQL_LIMIT ||
    messageRows.length > FALLBACK_SQL_LIMIT ||
    combinedRows.length > FALLBACK_SQL_LIMIT;
  const availableCount = sqlTruncated
    ? (
        db
          .prepare(
            `SELECT
               (
                 SELECT COUNT(*)
                 FROM summaries
                 WHERE ${scopeClause}
                   kind = 'leaf'
                   AND julianday(coalesce(earliest_at, latest_at, created_at)) < julianday(?)
                   AND julianday(coalesce(latest_at, earliest_at, created_at)) >= julianday(?)
               ) +
               (
                 SELECT COUNT(*)
                 FROM messages m
                 WHERE ${messageScopeClause}
                   julianday(m.created_at) < julianday(?)
                   AND julianday(m.created_at) >= julianday(?)
                   AND NOT EXISTS (
                     SELECT 1
                     FROM summary_messages sm
                     WHERE sm.message_id = m.message_id
                   )
               ) AS count`
          )
          .get(...args, ...args) as { count: number } | undefined
      )?.count ?? combinedRows.length
    : combinedRows.length;
  return {
    summaries: sqlTruncated
      ? combinedRows.slice(0, FALLBACK_SQL_LIMIT)
      : combinedRows,
    availableCount,
    sqlTruncated,
  };
}

function hasFallbackSourceItemsInRange(
  db: DatabaseSync,
  conversationId: number | undefined,
  start: Date,
  end: Date
): boolean {
  const scopeClause = conversationId == null ? "" : "conversation_id = ? AND";
  const args: Array<string | number> =
    conversationId == null
      ? [end.toISOString(), start.toISOString()]
      : [conversationId, end.toISOString(), start.toISOString()];

  const row = db
    .prepare(
      `SELECT
         EXISTS (
           SELECT 1
           FROM summaries
           WHERE ${scopeClause}
             kind = 'leaf'
             AND julianday(coalesce(earliest_at, latest_at, created_at)) < julianday(?)
             AND julianday(coalesce(latest_at, earliest_at, created_at)) >= julianday(?)
         )
         OR EXISTS (
           SELECT 1
           FROM messages m
           WHERE ${conversationId == null ? "" : "m.conversation_id = ? AND"}
             julianday(m.created_at) < julianday(?)
             AND julianday(m.created_at) >= julianday(?)
             AND NOT EXISTS (
               SELECT 1
               FROM summary_messages sm
               WHERE sm.message_id = m.message_id
             )
         ) AS present
       LIMIT 1`
    )
    .get(...args, ...args) as { present: 0 | 1 } | undefined;
  return row?.present === 1;
}

function dayHasFallbackSourceItems(
  db: DatabaseSync,
  conversationId: number | undefined,
  dayKey: string,
  timezone: string
): boolean {
  return hasFallbackSourceItemsInRange(
    db,
    conversationId,
    getUtcDateForZonedMidnight(dayKey, timezone),
    getUtcDateForZonedMidnight(addDays(dayKey, 1), timezone)
  );
}

export const __lcmRecentTestInternals = {
  resolvePeriod,
  getUtcDateForZonedMidnight,
  getUtcDateForZonedLocalTime,
};

export function createLcmRecentTool(input: {
  deps: LcmDependencies;
  lcm?: LcmContextEngine;
  getLcm?: () => Promise<LcmContextEngine>;
  rollupStore?: RollupStore;
  sessionId?: string;
  sessionKey?: string;
}): AnyAgentTool {
  return {
    name: "lcm_recent",
    label: "LCM Recent",
    description:
      "Retrieve recent activity from pre-built temporal rollups or a bounded leaf-summary SQL fallback. Supports daily, weekly, monthly, exact-date, sub-day local windows, and relative windows without LLM calls. Use for questions like 'what happened today?', 'what did we do yesterday 4-8pm?', or recap requests.",
    parameters: LcmRecentSchema,
    async execute(_toolCallId, params) {
      const lcm = input.lcm ?? (await input.getLcm?.());
      if (!lcm) {
        throw new Error("LCM engine is unavailable.");
      }

      const p = params as Record<string, unknown>;
      const includeSources = p.includeSources === true;
      const budget = resolveRecallBudget(p);
      const timezone = lcm.timezone;
      const conversationScope = await resolveLcmConversationScope({
        lcm,
        deps: input.deps,
        sessionId: input.sessionId,
        sessionKey: input.sessionKey,
        params: p,
      });

      if (
        !conversationScope.allConversations &&
        conversationScope.conversationId == null
      ) {
        return jsonResult({
          error:
            "No LCM conversation found for this session. Provide conversationId or set allConversations=true.",
        });
      }

      let resolution: PeriodResolution;
      try {
        resolution = resolvePeriod(String(p.period ?? ""), timezone);
      } catch (error) {
        return jsonResult({
          error: error instanceof Error ? error.message : "Invalid period.",
        });
      }

      const rollupStore = getLcmRollupStore(lcm, input.rollupStore);
      const db = rollupStore.db;

      if (conversationScope.allConversations) {
        const fallback = getRecentSummaryFallback(
          db,
          undefined,
          resolution.start,
          resolution.end
        );
        const rendered = renderFallbackRollupSection(
          resolution.label,
          fallback,
          timezone,
          budget,
          includeSources
        );
        const confidence = confidenceForAccounting(rendered.accounting, "fallback");

        const lines: string[] = [];
        lines.push(`## Recent Activity: ${resolution.label}`);
        lines.push(
          `**Period:** ${formatDisplayTime(
            resolution.start,
            timezone
          )} — ${formatDisplayTime(resolution.end, timezone)}`
        );
        lines.push("**Status:** fallback");
        lines.push(`**Confidence:** ${confidence}`);
        lines.push(...formatBudgetLines(budget, rendered.accounting));
        lines.push("");
        if (fallback.summaries.length === 0) {
          lines.push(
            "No pre-built rollup found, and no leaf summaries or unsummarized raw messages were captured in this period."
          );
        } else {
          lines.push(
            "No pre-built rollup available. Here's what LCM captured for this period:"
          );
          lines.push("");
          lines.push(rendered.content);
          lines.push("");
        }
        lines.push("---");
        lines.push(formatSourcesLine(rendered.sourceIds, includeSources));
        lines.push(formatDrilldownHint(includeSources, confidence));
        const response = enforceResponseBudget(lines.join("\n"), budget);

        return {
          content: [{ type: "text", text: response.text }],
          details: {
            status: "fallback",
            usedFallback: true,
            confidence,
            budget,
            accounting: rendered.accounting,
            totalMatches: fallback.availableCount,
            tokenCount: response.tokenCount,
            truncated:
              response.truncated ||
              rendered.accounting.truncated ||
              fallback.sqlTruncated,
            summaryIds: includeSources ? rendered.summaryIds : [],
            sourceIds: includeSources ? rendered.sourceIds : [],
          },
        };
      }

      const conversationId = conversationScope.conversationId as number;

      let rollupContent: string | null = null;
      let tokenCount = 0;
      let status: "ready" | "stale" | "fallback" = "fallback";
      let sourceSummaryIds: string[] = [];
      let sourceIds: string[] = [];
      let usedFallback = false;
      let truncated = false;
      let degradedReason: string | undefined;

      const currentDayKey = getZonedDayString(new Date(), timezone);
      const rollupState = rollupStore.getState(conversationId);
      const lastPendingMessageAt =
        rollupState?.pending_rebuild === 1 && rollupState.last_message_at
          ? new Date(rollupState.last_message_at)
          : null;
      const pendingDayKey =
        lastPendingMessageAt &&
        !Number.isNaN(lastPendingMessageAt.getTime()) &&
        lastPendingMessageAt >= resolution.start &&
        lastPendingMessageAt < resolution.end
          ? getZonedDayString(lastPendingMessageAt, timezone)
          : null;
      const canUseStoredCurrentDay =
        resolution.periodKey == null || resolution.periodKey !== currentDayKey;
      const hasPendingRebuild = rollupState?.pending_rebuild === 1;
      const pendingRebuildTouchesWindow = pendingDayKey != null;
      const canUseStoredResolvedRollup =
        canUseStoredCurrentDay &&
        !pendingRebuildTouchesWindow &&
        (resolution.kind === "day" || !hasPendingRebuild);
      if (!canUseStoredCurrentDay) {
        degradedReason =
          "Stored current-day rollups were bypassed so same-day recall uses bounded fresh sources.";
      } else if (pendingDayKey) {
        degradedReason =
          `Rollup rebuild is pending for ${pendingDayKey}, so stored rollups for that day were bypassed.`;
      } else if (resolution.kind && resolution.kind !== "day" && hasPendingRebuild) {
        degradedReason =
          "Rollup rebuild is pending, so stored aggregate rollups were bypassed.";
      }

      if (
        resolution.kind &&
        resolution.periodKey &&
        !resolution.window &&
        canUseStoredResolvedRollup
      ) {
        const rollup = rollupStore.getRollup(
          conversationId,
          resolution.kind,
          resolution.periodKey,
          timezone
        );
        if (
          rollup &&
          (rollup.status === "ready" || rollup.status === "stale")
        ) {
          rollupContent = rollup.content;
          tokenCount = rollup.token_count;
          status = rollup.status === "ready" ? "ready" : "stale";
          sourceSummaryIds = parseJsonStringArray(rollup.source_summary_ids);
          sourceIds = sourceSummaryIds;
        } else if (rollup) {
          degradedReason = `Stored ${resolution.kind} rollup is ${rollup.status}${
            rollup.error_text ? `: ${rollup.error_text}` : ""
          }.`;
        }
      } else if (
        resolution.kind &&
        !resolution.window &&
        (resolution.kind === "day" || !hasPendingRebuild)
      ) {
        const rollups = rollupStore
          .listRollups(conversationId, resolution.kind, 200)
          .filter((rollup) => rollup.timezone === timezone)
          .filter(
            (rollup) =>
              new Date(rollup.period_start) >= resolution.start &&
              new Date(rollup.period_start) < resolution.end
          );
        const usableRollups = rollups
          .filter(
            (rollup) => rollup.status === "ready" || rollup.status === "stale"
          )
          .map((rollup) => ({
            rollupId: rollup.rollup_id,
            conversationId: rollup.conversation_id,
            periodKind: rollup.period_kind,
            periodKey: rollup.period_key,
            periodStart: new Date(rollup.period_start),
            periodEnd: new Date(rollup.period_end),
            timezone: rollup.timezone,
            content: rollup.content,
            tokenCount: rollup.token_count,
            sourceSummaryIds: parseJsonStringArray(rollup.source_summary_ids),
            sourceMessageCount: rollup.source_message_count,
            sourceTokenCount: rollup.source_token_count,
            status: rollup.status,
            coverageStart: rollup.coverage_start
              ? new Date(rollup.coverage_start)
              : null,
            coverageEnd: rollup.coverage_end
              ? new Date(rollup.coverage_end)
              : null,
            summarizerModel: rollup.summarizer_model,
            sourceFingerprint: rollup.source_fingerprint,
            builtAt: new Date(rollup.built_at),
            invalidatedAt: rollup.invalidated_at
              ? new Date(rollup.invalidated_at)
              : null,
            errorText: rollup.error_text,
          }));
        const expectedKeys =
          resolution.kind === "day"
            ? getExpectedDayKeys(resolution.start, resolution.end, timezone)
            : [];
        const usableKeys = new Set(
          usableRollups.map((rollup) => rollup.periodKey)
        );
        const currentDayInWindow =
          resolution.kind === "day" && expectedKeys.includes(currentDayKey);
        const liveFallbackKeys = new Set<string>();
        if (currentDayInWindow) {
          liveFallbackKeys.add(currentDayKey);
        }
        if (
          resolution.kind === "day" &&
          pendingDayKey &&
          expectedKeys.includes(pendingDayKey)
        ) {
          liveFallbackKeys.add(pendingDayKey);
        }
        const requiredKeys = expectedKeys.filter((key) => !liveFallbackKeys.has(key));
        const hasCompleteCoverage =
          resolution.kind !== "day" ||
          (expectedKeys.length > 0 &&
            requiredKeys.every(
              (key) =>
                usableKeys.has(key) ||
                !dayHasFallbackSourceItems(db, conversationId, key, timezone)
            ));
        const hasStoredCoverage =
          resolution.kind === "day"
            ? requiredKeys.some((key) => usableKeys.has(key))
            : usableRollups.length > 0;
        const hasLiveFallbackCoverage = liveFallbackKeys.size > 0;
        if ((hasStoredCoverage || hasLiveFallbackCoverage) && hasCompleteCoverage) {
          const orderedRollups =
            resolution.kind === "day"
              ? requiredKeys
                  .map((key) => usableRollups.find((rollup) => rollup.periodKey === key))
                  .filter((rollup): rollup is RollupRecord => rollup != null)
              : usableRollups.sort(
                  (left, right) =>
                    left.periodStart.getTime() - right.periodStart.getTime()
                );
          const combined = combineRollups(orderedRollups, budget);
          truncated = truncated || combined.truncated;
          const liveSections: string[] = [];
          const liveSummaryIds: string[] = [];
          const liveSourceIds: string[] = [];
          for (const liveDayKey of liveFallbackKeys) {
            const currentStart = getUtcDateForZonedMidnight(
              liveDayKey,
              timezone
            );
            const currentEnd = new Date(
              Math.min(
                resolution.end.getTime(),
                getUtcDateForZonedMidnight(
                  addDays(liveDayKey, 1),
                  timezone
                ).getTime()
              )
            );
            const live = renderFallbackRollupSection(
              liveDayKey,
              getRecentSummaryFallback(db, conversationId, currentStart, currentEnd),
              timezone,
              budget,
              includeSources
            );
            liveSections.push(live.content);
            liveSummaryIds.push(...live.summaryIds);
            liveSourceIds.push(...live.sourceIds);
            usedFallback = true;
            truncated = truncated || live.accounting.truncated;
          }
          rollupContent = combined.content;
          if (liveSections.length > 0) {
            rollupContent = [rollupContent, ...liveSections]
              .filter((section) => section.trim().length > 0)
              .join("\n\n");
          }
          tokenCount = estimateTokens(rollupContent);
          status = orderedRollups.length > 0 ? combined.status : "fallback";
          sourceSummaryIds = [...combined.sourceSummaryIds, ...liveSummaryIds];
          sourceIds = [...combined.sourceSummaryIds, ...liveSourceIds];
        }
      }

      if (rollupContent == null) {
        const fallback = getRecentSummaryFallback(
          db,
          conversationId,
          resolution.start,
          resolution.end
        );
        const rendered = renderFallbackRollupSection(
          resolution.label,
          fallback,
          timezone,
          budget,
          includeSources
        );
        const confidence = confidenceForAccounting(rendered.accounting, "fallback");

        const lines: string[] = [];
        lines.push(`## Recent Activity: ${resolution.label}`);
        lines.push(
          `**Period:** ${formatDisplayTime(
            resolution.start,
            timezone
          )} — ${formatDisplayTime(resolution.end, timezone)}`
        );
        lines.push("**Status:** fallback");
        lines.push(`**Confidence:** ${confidence}`);
        if (degradedReason) {
          lines.push(`**Degraded:** ${degradedReason}`);
        }
        lines.push(...formatBudgetLines(budget, rendered.accounting));
        lines.push("");
        if (fallback.summaries.length === 0) {
          lines.push(
            "No pre-built rollup available, and LCM captured no leaf summaries or unsummarized raw messages for this period."
          );
        } else {
          lines.push(
            "No pre-built rollup available. Here's what LCM captured for this period:"
          );
          lines.push("");
          lines.push(rendered.content);
          lines.push("");
          sourceSummaryIds = rendered.summaryIds;
          sourceIds = rendered.sourceIds;
        }
        lines.push("---");
        lines.push(formatSourcesLine(sourceIds, includeSources));
        lines.push(formatDrilldownHint(includeSources, confidence));
        const response = enforceResponseBudget(lines.join("\n"), budget);

        return {
          content: [{ type: "text", text: response.text }],
          details: {
            status: "fallback",
            usedFallback: true,
            degradedReason,
            confidence,
            budget,
            accounting: rendered.accounting,
            totalMatches: fallback.availableCount,
            tokenCount: response.tokenCount,
            truncated:
              response.truncated ||
              rendered.accounting.truncated ||
              fallback.sqlTruncated,
            summaryIds: includeSources ? sourceSummaryIds : [],
            sourceIds: includeSources ? sourceIds : [],
          },
        };
      }

      const lines: string[] = [];
      lines.push(`## Recent Activity: ${resolution.label}`);
      lines.push(
        `**Period:** ${formatDisplayTime(
          resolution.start,
          timezone
        )} — ${formatDisplayTime(resolution.end, timezone)}`
      );
      lines.push(`**Status:** ${status}`);
      if (degradedReason) {
        lines.push(`**Degraded:** ${degradedReason}`);
      }
      lines.push("");
      lines.push(rollupContent.trim());
      lines.push("");
      lines.push("---");
      lines.push(formatSourcesLine(sourceIds, includeSources));
      lines.push(
        formatDrilldownHint(
          includeSources,
          usedFallback || status !== "ready" ? "medium" : "high"
        )
      );
      const response = enforceResponseBudget(lines.join("\n"), budget);

      return {
        content: [{ type: "text", text: response.text }],
        details: {
          status,
          usedFallback,
          degradedReason,
          tokenCount: response.tokenCount,
          truncated: response.truncated || truncated,
          summaryIds: includeSources ? sourceSummaryIds : [],
          sourceIds: includeSources ? sourceIds : [],
        },
      };
    },
  };
}
