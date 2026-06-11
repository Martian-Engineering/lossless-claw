import { createHash, randomUUID } from "node:crypto";
import { contentFromParts } from "./assembler.js";
import type {
  ConversationStore,
  CreateMessagePartInput,
  MessagePartRecord,
  MessageRecord,
  MessageRole,
} from "./store/conversation-store.js";
import type { SummaryStore, SummaryRecord, ContextItemRecord } from "./store/summary-store.js";
import { estimateTokens, truncateTextToEstimatedTokens } from "./estimate-tokens.js";
import { extractFileIdsFromContent } from "./large-files.js";
import { NOOP_LCM_LOGGER, type LcmLogger } from "./lcm-log.js";
import { LcmProviderAuthError } from "./summarize.js";
import {
  buildDeterministicFallbackSummary,
  FALLBACK_DIRECTIVE_SUMMARY_MARKER,
} from "./summary-fallback.js";

// ── Public types ─────────────────────────────────────────────────────────────

export interface CompactionDecision {
  shouldCompact: boolean;
  reason: "threshold" | "manual" | "none";
  /** Persisted Lossless context tokens before runtime prompt overhead. */
  storedTokens: number;
  /** Runtime-observed prompt tokens, when supplied by the host. */
  observedTokens?: number;
  /** Raw message tokens outside the protected fresh tail, when live prompt pressure is known. */
  rawTokensOutsideTail?: number;
  /** Projected prompt pressure after adding unsummarized raw backlog to observed tokens. */
  projectedTokens?: number;
  currentTokens: number;
  threshold: number;
}

export interface CompactionResult {
  actionTaken: boolean;
  /** Tokens before compaction */
  tokensBefore: number;
  /** Tokens after compaction */
  tokensAfter: number;
  /** Summary created (if any) */
  createdSummaryId?: string;
  /** Whether condensation was performed */
  condensed: boolean;
  /** Escalation level used: "normal" | "aggressive" | "fallback" */
  level?: CompactionLevel;
  /** Whether compaction was blocked by a provider auth failure */
  authFailure?: boolean;
  /** Whether the sweep stopped because its iteration or wall-clock budget was exhausted */
  stoppedAtBudget?: boolean;
}

export interface CompactionConfig {
  /** Context threshold as fraction of budget (default 0.75) */
  contextThreshold: number;
  /** Number of fresh tail turns to protect (default 8) */
  freshTailCount: number;
  /** Optional token cap for the protected fresh tail; newest message is always preserved. */
  freshTailMaxTokens?: number;
  /** Minimum number of depth-0 summaries needed for condensation. */
  leafMinFanout: number;
  /** Minimum number of depth>=1 summaries needed for condensation. */
  condensedMinFanout: number;
  /** Relaxed minimum fanout for hard-trigger sweeps. */
  condensedMinFanoutHard: number;
  /** Preferred source depth for routine full-sweep condensation (default 1). */
  sweepMaxDepth?: number;
  /** Deprecated alias for sweepMaxDepth. */
  incrementalMaxDepth?: number;
  /** Max source tokens to compact per leaf/condensed chunk (default 20000) */
  leafChunkTokens?: number;
  /** Optional target for summarized-prefix tokens after a full sweep. */
  summaryPrefixTargetTokens?: number;
  /** Target tokens for leaf summaries (default 600) */
  leafTargetTokens: number;
  /** Target tokens for condensed summaries (default 900) */
  condensedTargetTokens: number;
  /** Maximum compaction rounds (default 10) */
  maxRounds: number;
  /**
   * Hard cap on per-pass iterations within a single full sweep (default 12).
   * Bounds Phase 1 leaf passes and Phase 2 condensed passes so a large
   * conversation cannot trigger an unbounded sweep on the turn-critical path.
   */
  maxSweepIterations?: number;
  /**
   * Wall-clock budget for a single full sweep, in milliseconds (default
   * 120000). When exceeded, the sweep stops cleanly and returns the
   * consistent partial result instead of starting another pass.
   */
  sweepDeadlineMs?: number;
  /**
   * Wall-clock budget for a whole `compactUntilUnder` operation, in
   * milliseconds (default 300000). `compactUntilUnder` runs up to
   * `maxRounds` sweeps, each of which re-arms its own `sweepDeadlineMs`;
   * without an operation-wide budget the worst case is `maxRounds ×
   * sweepDeadlineMs`. When exceeded, `compactUntilUnder` stops before the
   * next round and returns the consistent partial result.
   */
  compactUntilUnderDeadlineMs?: number;
  /** IANA timezone for timestamps in summaries (default: UTC) */
  timezone?: string;
  /** Maximum allowed overage factor for summaries relative to target tokens (default 3). */
  summaryMaxOverageFactor: number;
  /** Injected context XML tags to strip before compaction summarization. */
  stripInjectedContextTags?: string[];
}

type CompactionLevel = "normal" | "aggressive" | "fallback" | "capped";
type CompactionPass = "leaf" | "condensed";
type CompactionSummarizeOptions = {
  previousSummary?: string;
  isCondensed?: boolean;
  depth?: number;
};
type CompactionSummarizeFn = (
  text: string,
  aggressive?: boolean,
  options?: CompactionSummarizeOptions,
) => Promise<string>;
type PassResult = {
  summaryId: string;
  level: CompactionLevel;
  /** Token count of source items removed from context. */
  removedTokens: number;
  /** Token count of the newly created summary. */
  addedTokens: number;
};
type CondensedPassSkipped = {
  skipped: "empty-source";
};
type CondensedPassResult = PassResult | CondensedPassSkipped;
type LeafChunkSelection = {
  items: ContextItemRecord[];
  rawTokensOutsideTail: number;
  threshold: number;
};
type CondensedChunkSelection = {
  items: ContextItemRecord[];
  summaryTokens: number;
  meaningfulCount: number;
};
type CondensedPhaseCandidate = {
  targetDepth: number;
  chunk: CondensedChunkSelection;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveContextThreshold(config: CompactionConfig, override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override >= 0 && override <= 1) {
    return override;
  }
  return config.contextThreshold;
}


/** Deterministically cap summary text so the persisted output stays within maxTokens. */
function capSummaryText(
  content: string,
  originalTokens: number,
  maxTokens: number,
): string {
  const suffixes = [
    `\n[Capped from ${originalTokens} tokens to ~${maxTokens}]`,
    `\n[Capped to ~${maxTokens}]`,
    "\n[Capped]",
    "",
  ];

  for (const suffix of suffixes) {
    const contentBudget = Math.max(0, maxTokens - estimateTokens(suffix));
    const capped = `${truncateTextToEstimatedTokens(content, contentBudget)}${suffix}`;
    if (estimateTokens(capped) <= maxTokens) {
      return capped;
    }
  }

  return truncateTextToEstimatedTokens(content, maxTokens);
}

/** Format a timestamp as `YYYY-MM-DD HH:mm TZ` for prompt source text. */
export function formatTimestamp(value: Date, timezone: string = "UTC"): string {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const parts = Object.fromEntries(
      fmt.formatToParts(value).map((p) => [p.type, p.value]),
    );
    const tzAbbr = timezone === "UTC" ? "UTC" : shortTzAbbr(value, timezone);
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${tzAbbr}`;
  } catch {
    // Fallback to UTC on invalid timezone
    const year = value.getUTCFullYear();
    const month = String(value.getUTCMonth() + 1).padStart(2, "0");
    const day = String(value.getUTCDate()).padStart(2, "0");
    const hours = String(value.getUTCHours()).padStart(2, "0");
    const minutes = String(value.getUTCMinutes()).padStart(2, "0");
    return `${year}-${month}-${day} ${hours}:${minutes} UTC`;
  }
}

/** Extract short timezone abbreviation (e.g. "PST", "PDT", "EST"). */
function shortTzAbbr(value: Date, timezone: string): string {
  try {
    const abbr = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "short",
    })
      .formatToParts(value)
      .find((p) => p.type === "timeZoneName")?.value;
    return abbr ?? timezone;
  } catch {
    return timezone;
  }
}

/** Generate a collision-resistant summary ID from content and a random nonce. */
function generateSummaryId(content: string): string {
  return (
    "sum_" +
    createHash("sha256")
      .update(content + randomUUID())
      .digest("hex")
      .slice(0, 16)
  );
}

/** Maximum estimated tokens for the deterministic fallback truncation. */
const FALLBACK_MAX_TOKENS = 512;
const DEFAULT_LEAF_CHUNK_TOKENS = 20_000;

/**
 * Default hard cap on per-pass iterations within a single full sweep. Each
 * pass summarizes one raw or summary chunk; large conversations would
 * otherwise drive an unbounded number of passes (observed: 16 passes on a
 * 308K-token conversation), each potentially burning a full summarizer
 * timeout on the turn-critical path.
 */
const DEFAULT_MAX_SWEEP_ITERATIONS = 12;

/**
 * Default wall-clock budget for a single full sweep, in milliseconds. Once a
 * sweep has run this long it stops before starting another pass and returns
 * the consistent partial result, so a slow/rate-limited summarizer cannot
 * hang the agent turn for tens of minutes.
 */
const DEFAULT_SWEEP_DEADLINE_MS = 120_000;

/**
 * Default wall-clock budget for a whole `compactUntilUnder` operation, in
 * milliseconds. `compactUntilUnder` runs up to `maxRounds` sweeps, each of
 * which re-arms its own `DEFAULT_SWEEP_DEADLINE_MS`; without an
 * operation-wide budget the worst case is `maxRounds × sweepDeadlineMs`
 * (~20 minutes at the defaults). 5 minutes leaves room for a few
 * full-deadline sweeps while capping the worst case well below that.
 */
const DEFAULT_COMPACT_UNTIL_UNDER_DEADLINE_MS = 300_000;

/**
 * Yield the Node event loop for one macrotask. Each leaf/condensed pass runs
 * synchronous `node:sqlite` scans that block the event loop; awaiting this
 * between passes lets the gateway service other work during a long sweep.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Pattern matching MEDIA:/... file path references that appear in message content
 * when the original message contained only a media attachment (image, file, etc.)
 * with no meaningful text.
 */
const MEDIA_PATH_RE = /^MEDIA:\/.+$/;
const EMBEDDED_DATA_URL_RE = /data:[^;\s"'`]+;base64,[A-Za-z0-9+/=\s]+/gi;
const MEDIA_ATTACHMENT_PART_TYPES = new Set(["file", "snapshot"]);
const MEDIA_ATTACHMENT_RAW_TYPES = new Set(["file", "image", "snapshot"]);
const PROVIDER_REASONING_RAW_TYPES = new Set(["reasoning", "thinking", "redacted_thinking"]);
const STRUCTURED_MEDIA_TEXT_KEYS = ["text", "caption", "alt", "title", "summary"] as const;
const STRUCTURED_MEDIA_NESTED_KEYS = [
  "content",
  "parts",
  "items",
  "message",
  "messages",
  "input",
  "arguments",
  "output",
  "result",
  "results",
  "data",
  "query",
  "command",
] as const;
const LEADING_CLOSED_REASONING_TEXT_BLOCK_RE =
  /^<\s*(think|thinking|reasoning)(?:\s[^>]*)?>[\s\S]*?<\s*\/\s*\1\s*>/i;
