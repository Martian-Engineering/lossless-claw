import { createHash } from "node:crypto";
import type { ConversationStore, CreateMessagePartInput } from "./store/conversation-store.js";
import type { SummaryStore, SummaryRecord, ContextItemRecord } from "./store/summary-store.js";
import { estimateTokens, truncateTextToEstimatedTokens } from "./estimate-tokens.js";
import { extractFileIdsFromContent } from "./large-files.js";
import { NOOP_LCM_LOGGER, type LcmLogger } from "./lcm-log.js";
import { LcmProviderAuthError } from "./summarize.js";

// ── Public types ─────────────────────────────────────────────────────────────

export interface CompactionDecision {
  shouldCompact: boolean;
  reason: "threshold" | "manual" | "none";
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
}

export interface CompactionConfig {
  /** Context threshold as fraction of budget (default 0.75) */
  contextThreshold: number;
  /** Number of fresh tail turns to protect (default 8) */
  freshTailCount: number;
  /** Minimum number of depth-0 summaries needed for condensation. */
  leafMinFanout: number;
  /** Minimum number of depth>=1 summaries needed for condensation. */
  condensedMinFanout: number;
  /** Relaxed minimum fanout for hard-trigger sweeps. */
  condensedMinFanoutHard: number;
  /** Incremental depth passes to run after each leaf compaction (default 1). */
  incrementalMaxDepth: number;
  /** Max source tokens to compact per leaf/condensed chunk (default 20000) */
  leafChunkTokens?: number;
  /** Target tokens for leaf summaries (default 600) */
  leafTargetTokens: number;
  /** Target tokens for condensed summaries (default 900) */
  condensedTargetTokens: number;
  /** Maximum compaction rounds (default 10) */
  maxRounds: number;
  /** IANA timezone for timestamps in summaries (default: UTC) */
  timezone?: string;
  /** Maximum allowed overage factor for summaries relative to target tokens (default 3). */
  summaryMaxOverageFactor: number;
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
type LeafChunkSelection = {
  items: ContextItemRecord[];
  rawTokensOutsideTail: number;
  threshold: number;
};
type CondensedChunkSelection = {
  items: ContextItemRecord[];
  summaryTokens: number;
};
type CondensedPhaseCandidate = {
  targetDepth: number;
  chunk: CondensedChunkSelection;
};

// ── Helpers ──────────────────────────────────────────────────────────────────


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

/** Generate a deterministic summary ID from content + timestamp. */
function generateSummaryId(content: string): string {
  return (
    "sum_" +
    createHash("sha256")
      .update(content + Date.now().toString())
      .digest("hex")
      .slice(0, 16)
  );
}

/** Maximum estimated tokens for the deterministic fallback truncation. */
const FALLBACK_MAX_TOKENS = 512;
const DEFAULT_LEAF_CHUNK_TOKENS = 20_000;

/**
 * Pattern matching MEDIA:/... file path references that appear in message content
 * when the original message contained only a media attachment (image, file, etc.)
 * with no meaningful text.
 */
const MEDIA_PATH_RE = /^MEDIA:\/.+$/;
const EMBEDDED_DATA_URL_RE = /data:[^;\s"'`]+;base64,[A-Za-z0-9+/=\s]+/gi;
const MEDIA_ATTACHMENT_PART_TYPES = new Set(["file", "snapshot"]);
const MEDIA_ATTACHMENT_RAW_TYPES = new Set(["file", "image", "snapshot"]);
const STRUCTURED_MEDIA_TEXT_KEYS = ["text", "caption", "alt", "title", "summary"] as const;
const STRUCTURED_MEDIA_NESTED_KEYS = ["content", "parts", "items", "message", "messages"] as const;

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

/** Extract human-readable text from structured content while ignoring attachment payload fields. */
function extractSanitizedStructuredText(value: unknown, depth = 0): string[] {
  if (depth >= 4 || value == null) {
    return [];
  }
  if (typeof value === "string") {
    const sanitized = stripEmbeddedMediaPayloads(value);
    return sanitized ? [sanitized] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractSanitizedStructuredText(entry, depth + 1));
  }
  if (typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  const rawType = typeof record.type === "string" ? record.type.trim().toLowerCase() : "";
  const textFragments: string[] = [];

  for (const key of STRUCTURED_MEDIA_TEXT_KEYS) {
    const candidate = record[key];
    if (typeof candidate !== "string") {
      continue;
    }
    const sanitized = stripEmbeddedMediaPayloads(candidate);
    if (sanitized) {
      textFragments.push(sanitized);
    }
  }

  if (MEDIA_ATTACHMENT_RAW_TYPES.has(rawType)) {
    return textFragments;
  }

  for (const key of STRUCTURED_MEDIA_NESTED_KEYS) {
    textFragments.push(...extractSanitizedStructuredText(record[key], depth + 1));
  }

  return textFragments;
}

/** Normalize message content down to human-readable text, excluding binary/media payloads. */
function extractMeaningfulMessageText(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return "";
  }
  if ((trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("{") && trimmed.endsWith("}"))) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const extracted = extractSanitizedStructuredText(parsed)
        .map((fragment) => fragment.trim())
        .filter(Boolean);
      return extracted.join("\n").trim();
    } catch {
      // Fall back to plain-text sanitation below.
    }
  }
  return stripEmbeddedMediaPayloads(content);
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
  ): Promise<CompactionDecision> {
    const storedTokens = await this.summaryStore.getContextTokenCount(conversationId);
    const liveTokens =
      typeof observedTokenCount === "number" &&
      Number.isFinite(observedTokenCount) &&
      observedTokenCount > 0
        ? Math.floor(observedTokenCount)
        : 0;
    const currentTokens = Math.max(storedTokens, liveTokens);
    const threshold = Math.floor(this.config.contextThreshold * tokenBudget);

    if (currentTokens > threshold) {
      return {
        shouldCompact: true,
        reason: "threshold",
        currentTokens,
        threshold,
      };
    }

    return {
      shouldCompact: false,
      reason: "none",
      currentTokens,
      threshold,
    };
  }

  /**
   * Evaluate whether the raw-message leaf trigger is active.
   *
   * Counts message tokens outside the protected fresh tail and compares against
   * `leafChunkTokens`. This lets callers trigger a soft incremental leaf pass
   * before the full context threshold is breached.
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
    /** LLM call function for summarization */
    summarize: CompactionSummarizeFn;
    force?: boolean;
    hardTrigger?: boolean;
    summaryModel?: string;
  }): Promise<CompactionResult> {
    return this.withContextCache(() => this.compactFullSweep(input));
  }

  /**
   * Run a single leaf pass against the oldest compactable raw chunk.
   *
   * This is the soft-trigger path used for incremental maintenance.
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
    summarize: CompactionSummarizeFn;
    leafChunkTokens?: number;
    force?: boolean;
    previousSummaryContent?: string;
    summaryModel?: string;
  }): Promise<CompactionResult> {
    const { conversationId, tokenBudget, summarize, force } = input;

    const tokensBefore = await this.summaryStore.getContextTokenCount(conversationId);
    const threshold = Math.floor(this.config.contextThreshold * tokenBudget);
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

    const incrementalMaxDepth = this.resolveIncrementalMaxDepth();
    const condensedMinChunkTokens = this.resolveCondensedMinChunkTokens();
    let runningTokens = tokensAfterLeaf;
    if (incrementalMaxDepth > 0 && input.allowCondensedPasses !== false) {
      for (let targetDepth = 0; targetDepth < incrementalMaxDepth; targetDepth++) {
        const fanout = this.resolveFanoutForDepth(targetDepth, false);
        const chunk = await this.selectOldestChunkAtDepth(conversationId, targetDepth);
        if (chunk.items.length < fanout || chunk.summaryTokens < condensedMinChunkTokens) {
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
        if (!condenseResult) {
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
   * Run a hard-trigger sweep:
   *
   * Phase 1: repeatedly compact raw-message chunks outside the fresh tail.
   * Phase 2: repeatedly condense oldest summary chunks while chunk utilization
   *          remains high enough to be worthwhile.
   */
  async compactFullSweep(input: {
    conversationId: number;
    tokenBudget: number;
    summarize: CompactionSummarizeFn;
    force?: boolean;
    hardTrigger?: boolean;
    summaryModel?: string;
  }): Promise<CompactionResult> {
    const { conversationId, tokenBudget, summarize, force, hardTrigger } = input;

    const tokensBefore = await this.summaryStore.getContextTokenCount(conversationId);
    const threshold = Math.floor(this.config.contextThreshold * tokenBudget);
    const leafTrigger = await this.evaluateLeafTrigger(conversationId);

    if (!force && tokensBefore <= threshold && !leafTrigger.shouldCompact) {
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

    // Phase 1: leaf passes over oldest raw chunks outside the protected tail.
    // Delta tracking: maintain a running token count instead of re-querying DB
    // after each pass. The arithmetic is exact: tokensAfter = tokensBefore - removed + added.
    let runningTokens = tokensBefore;
    while (true) {
      const leafChunk = await this.selectOldestLeafChunk(conversationId);
      if (leafChunk.items.length === 0) {
        break;
      }

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

      if (!force && passTokensAfter <= threshold) {
        previousTokens = passTokensAfter;
        break;
      }
      if (passTokensAfter >= passTokensBefore || passTokensAfter >= previousTokens) {
        break;
      }
      previousTokens = passTokensAfter;
    }

    // Phase 2: depth-aware condensed passes, always processing shallowest depth first.
    while (force || previousTokens > threshold) {
      const candidate = await this.selectShallowestCondensationCandidate({
        conversationId,
        hardTrigger: hardTrigger === true,
      });
      if (!candidate) {
        break;
      }

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

      actionTaken = true;
      condensed = true;
      createdSummaryId = condenseResult.summaryId;
      level = condenseResult.level;
      runningTokens = passTokensAfter;

      if (!force && passTokensAfter <= threshold) {
        previousTokens = passTokensAfter;
        break;
      }
      if (passTokensAfter >= passTokensBefore || passTokensAfter >= previousTokens) {
        break;
      }
      previousTokens = passTokensAfter;
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
    };
  }

  // ── compactUntilUnder ────────────────────────────────────────────────────

  /** Compact until under the requested target, running up to maxRounds. */
  async compactUntilUnder(input: {
    conversationId: number;
    tokenBudget: number;
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

    for (let round = 1; round <= this.config.maxRounds; round++) {
      const result = await this.compact({
        conversationId,
        tokenBudget,
        summarize,
        force: true,
        summaryModel: input.summaryModel,
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

  /**
   * Compute the ordinal boundary for protected fresh messages.
   *
   * Messages with ordinal >= returned value are preserved as fresh tail.
   */
  private resolveFreshTailOrdinal(contextItems: ContextItemRecord[]): number {
    const freshTailCount = this.resolveFreshTailCount();
    if (freshTailCount <= 0) {
      return Infinity;
    }

    const rawMessageItems = contextItems.filter(
      (item) => item.itemType === "message" && item.messageId != null,
    );
    if (rawMessageItems.length === 0) {
      return Infinity;
    }

    const tailStartIdx = Math.max(0, rawMessageItems.length - freshTailCount);
    return rawMessageItems[tailStartIdx]?.ordinal ?? Infinity;
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
    const freshTailOrdinal = this.resolveFreshTailOrdinal(contextItems);
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
    const freshTailOrdinal = this.resolveFreshTailOrdinal(contextItems);
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
      )
      .slice(-2);

    if (priorSummaryItems.length === 0) {
      return undefined;
    }

    const summaryContents: string[] = [];
    for (const item of priorSummaryItems) {
      if (typeof item.summaryId !== "string") {
        continue;
      }
      const summary = await this.summaryStore.getSummary(item.summaryId);
      const content = summary?.content.trim();
      if (content) {
        summaryContents.push(content);
      }
    }

    if (summaryContents.length === 0) {
      return undefined;
    }

    return summaryContents.join("\n\n");
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

  private resolveIncrementalMaxDepth(): number {
    if (
      typeof this.config.incrementalMaxDepth === "number" &&
      Number.isFinite(this.config.incrementalMaxDepth)
    ) {
      if (this.config.incrementalMaxDepth < 0) return Infinity;
      if (this.config.incrementalMaxDepth > 0) return Math.floor(this.config.incrementalMaxDepth);
    }
    return 0;
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
    const freshTailOrdinal = this.resolveFreshTailOrdinal(contextItems);
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
      if (chunk.items.length < fanout) {
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
        : this.resolveFreshTailOrdinal(contextItems);
    const chunkTokenBudget = this.resolveLeafChunkTokens();

    const chunk: ContextItemRecord[] = [];
    let summaryTokens = 0;
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
      const tokenCount = this.resolveSummaryTokenCount(summary);

      if (chunk.length > 0 && summaryTokens + tokenCount > chunkTokenBudget) {
        break;
      }

      chunk.push(item);
      summaryTokens += tokenCount;
      if (summaryTokens >= chunkTokenBudget) {
        break;
      }
    }

    return { items: chunk, summaryTokens };
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
      )
      .slice(-4);
    if (priorSummaryItems.length === 0) {
      return undefined;
    }

    const summaryContents: string[] = [];
    for (const item of priorSummaryItems) {
      if (typeof item.summaryId !== "string") {
        continue;
      }
      const summary = await this.summaryStore.getSummary(item.summaryId);
      if (!summary || summary.depth !== targetDepth) {
        continue;
      }
      const content = summary.content.trim();
      if (content) {
        summaryContents.push(content);
      }
    }

    if (summaryContents.length === 0) {
      return undefined;
    }
    return summaryContents.slice(-2).join("\n\n");
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
    const sourceText = params.sourceText.trim();
    if (!sourceText) {
      return {
        content: "[Truncated from 0 tokens]",
        level: "fallback",
      };
    }
    const inputTokens = Math.max(1, estimateTokens(sourceText));
    const buildDeterministicFallback = (): { content: string; level: CompactionLevel } => {
      const suffix = `\n[Truncated from ${inputTokens} tokens]`;
      const truncated = truncateTextToEstimatedTokens(
        sourceText,
        Math.max(0, FALLBACK_MAX_TOKENS - estimateTokens(suffix)),
      );
      return {
        content: `${truncated}${suffix}`,
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
  ): Promise<string> {
    const parts = await this.conversationStore.getMessageParts(messageId);
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
        const annotatedContent = await this.annotateMediaContent(
          msg.messageId,
          msg.content,
        );
        messageContents.push({
          messageId: msg.messageId,
          content: annotatedContent,
          createdAt: msg.createdAt,
          tokenCount: this.resolveMessageTokenCount(msg),
        });
      }
    }

    const concatenated = messageContents
      .map((message) => `[${formatTimestamp(message.createdAt, this.config.timezone)}]\n${message.content}`)
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
  ): Promise<PassResult | null> {
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

    const concatenated = summaryRecords
      .map((summary) => {
        const earliestAt = summary.earliestAt ?? summary.createdAt;
        const latestAt = summary.latestAt ?? summary.createdAt;
        const tz = this.config.timezone;
        const header = `[${formatTimestamp(earliestAt, tz)} - ${formatTimestamp(latestAt, tz)}]`;
        return `${header}\n${summary.content}`;
      })
      .join("\n\n");
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
