import { Type } from "@sinclair/typebox";
import { createHash } from "node:crypto";
import type { LcmContextEngine } from "../engine.js";
import {
  runSemanticSearch,
  SemanticSearchUnavailableError,
} from "../embeddings/semantic-search.js";
import { VoyageError } from "../voyage/client.js";
import { dispatchSynthesis, SynthesisDispatchError, type LlmCall } from "../synthesis/dispatch.js";
import { createLcmSummarizeFromLegacyParams } from "../summarize.js";
import { estimateTokens } from "../estimate-tokens.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { parseIsoTimestampParam, resolveLcmConversationScope } from "./lcm-conversation-scope.js";
import { formatTimestamp } from "../compaction.js";

/**
 * `lcm_synthesize_around` — agent tool (LCM v4.1 §13).
 *
 * Builds a freshly-synthesized summary of leaves over a window. THREE
 * window modes (replaces old lcm_recent surface):
 *   - `period`   — direct date-range or human-readable shortcut. Target
 *                  is OPTIONAL (acts as a label only). The operator-facing
 *                  surface for "what did we work on yesterday / last week /
 *                  this month?" — period boundaries are computed in the
 *                  operator's local timezone (lcm.timezone config), not
 *                  UTC. Accepts: today / yesterday / this-week / last-week /
 *                  this-month / last-month / last-Nh / last-Nd OR explicit
 *                  since/before bounds.
 *   - `time`     — leaves with `created_at` within ±N hours of the target's
 *                  timestamp. Target must be a `summary_id` (we anchor on
 *                  the target summary's `created_at`).
 *   - `semantic` — top-K most-similar leaves to the target's content. Target
 *                  may be a `summary_id` (we anchor on its content) OR a
 *                  free-text query.
 *
 * The selected leaves are concatenated with separators and passed through
 * `dispatchSynthesis` (D.02) using tier='custom' or 'filtered'. The result
 * is persisted to `lcm_synthesis_cache` so subsequent identical calls can
 * hit the cache rather than re-LLM (single-flight via INSERT OR IGNORE on
 * the UNIQUE lookup index — keyed on session_key, range, leaf set, tier,
 * AND prompt_id so cache stays fresh when the active prompt changes).
 *
 * Why a separate tool from `lcm_semantic_recall`: recall returns ranked
 * snippets (the agent picks). `synthesize_around` returns a single
 * synthesized markdown summary with telemetry — designed for
 * "give me a memory pass on what was happening around X" rather than
 * "find the closest leaves to query Q".
 */

const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_WINDOW_K = 30;
const MIN_WINDOW_HOURS = 1;
const MAX_WINDOW_HOURS = 24 * 7 * 4; // 4 weeks
const MIN_WINDOW_K = 1;
const MAX_WINDOW_K = 200;
const MAX_SOURCE_TEXT_TOKENS = 50_000; // dispatch-side cap

const LcmSynthesizeAroundSchema = Type.Object({
  target: Type.Optional(
    Type.String({
      description:
        "Target to anchor the window on. REQUIRED for window_kind='time' and " +
        "'semantic'. OPTIONAL (acts as a label) for window_kind='period'. " +
        "Pass a `sum_xxx` summary_id (works in 'time' and 'semantic' modes — anchors " +
        "on the summary's created_at OR content), OR a free-text query string " +
        "(semantic mode only — used as the query embedding directly).",
    }),
  ),
  window_kind: Type.String({
    enum: ["time", "semantic", "period"],
    description:
      "Window selection. 'time' = ±windowHours around target timestamp (target REQUIRED). " +
      "'semantic' = top-windowK most-similar leaves to target content/query (target REQUIRED). " +
      "'period' = direct date-range or period-shortcut selection (target OPTIONAL — agent " +
      "can ask 'what did we work on yesterday?' without first discovering an anchor leaf).",
  }),
  // Reviewer P1 fix: 'period' mode supports both explicit ranges (since/before)
  // AND human-readable shortcuts (yesterday/today/last-week/last-month/last-Nh/last-Nd).
  // This restores `lcm_recent`-style direct period recall.
  period: Type.Optional(
    Type.String({
      description:
        "Period shortcut for window_kind='period' (case-insensitive). Accepted: " +
        "'today' | 'yesterday' | 'this-week' | 'last-week' | 'this-month' | 'last-month' | " +
        "'last-7-days' | 'last-30-days' | 'last-Nh' (e.g. 'last-12h' = past 12 hours) | " +
        "'last-Nd' (e.g. 'last-3d' = past 3 days). Mutually exclusive with explicit " +
        "since/before bounds (use either-or, not both).",
    }),
  ),
  windowHours: Type.Optional(
    Type.Number({
      description: `Half-window for time mode (default ${DEFAULT_WINDOW_HOURS}, range ${MIN_WINDOW_HOURS}-${MAX_WINDOW_HOURS}). Ignored for semantic + period modes.`,
      minimum: MIN_WINDOW_HOURS,
      maximum: MAX_WINDOW_HOURS,
    }),
  ),
  windowK: Type.Optional(
    Type.Number({
      description: `Top-K size for semantic mode (default ${DEFAULT_WINDOW_K}, range ${MIN_WINDOW_K}-${MAX_WINDOW_K}). Ignored for time + period modes.`,
      minimum: MIN_WINDOW_K,
      maximum: MAX_WINDOW_K,
    }),
  ),
  tier: Type.Optional(
    Type.String({
      enum: ["custom", "filtered"],
      description:
        "Synthesis tier (default 'custom'). Both use single-pass dispatch with the " +
        "Sonnet-class default model. Use 'filtered' when the leaf set is grep-filtered " +
        "(matches the cache CHECK constraint convention).",
    }),
  ),
  conversationId: Type.Optional(
    Type.Number({
      description:
        "Physical conversation ID to scope leaf selection to. If omitted, defaults " +
        "to the current session family.",
    }),
  ),
  allConversations: Type.Optional(
    Type.Boolean({
      description:
        "Set true to include leaves from every conversation. Ignored when " +
        "conversationId is provided.",
    }),
  ),
  since: Type.Optional(
    Type.String({
      description:
        "Optional ISO timestamp lower bound. Combined with the chosen window — " +
        "e.g., for time mode, the effective window is `MAX(targetCreated - windowHours, since)`.",
    }),
  ),
  before: Type.Optional(
    Type.String({
      description:
        "Optional ISO timestamp upper bound. Combined with the chosen window — " +
        "e.g., for time mode, the effective window is `MIN(targetCreated + windowHours, before)`.",
    }),
  ),
});

interface SummariesScopeFilter {
  conversationIds?: number[];
}

/**
 * Compute the UTC instant corresponding to the START of the local day
 * containing `at` in the given IANA timezone.
 *
 * Why: operator-facing periods like "yesterday" / "this-week" must use
 * LOCAL day boundaries, not UTC. A Bangkok operator (UTC+7) at 02:00
 * local time asking "yesterday" wants local-yesterday (~17h different
 * from UTC-yesterday).
 *
 * Implementation (Wave-11 reviewer P1 fix — robust against half-hour
 * offsets like Asia/Kolkata UTC+05:30 and DST transition days):
 *
 *   1. Format `at` in target tz to get the local Y-M-D as a string.
 *   2. Find the UTC offset (in MINUTES, not hours) for that local day
 *      by sampling at local noon — use both `hour` AND `minute` parts,
 *      AND verify the rendered Y/M/D matches the target day (catches
 *      DST-transition days where local noon + 12h still in target day).
 *   3. Compute local midnight UTC instant = UTC noon - 12h - offsetMinutes.
 *
 * Previous Wave-10 implementation only sampled the hour at noon, which:
 *   - Dropped minute offsets (Kolkata showed +5 instead of +5:30)
 *   - Assumed every local day is exactly 24h (false on DST-transition
 *     days where local-day spans 23h or 25h UTC)
 */