const STANDALONE_CLOSED_REASONING_TEXT_BLOCK_RE =
  /(^|\n)[ \t]*<\s*(think|thinking|reasoning)(?:\s[^>]*)?>[\s\S]*?<\s*\/\s*\2\s*>[ \t]*(?=\n|$)/gi;
const REASONING_TEXT_START_RE =
  /^(?:<\s*(?:think|thinking|reasoning)(?:\s[^>]*)?>|<\|\s*(?:start_of_)?(?:think|thinking|reasoning)\s*\|>|\[\s*(?:think|thinking|reasoning)\s*\])/i;
const STANDALONE_REASONING_TEXT_START_RE =
  /(^|\n)[ \t]*(?:<\s*(?:think|thinking|reasoning)(?:\s[^>]*)?>|<\|\s*(?:start_of_)?(?:think|thinking|reasoning)\s*\|>|\[\s*(?:think|thinking|reasoning)\s*\])[\s\S]*$/i;

const CONDENSED_MIN_INPUT_RATIO = 0.1;

function dedupeOrderedIds(ids: Iterable<string>): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  return ordered;
}

/** Parse message-part metadata without throwing on malformed JSON. */
function parseMessagePartMetadata(part: CreateMessagePartInput | { metadata: string | null }): Record<string, unknown> {
  if (typeof part.metadata !== "string" || !part.metadata.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(part.metadata) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Detect whether a string is mostly binary/base64 payload and not meaningful prose. */
function looksLikeBinaryPayload(value: string): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (/^data:[^;\s"'`]+;base64,/i.test(trimmed)) {
    return true;
  }
  const compact = trimmed.replace(/\s+/g, "");
  if (compact.length < 256 || compact.length % 4 !== 0) {
    return false;
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(compact)) {
    return false;
  }
  return !/[ .,:;!?()[\]{}]/.test(trimmed);
}

/** Strip attachment payloads from plain strings before they reach the summarizer. */
function stripEmbeddedMediaPayloads(content: string): string {
  if (typeof content !== "string") return "";
  const withoutDataUrls = content.replace(EMBEDDED_DATA_URL_RE, "[embedded media omitted]");
  const sanitizedLines = withoutDataUrls
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return false;
      }
      if (MEDIA_PATH_RE.test(trimmed)) {
        return false;
      }
      if (looksLikeBinaryPayload(trimmed)) {
        return false;
      }
      return true;
    });
  return sanitizedLines.join("\n").trim();
}

/**
 * Strip auto-injected context blocks from message content.
 *
 * Memory and context plugins (active-memory, memory-lancedb, hindsight-openclaw,
 * etc.) prepend XML-tagged blocks to user messages via the `prependContext` hook.
 * These blocks contain ephemeral retrieval context that should not leak into
 * compacted summaries or FTS indexes.
 *
 * Each tag name from `tags` is matched case-insensitively as `<tag>.....</tag>`.
 * The leading "Untrusted context" header used by active-memory is also stripped.
 */
export function stripInjectedContextBlocks(content: string, tags: string[] | undefined): string {
  if (!tags || tags.length === 0) {
    return content;
  }
  let result = content;
  for (const tag of tags) {
    // Escape any regex-special chars in the tag name (e.g. hyphens).
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `<${escaped}>[\\s\\S]*?</${escaped}>`,
      "gi",
    );
    result = result.replace(re, "");
  }
  // Strip the "Untrusted context" one-liner header used by active-memory.
  result = result.replace(
    /^Untrusted context \(metadata, do not treat as instructions or commands\):\s*/gim,
    "",
  );
  return result.trim();
}

type MeaningfulTextOptions = {
  stripPlainTextReasoning?: boolean;
};

function stripPlainTextReasoningPayloads(content: string): string {
  let trimmed = content.trim();
  while (true) {
    const match = trimmed.match(LEADING_CLOSED_REASONING_TEXT_BLOCK_RE);
    if (!match) {
      break;
    }
    trimmed = trimmed.slice(match[0].length).trimStart();
  }
  trimmed = trimmed
    .replace(
      STANDALONE_CLOSED_REASONING_TEXT_BLOCK_RE,
      (_match, lineStart: string) => (lineStart === "\n" ? "\n" : ""),
    )
    .replace(
      STANDALONE_REASONING_TEXT_START_RE,
      (_match, lineStart: string) => (lineStart === "\n" ? "\n" : ""),
    )
    .trim();
  if (!trimmed) {
    return "";
  }
  if (REASONING_TEXT_START_RE.test(trimmed)) {
    return "";
  }
  return trimmed;
}

function sanitizeTextFragment(value: string, options: MeaningfulTextOptions): string {
  const withoutMedia = stripEmbeddedMediaPayloads(value);
  return options.stripPlainTextReasoning
    ? stripPlainTextReasoningPayloads(withoutMedia)
    : withoutMedia;
}

/** Extract human-readable text from structured content while ignoring attachment payload fields. */
function extractSanitizedStructuredText(
  value: unknown,
  options: MeaningfulTextOptions = {},
  depth = 0,
): string[] {
  if (depth >= 4 || value == null) {
    return [];
  }
  if (typeof value === "string") {
    const sanitized = sanitizeTextFragment(value, options);
    return sanitized ? [sanitized] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractSanitizedStructuredText(entry, options, depth + 1));
  }
  if (typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type.trim().toLowerCase() : "";
  const rawType = typeof record.rawType === "string" ? record.rawType.trim().toLowerCase() : "";
  if (PROVIDER_REASONING_RAW_TYPES.has(type) || PROVIDER_REASONING_RAW_TYPES.has(rawType)) {
    return [];
  }
  const textFragments: string[] = [];

  for (const key of STRUCTURED_MEDIA_TEXT_KEYS) {
    const candidate = record[key];
    if (typeof candidate !== "string") {
      continue;
    }
    const sanitized = sanitizeTextFragment(candidate, options);
    if (sanitized) {
      textFragments.push(sanitized);
    }
  }

  if (MEDIA_ATTACHMENT_RAW_TYPES.has(type) || MEDIA_ATTACHMENT_RAW_TYPES.has(rawType)) {
    return textFragments;
  }

  for (const key of STRUCTURED_MEDIA_NESTED_KEYS) {
    textFragments.push(...extractSanitizedStructuredText(record[key], options, depth + 1));
  }

  return textFragments;
}

/**
 * Normalize message content down to human-readable text, excluding
 * binary/media payloads and provider reasoning/thinking blocks.
 *
 * Shared by every summarizer entry point (leaf input, condensed input,
 * prior-summary context) so reasoning blocks introduced at any level —
 * including legacy data persisted before #503 — are stripped before they
 * reach the summarizer.
 *
 * @internal Exported for tests; production code reaches it via the
 * compaction-engine entry points.
 */
export function extractMeaningfulMessageText(
  content: string,
  options: MeaningfulTextOptions = {},
): string {
  if (typeof content !== "string") return "";
  const trimmed = content.trim();
  if (!trimmed) {
    return "";
  }
  if ((trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("{") && trimmed.endsWith("}"))) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const extracted = extractSanitizedStructuredText(parsed, options)
        .map((fragment) => fragment.trim())
        .filter(Boolean);
      return extracted.join("\n").trim();
    } catch {
      // Fall back to plain-text sanitation below.
    }
  }
  return sanitizeTextFragment(content, options);
}

/** Normalize stored summary content before it is fed into a later summarizer pass. */
function extractMeaningfulSummaryText(content: string): string {
  return extractMeaningfulMessageText(content, { stripPlainTextReasoning: true });
}

/** Map stored message roles back to runtime roles for structured reconstruction. */
function runtimeRoleForSummary(role: MessageRole): "user" | "assistant" | "toolResult" {
  if (role === "tool") {
    return "toolResult";
  }
  if (role === "user" || role === "system") {
    return "user";
  }
  return "assistant";
}

/** Parse JSON-ish message-part values while preserving plain text values. */
function parseStoredPartValue(value: string | null | undefined): unknown {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

/** Extract summarizable text from a structured runtime content value. */
function extractMeaningfulStructuredText(value: unknown): string {
  if (typeof value === "string") {
    return extractMeaningfulMessageText(value);
  }
  const extracted = extractSanitizedStructuredText(value)
    .map((fragment) => fragment.trim())
    .filter(Boolean);
  if (extracted.length > 0) {
    return extracted.join("\n").trim();
  }
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? extractMeaningfulMessageText(serialized) : "";
  } catch {
    return "";
  }
}

/** Extract a readable fallback from one structured message part. */
function extractMessagePartSummaryText(part: MessagePartRecord): string {
  if (part.partType === "reasoning") {
    return "";
  }

  const sections: string[] = [];
  const text = extractMeaningfulStructuredText(part.textContent);
  if (text) {
    sections.push(text);
  }

  const toolName = part.toolName?.trim();
  const toolLabel = toolName ? ` (${toolName})` : "";
  const input = extractMeaningfulStructuredText(parseStoredPartValue(part.toolInput));
  if (input) {
    sections.push(`Tool input${toolLabel}:\n${input}`);
  }
  const output = extractMeaningfulStructuredText(parseStoredPartValue(part.toolOutput));
  if (output) {
    sections.push(`Tool output${toolLabel}:\n${output}`);
  }

  return sections.join("\n\n").trim();
}

