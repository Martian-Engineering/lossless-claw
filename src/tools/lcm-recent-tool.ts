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
import type { CallGatewayFn, LcmDependencies } from "../types.js";
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

/**
 * Auto-detail-level picker thresholds. When the agent has at least this many
 * remaining context tokens (after a 20% safety buffer), use the corresponding
 * detailLevel. Listed high-to-low so we pick the highest level we can afford.
 */
const AUTO_DETAIL_LEVEL_THRESHOLDS: Array<{ minTokens: number; level: number }> = [
  { minTokens: 100_000, level: 3 },
  { minTokens: 50_000, level: 2 },
  { minTokens: 20_000, level: 1 },
];

/**
 * Fraction of the model's context window reserved as a safety buffer when
 * computing remaining context. Accounts for the fact that
 * `last_observed_prompt_token_count` is the PREVIOUS turn's prompt size — the
 * current turn may add tool results and system messages before our response
 * arrives.
 */
const AUTO_DETAIL_LEVEL_SAFETY_RATIO = 0.2;

/**
 * Process-lifetime cache of model → contextWindow, populated lazily on first
 * use via the gateway's `models.list` RPC. Model context windows don't change
 * within a gateway lifetime, so a single cached fetch is sufficient.
 *
 * This is the FALLBACK path — primary is the `status` RPC (see
 * `fetchRuntimeStatus` below) which gives both contextWindow AND current
 * usage in one call.
 */
const modelContextWindowCache = new Map<string, number | null>();
let modelCatalogFetchPromise: Promise<void> | null = null;

/**
 * Cached result of the most recent `status` RPC call, with a short TTL.
 * status returns runtime data (current model, contextTokens, current usage)
 * that changes per turn — short TTL keeps it close to live without hitting
 * the gateway every call.
 */
const RUNTIME_STATUS_CACHE_TTL_MS = 60_000;
let runtimeStatusCache: {
  fetchedAtMs: number;
  contextTokens: number | null;
  model: string | null;
  currentTokensBySessionKey: Map<string, number | null>;
} | null = null;
let runtimeStatusFetchPromise: Promise<void> | null = null;

/** Heuristic field path navigation — defensive against status response shape drift. */
function pickFirstNumber(obj: unknown, paths: string[][]): number | null {
  for (const path of paths) {
    let cur: unknown = obj;
    for (const key of path) {
      if (cur && typeof cur === "object" && !Array.isArray(cur)) {
        cur = (cur as Record<string, unknown>)[key];
      } else {
        cur = undefined;
        break;
      }
    }
    if (typeof cur === "number" && Number.isFinite(cur) && cur > 0) {
      return cur;
    }
  }
  return null;
}

/**
 * Tier 1 (primary) — fetch the gateway's `status` RPC (same data the agent's
 * `/status` slash command shows). Returns contextTokens + per-session usage.
 *
 * The result is cached for ~60s. status changes per turn (current usage) but
 * for auto-pick purposes a 60s window is acceptable.
 */
async function fetchRuntimeStatus(
  callGateway: CallGatewayFn | undefined,
): Promise<void> {
  if (!callGateway) return;
  const now = Date.now();
  if (
    runtimeStatusCache &&
    now - runtimeStatusCache.fetchedAtMs < RUNTIME_STATUS_CACHE_TTL_MS
  ) {
    return;
  }
  if (runtimeStatusFetchPromise) {
    await runtimeStatusFetchPromise;
    return;
  }
  runtimeStatusFetchPromise = (async () => {
    try {
      const result = (await callGateway({
        method: "status",
        params: { includeChannelSummary: false },
        timeoutMs: 5_000,
      })) as Record<string, unknown> | undefined;
      const sessions =
        (result?.sessions as Record<string, unknown> | undefined) ?? undefined;
      const defaults =
        (sessions?.defaults as Record<string, unknown> | undefined) ?? undefined;
      const contextTokens = pickFirstNumber(defaults, [
        ["contextTokens"],
        ["contextWindow"],
      ]);
      const model =
        typeof defaults?.model === "string" && defaults.model.length > 0
          ? defaults.model
          : null;
      const currentBy = new Map<string, number | null>();
      const byAgent = (sessions?.byAgent as Array<unknown> | undefined) ?? [];
      for (const agent of byAgent) {
        const entries =
          ((agent as Record<string, unknown>)?.entries as Array<unknown>) ?? [];
        for (const entry of entries) {
          const e = entry as Record<string, unknown>;
          const key = typeof e?.sessionKey === "string" ? e.sessionKey : null;
          if (!key) continue;
          // Defensive shape navigation — try several plausible field paths.
          const tokens = pickFirstNumber(e, [
            ["currentTokens"],
            ["promptTokens"],
            ["usage", "promptTokens"],
            ["usage", "totalTokens"],
            ["usage", "input"],
          ]);
          currentBy.set(key, tokens);
        }
      }
      runtimeStatusCache = {
        fetchedAtMs: now,
        contextTokens,
        model,
        currentTokensBySessionKey: currentBy,
      };
    } catch {
      // Swallow — fall through to fallback paths.
    } finally {
      runtimeStatusFetchPromise = null;
    }
  })();
  await runtimeStatusFetchPromise;
}