function getLocalDayStartUtc(at: Date, timezone: string): Date {
  // Step 1: get y/m/d in target tz.
  let y: number, m: number, d: number;
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts: Record<string, string> = {};
    for (const p of fmt.formatToParts(at)) {
      if (p.type !== "literal") parts[p.type] = p.value;
    }
    y = parseInt(parts.year ?? "1970", 10);
    m = parseInt(parts.month ?? "01", 10);
    d = parseInt(parts.day ?? "01", 10);
  } catch {
    y = at.getUTCFullYear();
    m = at.getUTCMonth() + 1;
    d = at.getUTCDate();
  }

  // Step 2: find UTC instant such that formatting it in target tz gives
  // exactly y/m/d 00:00. Iterate to converge — handles DST transitions
  // and half/quarter-hour offsets without special-casing.
  //
  // Algorithm: start with naive `Date.UTC(y, m-1, d, 0, 0, 0)`, format
  // it in target tz, compute the delta between rendered local time and
  // target midnight, subtract that delta from probe. Repeat 3 iters
  // (typically converges in 1-2; the third is a safety check).
  let probe = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  const targetMidnightLocalMs = Date.UTC(y, m - 1, d, 0, 0);
  for (let iter = 0; iter < 3; iter++) {
    let renderedY = y, renderedM = m, renderedD = d, renderedH = 0, renderedMin = 0;
    try {
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      });
      const parts: Record<string, string> = {};
      for (const p of fmt.formatToParts(probe)) {
        if (p.type !== "literal") parts[p.type] = p.value;
      }
      renderedY = parseInt(parts.year ?? String(y), 10);
      renderedM = parseInt(parts.month ?? String(m), 10);
      renderedD = parseInt(parts.day ?? String(d), 10);
      renderedH = parseInt(parts.hour ?? "0", 10);
      // h23 returns 24 for end-of-day in some implementations; normalize.
      if (renderedH === 24) renderedH = 0;
      renderedMin = parseInt(parts.minute ?? "0", 10);
    } catch {
      // Invalid timezone → return UTC midnight as fallback.
      return new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
    }
    const renderedAsLocalMs = Date.UTC(
      renderedY,
      renderedM - 1,
      renderedD,
      renderedH,
      renderedMin,
    );
    const delta = renderedAsLocalMs - targetMidnightLocalMs;
    if (delta === 0) return probe;
    probe = new Date(probe.getTime() - delta);
  }
  return probe;
}

/**
 * Compute the duration (in ms) of the LOCAL day starting at `localStartUtc`
 * in the given timezone. On DST spring-forward days this is 23h; on fall-
 * back days it's 25h. Used by period parsing to compute "yesterday" =
 * `[localStart-yesterdayDuration, localStart)` correctly across DST.
 */
function getLocalDayDurationMs(localStartUtc: Date, timezone: string): number {
  const nextStart = getLocalDayStartUtc(
    new Date(localStartUtc.getTime() + 36 * 3600_000), // +36h = next-day's noon-ish
    timezone,
  );
  const ms = nextStart.getTime() - localStartUtc.getTime();
  // Sanity bounds: ms should be in [22h, 26h]. If not, fall back to 24h.
  if (ms < 22 * 3600_000 || ms > 26 * 3600_000) return 24 * 3600_000;
  return ms;
}

/**
 * Reviewer P1 fix: parse a "period" shortcut into a (since, before) range.
 * Half-open [since, before).
 *
 * Wave-10 reviewer fix: timezone-aware. The day boundaries (today,
 * yesterday, this-week, last-week, this-month, last-month) are computed
 * in the operator's local timezone (`lcm.timezone`), not UTC. The
 * relative-window forms (`last-Nh`, `last-Nd`) remain UTC-anchored
 * since they're "now minus N hours/days," which doesn't depend on
 * day boundaries.
 *
 * Returns null + error string if the period is unrecognized.
 */
// Exported for tests — see test/v41-period-timezone.test.ts
export function parsePeriodShortcut(
  raw: string,
  options: { nowMs?: number; timezone?: string } = {},
): { since: Date; before: Date; label: string } | { error: string } {
  const period = raw.trim().toLowerCase();
  const nowMs = options.nowMs ?? Date.now();
  const timezone = options.timezone ?? "UTC";
  const now = new Date(nowMs);
  // Local-day midnight in the operator's timezone.
  const localMidnight = getLocalDayStartUtc(now, timezone);
  const dayMs = 24 * 60 * 60 * 1000;

  // Wave-11 reviewer P1 fix: use the actual local-day durations (23h on
  // spring-forward days, 25h on fall-back days) rather than a fixed 24h.
  // Yesterday's duration is computed by sampling the next-day boundary
  // from a known anchor.
  if (period === "today") {
    const todayDuration = getLocalDayDurationMs(localMidnight, timezone);
    return {
      since: localMidnight,
      before: new Date(localMidnight.getTime() + todayDuration),
      label: "today",
    };
  }
  if (period === "yesterday") {
    // Yesterday's local-day-start = today's local-day-start minus
    // yesterday's duration (which we compute by going back a buffer
    // and forward; getLocalDayStartUtc handles offsets correctly).
    const yesterdayStart = getLocalDayStartUtc(
      new Date(localMidnight.getTime() - 12 * 3600_000),
      timezone,
    );
    return {
      since: yesterdayStart,
      before: localMidnight,
      label: "yesterday",
    };
  }
  // Wave-12 reviewer P2 fix: weekly periods previously used fixed
  // dayMs = 24h * 3600_000 arithmetic, which is wrong on the weeks
  // containing DST transitions (week is 167h or 169h, not 168h). We now
  // overshoot by ±12h then snap with `getLocalDayStartUtc`, mirroring
  // the today/yesterday pattern. ±12h buffer absorbs the ±1h DST shift.
  const HALF_DAY_MS = 12 * 3600_000;
  const DAY_MS = dayMs;
  const computeDow = (): number => {
    const weekdayFmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
    });
    const weekdayName = weekdayFmt.format(localMidnight);
    const dowMap: Record<string, number> = {
      Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
    };
    return dowMap[weekdayName] ?? 1;
  };
  if (period === "this-week") {
    // ISO week: Monday = day 1. Land at this-Monday-noon (overshoot
    // by 12h) then snap to local-midnight to absorb DST shift.
    const dow = computeDow();
    const offsetToMondayMs = (dow - 1) * DAY_MS - HALF_DAY_MS;
    const monday = getLocalDayStartUtc(
      new Date(localMidnight.getTime() - offsetToMondayMs),
      timezone,
    );
    // Next Monday: +7 days, overshoot +12h, snap.
    const nextMonday = getLocalDayStartUtc(
      new Date(monday.getTime() + 7 * DAY_MS + HALF_DAY_MS),
      timezone,
    );
    return { since: monday, before: nextMonday, label: "this-week" };
  }
  if (period === "last-week") {
    const dow = computeDow();
    const offsetToMondayMs = (dow - 1) * DAY_MS - HALF_DAY_MS;
    const thisMonday = getLocalDayStartUtc(
      new Date(localMidnight.getTime() - offsetToMondayMs),
      timezone,
    );
    // Last Monday: 7 local-days before this-Monday. Use -156h
    // (7*24-12) so we always land in the target local-day.
    const lastMonday = getLocalDayStartUtc(
      new Date(thisMonday.getTime() - 7 * DAY_MS + HALF_DAY_MS),
      timezone,
    );
    return { since: lastMonday, before: thisMonday, label: "last-week" };
  }
  if (period === "this-month") {
    // Get y/m of local "today" via formatToParts in tz.
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
    });
    const parts: Record<string, string> = {};
    for (const p of fmt.formatToParts(now)) {
      if (p.type !== "literal") parts[p.type] = p.value;
    }
    const y = parseInt(parts.year ?? "1970", 10);
    const m = parseInt(parts.month ?? "01", 10);
    // Local first-of-month at midnight, in UTC instants:
    const monthStart = getLocalDayStartUtc(new Date(Date.UTC(y, m - 1, 1, 12)), timezone);
    const nextMonthStart = getLocalDayStartUtc(
      new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1, 12)),
      timezone,
    );
    return { since: monthStart, before: nextMonthStart, label: "this-month" };
  }
  if (period === "last-month") {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
    });
    const parts: Record<string, string> = {};
    for (const p of fmt.formatToParts(now)) {
      if (p.type !== "literal") parts[p.type] = p.value;
    }
    const y = parseInt(parts.year ?? "1970", 10);
    const m = parseInt(parts.month ?? "01", 10);
    const lastY = m === 1 ? y - 1 : y;
    const lastM = m === 1 ? 12 : m - 1;
    const lastMonthStart = getLocalDayStartUtc(
      new Date(Date.UTC(lastY, lastM - 1, 1, 12)),
      timezone,
    );
    const thisMonthStart = getLocalDayStartUtc(
      new Date(Date.UTC(y, m - 1, 1, 12)),
      timezone,
    );
    return { since: lastMonthStart, before: thisMonthStart, label: "last-month" };
  }
  // last-Nh / last-Nd patterns — these are "now minus N hours/days," not
  // calendar-day-anchored, so they stay UTC-anchored and are timezone-
  // independent.
  const hMatch = period.match(/^last-(\d+)h$/);
  if (hMatch) {
    const hours = Math.min(24 * 90, Math.max(1, parseInt(hMatch[1]!, 10)));
    return {
      since: new Date(now.getTime() - hours * 60 * 60 * 1000),
      before: now,
      label: `last-${hours}h`,
    };
  }
  // Wave-7 Auditor #6 P1 fix: tighten regex to only accept documented
  // forms: `last-Nd` (e.g. last-3d) OR `last-N-days` (e.g. last-7-days).
  // Previously also accepted undocumented variants like `last-3day`,
  // `last-3-d`, `last-3-day` which silently worked but weren't in docs.
  const dMatch = period.match(/^last-(\d+)d$|^last-(\d+)-days$/);
  if (dMatch) {
    const captured = dMatch[1] ?? dMatch[2]!;
    const days = Math.min(366, Math.max(1, parseInt(captured, 10)));
    return {
      since: new Date(now.getTime() - days * dayMs),
      before: now,
      label: `last-${days}d`,
    };
  }
  return {
    error: `Unrecognized period shortcut: '${raw}'. Accepted: today | yesterday | this-week | last-week | this-month | last-month | last-Nh (e.g. last-12h) | last-Nd (e.g. last-3d) | last-7-days | last-30-days.`,
  };
}