/** Identify whether a stored message part represents a media attachment. */
function isMediaAttachmentPart(part: CreateMessagePartInput | { partType: string; metadata: string | null }): boolean {
  if (MEDIA_ATTACHMENT_PART_TYPES.has(part.partType)) {
    return true;
  }
  const metadata = parseMessagePartMetadata(part);
  const rawType =
    typeof metadata.rawType === "string"
      ? metadata.rawType.trim().toLowerCase()
      : metadata.raw && typeof metadata.raw === "object" && !Array.isArray(metadata.raw) &&
          typeof (metadata.raw as Record<string, unknown>).type === "string"
        ? ((metadata.raw as Record<string, unknown>).type as string).trim().toLowerCase()
        : "";
  return MEDIA_ATTACHMENT_RAW_TYPES.has(rawType);
}

// ── CompactionEngine ─────────────────────────────────────────────────────────

export class CompactionEngine {
  /**
   * Per-conversation context items cache, active only during compaction
   * entry points. null when inactive — external callers (e.g., engine.ts
   * evaluateLeafTrigger) get uncached reads.
   *
   * Uses a reference count so concurrent compactions on different
   * conversations don't interfere: each withContextCache increments
   * on entry and decrements on exit; the cache is only destroyed
   * when all users have exited.
   */
  private _contextItemsCache: Map<number, ContextItemRecord[]> | null = null;
  private _contextItemsCacheRefCount = 0;

  constructor(
    private conversationStore: ConversationStore,
    private summaryStore: SummaryStore,
    private config: CompactionConfig,
    private log: LcmLogger = NOOP_LCM_LOGGER,
  ) {}

  /** Read context items, using per-phase cache when active. */
  private async getContextItemsCached(conversationId: number): Promise<ContextItemRecord[]> {
    if (this._contextItemsCache) {
      if (this._contextItemsCache.has(conversationId)) {
        return this._contextItemsCache.get(conversationId)!;
      }
      const items = await this.summaryStore.getContextItems(conversationId);
      this._contextItemsCache.set(conversationId, items);
      return items;
    }
    return this.summaryStore.getContextItems(conversationId);
  }

  /** Invalidate cache for a conversation after context mutation. */
  private invalidateContextCache(conversationId: number): void {
    this._contextItemsCache?.delete(conversationId);
  }

  /** Execute with context cache active. Reference-counted for concurrent use. */
  private async withContextCache<T>(fn: () => Promise<T>): Promise<T> {
    if (!this._contextItemsCache) this._contextItemsCache = new Map();
    this._contextItemsCacheRefCount++;
    try {
      return await fn();
    } finally {
      this._contextItemsCacheRefCount--;
      if (this._contextItemsCacheRefCount <= 0) {
        this._contextItemsCache = null;
        this._contextItemsCacheRefCount = 0;
      }
    }
  }

  // ── evaluate ─────────────────────────────────────────────────────────────

  /** Evaluate whether compaction is needed. */
  async evaluate(
    conversationId: number,
    tokenBudget: number,
    observedTokenCount?: number,
    options?: { contextThreshold?: number },
  ): Promise<CompactionDecision> {
    const storedTokens = await this.summaryStore.getContextTokenCount(conversationId);
    const liveTokens =
      typeof observedTokenCount === "number" &&
      Number.isFinite(observedTokenCount) &&
      observedTokenCount > 0
        ? Math.floor(observedTokenCount)
        : 0;
    const rawTokensOutsideTail =
      liveTokens > 0 ? await this.countRawTokensOutsideFreshTail(conversationId) : undefined;
    const projectedTokens =
      liveTokens > 0 ? liveTokens + (rawTokensOutsideTail ?? 0) : undefined;
    const currentTokens = Math.max(storedTokens, projectedTokens ?? liveTokens);
    const threshold = Math.floor(
      resolveContextThreshold(this.config, options?.contextThreshold) * tokenBudget,
    );

    if (currentTokens > threshold) {
      return {
        shouldCompact: true,
        reason: "threshold",
        storedTokens,
        ...(liveTokens > 0 ? { observedTokens: liveTokens } : {}),
        ...(rawTokensOutsideTail !== undefined ? { rawTokensOutsideTail } : {}),
        ...(projectedTokens !== undefined ? { projectedTokens } : {}),
        currentTokens,
        threshold,
      };
    }

    return {
      shouldCompact: false,
      reason: "none",
      storedTokens,
      ...(liveTokens > 0 ? { observedTokens: liveTokens } : {}),
      ...(rawTokensOutsideTail !== undefined ? { rawTokensOutsideTail } : {}),
      ...(projectedTokens !== undefined ? { projectedTokens } : {}),
      currentTokens,
      threshold,
    };
  }

  /**
   * Evaluate whether the raw-message leaf trigger is active.
   *
   * Counts message tokens outside the protected fresh tail and compares against
   * `leafChunkTokens`. Automatic compaction no longer uses this as a trigger,
   * but it remains useful for diagnostics and explicit maintenance commands.
   */
  async evaluateLeafTrigger(conversationId: number, leafChunkTokensOverride?: number): Promise<{
    shouldCompact: boolean;
    rawTokensOutsideTail: number;
    threshold: number;
  }> {
    const rawTokensOutsideTail = await this.countRawTokensOutsideFreshTail(conversationId);
    const threshold = this.resolveLeafChunkTokens(leafChunkTokensOverride);
    return {
      shouldCompact: rawTokensOutsideTail >= threshold,
      rawTokensOutsideTail,
      threshold,
    };
  }

  // ── compact ──────────────────────────────────────────────────────────────

  /** Run a full compaction sweep for a conversation. */
  async compact(input: {
    conversationId: number;
    tokenBudget: number;
    contextThreshold?: number;
    /** LLM call function for summarization */
    summarize: CompactionSummarizeFn;
    force?: boolean;
    hardTrigger?: boolean;
    /** Optional persisted-context target used when host runtime overhead is known. */
    stopAtTokens?: number;
    summaryModel?: string;
    /** Optional operation-wide wall-clock deadline shared across rounds. */
    operationDeadlineAt?: number;
  }): Promise<CompactionResult> {
    return this.withContextCache(() => this.compactFullSweep(input));
  }

  /**
   * Run a single leaf pass against the oldest compactable raw chunk.
   *
   * This lower-level helper is used by focused compaction tests and explicit
   * leaf-pass callers; automatic maintenance uses threshold full sweeps.
   */
  async compactLeaf(input: {
    conversationId: number;
    tokenBudget: number;
    summarize: CompactionSummarizeFn;
    leafChunkTokens?: number;
    force?: boolean;
    previousSummaryContent?: string;
    summaryModel?: string;
    allowCondensedPasses?: boolean;
  }): Promise<CompactionResult> {
    return this.withContextCache(() => this._compactLeafImpl(input));
  }

  private async _compactLeafImpl(input: {
    conversationId: number;
    tokenBudget: number;
    contextThreshold?: number;
    summarize: CompactionSummarizeFn;
    leafChunkTokens?: number;
    force?: boolean;
    previousSummaryContent?: string;
    summaryModel?: string;
    allowCondensedPasses?: boolean;
  }): Promise<CompactionResult> {
    const { conversationId, tokenBudget, summarize, force } = input;

    const tokensBefore = await this.summaryStore.getContextTokenCount(conversationId);
    const threshold = Math.floor(
      resolveContextThreshold(this.config, input.contextThreshold) * tokenBudget,
    );
    const leafTrigger = await this.evaluateLeafTrigger(conversationId, input.leafChunkTokens);

    if (!force && tokensBefore <= threshold && !leafTrigger.shouldCompact) {
      return {
        actionTaken: false,
        tokensBefore,
        tokensAfter: tokensBefore,
        condensed: false,
      };
    }

    const leafChunk = await this.selectOldestLeafChunk(conversationId, input.leafChunkTokens);
    if (leafChunk.items.length === 0) {
      return {
        actionTaken: false,
        tokensBefore,
        tokensAfter: tokensBefore,
        condensed: false,
      };
    }

    const previousSummaryContent =
      input.previousSummaryContent ??
      (await this.resolvePriorLeafSummaryContext(conversationId, leafChunk.items));

    const leafResult = await this.leafPass(
      conversationId,
      leafChunk.items,
      summarize,
      previousSummaryContent,
      input.summaryModel,
    );
    if (!leafResult) {
      return {
        actionTaken: false,
        tokensBefore,
        tokensAfter: tokensBefore,
        condensed: false,
        authFailure: true,
      };
    }
    // Delta tracking: compute token change from pass results instead of re-querying DB
    const tokensAfterLeaf = tokensBefore - leafResult.removedTokens + leafResult.addedTokens;

    await this.persistCompactionEvents({
      conversationId,
      tokensBefore,
      tokensAfterLeaf,
      tokensAfterFinal: tokensAfterLeaf,
      leafResult: { summaryId: leafResult.summaryId, level: leafResult.level },
      condenseResult: null,
    });

    let tokensAfter = tokensAfterLeaf;
    let condensed = false;
    let createdSummaryId = leafResult.summaryId;
    let level = leafResult.level;

    const sweepMaxDepth = this.resolveSweepMaxDepth();
    const condensedMinChunkTokens = this.resolveCondensedMinChunkTokens();
    let runningTokens = tokensAfterLeaf;
    if (sweepMaxDepth > 0 && input.allowCondensedPasses !== false) {
      for (let targetDepth = 0; targetDepth < sweepMaxDepth; targetDepth++) {
        const fanout = this.resolveFanoutForDepth(targetDepth, false);
        const chunk = await this.selectOldestChunkAtDepth(conversationId, targetDepth);
        if (chunk.meaningfulCount < fanout || chunk.summaryTokens < condensedMinChunkTokens) {
          break;
        }

        const passTokensBefore = runningTokens;
        const condenseResult = await this.condensedPass(
          conversationId,
          chunk.items,
          targetDepth,
          summarize,
          input.summaryModel,
        );
        if (!condenseResult || "skipped" in condenseResult) {
          break;
        }
        const passTokensAfter = passTokensBefore - condenseResult.removedTokens + condenseResult.addedTokens;
        await this.persistCompactionEvents({
          conversationId,
          tokensBefore: passTokensBefore,
          tokensAfterLeaf: passTokensBefore,
          tokensAfterFinal: passTokensAfter,
          leafResult: null,
          condenseResult,
        });

        tokensAfter = passTokensAfter;
        runningTokens = passTokensAfter;
        condensed = true;
        createdSummaryId = condenseResult.summaryId;
        level = condenseResult.level;

        if (passTokensAfter >= passTokensBefore) {
          break;
        }
      }
    }

    return {
      actionTaken: true,
      tokensBefore,
      tokensAfter,
      createdSummaryId,
      condensed,
      level,
    };
  }