/**
 * Tier 2 (fallback) — fetch openclaw's full model catalog via `models.list`
 * and populate `modelContextWindowCache`. Used when `status` doesn't return
 * a contextTokens for the agent's model. Process-lifetime cache.
 */
async function ensureModelCatalogLoaded(
  callGateway: CallGatewayFn | undefined,
): Promise<void> {
  if (!callGateway) return;
  if (modelContextWindowCache.size > 0) return;
  if (modelCatalogFetchPromise) {
    await modelCatalogFetchPromise;
    return;
  }
  modelCatalogFetchPromise = (async () => {
    try {
      const result = (await callGateway({
        method: "models.list",
        params: { view: "all" },
        timeoutMs: 5_000,
      })) as { models?: Array<{ id?: string; contextWindow?: number }> } | undefined;
      const models = result?.models ?? [];
      for (const entry of models) {
        if (
          typeof entry.id === "string" &&
          typeof entry.contextWindow === "number" &&
          entry.contextWindow > 0
        ) {
          modelContextWindowCache.set(entry.id, entry.contextWindow);
        }
      }
    } catch {
      // Swallow — auto-pick will fall through to static default if both
      // tiers fail. Don't poison the cache so a future call can retry.
    } finally {
      modelCatalogFetchPromise = null;
    }
  })();
  await modelCatalogFetchPromise;
}

/**
 * Compute an auto-picked `detailLevel` for the calling agent based on its
 * remaining context room. Returns null if no usable data is available; the
 * caller then falls back to the static default.
 *
 * Resolution order (graceful degradation):
 *   1. The optional `getModelContextWindow` dep (synchronous fast-path)
 *   2. The `status` RPC (primary) — same data as /status slash command;
 *      provides contextTokens + per-session current usage
 *   3. The `models.list` RPC (fallback) — static contextWindow per model;
 *      pair with LCM telemetry's last_observed_prompt_token_count for usage
 *   4. LCM telemetry alone (last resort) — usage estimate only, no window
 */