interface LeafRow {
  summary_id: string;
  content: string;
  created_at: string;
  token_count: number;
}

interface TargetSummaryRow {
  summary_id: string;
  content: string;
  created_at: string;
  conversation_id: number;
  session_key: string;
}

type SqlBind = string | number | bigint | null | Uint8Array;

function lookupTargetSummary(
  db: import("node:sqlite").DatabaseSync,
  summaryId: string,
  scope: SummariesScopeFilter,
): TargetSummaryRow | null {
  const filters: string[] = ["summary_id = ?", "suppressed_at IS NULL"];
  const binds: SqlBind[] = [summaryId];
  if (scope.conversationIds && scope.conversationIds.length > 0) {
    filters.push(`conversation_id IN (${scope.conversationIds.map(() => "?").join(",")})`);
    for (const id of scope.conversationIds) binds.push(id);
  }
  const row = db
    .prepare(
      `SELECT summary_id, content, created_at, conversation_id, session_key
         FROM summaries
         WHERE ${filters.join(" AND ")}
         LIMIT 1`,
    )
    .get(...binds) as unknown as TargetSummaryRow | undefined;
  return row ?? null;
}

function selectTimeWindowLeaves(
  db: import("node:sqlite").DatabaseSync,
  args: {
    rangeStart: string;
    rangeEnd: string;
    scope: SummariesScopeFilter;
    excludeSummaryId?: string;
  },
): LeafRow[] {
  // We compare via `datetime(col) >= datetime(?)` so the query is robust to
  // the format mismatch between SQLite's natural `'YYYY-MM-DD HH:MM:SS'`
  // (from `datetime('now')`) and JS `Date.toISOString()` `'...T...Z'` ISO
  // form. Plain string comparison would treat '2026-05-01 09:00:00' as
  // smaller than '2026-05-01T09:00:00.000Z' (space < T), which silently
  // drops valid rows. SQLite normalizes both via datetime().
  // Wave-2 Auditor #7 fix A1: time filter now uses
  // `julianday(COALESCE(latest_at, created_at))` for parity with the
  // summary FTS path (summary-store.ts) and the semantic-search path
  // (post Wave-1). Without this, `since`/`before` on a condensed
  // summary covering content from time T but written to the row at
  // time T' would land in different "windows" depending on which tool
  // an agent used. Leaves typically have latest_at = created_at, so
  // for the leaf-only filter below this is functionally equivalent —
  // but using the same SQL across tools eliminates a class of subtle
  // cross-tool inconsistency bugs.
  const filters: string[] = [
    "julianday(COALESCE(latest_at, created_at)) >= julianday(?)",
    "julianday(COALESCE(latest_at, created_at)) < julianday(?)",
    "suppressed_at IS NULL",
    "kind = 'leaf'",
  ];
  const binds: SqlBind[] = [args.rangeStart, args.rangeEnd];
  if (args.scope.conversationIds && args.scope.conversationIds.length > 0) {
    filters.push(`conversation_id IN (${args.scope.conversationIds.map(() => "?").join(",")})`);
    for (const id of args.scope.conversationIds) binds.push(id);
  }
  if (args.excludeSummaryId) {
    filters.push(`summary_id != ?`);
    binds.push(args.excludeSummaryId);
  }
  const rows = db
    .prepare(
      `SELECT summary_id, content, created_at, token_count
         FROM summaries
         WHERE ${filters.join(" AND ")}
         ORDER BY created_at ASC`,
    )
    .all(...binds) as unknown as LeafRow[];
  return rows;
}

function buildSourceText(rows: LeafRow[]): { text: string; truncatedAt?: number } {
  const parts: string[] = [];
  let totalTokens = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    const block = `### Leaf ${row.summary_id} (${row.created_at})\n\n${row.content}`;
    totalTokens += row.token_count > 0 ? row.token_count : estimateTokens(block);
    if (totalTokens > MAX_SOURCE_TEXT_TOKENS) {
      return {
        text: parts.join("\n\n---\n\n"),
        truncatedAt: i,
      };
    }
    parts.push(block);
  }
  return { text: parts.join("\n\n---\n\n") };
}

function fingerprintLeaves(ids: string[]): string {
  const hash = createHash("sha256");
  for (const id of ids) {
    hash.update(id);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 24);
}

function shortRandomSuffix(): string {
  return Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0");
}

/**
 * SQLite stores timestamps via `datetime('now')` as UTC strings of the form
 * `'YYYY-MM-DD HH:MM:SS'` (no `T`, no `Z`). When fed to JS `new Date(...)`
 * the same string is parsed as **local time**, silently shifting the
 * reference point by the host timezone offset. This helper forces a UTC
 * reading by appending `Z` (and the missing `T`) before the JS parse.
 */