  /**
   * Run a threshold-triggered full sweep:
   *
   * Phase 1: repeatedly compact raw-message chunks outside the fresh tail.
   * Phase 2: repeatedly condense oldest summary chunks while chunk utilization
   *          remains high enough to be worthwhile.
   */
  async compactFullSweep(input: {
    conversationId: number;
    tokenBudget: number;
    contextThreshold?: number;
    summarize: CompactionSummarizeFn;
    force?: boolean;
    hardTrigger?: boolean;
    /** Optional persisted-context target used when host runtime overhead is known. */
    stopAtTokens?: number;
    summaryModel?: string;
    /**
     * Optional absolute wall-clock deadline (epoch ms) shared by a
     * multi-round caller (`compactUntilUnder`). When set, the sweep stops
     * at whichever is sooner — its own `sweepDeadlineMs` or this deadline —
     * so per-round sweeps cannot each re-arm a fresh full budget and let
     * the whole operation run `maxRounds × sweepDeadlineMs`.
     */
    operationDeadlineAt?: number;
  }): Promise<CompactionResult> {
    const { conversationId, tokenBudget, summarize, force, hardTrigger } = input;

    const tokensBefore = await this.summaryStore.getContextTokenCount(conversationId);
    const contextThreshold = resolveContextThreshold(this.config, input.contextThreshold);
    const threshold = Math.floor(contextThreshold * tokenBudget);
    const stopAtTokens =
      typeof input.stopAtTokens === "number" &&
      Number.isFinite(input.stopAtTokens) &&
      input.stopAtTokens > 0
        ? Math.floor(input.stopAtTokens)
        : undefined;

    if (
      !force &&
      tokensBefore <= threshold &&
      (stopAtTokens === undefined || tokensBefore <= stopAtTokens)
    ) {
      return {
        actionTaken: false,
        tokensBefore,
        tokensAfter: tokensBefore,
        condensed: false,
      };
    }

    const contextItems = await this.getContextItemsCached(conversationId);
    if (contextItems.length === 0) {
      return {
        actionTaken: false,
        tokensBefore,
        tokensAfter: tokensBefore,
        condensed: false,
      };
    }

    let actionTaken = false;
    let condensed = false;
    let createdSummaryId: string | undefined;
    let level: CompactionLevel | undefined;
    let previousSummaryContent: string | undefined;
    let previousTokens = tokensBefore;
    let hadAuthFailure = false;
    let stoppedForNoProgress = false;

    // Sweep bounds: a single full sweep must not run an unbounded number of
    // summarizer passes, nor exceed a wall-clock budget. Both phases share
    // these counters so the *total* sweep stays bounded — important because
    // this can run inline on the turn-critical path (assemble() deferred-debt
    // drain). On hitting either limit the sweep stops cleanly and returns the
    // consistent partial result built so far.
    //
    // When a multi-round caller (compactUntilUnder) passes operationDeadlineAt,
    // the sweep stops at whichever is sooner: its own sweepDeadlineMs or the
    // operation-wide deadline. Without this clamp each round re-arms a fresh
    // full sweepDeadlineMs and the whole operation can run maxRounds × that.
    const maxSweepIterations = this.resolveMaxSweepIterations();
    const sweepDeadlineMs = this.resolveSweepDeadlineMs();
    const sweepStartedAt = Date.now();
    const ownSweepDeadlineAt = sweepStartedAt + sweepDeadlineMs;
    const sweepDeadlineAt =
      typeof input.operationDeadlineAt === "number" &&
      Number.isFinite(input.operationDeadlineAt)
        ? Math.min(ownSweepDeadlineAt, input.operationDeadlineAt)
        : ownSweepDeadlineAt;
    let sweepIterations = 0;
    let stoppedAtBudget = false;
    /**
     * Check whether another pass is permitted. Logs a single warning the
     * first time a limit is hit, then returns false for all later checks.
     */
    const sweepBudgetExhausted = (phase: "leaf" | "condensed"): boolean => {
      if (stoppedAtBudget) {
        return true;
      }
      const hitIterationCap = sweepIterations >= maxSweepIterations;
      const hitDeadline = Date.now() >= sweepDeadlineAt;
      if (hitIterationCap || hitDeadline) {
        stoppedAtBudget = true;
        const clampedByOperation =
          hitDeadline && sweepDeadlineAt < ownSweepDeadlineAt;
        const limit = hitIterationCap
          ? `iteration cap ${maxSweepIterations}`
          : clampedByOperation
            ? `compactUntilUnder operation deadline`
            : `wall-clock deadline ${sweepDeadlineMs}ms`;
        this.log.warn(
          `[lcm] compactFullSweep stopped at ${limit} in ${phase} phase: ` +
            `conversation=${conversationId} passes=${sweepIterations} ` +
            `elapsedMs=${Date.now() - sweepStartedAt} ` +
            `tokensBefore=${tokensBefore} tokensSoFar=${runningTokens} ` +
            `(returning partial result)`,
        );
        return true;
      }
      return false;
    };

    // Phase 1: leaf passes over oldest raw chunks outside the protected tail.
    // Delta tracking: maintain a running token count instead of re-querying DB
    // after each pass. The arithmetic is exact: tokensAfter = tokensBefore - removed + added.
    let runningTokens = tokensBefore;
    while (true) {
      if (sweepBudgetExhausted("leaf")) {
        break;
      }
      const leafChunk = await this.selectOldestLeafChunk(conversationId);
      if (leafChunk.items.length === 0) {
        break;
      }
      if (sweepBudgetExhausted("leaf")) {
        break;
      }

      sweepIterations++;
      const passTokensBefore = runningTokens;
      const leafResult = await this.leafPass(
        conversationId,
        leafChunk.items,
        summarize,
        previousSummaryContent,
        input.summaryModel,
      );
      if (!leafResult) {
        hadAuthFailure = true;
        break;
      }
      const passTokensAfter = passTokensBefore - leafResult.removedTokens + leafResult.addedTokens;
      await this.persistCompactionEvents({
        conversationId,
        tokensBefore: passTokensBefore,
        tokensAfterLeaf: passTokensAfter,
        tokensAfterFinal: passTokensAfter,
        leafResult: { summaryId: leafResult.summaryId, level: leafResult.level },
        condenseResult: null,
      });

      actionTaken = true;
      createdSummaryId = leafResult.summaryId;
      level = leafResult.level;
      previousSummaryContent = leafResult.content;
      runningTokens = passTokensAfter;

      if (passTokensAfter >= passTokensBefore || passTokensAfter >= previousTokens) {
        break;
      }
      previousTokens = passTokensAfter;
      // Yield the event loop between the synchronous node:sqlite scans so a
      // long sweep does not freeze the gateway for its entire duration.
      await yieldToEventLoop();
    }

    // Phase 2: depth-aware condensed passes, always processing shallowest depth first.
    const preferredMaxSourceDepth = this.resolveSweepMaxDepth();
    const summaryPrefixTargetTokens = this.resolveSummaryPrefixTargetTokens(
      tokenBudget,
      contextThreshold,
    );
    const hasSummaryPrefixPressure = async (): Promise<boolean> =>
      (await this.countSummaryTokensOutsideFreshTail(conversationId)) > summaryPrefixTargetTokens;
    const hasStopTargetPressure = (): boolean =>
      stopAtTokens !== undefined && runningTokens > stopAtTokens;
    const hasCondensationPressure = async (): Promise<boolean> =>
      hasStopTargetPressure() || await hasSummaryPrefixPressure();

    const runCondensationPass = async (params: {
      enforcePreferredDepth: boolean;
      useHardFanout: boolean;
    }): Promise<
      "progress" | "no-candidate" | "depth-cap" | "budget" | "auth-failure" | "no-progress"
    > => {
      const candidate = await this.selectShallowestCondensationCandidate({
        conversationId,
        hardTrigger: params.useHardFanout,
      });
      if (!candidate) {
        return "no-candidate";
      }
      if (params.enforcePreferredDepth && candidate.targetDepth >= preferredMaxSourceDepth) {
        return "depth-cap";
      }
      if (sweepBudgetExhausted("condensed")) {
        return "budget";
      }

      sweepIterations++;
      const passTokensBefore = runningTokens;
      const condenseResult = await this.condensedPass(
        conversationId,
        candidate.chunk.items,
        candidate.targetDepth,
        summarize,
        input.summaryModel,
      );
      if (!condenseResult) {
        hadAuthFailure = true;
        return "auth-failure";
      }
      if ("skipped" in condenseResult) {
        return "no-progress";
      }
      const passTokensAfter = passTokensBefore - condenseResult.removedTokens + condenseResult.addedTokens;
      await this.persistCompactionEvents({
        conversationId,
        tokensBefore: passTokensBefore,
        tokensAfterLeaf: passTokensBefore,
        tokensAfterFinal: passTokensAfter,
        leafResult: null,
        condenseResult,
      });

      actionTaken = true;
      condensed = true;
      createdSummaryId = condenseResult.summaryId;
      level = condenseResult.level;
      runningTokens = passTokensAfter;

      if (stopAtTokens !== undefined && passTokensAfter <= stopAtTokens) {
        previousTokens = passTokensAfter;
        return "progress";
      }
      if (!force && passTokensAfter <= threshold) {
        previousTokens = passTokensAfter;
        return "progress";
      }
      if (passTokensAfter >= passTokensBefore || passTokensAfter >= previousTokens) {
        return "no-progress";
      }
      previousTokens = passTokensAfter;
      return "progress";
    };

    while (await hasCondensationPressure()) {
      if (sweepBudgetExhausted("condensed")) {
        break;
      }
      const status = await runCondensationPass({
        enforcePreferredDepth: true,
        useHardFanout: hardTrigger === true,
      });
      if (status !== "progress") {
        if (status === "no-progress") {
          stoppedForNoProgress = true;
        }
        break;
      }
      // Yield between the synchronous node:sqlite scans of consecutive passes.
      await yieldToEventLoop();
    }

    while (
      !hadAuthFailure &&
      !stoppedForNoProgress &&
      !stoppedAtBudget &&
      await hasCondensationPressure()
    ) {
      if (sweepBudgetExhausted("condensed")) {
        break;
      }
      const status = await runCondensationPass({
        enforcePreferredDepth: false,
        useHardFanout: true,
      });
      if (status !== "progress") {
        if (status === "no-progress") {
          stoppedForNoProgress = true;
        }
        break;
      }
      // Yield between the synchronous node:sqlite scans of consecutive passes.
      await yieldToEventLoop();
    }

    const tokensAfter = runningTokens;

    return {
      actionTaken,
      tokensBefore,
      tokensAfter,
      createdSummaryId,
      condensed,
      level,
      ...(hadAuthFailure ? { authFailure: true } : {}),
      ...(stoppedAtBudget ? { stoppedAtBudget: true } : {}),
    };
  }