async function computeAutoDetailLevel(
  db: DatabaseSync,
  conversationId: number,
  sessionKey: string | undefined,
  getModelContextWindow: ((model: string) => number | null) | undefined,
  callGateway: CallGatewayFn | undefined,
): Promise<number | null> {
  const row = db
    .prepare(
      "SELECT last_observed_prompt_token_count AS tokens, model FROM conversation_compaction_telemetry WHERE conversation_id = ?",
    )
    .get(conversationId) as
    | { tokens: number | null; model: string | null }
    | undefined;
  if (!row || !row.model) return null;
  const telemetryTokens =
    typeof row.tokens === "number" && row.tokens > 0 ? row.tokens : 0;

  // Tier 1 fast-path: synchronous dep injection (rare today, future-proof).
  let contextWindow = getModelContextWindow ? getModelContextWindow(row.model) : null;
  let currentTokens: number | null = null;

  // Tier 2 primary: status RPC for both contextWindow and live usage.
  if (!contextWindow || contextWindow <= 0) {
    await fetchRuntimeStatus(callGateway);
    if (runtimeStatusCache) {
      // Use status's contextTokens if it matches our model, else null.
      if (
        runtimeStatusCache.model === row.model &&
        runtimeStatusCache.contextTokens
      ) {
        contextWindow = runtimeStatusCache.contextTokens;
      }
      if (sessionKey) {
        currentTokens =
          runtimeStatusCache.currentTokensBySessionKey.get(sessionKey) ?? null;
      }
    }
  }

  // Tier 3 fallback: models.list catalog for contextWindow only.
  if (!contextWindow || contextWindow <= 0) {
    await ensureModelCatalogLoaded(callGateway);
    contextWindow = modelContextWindowCache.get(row.model) ?? null;
  }

  if (!contextWindow || contextWindow <= 0) return null;

  // Tier 4 final fallback for current usage: LCM telemetry (stale but
  // available). Status is preferred when present because it reflects the
  // FULL assembled prompt size including bootstrap + tools + runtime
  // context, whereas LCM telemetry only sees what got persisted on the last
  // successful turn.
  const observedTokens = currentTokens ?? telemetryTokens;
  const safetyReserve = Math.floor(contextWindow * AUTO_DETAIL_LEVEL_SAFETY_RATIO);
  const remaining = contextWindow - observedTokens - safetyReserve;
  if (remaining <= 0) return 0;
  for (const tier of AUTO_DETAIL_LEVEL_THRESHOLDS) {
    if (remaining >= tier.minTokens) return tier.level;
  }
  return 0;
}

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
  mode: Type.Optional(
    Type.Union(
      [Type.Literal("summary"), Type.Literal("index")],
      {
        description:
          "Response mode. \"summary\" (default) returns the full rollup content per detailLevel. \"index\" returns a navigation digest — one short bullet per rollup in the window, with builtAt/source IDs — for cheap exploration before drilling in with detailLevel:3 or lcm_expand_query.",
      },
    ),
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
  /** The detailLevel value the caller actually passed (pre-clamp). null if omitted. */
  requestedDetailLevel: number | null;
  /** Reason `detailLevel` differs from `requestedDetailLevel`, if any. */
  clampReason: "above-max" | "below-min" | null;
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
  const requestedDetailLevelRaw =
    typeof params.detailLevel === "number" && Number.isFinite(params.detailLevel)
      ? Math.floor(params.detailLevel)
      : null;
  const detailLevel = clampInt(params.detailLevel, 1, 0, 3);
  let clampReason: "above-max" | "below-min" | null = null;
  if (requestedDetailLevelRaw != null) {
    if (requestedDetailLevelRaw > 3) clampReason = "above-max";
    else if (requestedDetailLevelRaw < 0) clampReason = "below-min";
  }
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
    requestedDetailLevel: requestedDetailLevelRaw,
    clampReason,
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

/**
 * Find the newest rollup for a given (periodKind, periodKey) across multiple
 * conversation IDs. Used when a session_key spans multiple conversations
 * (eg. after `/new` or `/reset`) — we want lossless coverage by reading the
 * freshest rollup any of those conversations produced for the period.
 *
 * Single-conversation case: pass a one-element array.
 */
function getRollupAcrossConversations(
  rollupStore: RollupStore,
  conversationIds: number[],
  periodKind: "day" | "week" | "month",
  periodKey: string,
  timezone: string,
): import("../store/rollup-store.js").RollupRow | null {
  let best: import("../store/rollup-store.js").RollupRow | null = null;
  for (const cid of conversationIds) {
    const row = rollupStore.getRollup(cid, periodKind, periodKey, timezone);
    if (!row) continue;
    if (
      !best ||
      new Date(row.built_at).getTime() > new Date(best.built_at).getTime()
    ) {
      best = row;
    }
  }
  return best;
}

/**
 * List all rollups of a given periodKind across multiple conversations,
 * deduplicating by (periodKind, period_key, timezone) and keeping the row
 * with the newest `built_at`. Used by lcm_recent when crossing /new and
 * /reset boundaries.
 */
function listRollupsAcrossConversations(
  rollupStore: RollupStore,
  conversationIds: number[],
  periodKind: "day" | "week" | "month",
  perConvLimit: number,
): import("../store/rollup-store.js").RollupRow[] {
  const dedup = new Map<string, import("../store/rollup-store.js").RollupRow>();
  for (const cid of conversationIds) {
    const rows = rollupStore.listRollups(cid, periodKind, perConvLimit);
    for (const row of rows) {
      const key = `${row.period_kind}|${row.timezone}|${row.period_key}`;
      const existing = dedup.get(key);
      if (
        !existing ||
        new Date(row.built_at).getTime() >
          new Date(existing.built_at).getTime()
      ) {
        dedup.set(key, row);
      }
    }
  }
  return Array.from(dedup.values());
}

/**
 * Render an index/digest view of the rollups in the window. Each rollup gets
 * a header (period_kind/period_key, status, builtAt, source counts) followed
 * by a short digest extracted from its content. Used when caller passes
 * `mode: "index"` — cheaper than full content, useful for navigation before
 * drilling in with `mode: "summary"` and `detailLevel: 3`.
 */
function extractRollupDigest(
  content: string,
  maxChars: number,
  periodKind?: string,
): string {
  // Aggregate (weekly/monthly) rollups embed each daily verbatim, including
  // each daily's own "## Key Items" section. Matching the first one would
  // surface the FIRST nested day's bullets and pretend they're the whole
  // week/month digest — actively misleading. Skip the regex for aggregates
  // and emit a generic content prefix instead. Also fall back to a generic
  // prefix when periodKind is unknown but the content includes embedded
  // "## YYYY-MM-DD" day headers (sibling defensive check).
  const isAggregate =
    periodKind === "week" ||
    periodKind === "month" ||
    /(?:^|\n)##\s+\d{4}-\d{2}-\d{2}\b/.test(content);
  if (!isAggregate) {
    // Prefer the "## Key Items" section if the rollup uses that structure
    // (current daily rollup format does).
    const keyItemsMatch = content.match(/##\s+Key Items[\s\S]*?(?=\n##\s|$)/);
    if (keyItemsMatch) {
      const section = keyItemsMatch[0].trim();
      return section.length > maxChars
        ? section.slice(0, maxChars).trimEnd() + "…"
        : section;
    }
  }
  const trimmed = content.trim();
  return trimmed.length > maxChars
    ? trimmed.slice(0, maxChars).trimEnd() + "…"
    : trimmed;
}

function renderRollupsIndex(
  rollups: RollupRecord[],
  budget: RecallBudget,
): {
  content: string;
  tokenCount: number;
  status: "ready" | "stale";
  sourceSummaryIds: string[];
  truncated: boolean;
  lastBuiltAt: Date | null;
} {
  if (rollups.length === 0) {
    return {
      content: "(no rollups in window)",
      tokenCount: 0,
      status: "ready",
      sourceSummaryIds: [],
      truncated: false,
      lastBuiltAt: null,
    };
  }
  const sortedRollups = [...rollups].sort(
    (a, b) => a.periodStart.getTime() - b.periodStart.getTime(),
  );
  // Index entries get a per-rollup digest cap of ~600 chars (~150 tokens),
  // so for a week's worth of dailies we stay well under typical detailLevel 0/1
  // budgets (~12-24K tokens).
  const perRollupDigestMax = 600;
  const lines: string[] = [];
  lines.push(
    `### Rollup index (${sortedRollups.length} period${sortedRollups.length === 1 ? "" : "s"})`,
  );
  lines.push("");
  for (const rollup of sortedRollups) {
    lines.push(`#### ${rollup.periodKind}/${rollup.periodKey}`);
    lines.push(
      `- Status: ${rollup.status} | Built: ${rollup.builtAt.toISOString()}`,
    );
    lines.push(
      `- Sources: ${rollup.sourceMessageCount} msgs, ${rollup.sourceTokenCount} src tokens, ${rollup.sourceSummaryIds.length} summaries`,
    );
    lines.push("");
    lines.push(
      extractRollupDigest(rollup.content, perRollupDigestMax, rollup.periodKind),
    );
    lines.push("");
  }
  let content = lines.join("\n");
  let truncated = false;
  if (estimateTokens(content) > budget.effectiveOutputTokens) {
    content = truncateToEstimatedTokens(content, budget.effectiveOutputTokens);
    truncated = true;
  }
  const sourceSummaryIds = [
    ...new Set(sortedRollups.flatMap((r) => r.sourceSummaryIds)),
  ];
  const status: "ready" | "stale" = sortedRollups.every(
    (r) => r.status === "ready",
  )
    ? "ready"
    : "stale";
  const lastBuiltAt = new Date(
    Math.max(...sortedRollups.map((r) => r.builtAt.getTime())),
  );
  return {
    content,
    tokenCount: estimateTokens(content),
    status,
    sourceSummaryIds,
    truncated,
    lastBuiltAt,
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
  /** Latest build timestamp across the retained rollups. null if none retained. */
  lastBuiltAt: Date | null;
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
  const lastBuiltAt =
    retained.length > 0
      ? new Date(
          Math.max(...retained.map((rollup) => rollup.builtAt.getTime()))
        )
      : null;
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
    lastBuiltAt,
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
  end: Date,
  relatedConversationIds?: ReadonlyArray<number>
): RecentSummaryFallbackResult {
  const scope = normalizeConversationScope(conversationId, relatedConversationIds);
  const placeholders = scope ? scope.map(() => "?").join(", ") : "";
  const scopeClause =
    scope == null ? "" : `conversation_id IN (${placeholders}) AND`;
  const messageScopeClause =
    scope == null ? "" : `m.conversation_id IN (${placeholders}) AND`;
  const args: Array<string | number> =
    scope == null
      ? [end.toISOString(), start.toISOString()]
      : [...scope, end.toISOString(), start.toISOString()];

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

/**
 * Resolve a "scope" of conversation IDs into a normalized list. Callers pass
 * either a single id, undefined (= unscoped, all conversations), or an
 * explicit list (for cross-conversation reads under the same session_key).
 *
 * Returns null when the caller is unscoped, or a non-empty list otherwise.
 * The returned list is deduped to avoid SQL placeholder waste.
 */
function normalizeConversationScope(
  conversationId: number | undefined,
  relatedConversationIds?: ReadonlyArray<number>,
): number[] | null {
  if (relatedConversationIds && relatedConversationIds.length > 0) {
    return [...new Set(relatedConversationIds)];
  }
  if (conversationId == null) {
    return null;
  }
  return [conversationId];
}

function hasFallbackSourceItemsInRange(
  db: DatabaseSync,
  conversationId: number | undefined,
  start: Date,
  end: Date,
  relatedConversationIds?: ReadonlyArray<number>
): boolean {
  const scope = normalizeConversationScope(conversationId, relatedConversationIds);
  const placeholders = scope ? scope.map(() => "?").join(", ") : "";
  const summaryScopeClause =
    scope == null ? "" : `conversation_id IN (${placeholders}) AND`;
  const messageScopeClause =
    scope == null ? "" : `m.conversation_id IN (${placeholders}) AND`;
  const summaryArgs: Array<string | number> =
    scope == null
      ? [end.toISOString(), start.toISOString()]
      : [...scope, end.toISOString(), start.toISOString()];
  const messageArgs: Array<string | number> =
    scope == null
      ? [end.toISOString(), start.toISOString()]
      : [...scope, end.toISOString(), start.toISOString()];

  const row = db
    .prepare(
      `SELECT
         EXISTS (
           SELECT 1
           FROM summaries
           WHERE ${summaryScopeClause}
             kind = 'leaf'
             AND julianday(coalesce(earliest_at, latest_at, created_at)) < julianday(?)
             AND julianday(coalesce(latest_at, earliest_at, created_at)) >= julianday(?)
         )
         OR EXISTS (
           SELECT 1
           FROM messages m
           WHERE ${messageScopeClause}
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
    .get(...summaryArgs, ...messageArgs) as { present: 0 | 1 } | undefined;
  return row?.present === 1;
}

function dayHasFallbackSourceItems(
  db: DatabaseSync,
  conversationId: number | undefined,
  dayKey: string,
  timezone: string,
  relatedConversationIds?: ReadonlyArray<number>
): boolean {
  return hasFallbackSourceItemsInRange(
    db,
    conversationId,
    getUtcDateForZonedMidnight(dayKey, timezone),
    getUtcDateForZonedMidnight(addDays(dayKey, 1), timezone),
    relatedConversationIds
  );
}

export const __lcmRecentTestInternals = {
  resolvePeriod,
  getUtcDateForZonedMidnight,
  getUtcDateForZonedLocalTime,
  extractRollupDigest,
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
      const mode: "summary" | "index" = p.mode === "index" ? "index" : "summary";
      let budget = resolveRecallBudget(p);
      const timezone = lcm.timezone;
      const conversationScope = await resolveLcmConversationScope({
        lcm,
        deps: input.deps,
        sessionId: input.sessionId,
        sessionKey: input.sessionKey,
        params: p,
      });

      // Smart detailLevel auto-pick: when caller didn't specify and we know the
      // agent's last observed prompt size + model, pick a detailLevel that
      // fits the agent's remaining context room. Pulls runtime data via the
      // gateway's `status` RPC (same data /status returns), with `models.list`
      // and LCM telemetry as graceful fallbacks. Falls through to the static
      // default (1) if all tiers fail.
      if (
        p.detailLevel == null &&
        conversationScope.conversationId != null
      ) {
        const rollupStoreForAuto = getLcmRollupStore(lcm, input.rollupStore);
        const dbForAuto = rollupStoreForAuto.db;
        const autoLevel = await computeAutoDetailLevel(
          dbForAuto,
          conversationScope.conversationId,
          input.sessionKey,
          input.deps.getModelContextWindow,
          input.deps.callGateway,
        );
        if (autoLevel != null && autoLevel !== budget.detailLevel) {
          budget = resolveRecallBudget({ ...p, detailLevel: autoLevel });
          // Reset requestedDetailLevel + clampReason: caller didn't explicitly
          // request this level — it was auto-picked.
          budget = { ...budget, requestedDetailLevel: null, clampReason: null };
        }
      }

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
            lastBuiltAt: null,
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
      let lastBuiltAt: Date | null = null;

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
      const pendingRebuildTouchesWindow =
        hasPendingRebuild && (resolution.kind === "day" || pendingDayKey != null);
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
      } else if (resolution.kind === "day" && hasPendingRebuild) {
        degradedReason =
          "Rollup rebuild is pending, so stored day rollups were bypassed.";
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
        // Cross-conversation: prefer the freshest rollup across all
        // conversations under the same session_key (boundary crossing).
        const conversationIdsForLookup =
          conversationScope.relatedConversationIds.length > 0
            ? conversationScope.relatedConversationIds
            : [conversationId];
        const rollup = getRollupAcrossConversations(
          rollupStore,
          conversationIdsForLookup,
          resolution.kind,
          resolution.periodKey,
          timezone,
        );
        if (
          rollup &&
          (rollup.status === "ready" || rollup.status === "stale")
        ) {
          if (mode === "index") {
            const record: RollupRecord = {
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
              coverageStart: rollup.coverage_start ? new Date(rollup.coverage_start) : null,
              coverageEnd: rollup.coverage_end ? new Date(rollup.coverage_end) : null,
              summarizerModel: rollup.summarizer_model,
              sourceFingerprint: rollup.source_fingerprint,
              builtAt: rollup.built_at ? new Date(rollup.built_at) : new Date(),
              invalidatedAt: rollup.invalidated_at ? new Date(rollup.invalidated_at) : null,
              errorText: rollup.error_text,
            };
            const indexed = renderRollupsIndex([record], budget);
            rollupContent = indexed.content;
            tokenCount = indexed.tokenCount;
            status = indexed.status;
            sourceSummaryIds = indexed.sourceSummaryIds;
            sourceIds = sourceSummaryIds;
            truncated = truncated || indexed.truncated;
            lastBuiltAt = indexed.lastBuiltAt;
          } else {
            rollupContent = rollup.content;
            tokenCount = rollup.token_count;
            status = rollup.status === "ready" ? "ready" : "stale";
            sourceSummaryIds = parseJsonStringArray(rollup.source_summary_ids);
            sourceIds = sourceSummaryIds;
            lastBuiltAt = rollup.built_at ? new Date(rollup.built_at) : null;
          }
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
        // Cross-conversation: gather rollups across all conversations under
        // the same session_key, dedupe by period_key keeping the freshest.
        const conversationIdsForListing =
          conversationScope.relatedConversationIds.length > 0
            ? conversationScope.relatedConversationIds
            : [conversationId];
        const rollups = listRollupsAcrossConversations(
          rollupStore,
          conversationIdsForListing,
          resolution.kind,
          200,
        )
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
          hasPendingRebuild
        ) {
          if (pendingDayKey && expectedKeys.includes(pendingDayKey)) {
            liveFallbackKeys.add(pendingDayKey);
          } else if (!pendingDayKey) {
            for (const expectedKey of expectedKeys) {
              liveFallbackKeys.add(expectedKey);
            }
          }
        }
        const requiredKeys = expectedKeys.filter((key) => !liveFallbackKeys.has(key));
        const hasCompleteCoverage =
          resolution.kind !== "day" ||
          (expectedKeys.length > 0 &&
            requiredKeys.every(
              (key) =>
                usableKeys.has(key) ||
                !dayHasFallbackSourceItems(
                  db,
                  conversationId,
                  key,
                  timezone,
                  conversationScope.relatedConversationIds
                )
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
          if (mode === "index") {
            const indexed = renderRollupsIndex(orderedRollups, budget);
            const liveDigestSections: string[] = [];
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
                getRecentSummaryFallback(
                  db,
                  conversationId,
                  currentStart,
                  currentEnd,
                  conversationScope.relatedConversationIds
                ),
                timezone,
                budget,
                includeSources
              );
              const digest = extractRollupDigest(live.content, 600);
              const digestSection = [
                `#### day/${liveDayKey} (live fallback)`,
                `- Status: fallback | Built: (live)`,
                `- Sources: ${live.retainedSummaries.length} summaries`,
                "",
                digest,
                "",
              ].join("\n");
              liveDigestSections.push(digestSection);
              liveSummaryIds.push(...live.summaryIds);
              liveSourceIds.push(...live.sourceIds);
              usedFallback = true;
              truncated = truncated || live.accounting.truncated;
            }
            const baseContent =
              orderedRollups.length === 0 && liveDigestSections.length > 0
                ? `### Rollup index (${liveDigestSections.length} period${liveDigestSections.length === 1 ? "" : "s"})`
                : indexed.content;
            const combinedContent = [
              baseContent,
              ...liveDigestSections,
            ]
              .filter((section) => section.trim().length > 0)
              .join("\n\n");
            rollupContent = combinedContent;
            tokenCount = estimateTokens(combinedContent);
            status =
              orderedRollups.length === 0 && liveDigestSections.length > 0
                ? "fallback"
                : indexed.status;
            sourceSummaryIds = [...indexed.sourceSummaryIds, ...liveSummaryIds];
            sourceIds = [...indexed.sourceSummaryIds, ...liveSourceIds];
            truncated = truncated || indexed.truncated;
            lastBuiltAt = indexed.lastBuiltAt;
          } else {
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
                getRecentSummaryFallback(
                  db,
                  conversationId,
                  currentStart,
                  currentEnd,
                  conversationScope.relatedConversationIds
                ),
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
            lastBuiltAt = combined.lastBuiltAt;
          }
        }
      }

      if (rollupContent == null) {
        const fallback = getRecentSummaryFallback(
          db,
          conversationId,
          resolution.start,
          resolution.end,
          conversationScope.relatedConversationIds
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
            detailLevel: budget.detailLevel,
            requestedDetailLevel: budget.requestedDetailLevel,
            clampReason: budget.clampReason,
            lastBuiltAt: null,
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
          detailLevel: budget.detailLevel,
          requestedDetailLevel: budget.requestedDetailLevel,
          clampReason: budget.clampReason,
          lastBuiltAt: lastBuiltAt ? lastBuiltAt.toISOString() : null,
        },
      };
    },
  };
}