function parseSqliteUtcTimestamp(value: string): Date {
  const trimmed = value.trim();
  // If the value already includes a timezone indicator or `T`, defer to JS.
  if (/[Tt]/.test(trimmed) || /[Zz]|[+\-]\d\d:?\d\d$/.test(trimmed)) {
    return new Date(trimmed);
  }
  // SQLite default form: 'YYYY-MM-DD HH:MM:SS' or 'YYYY-MM-DD HH:MM:SS.SSS'
  return new Date(`${trimmed.replace(" ", "T")}Z`);
}

function formatDisplayTime(value: string | Date | null | undefined, timezone: string): string {
  if (!value) return "-";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return formatTimestamp(d, timezone);
}

/**
 * Adapt the existing `LcmSummarizeFn` (text → text) to dispatch's `LlmCall`
 * (model + prompt → output + telemetry). Latency is measured locally; cost
 * is left undefined (we don't have a cost calculator wired here).
 *
 * The summarizer wrapper ignores the dispatch-supplied model (the legacy
 * resolver picks its own provider/model fallback chain). Wave-12 reviewer
 * F8 audit-honesty fix: we now pass `actualModel` from the summarizer's
 * resolved-primary-candidate so the audit row records what *actually ran*,
 * not what dispatch's `pickModel` recommended. Without this, the audit
 * silently records the dispatched intent and operators debugging a
 * synthesis failure see the wrong model name.
 *
 * Caveat: `resolveActualModel()` returns the PRIMARY resolved candidate;
 * if mid-call fallback fires, the recorded model may not match the
 * actually-used candidate. Strictly better than recording dispatched
 * intent, but not perfect. Future improvement: have the summarizer
 * surface the candidate that actually succeeded.
 */
function buildLlmCallFromSummarizer(
  summarize: (text: string) => Promise<string>,
  resolveActualModel: () => string | undefined,
): LlmCall {
  return async (args) => {
    const startedAt = Date.now();
    const output = await summarize(args.prompt);
    const latencyMs = Date.now() - startedAt;
    return { output, latencyMs, actualModel: resolveActualModel() };
  };
}