  // ── compactUntilUnder ────────────────────────────────────────────────────

  /** Compact until under the requested target, running up to maxRounds. */
  async compactUntilUnder(input: {
    conversationId: number;
    tokenBudget: number;
    contextThreshold?: number;
    targetTokens?: number;
    currentTokens?: number;
    summarize: CompactionSummarizeFn;
    summaryModel?: string;
  }): Promise<{ success: boolean; rounds: number; finalTokens: number; authFailure?: boolean }> {
    return this.withContextCache(() => this._compactUntilUnderImpl(input));
  }

  private async _compactUntilUnderImpl(input: {
    conversationId: number;
    tokenBudget: number;
    contextThreshold?: number;
    targetTokens?: number;
    currentTokens?: number;
    summarize: CompactionSummarizeFn;
    summaryModel?: string;
  }): Promise<{ success: boolean; rounds: number; finalTokens: number; authFailure?: boolean }> {
    const { conversationId, tokenBudget, summarize } = input;
    const targetTokens =
      typeof input.targetTokens === "number" &&
      Number.isFinite(input.targetTokens) &&
      input.targetTokens > 0
        ? Math.floor(input.targetTokens)
        : tokenBudget;

    const storedTokens = await this.summaryStore.getContextTokenCount(conversationId);
    const liveTokens =
      typeof input.currentTokens === "number" &&
      Number.isFinite(input.currentTokens) &&
      input.currentTokens > 0
        ? Math.floor(input.currentTokens)
        : 0;
    let lastTokens = Math.max(storedTokens, liveTokens);

    // For forced overflow recovery, callers may pass an observed count that
    // equals the context budget. Treat equality as still needing a compaction
    // attempt so we can create headroom for provider-side framing overhead.
    if (lastTokens < targetTokens) {
      return { success: true, rounds: 0, finalTokens: lastTokens };
    }

    // Operation-wide wall-clock bound. Each round runs a compactFullSweep that
    // re-arms its own sweepDeadlineMs; without an operation-wide deadline the
    // worst case is maxRounds × sweepDeadlineMs (~20 min at the defaults). The
    // shared deadline is threaded into each sweep (so a sweep stops at
    // whichever is sooner) and checked here before starting the next round.
    const operationDeadlineMs = this.resolveCompactUntilUnderDeadlineMs();
    const operationStartedAt = Date.now();
    const operationDeadlineAt = operationStartedAt + operationDeadlineMs;

    for (let round = 1; round <= this.config.maxRounds; round++) {
      // Stop before starting another round once the operation budget is spent.
      // The in-flight round may overrun by at most one clamped sweep.
      if (round > 1 && Date.now() >= operationDeadlineAt) {
        this.log.warn(
          `[lcm] compactUntilUnder stopped at wall-clock deadline ` +
            `${operationDeadlineMs}ms: conversation=${conversationId} ` +
            `rounds=${round - 1} elapsedMs=${Date.now() - operationStartedAt} ` +
            `finalTokens=${lastTokens} targetTokens=${targetTokens} ` +
            `(returning partial result)`,
        );
        return {
          success: lastTokens <= targetTokens,
          rounds: round - 1,
          finalTokens: lastTokens,
        };
      }

      const result = await this.compact({
        conversationId,
        tokenBudget,
        contextThreshold: input.contextThreshold,
        summarize,
        force: true,
        summaryModel: input.summaryModel,
        operationDeadlineAt,
      });

      if (result.authFailure) {
        return {
          success: false,
          rounds: round,
          finalTokens: result.tokensAfter,
          authFailure: true,
        };
      }

      if (result.tokensAfter <= targetTokens) {
        return {
          success: true,
          rounds: round,
          finalTokens: result.tokensAfter,
        };
      }

      // No progress -- bail to avoid infinite loop
      if (!result.actionTaken || result.tokensAfter >= lastTokens) {
        return {
          success: false,
          rounds: round,
          finalTokens: result.tokensAfter,
        };
      }

      lastTokens = result.tokensAfter;
    }

    // Exhausted all rounds — use the last known token count from compact() result
    const finalTokens = lastTokens;
    return {
      success: finalTokens <= targetTokens,
      rounds: this.config.maxRounds,
      finalTokens,
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /** Normalize configured leaf chunk size to a safe positive integer. */
  private resolveLeafChunkTokens(leafChunkTokensOverride?: number): number {
    if (
      typeof leafChunkTokensOverride === "number" &&
      Number.isFinite(leafChunkTokensOverride) &&
      leafChunkTokensOverride > 0
    ) {
      return Math.floor(leafChunkTokensOverride);
    }
    if (
      typeof this.config.leafChunkTokens === "number" &&
      Number.isFinite(this.config.leafChunkTokens) &&
      this.config.leafChunkTokens > 0
    ) {
      return Math.floor(this.config.leafChunkTokens);
    }
    return DEFAULT_LEAF_CHUNK_TOKENS;
  }

  /** Normalize configured fresh tail count to a safe non-negative integer. */
  private resolveFreshTailCount(): number {
    if (
      typeof this.config.freshTailCount === "number" &&
      Number.isFinite(this.config.freshTailCount) &&
      this.config.freshTailCount > 0
    ) {
      return Math.floor(this.config.freshTailCount);
    }
    return 0;
  }

  /** Normalize configured fresh tail token cap to a safe non-negative integer. */
  private resolveFreshTailMaxTokens(): number | undefined {
    if (
      typeof this.config.freshTailMaxTokens === "number" &&
      Number.isFinite(this.config.freshTailMaxTokens) &&
      this.config.freshTailMaxTokens >= 0
    ) {
      return Math.floor(this.config.freshTailMaxTokens);
    }
    return undefined;
  }

  /**
   * Compute the ordinal boundary for protected fresh messages.
   *
   * Messages with ordinal >= returned value are preserved as fresh tail.
   */
  private async resolveFreshTailOrdinal(contextItems: ContextItemRecord[]): Promise<number> {
    const freshTailCount = this.resolveFreshTailCount();
    if (freshTailCount <= 0) {
      return Infinity;
    }
    const freshTailMaxTokens = this.resolveFreshTailMaxTokens();

    const rawMessageItems = contextItems.filter(
      (item) => item.itemType === "message" && item.messageId != null,
    );
    if (rawMessageItems.length === 0) {
      return Infinity;
    }

    let protectedCount = 0;
    let protectedTokens = 0;
    let tailStartOrdinal = Infinity;

    for (let idx = rawMessageItems.length - 1; idx >= 0; idx--) {
      if (protectedCount >= freshTailCount) {
        break;
      }

      const item = rawMessageItems[idx];
      if (!item || item.messageId == null) {
        continue;
      }

      const messageTokens = await this.getMessageTokenCount(item.messageId);
      const wouldExceedBudget =
        protectedCount > 0 &&
        typeof freshTailMaxTokens === "number" &&
        protectedTokens + messageTokens > freshTailMaxTokens;
      if (wouldExceedBudget) {
        break;
      }

      tailStartOrdinal = item.ordinal;
      protectedCount++;
      protectedTokens += messageTokens;
    }

    return tailStartOrdinal;
  }

  /** Resolve message token count with a content-length fallback. */
  private async getMessageTokenCount(messageId: number): Promise<number> {
    const message = await this.conversationStore.getMessageById(messageId);
    if (!message) {
      return 0;
    }
    if (
      typeof message.tokenCount === "number" &&
      Number.isFinite(message.tokenCount) &&
      message.tokenCount > 0
    ) {
      return message.tokenCount;
    }
    return estimateTokens(message.content);
  }

  /** Sum raw message tokens outside the protected fresh tail. */
  private async countRawTokensOutsideFreshTail(conversationId: number): Promise<number> {
    const contextItems = await this.getContextItemsCached(conversationId);
    const freshTailOrdinal = await this.resolveFreshTailOrdinal(contextItems);
    let rawTokens = 0;

    for (const item of contextItems) {
      if (item.ordinal >= freshTailOrdinal) {
        break;
      }
      if (item.itemType !== "message" || item.messageId == null) {
        continue;
      }
      rawTokens += await this.getMessageTokenCount(item.messageId);
    }

    return rawTokens;
  }

  /** Sum summary tokens outside the protected fresh tail. */
  private async countSummaryTokensOutsideFreshTail(conversationId: number): Promise<number> {
    const contextItems = await this.getContextItemsCached(conversationId);
    const freshTailOrdinal = await this.resolveFreshTailOrdinal(contextItems);
    let summaryTokens = 0;

    for (const item of contextItems) {
      if (item.ordinal >= freshTailOrdinal) {
        break;
      }
      if (item.itemType !== "summary" || item.summaryId == null) {
        continue;
      }
      const summary = await this.summaryStore.getSummary(item.summaryId);
      if (summary) {
        summaryTokens += this.resolveSummaryTokenCount(summary);
      }
    }

    return summaryTokens;
  }

  /**
   * Select the oldest contiguous raw-message chunk outside fresh tail.
   *
   * The selected chunk size is capped by `leafChunkTokens`, but we always pick
   * at least one message when any compactable message exists.
   */
  private async selectOldestLeafChunk(
    conversationId: number,
    leafChunkTokensOverride?: number,
  ): Promise<LeafChunkSelection> {
    const contextItems = await this.getContextItemsCached(conversationId);
    const freshTailOrdinal = await this.resolveFreshTailOrdinal(contextItems);
    const threshold = this.resolveLeafChunkTokens(leafChunkTokensOverride);

    let rawTokensOutsideTail = 0;
    for (const item of contextItems) {
      if (item.ordinal >= freshTailOrdinal) {
        break;
      }
      if (item.itemType !== "message" || item.messageId == null) {
        continue;
      }
      rawTokensOutsideTail += await this.getMessageTokenCount(item.messageId);
    }

    const chunk: ContextItemRecord[] = [];
    let chunkTokens = 0;
    let started = false;
    for (const item of contextItems) {
      if (item.ordinal >= freshTailOrdinal) {
        break;
      }

      if (!started) {
        if (item.itemType !== "message" || item.messageId == null) {
          continue;
        }
        started = true;
      } else if (item.itemType !== "message" || item.messageId == null) {
        break;
      }

      if (item.messageId == null) {
        continue;
      }
      const messageTokens = await this.getMessageTokenCount(item.messageId);
      if (chunk.length > 0 && chunkTokens + messageTokens > threshold) {
        break;
      }

      chunk.push(item);
      chunkTokens += messageTokens;
      if (chunkTokens >= threshold) {
        break;
      }
    }

    return { items: chunk, rawTokensOutsideTail, threshold };
  }

  /**
   * Resolve recent summary continuity for a leaf pass.
   *
   * Collects up to two most recent summary context items that precede the
   * compacted raw-message chunk and returns their combined content.
   */
  private async resolvePriorLeafSummaryContext(
    conversationId: number,
    messageItems: ContextItemRecord[],
  ): Promise<string | undefined> {
    if (messageItems.length === 0) {
      return undefined;
    }

    const startOrdinal = Math.min(...messageItems.map((item) => item.ordinal));
    const priorSummaryItems = (await this.getContextItemsCached(conversationId))
      .filter(
        (item) =>
          item.ordinal < startOrdinal &&
          item.itemType === "summary" &&
          typeof item.summaryId === "string",
      );

    if (priorSummaryItems.length === 0) {
      return undefined;
    }

    const summaryContents: string[] = [];
    for (const item of [...priorSummaryItems].reverse()) {
      if (typeof item.summaryId !== "string") {
        continue;
      }
      const summary = await this.summaryStore.getSummary(item.summaryId);
      const rawContent = typeof summary?.content === "string" ? summary.content : "";
      // Leaf continuity context is also summarizer input. Sanitize legacy
      // summary rows here so pre-#503 reasoning blocks cannot leak forward
      // when the next raw chunk is compacted.
      const sanitized = extractMeaningfulSummaryText(rawContent).trim();
      if (sanitized) {
        summaryContents.push(sanitized);
        if (summaryContents.length >= 2) {
          break;
        }
      }
    }

    if (summaryContents.length === 0) {
      return undefined;
    }

    return [...summaryContents].reverse().join("\n\n");
  }

  /** Resolve summary token count with content-length fallback. */
  private resolveSummaryTokenCount(summary: SummaryRecord): number {
    if (
      typeof summary.tokenCount === "number" &&
      Number.isFinite(summary.tokenCount) &&
      summary.tokenCount > 0
    ) {
      return summary.tokenCount;
    }
    return estimateTokens(summary.content);
  }

  private summaryHasMeaningfulCondensedSource(summary: SummaryRecord): boolean {
    return extractMeaningfulSummaryText(summary.content).trim().length > 0;
  }

  /** Resolve message token count with content-length fallback. */
  private resolveMessageTokenCount(message: { tokenCount: number; content: string }): number {
    if (
      typeof message.tokenCount === "number" &&
      Number.isFinite(message.tokenCount) &&
      message.tokenCount > 0
    ) {
      return message.tokenCount;
    }
    return estimateTokens(message.content);
  }

  private resolveLeafMinFanout(): number {
    if (
      typeof this.config.leafMinFanout === "number" &&
      Number.isFinite(this.config.leafMinFanout) &&
      this.config.leafMinFanout > 0
    ) {
      return Math.floor(this.config.leafMinFanout);
    }
    return 8;
  }

  private resolveCondensedMinFanout(): number {
    if (
      typeof this.config.condensedMinFanout === "number" &&
      Number.isFinite(this.config.condensedMinFanout) &&
      this.config.condensedMinFanout > 0
    ) {
      return Math.floor(this.config.condensedMinFanout);
    }
    return 4;
  }

  private resolveCondensedMinFanoutHard(): number {
    if (
      typeof this.config.condensedMinFanoutHard === "number" &&
      Number.isFinite(this.config.condensedMinFanoutHard) &&
      this.config.condensedMinFanoutHard > 0
    ) {
      return Math.floor(this.config.condensedMinFanoutHard);
    }
    return 2;
  }

  private resolveSweepMaxDepth(): number {
    const configured =
      typeof this.config.sweepMaxDepth === "number" && Number.isFinite(this.config.sweepMaxDepth)
        ? this.config.sweepMaxDepth
        : this.config.incrementalMaxDepth;
    if (
      typeof configured === "number" &&
      Number.isFinite(configured)
    ) {
      if (configured < 0) return Infinity;
      if (configured > 0) return Math.floor(configured);
    }
    return 0;
  }

  /** Resolve the hard per-pass iteration cap for a single full sweep. */
  private resolveMaxSweepIterations(): number {
    const configured = this.config.maxSweepIterations;
    if (typeof configured === "number" && Number.isFinite(configured) && configured >= 1) {
      return Math.floor(configured);
    }
    return DEFAULT_MAX_SWEEP_ITERATIONS;
  }

  /** Resolve the wall-clock budget (ms) for a single full sweep. */
  private resolveSweepDeadlineMs(): number {
    const configured = this.config.sweepDeadlineMs;
    if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
      return Math.floor(configured);
    }
    return DEFAULT_SWEEP_DEADLINE_MS;
  }

  /** Resolve the wall-clock budget (ms) for a whole compactUntilUnder run. */
  private resolveCompactUntilUnderDeadlineMs(): number {
    const configured = this.config.compactUntilUnderDeadlineMs;
    if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
      return Math.floor(configured);
    }
    return DEFAULT_COMPACT_UNTIL_UNDER_DEADLINE_MS;
  }

  /** Resolve the summarized-prefix pressure target for this token budget. */
  private resolveSummaryPrefixTargetTokens(tokenBudget: number, contextThresholdOverride?: number): number {
    if (
      typeof this.config.summaryPrefixTargetTokens === "number" &&
      Number.isFinite(this.config.summaryPrefixTargetTokens) &&
      this.config.summaryPrefixTargetTokens > 0
    ) {
      return Math.floor(this.config.summaryPrefixTargetTokens);
    }
    const threshold = Math.max(
      1,
      Math.floor(resolveContextThreshold(this.config, contextThresholdOverride) * tokenBudget),
    );
    const derivedTarget = Math.floor(threshold * 0.5);
    return Math.max(
      this.config.condensedTargetTokens,
      Math.min(this.resolveLeafChunkTokens(), derivedTarget),
    );
  }
  private resolveFanoutForDepth(targetDepth: number, hardTrigger: boolean): number {
    if (hardTrigger) {
      return this.resolveCondensedMinFanoutHard();
    }
    if (targetDepth === 0) {
      return this.resolveLeafMinFanout();
    }
    return this.resolveCondensedMinFanout();
  }

  /** Minimum condensed input size before we run another condensed pass. */
  private resolveCondensedMinChunkTokens(): number {
    const chunkTarget = this.resolveLeafChunkTokens();
    const ratioFloor = Math.floor(chunkTarget * CONDENSED_MIN_INPUT_RATIO);
    return Math.max(this.config.condensedTargetTokens, ratioFloor);
  }

  /**
   * Find the shallowest depth with an eligible same-depth summary chunk.
   */
  private async selectShallowestCondensationCandidate(params: {
    conversationId: number;
    hardTrigger: boolean;
  }): Promise<CondensedPhaseCandidate | null> {
    const { conversationId, hardTrigger } = params;
    const contextItems = await this.getContextItemsCached(conversationId);
    const freshTailOrdinal = await this.resolveFreshTailOrdinal(contextItems);
    const minChunkTokens = this.resolveCondensedMinChunkTokens();
    const depthLevels = await this.summaryStore.getDistinctDepthsInContext(conversationId, {
      maxOrdinalExclusive: freshTailOrdinal,
    });

    for (const targetDepth of depthLevels) {
      const fanout = this.resolveFanoutForDepth(targetDepth, hardTrigger);
      const chunk = await this.selectOldestChunkAtDepth(
        conversationId,
        targetDepth,
        freshTailOrdinal,
      );
      if (chunk.meaningfulCount < fanout) {
        continue;
      }
      if (chunk.summaryTokens < minChunkTokens) {
        continue;
      }
      return { targetDepth, chunk };
    }

    return null;
  }

  /**
   * Select the oldest contiguous summary chunk at a specific summary depth.
   *
   * Once selection starts, any non-summary item or depth mismatch terminates
   * the chunk to prevent mixed-depth condensation.
   */
  private async selectOldestChunkAtDepth(
    conversationId: number,
    targetDepth: number,
    freshTailOrdinalOverride?: number,
  ): Promise<CondensedChunkSelection> {
    const contextItems = await this.getContextItemsCached(conversationId);
    const freshTailOrdinal =
      typeof freshTailOrdinalOverride === "number"
        ? freshTailOrdinalOverride
        : await this.resolveFreshTailOrdinal(contextItems);
    const chunkTokenBudget = this.resolveLeafChunkTokens();

    const chunk: ContextItemRecord[] = [];
    let summaryTokens = 0;
    let meaningfulCount = 0;
    for (const item of contextItems) {
      if (item.ordinal >= freshTailOrdinal) {
        break;
      }
      if (item.itemType !== "summary" || item.summaryId == null) {
        if (chunk.length > 0) {
          break;
        }
        continue;
      }

      const summary = await this.summaryStore.getSummary(item.summaryId);
      if (!summary) {
        if (chunk.length > 0) {
          break;
        }
        continue;
      }
      if (summary.depth !== targetDepth) {
        if (chunk.length > 0) {
          break;
        }
        continue;
      }
      const hasMeaningfulSource = this.summaryHasMeaningfulCondensedSource(summary);
      if (!hasMeaningfulSource && chunk.length === 0) {
        continue;
      }
      const tokenCount = this.resolveSummaryTokenCount(summary);

      if (hasMeaningfulSource && chunk.length > 0 && summaryTokens + tokenCount > chunkTokenBudget) {
        break;
      }

      chunk.push(item);
      if (hasMeaningfulSource) {
        meaningfulCount++;
        summaryTokens += tokenCount;
      }
      if (summaryTokens >= chunkTokenBudget) {
        break;
      }
    }

    return { items: chunk, summaryTokens, meaningfulCount };
  }