export function createLcmSynthesizeAroundTool(input: {
  deps: LcmDependencies;
  lcm?: LcmContextEngine;
  getLcm?: () => Promise<LcmContextEngine>;
  sessionId?: string;
  sessionKey?: string;
}): AnyAgentTool {
  return {
    name: "lcm_synthesize_around",
    label: "LCM Synthesize Around",
    description:
      "Synthesize a fresh summary of leaves over a window (replaces old lcm_recent). " +
      "Three modes: 'period' (date range or shortcut like 'yesterday' / 'last-7-days' / " +
      "'this-month' — target OPTIONAL; this is the direct \"what did we work on yesterday\" " +
      "surface), 'time' (leaves within ±windowHours of a target summary's timestamp — " +
      "target REQUIRED), or 'semantic' (top windowK most-similar leaves to target " +
      "content/query — target REQUIRED). Period boundaries are computed in the operator's " +
      "local timezone (configured on the LCM engine; handles half-hour offsets like Asia/Kolkata " +
      "and DST transitions). Returns a markdown summary backed by lcm_synthesis_cache so " +
      "subsequent identical calls hit the cache. The actual LLM call goes through the " +
      "operator's configured summarizer chain (summaryModel/summaryProvider) for inheritance of auth " +
      "retries + fallback handling; the audit table records the resolved model that actually ran " +
      "(Wave-12 fix — was previously recording the dispatched recommendation). Distinct from " +
      "lcm_semantic_recall (which returns ranked snippets, not a synthesized rollup).",
    parameters: LcmSynthesizeAroundSchema,
    async execute(_toolCallId, params) {
      const lcm = input.lcm ?? (await input.getLcm?.());
      if (!lcm) {
        throw new Error("LCM engine is unavailable.");
      }
      const timezone = lcm.timezone;
      const p = params as Record<string, unknown>;

      // 2. Validate window_kind FIRST so we can enforce target-required
      //    semantics correctly per mode (period mode allows missing target).
      const windowKind = typeof p.window_kind === "string" ? p.window_kind.trim() : "";
      if (windowKind !== "time" && windowKind !== "semantic" && windowKind !== "period") {
        return jsonResult({
          error: "`window_kind` must be 'time', 'semantic', or 'period'.",
        });
      }

      // 1. Validate target — REQUIRED for time + semantic, OPTIONAL for period.
      // Reviewer P1 fix: period mode is the lcm_recent replacement —
      // "what did we work on yesterday?" should not require an anchor.
      const target = typeof p.target === "string" ? p.target.trim() : "";
      if (target.length === 0 && windowKind !== "period") {
        return jsonResult({
          error: "`target` is required for window_kind='time' or 'semantic' (sum_xxx summary_id OR free-text query). For period mode, target is optional.",
        });
      }

      // 3. Numeric window args
      const windowHours =
        typeof p.windowHours === "number" && Number.isFinite(p.windowHours)
          ? Math.max(MIN_WINDOW_HOURS, Math.min(MAX_WINDOW_HOURS, p.windowHours))
          : DEFAULT_WINDOW_HOURS;
      const windowK =
        typeof p.windowK === "number" && Number.isFinite(p.windowK)
          ? Math.max(MIN_WINDOW_K, Math.min(MAX_WINDOW_K, Math.trunc(p.windowK)))
          : DEFAULT_WINDOW_K;

      // 4. Tier selection
      const tier =
        typeof p.tier === "string" && (p.tier === "custom" || p.tier === "filtered")
          ? (p.tier as "custom" | "filtered")
          : "custom";
      // lcm_synthesis_cache CHECK constrains tier_label to ('year','custom','filtered').
      const cacheTierLabel = tier;

      // 5. Optional time bounds
      let sinceBound: Date | undefined;
      let beforeBound: Date | undefined;
      try {
        sinceBound = parseIsoTimestampParam(p, "since");
        beforeBound = parseIsoTimestampParam(p, "before");
      } catch (error) {
        return jsonResult({
          error: error instanceof Error ? error.message : "Invalid timestamp filter.",
        });
      }
      if (sinceBound && beforeBound && sinceBound.getTime() >= beforeBound.getTime()) {
        return jsonResult({ error: "`since` must be earlier than `before`." });
      }

      // 6. Resolve conversation scope
      const conversationScope = await resolveLcmConversationScope({
        lcm,
        deps: input.deps,
        sessionId: input.sessionId,
        sessionKey: input.sessionKey,
        params: p,
      });
      if (!conversationScope.allConversations && conversationScope.conversationId == null) {
        return jsonResult({
          error:
            "No LCM conversation found for this session. Provide conversationId or set allConversations=true.",
        });
      }
      const conversationIds = conversationScope.allConversations
        ? undefined
        : conversationScope.conversationIds && conversationScope.conversationIds.length > 0
          ? conversationScope.conversationIds
          : conversationScope.conversationId != null
            ? [conversationScope.conversationId]
            : undefined;
      const summariesScope: SummariesScopeFilter = { conversationIds };

      const db = lcm.getDb();

      // 7. Resolve target — only summary_id targets allowed for time mode.
      const targetIsSummaryId = target.startsWith("sum_");
      let targetSummary: TargetSummaryRow | null = null;
      if (targetIsSummaryId) {
        targetSummary = lookupTargetSummary(db, target, summariesScope);
        if (!targetSummary) {
          return jsonResult({
            error: `Target summary not found in scope: ${target}`,
            hint: "Verify the summary_id and (if scoped) the conversationId/allConversations.",
          });
        }
      } else if (windowKind === "time") {
        return jsonResult({
          error:
            "time window requires a summary_id target (sum_xxx). Free-text queries are only supported in semantic mode.",
        });
      }

      // 8. Build leaf set per window mode.
      let leafRows: LeafRow[];
      let rangeStartIso: string;
      let rangeEndIso: string;
      let semanticMeta: { modelName?: string; voyageTokensConsumed?: number } | undefined;
      // Wave-7 Auditor #6 P0 fix: derive a NON-EMPTY sessionKeyForCache
      // even when targetSummary is null (period mode without anchor) AND
      // input.sessionKey is missing. The cache UNIQUE constraint on
      // (session_key, range_start, range_end, leaf_fingerprint, ...)
      // collapses to "" for all such callers, causing CROSS-SESSION
      // CACHE POLLUTION — caller A's cached synthesis surfaces in
      // caller B's loser-path SELECT.
      //
      // Fallback chain:
      //   1. targetSummary's session_key (if present)
      //   2. input.sessionKey (if present)
      //   3. resolved conversationIds[0]'s session_key (looked up from DB)
      //   4. agent:main:main as the safe default for shell/CLI callers
      //      who don't carry a session identity
      const lookupConversationSessionKey = (convId: number): string | undefined => {
        try {
          const row = db
            .prepare(`SELECT session_key FROM conversations WHERE conversation_id = ?`)
            .get(convId) as { session_key?: string } | undefined;
          return row?.session_key?.trim() || undefined;
        } catch {
          return undefined;
        }
      };
      let sessionKeyForCache =
        targetSummary?.session_key?.trim() ||
        (typeof input.sessionKey === "string" && input.sessionKey.trim()) ||
        "";
      if (!sessionKeyForCache && conversationIds && conversationIds.length > 0) {
        sessionKeyForCache = lookupConversationSessionKey(conversationIds[0]!) ?? "";
      }
      if (!sessionKeyForCache && conversationScope.conversationId != null) {
        sessionKeyForCache =
          lookupConversationSessionKey(conversationScope.conversationId) ?? "";
      }
      if (!sessionKeyForCache) {
        // Last-resort fallback. Better to silo cache to a clear default
        // than to collapse to "" and pollute across callers.
        sessionKeyForCache = "agent:main:main";
      }

      if (windowKind === "period") {
        // Reviewer P1 fix: direct date-range / period-shortcut selection.
        // No target required. The caller can pass (a) `period: "yesterday"`,
        // (b) explicit since/before, or (c) both — the period derives the
        // base bounds and since/before further constrain them.
        const periodRaw = typeof p.period === "string" ? p.period.trim() : "";
        let periodSince: Date | undefined;
        let periodBefore: Date | undefined;
        let periodLabel = "custom-range";
        if (periodRaw.length > 0) {
          // Wave-10 reviewer P1 fix: pass timezone so day-boundary
          // periods (today/yesterday/this-week/last-week/this-month/
          // last-month) are computed in the operator's local timezone
          // instead of UTC.
          const parsed = parsePeriodShortcut(periodRaw, { timezone });
          if ("error" in parsed) {
            return jsonResult({ error: parsed.error });
          }
          periodSince = parsed.since;
          periodBefore = parsed.before;
          periodLabel = parsed.label;
        }
        // Combine period bounds + explicit since/before. Tightest wins.
        let rangeStart =
          sinceBound && periodSince
            ? new Date(Math.max(sinceBound.getTime(), periodSince.getTime()))
            : sinceBound ?? periodSince;
        let rangeEnd =
          beforeBound && periodBefore
            ? new Date(Math.min(beforeBound.getTime(), periodBefore.getTime()))
            : beforeBound ?? periodBefore;
        if (!rangeStart || !rangeEnd) {
          return jsonResult({
            error:
              "window_kind='period' requires either `period` (shortcut) or both `since` and `before` (explicit range).",
            hint:
              "Examples: {window_kind:'period', period:'yesterday'} | {window_kind:'period', period:'last-7-days'} | {window_kind:'period', since:'2026-05-01T00:00:00Z', before:'2026-05-02T00:00:00Z'}",
          });
        }
        if (rangeStart.getTime() >= rangeEnd.getTime()) {
          return jsonResult({
            error:
              "Effective period window is empty after combining period + since/before bounds.",
          });
        }
        rangeStartIso = rangeStart.toISOString();
        rangeEndIso = rangeEnd.toISOString();

        leafRows = selectTimeWindowLeaves(db, {
          rangeStart: rangeStartIso,
          rangeEnd: rangeEndIso,
          scope: summariesScope,
          // No exclude in period mode — there's no "anchor" leaf to drop.
          excludeSummaryId: targetSummary?.summary_id,
        });

        if (leafRows.length === 0) {
          return jsonResult({
            error: `No leaves found in period ${periodLabel} (${rangeStartIso} → ${rangeEndIso}).`,
            hint:
              "Widen the period (e.g. 'last-7-days' instead of 'yesterday') or set allConversations=true if leaves live elsewhere.",
            window: { kind: "period", label: periodLabel, since: rangeStartIso, before: rangeEndIso },
          });
        }
      } else if (windowKind === "time") {
        // targetSummary is non-null here (validated above)
        const anchor = parseSqliteUtcTimestamp(targetSummary!.created_at);
        if (Number.isNaN(anchor.getTime())) {
          return jsonResult({
            error: `Target summary has invalid created_at: ${targetSummary!.created_at}`,
          });
        }
        const halfMs = windowHours * 60 * 60 * 1000;
        let rangeStart = new Date(anchor.getTime() - halfMs);
        let rangeEnd = new Date(anchor.getTime() + halfMs);
        if (sinceBound && sinceBound.getTime() > rangeStart.getTime()) {
          rangeStart = sinceBound;
        }
        if (beforeBound && beforeBound.getTime() < rangeEnd.getTime()) {
          rangeEnd = beforeBound;
        }
        if (rangeStart.getTime() >= rangeEnd.getTime()) {
          return jsonResult({
            error: "Effective window is empty after applying since/before bounds.",
          });
        }
        rangeStartIso = rangeStart.toISOString();
        rangeEndIso = rangeEnd.toISOString();

        leafRows = selectTimeWindowLeaves(db, {
          rangeStart: rangeStartIso,
          rangeEnd: rangeEndIso,
          scope: summariesScope,
          excludeSummaryId: targetSummary!.summary_id,
        });
      } else {
        // semantic mode — use runSemanticSearch.
        const queryText = targetIsSummaryId ? targetSummary!.content : target;
        try {
          const result = await runSemanticSearch(db, {
            query: queryText,
            k: windowK,
            conversationIds,
            since: sinceBound,
            before: beforeBound,
            summaryKinds: ["leaf"],
            excludeSuppressed: true,
            voyageMaxRetries: 1,
            voyageTimeoutMs: 15_000,
          });
          semanticMeta = {
            modelName: result.modelName,
            voyageTokensConsumed: result.voyageTokensConsumed,
          };
          // Drop the target itself from the candidate set if it appears.
          const filtered = targetIsSummaryId
            ? result.hits.filter((h) => h.summaryId !== targetSummary!.summary_id)
            : result.hits;
          if (filtered.length === 0) {
            const startIso = sinceBound?.toISOString() ?? "1970-01-01T00:00:00.000Z";
            const endIso = beforeBound?.toISOString() ?? new Date().toISOString();
            return jsonResult({
              error: "Semantic window returned no leaves (after suppression and target dedupe).",
              hint: "Try increasing windowK or relaxing since/before bounds.",
              window: { kind: "semantic", k: windowK, since: startIso, before: endIso },
            });
          }
          leafRows = filtered.map((h) => ({
            summary_id: h.summaryId,
            content: h.content,
            created_at: h.createdAt,
            token_count: h.tokenCount,
          }));
          // Sort chronologically for the synthesis prompt to receive
          // leaves in stable temporal order (helps the model build a
          // coherent narrative).
          leafRows.sort((a, b) => a.created_at.localeCompare(b.created_at));
          rangeStartIso = leafRows[0]!.created_at;
          rangeEndIso = leafRows[leafRows.length - 1]!.created_at;
        } catch (error) {
          if (error instanceof SemanticSearchUnavailableError) {
            return jsonResult({
              error:
                "Semantic search is unavailable (sqlite-vec / vec0 not loaded or no active embedding model). " +
                "Use window_kind='time' with a summary_id target instead.",
              detail: error.message,
            });
          }
          if (error instanceof VoyageError) {
            if (error.kind === "auth") {
              return jsonResult({
                error: "Voyage API key is missing or invalid (set VOYAGE_API_KEY).",
                detail: error.message,
              });
            }
            return jsonResult({
              error: `Voyage embed call failed (${error.kind}).`,
              detail: error.message,
            });
          }
          const message = error instanceof Error ? error.message : String(error);
          if (/VOYAGE_API_KEY/i.test(message)) {
            return jsonResult({
              error: "Voyage API key is missing (set VOYAGE_API_KEY).",
              detail: message,
            });
          }
          return jsonResult({ error: `Semantic search failed: ${message}` });
        }
      }

      if (leafRows.length === 0) {
        return jsonResult({
          error: "Window selected zero leaves.",
          hint:
            windowKind === "time"
              ? "Widen windowHours, or set allConversations=true if leaves live elsewhere."
              : windowKind === "period"
                ? "Widen the period (e.g. 'last-30-days' instead of 'yesterday'), or set allConversations=true."
                : "Increase windowK, or relax since/before bounds.",
          window: {
            kind: windowKind,
            ...(windowKind === "time"
              ? { hours: windowHours, since: rangeStartIso, before: rangeEndIso }
              : windowKind === "period"
                ? { since: rangeStartIso, before: rangeEndIso }
                : { k: windowK }),
          },
        });
      }

      const built = buildSourceText(leafRows);
      const sourceText = built.text;
      const sourceTokenCount = estimateTokens(sourceText);
      const leafIds = leafRows
        .slice(0, built.truncatedAt ?? leafRows.length)
        .map((r) => r.summary_id);
      const leafFingerprint = fingerprintLeaves(leafIds);

      // 9. Build LLM call wrapper from the existing summarizer chain. We
      //    don't have a synthesizer-specific model resolver here, so we
      //    reuse the configured summarizer (it already handles fallback +
      //    auth retries + timeouts).
      const summarizerBuilt = await createLcmSummarizeFromLegacyParams({
        deps: input.deps,
        legacyParams: {},
      });
      if (!summarizerBuilt) {
        return jsonResult({
          error:
            "No summarization model resolved — set summaryModel/summaryProvider on the lossless-claw plugin or LCM_SUMMARY_MODEL env.",
        });
      }
      // Wave-12 reviewer F8 audit-honesty: pass the resolved primary
      // candidate's model name so the audit row records the actually-run
      // model, not dispatch's pickModel recommendation. summarizerBuilt
      // exposes `model` from its first resolved candidate (src/summarize.ts:1688-1695).
      const llmCall = buildLlmCallFromSummarizer(
        (text) => summarizerBuilt.fn(text, false, { isCondensed: true }),
        () => summarizerBuilt.model,
      );

      // 10. Pre-compute the cache_id and persist the synthesis to
      //     lcm_synthesis_cache. dispatchSynthesis writes to the audit
      //     log via the targetCacheId we supply, so we INSERT the cache
      //     row first as 'building' (single-flight via UNIQUE index),
      //     run dispatch, then UPDATE with the output.
      const cacheId = `cache_around_${Date.now().toString(36)}_${shortRandomSuffix()}`;
      const passSessionId = `pas_around_${Date.now().toString(36)}_${shortRandomSuffix()}`;

      // Pre-write cache row in 'building' state. CHECK constraint requires
      // tier_label IN ('year','custom','filtered'), session_key NOT NULL,
      // range_start/range_end NOT NULL. prompt_id is REQUIRED — but we
      // need to look it up first.
      // Look up the active prompt_id BEFORE the cache write so we can
      // satisfy the FK to lcm_prompt_registry. If no prompt is registered
      // we surface a clear error before any LLM call.
      const promptCheckRow = db
        .prepare(
          `SELECT prompt_id FROM lcm_prompt_registry
             WHERE memory_type = 'episodic-condensed' AND tier_label = ? AND pass_kind = 'single' AND active = 1
             ORDER BY version DESC LIMIT 1`,
        )
        .get(tier) as { prompt_id: string } | undefined;
      if (!promptCheckRow) {
        return jsonResult({
          error: `missing_prompt: no active prompt for (memory_type=episodic-condensed, tier=${tier}, pass_kind=single).`,
          hint:
            "Register a prompt via `registerPrompt(db, { memoryType: 'episodic-condensed', tierLabel: '" +
            tier +
            "', passKind: 'single', template: '...' })` before calling this tool.",
        });
      }
      const initialPromptId = promptCheckRow.prompt_id;

      // Wave-1 Auditor #3 fix #1+#5 + Wave-2 Auditor #1 fix #2 + Wave-3
      // Auditor #1 fixes (H2 + M1 + M2): single-flight via INSERT OR IGNORE
      // on the UNIQUE lookup index (session_key, range_start, range_end,
      // leaf_fingerprint, COALESCE(grep_filter,'')).
      //
      // Pre-write janitor:
      //   1. Reap zombie 'building' rows older than 10 min (process killed
      //      mid-dispatch can leave them blocking the latch).
      //   2. Reap 'failed' rows older than the FAILURE_BACKOFF_MIN (start
      //      at 10 min; doubles per repeated failure, capped at 6h). This
      //      avoids hammering the LLM during long outages: instead of
      //      retrying every 10 min, we back off exponentially.
      //   3. Both DELETE + INSERT OR IGNORE wrapped in BEGIN IMMEDIATE so
      //      cross-process callers can't sneak in between.
      //
      // Audit row may have already been written by the dispatcher; FK
      // ON DELETE CASCADE on lcm_synthesis_audit handles it (per
      // migration.ts:1574).
      const ZOMBIE_TTL_MIN = 10;
      const FAILED_BACKOFF_HARD_CAP_MIN = 6 * 60; // 6h ceiling

      // Wave-3 fix M2 + Wave-8 Auditor #6 P1 honest-comment fix: the
      // janitor (zombie reap + audit GC) runs INSIDE a BEGIN IMMEDIATE
      // tx that COMMITs before the INSERT OR IGNORE below. The INSERT is
      // therefore NOT in the same tx as the janitor — but single-flight
      // is still correct because INSERT OR IGNORE on the UNIQUE lookup
      // index handles any concurrent claim atomically (SQLite-level).
      // The tx around the janitor exists to serialize zombie/failed-row
      // cleanup against concurrent zombie-reap attempts; not to make
      // janitor+INSERT atomic. (Wave-7 audit caught the misleading prior
      // comment.)
      let txStarted = false;
      try {
        db.exec("BEGIN IMMEDIATE");
        txStarted = true;
      } catch {
        // Another writer holds the lock — proceed without our own tx
        // and let the INSERT OR IGNORE do its work. Worst case we get a
        // benign latch loss.
      }
      try {
        // Building zombies: simple 10-min TTL.
        db.prepare(
          `DELETE FROM lcm_synthesis_cache
             WHERE status = 'building'
               AND building_started_at IS NOT NULL
               AND julianday(building_started_at) < julianday('now', ?)`,
        ).run(`-${ZOMBIE_TTL_MIN} minutes`);

        // Failed rows: count attempts via lcm_synthesis_audit (rows with
        // status='failed' targeting the same cache_id) and apply
        // exponential backoff: TTL_MIN * 2^attempts, capped 6h.
        // For SQLite's strftime arithmetic we compute the threshold as
        // a julianday delta. We do the count + delete in two steps for
        // clarity (small audit table; no perf concern).
        const failedRows = db
          .prepare(
            `SELECT cache_id, building_started_at FROM lcm_synthesis_cache
               WHERE status = 'failed'
                 AND building_started_at IS NOT NULL`,
          )
          .all() as Array<{ cache_id: string; building_started_at: string }>;
        for (const fr of failedRows) {
          // Count prior failure-audits for this cache to compute backoff.
          const auditCountRow = db
            .prepare(
              `SELECT COUNT(*) AS n FROM lcm_synthesis_audit
                 WHERE target_cache_id = ? AND status = 'failed'`,
            )
            .get(fr.cache_id) as { n: number };
          const attempts = Math.max(1, auditCountRow?.n ?? 1);
          const backoffMin = Math.min(
            ZOMBIE_TTL_MIN * 2 ** Math.max(0, attempts - 1),
            FAILED_BACKOFF_HARD_CAP_MIN,
          );
          // Reap iff started > backoffMin minutes ago.
          db.prepare(
            `DELETE FROM lcm_synthesis_cache
               WHERE cache_id = ?
                 AND status = 'failed'
                 AND building_started_at IS NOT NULL
                 AND julianday(building_started_at) < julianday('now', ?)`,
          ).run(fr.cache_id, `-${backoffMin} minutes`);
        }

        // Audit GC (Wave-1 Auditor #3 #2 + Wave-3 Auditor #1 M1): reap
        // orphaned 'started' rows >1 hour and aged 'completed'/'failed'
        // rows >30 days. Wave-3 noted the 30-day branch was unindexed —
        // we added an index in this commit (see migration.ts) and now
        // both branches scan via index.
        db.prepare(
          `DELETE FROM lcm_synthesis_audit
             WHERE (status = 'started' AND julianday(ran_at) < julianday('now', '-1 hour'))
                OR (status IN ('completed','failed') AND julianday(ran_at) < julianday('now', '-30 days'))`,
        ).run();
      } catch {
        // best-effort; the INSERT below will still proceed.
      } finally {
        if (txStarted) {
          try {
            db.exec("COMMIT");
          } catch {
            try { db.exec("ROLLBACK"); } catch {}
          }
        }
      }

      // INSERT OR IGNORE — UNIQUE collision means another caller already
      // started the same synthesis. We re-SELECT to see who won.
      let weHoldTheCacheLatch = true;
      try {
        const insertResult = db
          .prepare(
            `INSERT OR IGNORE INTO lcm_synthesis_cache
               (cache_id, session_key, range_start, range_end, leaf_fingerprint,
                entity_index, model_used, prompt_id, tier_label,
                source_leaf_ids, source_token_count, output_token_count,
                actual_range_covered, leaf_count_synthesized,
                status, building_started_at)
             VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, 0, ?, ?, 'building', datetime('now'))`,
          )
          .run(
            cacheId,
            sessionKeyForCache,
            rangeStartIso,
            rangeEndIso,
            leafFingerprint,
            summarizerBuilt.model,
            initialPromptId,
            cacheTierLabel,
            JSON.stringify(leafIds),
            sourceTokenCount,
            JSON.stringify({
              mode: windowKind,
              anchorSummaryId: targetSummary?.summary_id ?? null,
              ...(windowKind === "time"
                ? { hours: windowHours }
                : windowKind === "period"
                  ? {
                      period:
                        typeof p.period === "string" ? p.period.trim() || null : null,
                      rangeStart: rangeStartIso,
                      rangeEnd: rangeEndIso,
                    }
                  : { k: windowK, model: semanticMeta?.modelName ?? null }),
              since: sinceBound?.toISOString() ?? null,
              before: beforeBound?.toISOString() ?? null,
            }),
            leafIds.length,
          );
        // sqlite IGNORE returns changes=0 if a UNIQUE conflict was hit
        if (insertResult.changes === 0) {
          weHoldTheCacheLatch = false;
        }
      } catch (insertErr) {
        return jsonResult({
          error: `Failed to insert synthesis cache row: ${insertErr instanceof Error ? insertErr.message : String(insertErr)}`,
        });
      }

      // Latch lost — another concurrent caller is synthesizing the same
      // (session_key, range, leaf_fingerprint) tuple. Look up their cache
      // row and either return the cached result (status='ready') or
      // surface a "building elsewhere" hint without re-LLM-ing.
      if (!weHoldTheCacheLatch) {
        // Wave-2 Auditor #1 fix #1 (HIGH CRASH BUG): the cache table column
        // is `content` (per migration.ts:1506), NOT `output`. Previous code
        // SELECTed `output, output_token_count` — every concurrent
        // ready-cache hit threw `no such column: output` instead of
        // returning the cached synthesis. Single-flight winner-already-ready
        // fast-path was completely broken. This fix uses the real columns.
        //
        // Wave-3 Auditor #1 fix H1: also SELECT `failure_reason` so the
        // recent_failure response surfaces the actual cause to the caller
        // (was hidden one column away).
        // Wave-10 reviewer P1 fix: include `tier_label` and `prompt_id`
        // in the cache lookup so distinct (tier, prompt) combinations
        // get distinct cache rows — matches the new UNIQUE index.
        // Previously the lookup ignored both, so:
        //   - tier='custom' then tier='filtered' for same range/leaves
        //     silently returned the wrong-tier cached text
        //   - active prompt change via registerPrompt continued to serve
        //     stale text from the old prompt
        const winner = db
          .prepare(
            `SELECT cache_id, status, content, output_token_count,
                    building_started_at, failure_reason
               FROM lcm_synthesis_cache
               WHERE session_key = ? AND range_start = ? AND range_end = ?
                 AND leaf_fingerprint = ? AND COALESCE(grep_filter, '') = ''
                 AND tier_label = ? AND prompt_id = ?
               ORDER BY building_started_at DESC LIMIT 1`,
          )
          .get(
            sessionKeyForCache,
            rangeStartIso,
            rangeEndIso,
            leafFingerprint,
            cacheTierLabel,
            initialPromptId,
          ) as
          | {
              cache_id: string;
              status: string;
              content: string | null;
              output_token_count: number | null;
              building_started_at: string | null;
              failure_reason: string | null;
            }
          | undefined;
        if (winner?.status === "ready" && winner.content != null) {
          // Cache hit — return the existing synthesis without re-LLM.
          return jsonResult({
            cache_id: winner.cache_id,
            status: "cached",
            text: winner.content,
            output_token_count: winner.output_token_count ?? 0,
            single_flight_outcome: "winner_already_ready",
          });
        }
        if (winner?.status === "failed") {
          // Wave-3 Auditor #1 H1: include failure_reason so caller knows
          // WHY (was just "A recent attempt failed; retry"). Compute
          // retry_after_ms based on building_started_at + 10 min so caller
          // can sleep precisely instead of polling.
          const startedAtMs = winner.building_started_at
            ? new Date(winner.building_started_at).getTime()
            : null;
          const retryAfterMs =
            startedAtMs != null
              ? Math.max(0, startedAtMs + 10 * 60 * 1000 - Date.now())
              : null;
          return jsonResult({
            status: "recent_failure",
            cache_id: winner.cache_id,
            building_started_at: winner.building_started_at,
            failure_reason: winner.failure_reason,
            retry_after_ms: retryAfterMs,
            hint: winner.failure_reason
              ? `Last attempt failed: ${String(winner.failure_reason).slice(0, 200)}. Retries are exponentially backed off (10 min × 2^attempt, capped 6h). Wait retry_after_ms then re-call, or pass slightly different criteria.`
              : "A recent attempt failed. Retries are exponentially backed off; wait retry_after_ms or pass slightly different criteria.",
            single_flight_outcome: "lost_latch",
          });
        }
        // Wave-3 Auditor #1 H3: building_elsewhere now includes
        // retry_after_ms so the caller can sleep precisely once instead
        // of polling. Computed from building_started_at + zombie TTL
        // (10 min) so we converge on the same exhaustion that the
        // janitor uses.
        const startedAtMs = winner?.building_started_at
          ? new Date(winner.building_started_at).getTime()
          : null;
        const retryAfterMs =
          startedAtMs != null
            ? Math.max(0, startedAtMs + 10 * 60 * 1000 - Date.now())
            : null;
        return jsonResult({
          status: "building_elsewhere",
          cache_id: winner?.cache_id ?? "(unknown)",
          building_started_at: winner?.building_started_at ?? null,
          retry_after_ms: retryAfterMs,
          hint: "Another caller is synthesizing the same window. Wait retry_after_ms (or a few seconds) before retrying — the janitor will reap stalled work after 10 minutes max.",
          single_flight_outcome: "lost_latch",
        });
      }

      // 11. Dispatch synthesis. The dispatch will look up the active
      //     prompt for (memoryType, tier, single), record audit rows, and
      //     return the synthesized output.
      let dispatchResult;
      try {
        dispatchResult = await dispatchSynthesis(db, llmCall, {
          tier,
          memoryType: "episodic-condensed",
          sourceText,
          passSessionId,
          targetCacheId: cacheId,
        });
      } catch (error) {
        // Update cache row to failed and surface the error kind.
        try {
          db.prepare(
            `UPDATE lcm_synthesis_cache
               SET status = 'failed', failure_reason = ?
               WHERE cache_id = ?`,
          ).run(error instanceof Error ? error.message.slice(0, 800) : String(error).slice(0, 800), cacheId);
        } catch {
          // best-effort
        }
        if (error instanceof SynthesisDispatchError) {
          return jsonResult({
            error: `${error.kind}: ${error.message}`,
            cache_id: cacheId,
            hint:
              error.kind === "missing_prompt"
                ? `Register an active prompt for (memory_type='episodic-condensed', tier_label='${tier}', pass_kind='single') before calling this tool.`
                : undefined,
          });
        }
        const message = error instanceof Error ? error.message : String(error);
        return jsonResult({ error: `Synthesis dispatch failed: ${message}`, cache_id: cacheId });
      }

      const outputText = dispatchResult.output;
      const outputTokens = estimateTokens(outputText);

      // 12. Update the cache row with the final content + ready status.
      try {
        db.prepare(
          `UPDATE lcm_synthesis_cache
             SET status = 'ready', content = ?, output_token_count = ?,
                 prompt_id = ?, building_started_at = NULL
             WHERE cache_id = ?`,
        ).run(outputText, outputTokens, dispatchResult.primaryPromptId, cacheId);
      } catch (updateErr) {
        // The synthesis succeeded; cache update failure is logged but
        // shouldn't block the response.
        input.deps.log.warn(
          `[lcm] synthesize_around: cache row update failed for ${cacheId}: ${updateErr instanceof Error ? updateErr.message : String(updateErr)}`,
        );
      }

      // 13. Optional: leaf refs for purge-cascade (best-effort — if any
      //     leaf goes away later, cascade deletes this cache row too).
      try {
        const refStmt = db.prepare(
          `INSERT OR IGNORE INTO lcm_cache_leaf_refs (cache_id, leaf_summary_id) VALUES (?, ?)`,
        );
        for (const id of leafIds) {
          refStmt.run(cacheId, id);
        }
      } catch (refErr) {
        input.deps.log.warn(
          `[lcm] synthesize_around: cache_leaf_refs insert failed for ${cacheId}: ${refErr instanceof Error ? refErr.message : String(refErr)}`,
        );
      }

      // 14. Build the markdown response.
      const lines: string[] = [];
      lines.push("## LCM Synthesize-Around");
      lines.push(`**Mode:** ${windowKind}`);
      if (windowKind === "time") {
        lines.push(`**Window:** ±${windowHours}h around ${formatDisplayTime(targetSummary!.created_at, timezone)}`);
      } else if (windowKind === "period") {
        const periodLabel = typeof p.period === "string" && p.period.trim().length > 0 ? p.period.trim() : "custom-range";
        lines.push(`**Window:** period='${periodLabel}' (direct date-range — no anchor required)`);
      } else {
        lines.push(`**Window:** top-${windowK} semantic neighbours`);
        if (semanticMeta?.modelName) {
          lines.push(`**Embedding model:** ${semanticMeta.modelName}`);
        }
      }
      lines.push(`**Effective range:** ${formatDisplayTime(rangeStartIso, timezone)} → ${formatDisplayTime(rangeEndIso, timezone)}`);
      lines.push(`**Leaves synthesized:** ${leafIds.length}${built.truncatedAt != null ? ` (truncated from ${leafRows.length})` : ""}`);
      lines.push(`**Tier:** ${tier}`);
      lines.push(`**Cache id:** \`${cacheId}\``);
      lines.push(`**Cost:** ${dispatchResult.totalCostCents} cents | **Latency:** ${dispatchResult.totalLatencyMs}ms`);
      if (dispatchResult.hallucinationFlagged === true) {
        lines.push("**Verify-fidelity:** flagged possible hallucination — see audit");
      }
      lines.push("");
      lines.push("---");
      lines.push("");
      lines.push(outputText);

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          cache_id: cacheId,
          mode: windowKind,
          tier,
          range_start: rangeStartIso,
          range_end: rangeEndIso,
          leaf_count: leafIds.length,
          source_token_count: sourceTokenCount,
          output_token_count: outputTokens,
          truncated: built.truncatedAt != null,
          model_used: summarizerBuilt.model,
          embedding_model: semanticMeta?.modelName ?? null,
          voyage_tokens_consumed: semanticMeta?.voyageTokensConsumed ?? 0,
          // Wave-2 Auditor #7 fix A2: cross-tool naming parity. The
          // synthesize-around output shape uses snake_case throughout
          // (cache_id, range_start, output_token_count etc.) so we keep
          // voyage_tokens_consumed for internal consistency, AND mirror
          // it as voyageTokensConsumed so cross-tool agents that key on
          // the standard camelCase name find it. Both fields read the
          // same value.
          voyageTokensConsumed: semanticMeta?.voyageTokensConsumed ?? 0,
          synthesis: {
            primary_prompt_id: dispatchResult.primaryPromptId,
            audit_ids: dispatchResult.auditIds,
            total_latency_ms: dispatchResult.totalLatencyMs,
            total_cost_cents: dispatchResult.totalCostCents,
            hallucination_flagged: dispatchResult.hallucinationFlagged ?? null,
          },
          target: {
            kind: targetIsSummaryId ? "summary_id" : "query",
            value: target,
            summary_anchor_at: targetSummary?.created_at ?? null,
          },
        },
      };
    },
  };
}