  private async resolvePriorSummaryContextAtDepth(
    conversationId: number,
    summaryItems: ContextItemRecord[],
    targetDepth: number,
  ): Promise<string | undefined> {
    if (summaryItems.length === 0) {
      return undefined;
    }

    const startOrdinal = Math.min(...summaryItems.map((item) => item.ordinal));
    const priorSummaryItems = (await this.getContextItemsCached(conversationId))
      .filter(
        (item) =>
          item.ordinal < startOrdinal &&
          item.itemType === "summary" &&
          typeof item.summaryId === "string",
      );
    if (priorSummaryItems.length === 0) {
      return undefined;
    }

    const summaryContents: string[] = [];
    for (const item of [...priorSummaryItems].reverse()) {
      if (typeof item.summaryId !== "string") {
        continue;
      }
      const summary = await this.summaryStore.getSummary(item.summaryId);
      if (!summary || summary.depth !== targetDepth) {
        continue;
      }
      const rawContent = typeof summary.content === "string" ? summary.content : "";
      // Apply the same reasoning/thinking-block sanitizer used at the leaf
      // input (PR #503) so prior-summary context fed back into the summarizer
      // can never reintroduce raw thinking blocks at higher levels.  See #564.
      //
      // An empty `sanitized` is a deliberate signal: the stored summary was
      // structurally reasoning-only (or otherwise had no meaningful text).
      // Skip such summaries entirely — falling back to `rawContent` would
      // re-introduce the very thinking/reasoning payload this sanitizer is
      // trying to keep out of higher-level summarizer inputs.
      const sanitized = extractMeaningfulSummaryText(rawContent).trim();
      if (sanitized) {
        summaryContents.push(sanitized);
        if (summaryContents.length >= 2) {
          break;
        }
      }
    }

    if (summaryContents.length === 0) {
      return undefined;
    }
    return [...summaryContents].reverse().join("\n\n");
  }

  /**
   * Run three-level summarization escalation:
   * normal -> aggressive -> deterministic fallback.
   *
   * Provider-auth failures are treated as non-compacting skips so we do not
   * persist truncation artifacts into the summary DAG.
   */
  private async summarizeWithEscalation(params: {
    sourceText: string;
    summarize: CompactionSummarizeFn;
    options?: CompactionSummarizeOptions;
    /** Target token count for this summary kind (leaf or condensed). Used for hard-cap enforcement. */
    targetTokens: number;
  }): Promise<{ content: string; level: CompactionLevel } | null> {
    const sourceText = typeof params.sourceText === "string" ? params.sourceText.trim() : "";
    if (!sourceText) {
      return {
        content: "[Truncated from 0 tokens]",
        level: "fallback",
      };
    }
    const inputTokens = Math.max(1, estimateTokens(sourceText));
    const buildDeterministicFallback = (): { content: string; level: CompactionLevel } => {
      const truncationNote = `[Truncated from ${inputTokens} tokens]`;
      const directiveOmissionNote = [
        FALLBACK_DIRECTIVE_SUMMARY_MARKER,
        truncationNote,
      ].join("\n");
      const content = buildDeterministicFallbackSummary(sourceText, FALLBACK_MAX_TOKENS, {
        maxTokens: FALLBACK_MAX_TOKENS,
        truncationNote,
        directiveOmissionNote,
        alwaysAppendNote: true,
      });
      return {
        content,
        level: "fallback",
      };
    };
    const authFailure = Symbol("authFailure");

    const runSummarizer = async (
      aggressiveMode: boolean,
    ): Promise<string | null | typeof authFailure> => {
      let output: string;
      try {
        output = await params.summarize(sourceText, aggressiveMode, params.options);
      } catch (err) {
        if (err instanceof LcmProviderAuthError) {
          return authFailure;
        }
        throw err;
      }
      const trimmed = output.trim();
      return trimmed || null;
    };

    const initialSummary = await runSummarizer(false);
    if (initialSummary === authFailure) {
      return null;
    }
    if (initialSummary === null) {
      // Empty provider output should still compact deterministically so a
      // silent no-op does not stall compaction forever.
      return buildDeterministicFallback();
    }
    let summaryText = initialSummary;
    let level: CompactionLevel = "normal";

    if (estimateTokens(summaryText) >= inputTokens) {
      const aggressiveSummary = await runSummarizer(true);
      if (aggressiveSummary === authFailure) {
        return null;
      }
      if (aggressiveSummary === null) {
        return buildDeterministicFallback();
      }
      summaryText = aggressiveSummary;
      level = "aggressive";

      if (estimateTokens(summaryText) >= inputTokens) {
        return buildDeterministicFallback();
      }
    }

    // Hard cap: enforce maximum summary size relative to the kind-appropriate target.
    const summaryTokens = estimateTokens(summaryText);
    const maxTokens = Math.ceil(params.targetTokens * this.config.summaryMaxOverageFactor);

    if (summaryTokens > Math.ceil(params.targetTokens * 1.5)) {
      this.log.warn(
        `[lcm] summary exceeds target by ${Math.round((summaryTokens / params.targetTokens - 1) * 100)}%: ${summaryTokens} tokens vs target ${params.targetTokens}`,
      );
    }

    if (summaryTokens > maxTokens) {
      summaryText = capSummaryText(summaryText, summaryTokens, maxTokens);
      level = "capped";
    }

    return { content: summaryText, level };
  }

  // ── Private: Media Annotation ────────────────────────────────────────────

  /**
   * Annotate a message's content with media context when it has file/media
   * attachments. This gives the summarizer enough context to produce a
   * meaningful summary instead of trying to compress raw file paths.
   *
   * - Media-only messages: content is replaced with "[Media attachment]".
   * - Media-mostly messages: text is preserved and annotated with
   *   " [with media attachment]".
   * - Text-only messages: returned unchanged.
   */
  private async annotateMediaContent(
    messageId: number,
    content: string,
    preloadedParts?: MessagePartRecord[],
  ): Promise<string> {
    const parts = preloadedParts ?? (await this.conversationStore.getMessageParts(messageId));
    const hasMediaParts = parts.some((part) => isMediaAttachmentPart(part));
    if (!hasMediaParts) {
      return content;
    }

    const partText = parts
      .filter((part) => !isMediaAttachmentPart(part))
      .map((part) => (typeof part.textContent === "string" ? part.textContent : ""))
      .map((text) => stripEmbeddedMediaPayloads(text))
      .map((text) => text.trim())
      .filter(Boolean)
      .join("\n")
      .trim();
    const fallbackText = extractMeaningfulMessageText(content);
    const meaningfulText = (partText || fallbackText).trim();

    if (!meaningfulText) {
      return "[Media attachment]";
    }
    if (meaningfulText.includes("[with media attachment]")) {
      return meaningfulText;
    }
    return `${meaningfulText} [with media attachment]`;
  }

  /**
   * Reconstruct the text used by leaf summaries from stored message data.
   *
   * Plain `messages.content` is preferred when present, but structured tool
   * calls/results often store their actual payload in `message_parts` while the
   * fallback content column is empty. Rehydrating through the assembler helper
   * keeps compaction aligned with the prompt assembly path.
   */
  private async resolveLeafSummaryMessageContent(msg: MessageRecord): Promise<string> {
    const parts = await this.conversationStore.getMessageParts(msg.messageId);
    const annotatedContent = await this.annotateMediaContent(
      msg.messageId,
      msg.content,
      parts,
    );
    const storedText = extractMeaningfulMessageText(annotatedContent);
    if (storedText) {
      return storedText;
    }

    if (parts.length === 0) {
      return "";
    }

    const rehydrated = contentFromParts(
      parts.map((part) => ({ ...part })),
      runtimeRoleForSummary(msg.role),
      msg.content,
    );
    const rehydratedText = extractMeaningfulStructuredText(rehydrated);
    if (rehydratedText) {
      return rehydratedText;
    }

    return parts
      .map(extractMessagePartSummaryText)
      .map((text) => text.trim())
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }

  // ── Private: Leaf Pass ───────────────────────────────────────────────────

  /**
   * Summarize a chunk of messages into one leaf summary.
   */
  private async leafPass(
    conversationId: number,
    messageItems: ContextItemRecord[],
    summarize: CompactionSummarizeFn,
    previousSummaryContent?: string,
    summaryModel?: string,
  ): Promise<{ summaryId: string; level: CompactionLevel; content: string; removedTokens: number; addedTokens: number } | null> {
    // Fetch full message content for each context item
    const messageContents: { messageId: number; content: string; createdAt: Date; tokenCount: number }[] =
      [];
    for (const item of messageItems) {
      if (item.messageId == null) {
        continue;
      }
      const msg = await this.conversationStore.getMessageById(item.messageId);
      if (msg) {
        messageContents.push({
          messageId: msg.messageId,
          content: await this.resolveLeafSummaryMessageContent(msg),
          createdAt: msg.createdAt,
          tokenCount: this.resolveMessageTokenCount(msg),
        });
      }
    }

    const concatenated = messageContents
      .map((message) => {
        // Strip injected plugin context blocks (memory/hindsight XML tags) first,
        // then strip provider reasoning/thinking blocks so encrypted signatures and
        // non-visible metadata don't pollute the summary.
        const cleaned = stripInjectedContextBlocks(message.content, this.config.stripInjectedContextTags);
        const text = extractMeaningfulMessageText(cleaned);
        if (!text) return null;
        return `[${formatTimestamp(message.createdAt, this.config.timezone)}]\n${text}`;
      })
      .filter((s): s is string => s !== null)
      .join("\n\n");
    const fileIds = dedupeOrderedIds(
      messageContents.flatMap((message) => extractFileIdsFromContent(message.content)),
    );
    const summary = await this.summarizeWithEscalation({
      sourceText: concatenated,
      summarize,
      options: {
        previousSummary: previousSummaryContent,
        isCondensed: false,
      },
      targetTokens: this.config.leafTargetTokens,
    });
    if (!summary) {
      this.log.warn(
        `[lcm] leaf compaction skipped summary write; conversationId=${conversationId}; chunkMessages=${messageContents.length}`,
      );
      return null;
    }

    // Persist the leaf summary
    const summaryId = generateSummaryId(summary.content);
    const tokenCount = estimateTokens(summary.content);
    // Note: removedTokens uses resolveMessageTokenCount values (which fall back to
    // estimateTokens for messages with token_count <= 0). This can diverge from
    // getContextTokenCount() which would sum the stored 0. The delta feeds into
    // stopping decisions (threshold checks, progress guards), but the divergence
    // is bounded to empty/corrupt messages (token_count=0) which are rare.
    // For summaries, removedTokens matches the DB exactly (same tokenCount column).
    const removedTokens = messageContents.reduce(
      (sum, message) => sum + Math.max(0, Math.floor(message.tokenCount)),
      0,
    );

    await this.summaryStore.withTransaction(async () => {
      await this.summaryStore.insertSummary({
        summaryId,
        conversationId,
        kind: "leaf",
        depth: 0,
        content: summary.content,
        tokenCount,
        fileIds,
        earliestAt:
          messageContents.length > 0
            ? new Date(Math.min(...messageContents.map((message) => message.createdAt.getTime())))
            : undefined,
        latestAt:
          messageContents.length > 0
            ? new Date(Math.max(...messageContents.map((message) => message.createdAt.getTime())))
            : undefined,
        descendantCount: 0,
        descendantTokenCount: 0,
        sourceMessageTokenCount: removedTokens,
        model: summaryModel,
      });

      // Link to source messages before the context swap becomes visible.
      const messageIds = messageContents.map((m) => m.messageId);
      await this.summaryStore.linkSummaryToMessages(summaryId, messageIds);

      // Replace the message range in context with the new summary.
      const ordinals = messageItems.map((ci) => ci.ordinal);
      const startOrdinal = Math.min(...ordinals);
      const endOrdinal = Math.max(...ordinals);

      await this.summaryStore.replaceContextRangeWithSummary({
        conversationId,
        startOrdinal,
        endOrdinal,
        summaryId,
      });
    });
    this.invalidateContextCache(conversationId);

    return { summaryId, level: summary.level, content: summary.content, removedTokens, addedTokens: tokenCount };
  }

  // ── Private: Condensed Pass ──────────────────────────────────────────────

  /**
   * Condense one ratio-sized summary chunk into a single condensed summary.
   */
  private async condensedPass(
    conversationId: number,
    summaryItems: ContextItemRecord[],
    targetDepth: number,
    summarize: CompactionSummarizeFn,
    summaryModel?: string,
  ): Promise<CondensedPassResult | null> {
    // Fetch full summary records
    const summaryRecords: SummaryRecord[] = [];
    for (const item of summaryItems) {
      if (item.summaryId == null) {
        continue;
      }
      const rec = await this.summaryStore.getSummary(item.summaryId);
      if (rec) {
        summaryRecords.push(rec);
      }
    }

    // Sanitize stored summary content before re-summarizing.  Leaves persisted
    // before #503 (and any future leak from a reasoning-capable summaryModel)
    // may carry embedded thinking/reasoning blocks; strip them at every
    // summarizer boundary, not only at the leaf input.  See #564.
    //
    // An empty sanitized body is the deterministic signal that the stored
    // summary was thinking/reasoning-only (or otherwise had no meaningful
    // text).  Drop those records entirely — falling back to the raw stored
    // content would feed reasoning payloads right back into the condensed
    // summarizer input, undermining the boundary sanitizer.
    const concatenated = summaryRecords
      .map((summary) => {
        const earliestAt = summary.earliestAt ?? summary.createdAt;
        const latestAt = summary.latestAt ?? summary.createdAt;
        const tz = this.config.timezone;
        const header = `[${formatTimestamp(earliestAt, tz)} - ${formatTimestamp(latestAt, tz)}]`;
        const sanitized = extractMeaningfulSummaryText(summary.content).trim();
        return sanitized ? `${header}\n${sanitized}` : "";
      })
      .filter((entry) => entry.trim().length > 0)
      .join("\n\n");
    if (!concatenated.trim()) {
      this.log.warn(
        `[lcm] condensed compaction skipped summary write; conversationId=${conversationId}; depth=${targetDepth}; chunkSummaries=${summaryRecords.length}; sanitized_source=empty`,
      );
      return { skipped: "empty-source" };
    }
    const fileIds = dedupeOrderedIds(
      summaryRecords.flatMap((summary) => [
        ...summary.fileIds,
        ...extractFileIdsFromContent(summary.content),
      ]),
    );
    const previousSummaryContent =
      targetDepth === 0
        ? await this.resolvePriorSummaryContextAtDepth(conversationId, summaryItems, targetDepth)
        : undefined;
    const condensed = await this.summarizeWithEscalation({
      sourceText: concatenated,
      summarize,
      options: {
        previousSummary: previousSummaryContent,
        isCondensed: true,
        depth: targetDepth + 1,
      },
      targetTokens: this.config.condensedTargetTokens,
    });
    if (!condensed) {
      this.log.warn(
        `[lcm] condensed compaction skipped summary write; conversationId=${conversationId}; depth=${targetDepth}; chunkSummaries=${summaryRecords.length}`,
      );
      return null;
    }

    // Persist the condensed summary
    const summaryId = generateSummaryId(condensed.content);
    const tokenCount = estimateTokens(condensed.content);

    await this.summaryStore.withTransaction(async () => {
      await this.summaryStore.insertSummary({
        summaryId,
        conversationId,
        kind: "condensed",
        depth: targetDepth + 1,
        content: condensed.content,
        tokenCount,
        fileIds,
        earliestAt:
          summaryRecords.length > 0
            ? new Date(
                Math.min(
                  ...summaryRecords.map((summary) =>
                    (summary.earliestAt ?? summary.createdAt).getTime(),
                  ),
                ),
              )
            : undefined,
        latestAt:
          summaryRecords.length > 0
            ? new Date(
                Math.max(
                  ...summaryRecords.map(
                    (summary) => (summary.latestAt ?? summary.createdAt).getTime(),
                  ),
                ),
              )
            : undefined,
        descendantCount: summaryRecords.reduce((count, summary) => {
          const childDescendants =
            typeof summary.descendantCount === "number" && Number.isFinite(summary.descendantCount)
              ? Math.max(0, Math.floor(summary.descendantCount))
              : 0;
          return count + childDescendants + 1;
        }, 0),
        descendantTokenCount: summaryRecords.reduce((count, summary) => {
          const childDescendantTokens =
            typeof summary.descendantTokenCount === "number" &&
            Number.isFinite(summary.descendantTokenCount)
              ? Math.max(0, Math.floor(summary.descendantTokenCount))
              : 0;
          return count + Math.max(0, Math.floor(summary.tokenCount)) + childDescendantTokens;
        }, 0),
        sourceMessageTokenCount: summaryRecords.reduce((count, summary) => {
          const sourceTokens =
            typeof summary.sourceMessageTokenCount === "number" &&
            Number.isFinite(summary.sourceMessageTokenCount)
              ? Math.max(0, Math.floor(summary.sourceMessageTokenCount))
              : 0;
          return count + sourceTokens;
        }, 0),
        model: summaryModel,
      });

      // Link to parent summaries before the context swap becomes visible.
      const parentSummaryIds = summaryRecords.map((s) => s.summaryId);
      await this.summaryStore.linkSummaryToParents(summaryId, parentSummaryIds);

      // Replace all summary items in context with the condensed summary.
      const ordinals = summaryItems.map((ci) => ci.ordinal);
      const startOrdinal = Math.min(...ordinals);
      const endOrdinal = Math.max(...ordinals);

      await this.summaryStore.replaceContextRangeWithSummary({
        conversationId,
        startOrdinal,
        endOrdinal,
        summaryId,
      });
    });
    this.invalidateContextCache(conversationId);

    const removedTokens = summaryRecords.reduce(
      (sum, s) => sum + Math.max(0, Math.floor(s.tokenCount)),
      0,
    );
    return { summaryId, level: condensed.level, removedTokens, addedTokens: tokenCount };
  }

  /** Emit compaction telemetry without mutating canonical conversation history. */
  private async persistCompactionEvents(input: {
    conversationId: number;
    tokensBefore: number;
    tokensAfterLeaf: number;
    tokensAfterFinal: number;
    leafResult: { summaryId: string; level: CompactionLevel } | null;
    condenseResult: { summaryId: string; level: CompactionLevel } | null;
  }): Promise<void> {
    const {
      conversationId,
      tokensBefore,
      tokensAfterLeaf,
      tokensAfterFinal,
      leafResult,
      condenseResult,
    } = input;

    if (!leafResult && !condenseResult) {
      return;
    }

    const conversation = await this.conversationStore.getConversation(conversationId);
    if (!conversation) {
      return;
    }

    const createdSummaryIds = [leafResult?.summaryId, condenseResult?.summaryId].filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
    const condensedPassOccurred = condenseResult !== null;

    if (leafResult) {
      await this.persistCompactionEvent({
        conversationId,
        sessionId: conversation.sessionId,
        pass: "leaf",
        level: leafResult.level,
        tokensBefore,
        tokensAfter: tokensAfterLeaf,
        createdSummaryId: leafResult.summaryId,
        createdSummaryIds,
        condensedPassOccurred,
      });
    }

    if (condenseResult) {
      await this.persistCompactionEvent({
        conversationId,
        sessionId: conversation.sessionId,
        pass: "condensed",
        level: condenseResult.level,
        tokensBefore: tokensAfterLeaf,
        tokensAfter: tokensAfterFinal,
        createdSummaryId: condenseResult.summaryId,
        createdSummaryIds,
        condensedPassOccurred,
      });
    }
  }

  /** Log one compaction event without appending a synthetic chat message. */
  private async persistCompactionEvent(input: {
    conversationId: number;
    sessionId: string;
    pass: CompactionPass;
    level: CompactionLevel;
    tokensBefore: number;
    tokensAfter: number;
    createdSummaryId: string;
    createdSummaryIds: string[];
    condensedPassOccurred: boolean;
  }): Promise<void> {
    const content = `LCM compaction ${input.pass} pass (${input.level}): ${input.tokensBefore} -> ${input.tokensAfter}`;
    this.log.info(
      `[lcm] ${content} conversation=${input.conversationId} summary=${input.createdSummaryId}`,
    );
  }
}
