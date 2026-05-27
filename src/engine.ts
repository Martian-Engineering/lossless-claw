import { createHash, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
  ContextEngine,
  ContextEngineInfo,
  ContextEngineHostCapability,
  ContextEngineRuntimeContext,
  AssembleResult,
  BootstrapResult,
  CompactResult,
  IngestBatchResult,
  IngestResult,
  SubagentEndReason,
  SubagentSpawnPreparation,
} from "./openclaw-bridge.js";
import {
  blockFromPart,
  contentFromParts,
  ContextAssembler,
  pickToolCallId,
  pickToolIsError,
  pickToolName,
  type AssemblyOverflowDiagnostics,
} from "./assembler.js";
import { CompactionEngine, type CompactionConfig } from "./compaction.js";
import type { LcmConfig } from "./db/config.js";
import { getLcmDbFeatures } from "./db/features.js";
import { runLcmMigrations } from "./db/migration.js";
import {
  createDelegatedExpansionGrant,
  getRuntimeExpansionAuthManager,
  removeDelegatedExpansionGrantForSession,
  resolveDelegatedExpansionGrantId,
  revokeDelegatedExpansionGrantForSession,
} from "./expansion-auth.js";
import {
  extensionFromNameOrMime,
  formatFileReference,
  formatRawPayloadReference,
  formatToolOutputReference,
  generateExplorationSummary,
  parseFileBlocks,
} from "./large-files.js";
import { describeLogError } from "./lcm-log.js";
import { describeLcmConfigSource } from "./db/config.js";
import { RetrievalEngine } from "./retrieval.js";
import { compileSessionPatterns, matchesSessionPattern } from "./session-patterns.js";
import { logStartupBannerOnce } from "./startup-banner-log.js";
import {
  CompactionTelemetryStore,
  type ConversationCompactionTelemetryRecord,
  type CacheState,
} from "./store/compaction-telemetry-store.js";
import {
  CompactionMaintenanceStore,
} from "./store/compaction-maintenance-store.js";
import {
  ConversationStore,
  type ConversationRecord,
  type CreateMessagePartInput,
  type MessagePartRecord,
  type MessagePartType,
} from "./store/conversation-store.js";
import { FocusBriefStore, type FocusBriefRecord } from "./store/focus-brief-store.js";
import { SummaryStore, type ContextItemRecord } from "./store/summary-store.js";
import { createLcmSummarizeFromLegacyParams, LcmProviderAuthError } from "./summarize.js";
import type { LcmDependencies } from "./types.js";
import { estimateTokens } from "./estimate-tokens.js";
import { sanitizeToolUseResultPairing } from "./transcript-repair.js";

type AgentMessage = Parameters<ContextEngine["ingest"]>[0]["message"];

const LOSSLESS_AGENT_RUN_REQUIRED_HOST_CAPABILITIES: ContextEngineHostCapability[] = [
  "bootstrap",
  "assemble-before-prompt",
  "after-turn",
  "maintain",
  "compact",
  "runtime-llm-complete",
];
type AssemblePrefixSnapshot = {
  serializedMessages: string[];
  messageSummaries: string[];
  fullHash: string;
};

type BootstrapImportObservation = {
  importedMessages: number;
  reason: string | null;
  observedAt: Date;
};

const MAX_PREVIOUS_ASSEMBLED_SNAPSHOTS = 100;
const CONTEXT_ENGINE_PROJECTION_EPOCH_VERSION = "summary-prefix-v1";
type CircuitBreakerState = {
  failures: number;
  openSince: number | null;
};
type PromptCacheSnapshot = {
  lastObservedCacheRead?: number;
  lastObservedCacheWrite?: number;
  lastObservedPromptTokenCount?: number;
  cacheState: CacheState;
  retention?: string;
  sawExplicitBreak: boolean;
  lastCacheTouchAt?: Date;
  provider?: string;
  model?: string;
};
type ContextEngineMaintenanceResult = {
  changed: boolean;
  bytesFreed: number;
  rewrittenEntries: number;
  reason?: string;
};
type CompactionExecutionParams = {
  conversationId: number;
  sessionId: string;
  sessionKey?: string;
  tokenBudget?: number;
  currentTokenCount?: number;
  compactionTarget?: "budget" | "threshold";
  customInstructions?: string;
  /** OpenClaw runtime param name (preferred). */
  runtimeContext?: Record<string, unknown>;
  /** Back-compat param name. */
  legacyParams?: Record<string, unknown>;
  /** Force compaction even if below threshold */
  force?: boolean;
};
type ContextEngineMaintenanceRuntimeContext = Record<string, unknown> & {
  allowDeferredCompactionExecution?: boolean;
};
type DeferredCompactionDebtDrainParams = {
  conversationId: number;
  sessionId: string;
  sessionKey?: string;
  tokenBudget: number;
  currentTokenCount?: number;
  reason: string;
};

function buildContextEngineProjectionEpoch(
  conversationId: number,
  contextItems: ContextItemRecord[],
  activeFocusBrief?: FocusBriefRecord | null,
): string {
  const hash = createHash("sha256");
  hash.update(CONTEXT_ENGINE_PROJECTION_EPOCH_VERSION);
  hash.update("\0");
  hash.update(String(conversationId));

  // Only summaries are part of the projection epoch. Raw tail growth is already
  // visible to a live Codex backend thread, while summary changes represent a
  // new compacted semantic prefix that must be bootstrapped into a fresh thread.
  for (const item of contextItems) {
    if (item.itemType !== "summary" || !item.summaryId) {
      continue;
    }
    hash.update("\0");
    hash.update(String(item.ordinal));
    hash.update(":");
    hash.update(item.summaryId);
  }
  const focusProjectionKey = buildFocusProjectionKey(activeFocusBrief);
  if (focusProjectionKey) {
    hash.update("\0focus:");
    hash.update(focusProjectionKey);
  }

  return [
    CONTEXT_ENGINE_PROJECTION_EPOCH_VERSION,
    conversationId,
    hash.digest("hex").slice(0, 32),
  ].join(":");
}

function buildFocusProjectionKey(brief?: FocusBriefRecord | null): string | null {
  if (!brief) {
    return null;
  }
  const hash = createHash("sha256");
  hash.update(brief.briefId);
  hash.update("\0");
  hash.update(brief.updatedAt.toISOString());
  hash.update("\0");
  hash.update(brief.prompt);
  hash.update("\0");
  hash.update(brief.content);
  return hash.digest("hex").slice(0, 32);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  return typeof encoded === "string" ? encoded : "";
}

function hashSerializedMessages(messages: string[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex").slice(0, 16);
}

function normalizeDebugTextSnippet(value: string, maxLength: number = 48): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, Math.max(0, maxLength - 3))}...`;
}

function summarizeMessageContentShape(content: unknown): string {
  if (Array.isArray(content)) {
    const blockTypes = content
      .map((item) => {
        const record = asRecord(item);
        if (record) {
          return safeString(record.type) ?? "object";
        }
        return typeof item;
      })
      .slice(0, 4);
    const typeSummary = blockTypes.length > 0 ? blockTypes.join(",") : "empty";
    return `blocks=${content.length}:${typeSummary}`;
  }
  if (typeof content === "string") {
    return "content=text";
  }
  if (content == null) {
    return "content=empty";
  }
  if (typeof content === "object") {
    return "content=object";
  }
  return `content=${typeof content}`;
}

function summarizeMessageForPrefixDebug(message: AgentMessage): string {
  const serialized = JSON.stringify(message);
  const topLevel = message as Record<string, unknown>;
  const role = safeString(topLevel.role) ?? "unknown";
  const summaryParts = [role, summarizeMessageContentShape(topLevel.content)];
  const toolCallId = extractTranscriptToolCallId(message);
  if (toolCallId) {
    summaryParts.push(`tool=${toolCallId}`);
  }
  const toolName =
    safeString(topLevel.toolName) ??
    safeString(topLevel.tool_name) ??
    (Array.isArray(topLevel.content)
      ? topLevel.content
          .map((item) => asRecord(item))
          .map((record) => safeString(record?.name))
          .find((name) => typeof name === "string")
      : undefined);
  if (toolName) {
    summaryParts.push(`name=${toolName}`);
  }
  const text = extractStructuredText(topLevel.content);
  if (typeof text === "string" && text.trim().length > 0) {
    summaryParts.push(`text=${toJson(normalizeDebugTextSnippet(text))}`);
  }
  summaryParts.push(
    `hash=${createHash("sha256").update(serialized).digest("hex").slice(0, 8)}`,
  );
  return summaryParts.join("|");
}

function describeAssembledPrefixChange(
  previous: AssemblePrefixSnapshot | undefined,
  messages: AgentMessage[],
): {
  currentSnapshot: AssemblePrefixSnapshot;
  previousCount: number;
  commonPrefixCount: number;
  commonPrefixHash: string;
  previousWasPrefix: boolean;
  firstDivergenceIndex: number;
  previousDivergenceMessage: string;
  currentDivergenceMessage: string;
} {
  const serializedMessages = messages.map((message) => JSON.stringify(message));
  const messageSummaries = messages.map((message) => summarizeMessageForPrefixDebug(message));
  const currentSnapshot = {
    serializedMessages,
    messageSummaries,
    fullHash: hashSerializedMessages(serializedMessages),
  };

  if (!previous) {
    return {
      currentSnapshot,
      previousCount: 0,
      commonPrefixCount: 0,
      commonPrefixHash: hashSerializedMessages([]),
      previousWasPrefix: true,
      firstDivergenceIndex: -1,
      previousDivergenceMessage: "none",
      currentDivergenceMessage: "none",
    };
  }

  const limit = Math.min(previous.serializedMessages.length, serializedMessages.length);
  let commonPrefixCount = 0;
  while (
    commonPrefixCount < limit &&
    previous.serializedMessages[commonPrefixCount] === serializedMessages[commonPrefixCount]
  ) {
    commonPrefixCount++;
  }

  const previousWasPrefix = commonPrefixCount === previous.serializedMessages.length;
  return {
    currentSnapshot,
    previousCount: previous.serializedMessages.length,
    commonPrefixCount,
    commonPrefixHash: hashSerializedMessages(serializedMessages.slice(0, commonPrefixCount)),
    previousWasPrefix,
    firstDivergenceIndex: previousWasPrefix ? -1 : commonPrefixCount,
    previousDivergenceMessage: previousWasPrefix
      ? "none"
      : (previous.messageSummaries[commonPrefixCount] ?? "(end)"),
    currentDivergenceMessage: previousWasPrefix
      ? "none"
      : (currentSnapshot.messageSummaries[commonPrefixCount] ?? "(end)"),
  };
}

function shouldLogOverflowDiagnostics(params: {
  diagnostics: AssemblyOverflowDiagnostics;
  assembledTokens: number;
  liveContextTokens: number;
}): boolean {
  const budget = Math.max(1, params.diagnostics.tokenBudget);
  return (
    params.diagnostics.totalContextTokens > budget ||
    params.assembledTokens >= Math.floor(budget * 0.9) ||
    params.liveContextTokens >= Math.floor(budget * 0.9) ||
    params.diagnostics.duplicateRefClusters.length > 0 ||
    params.diagnostics.duplicateMessageClusters.length > 0
  );
}

function formatOverflowDiagnosticsForLog(params: {
  diagnostics: AssemblyOverflowDiagnostics;
  recentBootstrapImport?: BootstrapImportObservation;
}): string {
  const recent = params.recentBootstrapImport;
  return JSON.stringify({
    ...params.diagnostics,
    recentBootstrapImportCount: recent?.importedMessages ?? null,
    recentBootstrapImportReason: recent?.reason ?? null,
  });
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function extractRawIdsFromPartMetadata(metadata: string | null | undefined): string[] {
  if (!metadata) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return [];
  }

  const raw = asRecord(asRecord(parsed)?.raw);
  if (!raw) {
    return [];
  }

  return [
    safeString(raw.id),
    safeString(raw.call_id),
    safeString(raw.toolCallId),
    safeString(raw.tool_call_id),
    safeString(raw.toolUseId),
    safeString(raw.tool_use_id),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

function formatDurationMs(durationMs: number): string {
  return `${durationMs}ms`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function extractTranscriptToolCallId(message: AgentMessage): string | undefined {
  const topLevel = message as Record<string, unknown>;
  const direct =
    safeString(topLevel.toolCallId) ??
    safeString(topLevel.tool_call_id) ??
    safeString(topLevel.toolUseId) ??
    safeString(topLevel.tool_use_id) ??
    safeString(topLevel.call_id) ??
    safeString(topLevel.id);
  if (direct) {
    return direct;
  }

  if (!Array.isArray(topLevel.content)) {
    return undefined;
  }

  for (const item of topLevel.content) {
    const record = asRecord(item);
    if (!record) {
      continue;
    }
    const nested =
      safeString(record.toolCallId) ??
      safeString(record.tool_call_id) ??
      safeString(record.toolUseId) ??
      safeString(record.tool_use_id) ??
      safeString(record.call_id) ??
      safeString(record.id);
    if (nested) {
      return nested;
    }
  }

  return undefined;
}

function appendTextValue(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      appendTextValue(entry, out);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }

  const record = value as Record<string, unknown>;
  appendTextValue(record.text, out);
  appendTextValue(record.value, out);
}

const STRUCTURED_TEXT_FIELD_KEYS = ["text", "transcript", "transcription", "message", "summary"];
const STRUCTURED_ARRAY_FIELD_KEYS = [
  "segments",
  "utterances",
  "paragraphs",
  "alternatives",
  "words",
  "items",
  "results",
];
const STRUCTURED_NESTED_FIELD_KEYS = ["content", "output", "result", "payload", "data", "value"];
const MAX_STRUCTURED_TEXT_DEPTH = 6;
const TOOL_CALL_RAW_TYPES: ReadonlySet<string> = new Set([
  "tool_use",
  "toolUse",
  "tool-use",
  "toolCall",
  "tool_call",
  "functionCall",
  "function_call",
]);
const TOOL_RESULT_RAW_TYPES: ReadonlySet<string> = new Set([
  "function_call_output",
  "tool_result",
  "toolResult",
  "tool_use_result",
]);
const TOOL_RAW_TYPES: ReadonlySet<string> = new Set([
  ...TOOL_CALL_RAW_TYPES,
  ...TOOL_RESULT_RAW_TYPES,
]);
const REPLAY_CRITICAL_RAW_TYPES: ReadonlySet<string> = new Set([
  ...TOOL_RAW_TYPES,
  "thinking",
  "reasoning",
]);
const RAW_PAYLOAD_EXTERNALIZATION_REASON = "large_raw_message";

function looksLikeJsonPayload(value: string): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}

function extractStructuredText(value: unknown, depth: number = 0): string | undefined {
  if (value == null || depth > MAX_STRUCTURED_TEXT_DEPTH) {
    return undefined;
  }
  if (typeof value === "string") {
    if (looksLikeJsonPayload(value)) {
      try {
        const parsed = JSON.parse(value.trim());
        const parsedText = extractStructuredText(parsed, depth + 1);
        if (typeof parsedText === "string" && parsedText.length > 0) {
          return parsedText;
        }
      } catch {
        // Fall through to returning the original string when parsing fails.
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    const texts: string[] = [];
    for (const entry of value) {
      const text = extractStructuredText(entry, depth + 1);
      if (typeof text === "string" && text.trim().length > 0) {
        texts.push(text);
      }
    }
    return texts.length > 0 ? texts.join("\n") : undefined;
  }
  if (typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  // Skip tool call/result objects — their structured data belongs in the parts table, not content
  if (typeof record.type === "string" && TOOL_RAW_TYPES.has(record.type)) {
    if (safeBoolean(record.toolOutputExternalized)) {
      const externalizedText =
        extractStructuredText(record.output, depth + 1) ??
        extractStructuredText(record.content, depth + 1) ??
        extractStructuredText(record.result, depth + 1);
      if (typeof externalizedText === "string" && externalizedText.trim().length > 0) {
        return externalizedText;
      }
    }
    return undefined;
  }

  for (const key of STRUCTURED_TEXT_FIELD_KEYS) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }

  for (const key of STRUCTURED_ARRAY_FIELD_KEYS) {
    const candidate = record[key];
    if (Array.isArray(candidate)) {
      const texts: string[] = [];
      for (const entry of candidate) {
        const text = extractStructuredText(entry, depth + 1);
        if (typeof text === "string" && text.trim().length > 0) {
          texts.push(text);
        }
      }
      if (texts.length > 0) {
        return texts.join("\n");
      }
    }
  }

  for (const key of STRUCTURED_NESTED_FIELD_KEYS) {
    const nested = record[key];
    const nestedText = extractStructuredText(nested, depth + 1);
    if (typeof nestedText === "string" && nestedText.trim().length > 0) {
      return nestedText;
    }
  }

  return undefined;
}

function extractReasoningText(record: Record<string, unknown>): string | undefined {
  const chunks: string[] = [];
  appendTextValue(record.summary, chunks);
  if (chunks.length === 0) {
    return undefined;
  }

  const normalized = chunks
    .map((chunk) => chunk.trim())
    .filter((chunk, idx, arr) => chunk.length > 0 && arr.indexOf(chunk) === idx);
  return normalized.length > 0 ? normalized.join("\n") : undefined;
}

/** Return true when a raw block should remain structurally replayable. */
function hasReplayCriticalRawBlock(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => hasReplayCriticalRawBlock(entry));
  }

  const record = value as Record<string, unknown>;
  const rawType = safeString(record.type) ?? safeString(record.rawType);
  if (rawType && REPLAY_CRITICAL_RAW_TYPES.has(rawType)) {
    return true;
  }

  for (const key of STRUCTURED_NESTED_FIELD_KEYS) {
    if (hasReplayCriticalRawBlock(record[key])) {
      return true;
    }
  }
  for (const key of STRUCTURED_ARRAY_FIELD_KEYS) {
    if (hasReplayCriticalRawBlock(record[key])) {
      return true;
    }
  }

  return false;
}

/** Serialize the original message content that backs a generic raw-payload reference. */
function serializeRawPayloadContent(message: AgentMessage, fallbackContent: string): {
  content: string;
  mimeType: string;
} | null {
  if (!("content" in message)) {
    return null;
  }
  if (typeof message.content === "string") {
    return {
      content: message.content,
      mimeType: "text/plain",
    };
  }

  const serialized = JSON.stringify(message.content);
  if (typeof serialized !== "string") {
    return null;
  }
  return {
    content: serialized || fallbackContent,
    mimeType: "application/json",
  };
}

function normalizeUnknownBlock(value: unknown): {
  type: string;
  text?: string;
  metadata: Record<string, unknown>;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      type: "agent",
      metadata: { raw: value },
    };
  }

  const record = value as Record<string, unknown>;
  const rawType = safeString(record.type);
  return {
    type: rawType ?? "agent",
    text:
      safeString(record.text) ??
      safeString(record.thinking) ??
      ((rawType === "reasoning" || rawType === "thinking")
        ? extractReasoningText(record)
        : undefined),
    metadata: { raw: record },
  };
}

function toPartType(type: string): MessagePartType {
  switch (type) {
    case "text":
      return "text";
    case "thinking":
    case "reasoning":
      return "reasoning";
    case "tool_use":
    case "toolUse":
    case "tool-use":
    case "toolCall":
    case "functionCall":
    case "function_call":
    case "function_call_output":
    case "tool_result":
    case "toolResult":
    case "tool":
      return "tool";
    case "patch":
      return "patch";
    case "file":
    case "image":
      return "file";
    case "subtask":
      return "subtask";
    case "compaction":
      return "compaction";
    case "step_start":
    case "step-start":
      return "step_start";
    case "step_finish":
    case "step-finish":
      return "step_finish";
    case "snapshot":
      return "snapshot";
    case "retry":
      return "retry";
    case "agent":
      return "agent";
    default:
      return "agent";
  }
}

/**
 * Convert AgentMessage content into plain text for DB storage.
 *
 * For content block arrays we keep only text blocks to avoid persisting raw
 * JSON syntax that can later pollute assembled model context.
 */
function extractMessageContent(content: unknown): string {
  const extracted = extractStructuredText(content);
  if (typeof extracted === "string") {
    return extracted;
  }
  if (content == null) {
    return "";
  }
  if (Array.isArray(content) && content.length === 0) {
    return "";
  }
  // If content is an array of only tool call/result objects, store as empty
  // (structured data is preserved in the message parts table)
  if (Array.isArray(content) && content.length > 0 && content.every(
    (item) => typeof item === "object" && item !== null && !Array.isArray(item) &&
      typeof (item as Record<string, unknown>).type === "string" &&
      TOOL_RAW_TYPES.has((item as Record<string, unknown>).type as string)
  )) {
    return "";
  }

  const serialized = JSON.stringify(content);
  return typeof serialized === "string" ? serialized : "";
}

function toRuntimeRoleForTokenEstimate(role: string): "user" | "assistant" | "toolResult" {
  if (role === "tool" || role === "toolResult") {
    return "toolResult";
  }
  if (role === "user" || role === "system") {
    return "user";
  }
  return "assistant";
}

function isTextBlock(value: unknown): value is { type: "text"; text: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.type === "text" && typeof record.text === "string";
}

function toSyntheticMessagePartRecord(
  part: CreateMessagePartInput,
  messageId: number,
): MessagePartRecord {
  return {
    partId: `estimate-part-${part.ordinal}`,
    messageId,
    sessionId: part.sessionId,
    partType: part.partType,
    ordinal: part.ordinal,
    textContent: part.textContent ?? null,
    toolCallId: part.toolCallId ?? null,
    toolName: part.toolName ?? null,
    toolInput: part.toolInput ?? null,
    toolOutput: part.toolOutput ?? null,
    metadata: part.metadata ?? null,
  };
}

function normalizeMessageContentForStorage(params: {
  message: AgentMessage;
  fallbackContent: string;
}): unknown {
  const { message, fallbackContent } = params;
  if (!("content" in message)) {
    return fallbackContent;
  }

  const role = toRuntimeRoleForTokenEstimate(message.role);
  const parts = buildMessageParts({
    sessionId: "storage-estimate",
    message,
    fallbackContent,
  }).map((part) => toSyntheticMessagePartRecord(part, 0));

  if (parts.length === 0) {
    if (role === "assistant") {
      return fallbackContent ? [{ type: "text", text: fallbackContent }] : [];
    }
    if (role === "toolResult") {
      return [{ type: "text", text: fallbackContent }];
    }
    return fallbackContent;
  }

  const blocks = parts.map(blockFromPart);
  if (role === "user" && blocks.length === 1 && isTextBlock(blocks[0])) {
    return blocks[0].text;
  }
  return blocks;
}

/**
 * Estimate token usage for the content shape that the assembler will emit.
 *
 * LCM stores a plain-text fallback copy in messages.content, but message_parts
 * can rehydrate larger structured/raw blocks. This estimator mirrors the
 * rehydrated shape so compaction decisions use realistic token totals.
 */
function estimateContentTokensForRole(params: {
  role: "user" | "assistant" | "toolResult";
  content: unknown;
  fallbackContent: string;
}): number {
  const { role, content, fallbackContent } = params;

  if (typeof content === "string") {
    return estimateTokens(content);
  }

  if (Array.isArray(content)) {
    if (content.length === 0) {
      return estimateTokens(fallbackContent);
    }

    if (role === "user" && content.length === 1 && isTextBlock(content[0])) {
      return estimateTokens(content[0].text);
    }

    const serialized = JSON.stringify(content);
    return estimateTokens(typeof serialized === "string" ? serialized : "");
  }

  if (content && typeof content === "object") {
    if (role === "user" && isTextBlock(content)) {
      return estimateTokens(content.text);
    }

    const serialized = JSON.stringify([content]);
    return estimateTokens(typeof serialized === "string" ? serialized : "");
  }

  return estimateTokens(fallbackContent);
}

function buildMessageParts(params: {
  sessionId: string;
  message: AgentMessage;
  fallbackContent: string;
}): import("./store/conversation-store.js").CreateMessagePartInput[] {
  const { sessionId, message, fallbackContent } = params;
  const role = typeof message.role === "string" ? message.role : "unknown";
  const topLevel = message as unknown as Record<string, unknown>;
  const topLevelToolCallId =
    safeString(topLevel.toolCallId) ??
    safeString(topLevel.tool_call_id) ??
    safeString(topLevel.toolUseId) ??
    safeString(topLevel.tool_use_id) ??
    safeString(topLevel.call_id) ??
    safeString(topLevel.id);
  const topLevelToolName =
    safeString(topLevel.toolName) ??
    safeString(topLevel.tool_name);
  const topLevelIsError =
    safeBoolean(topLevel.isError) ??
    safeBoolean(topLevel.is_error);
  const rawPayloadExternalized = safeBoolean(topLevel.rawPayloadExternalized);
  const externalizedFileId = safeString(topLevel.externalizedFileId);
  const originalByteSize =
    typeof topLevel.originalByteSize === "number"
      ? topLevel.originalByteSize
      : undefined;
  const externalizationReason = safeString(topLevel.externalizationReason);

  // BashExecutionMessage: preserve a synthetic text part so output is round-trippable.
  if (!("content" in message) && "command" in message && "output" in message) {
    return [
      {
        sessionId,
        partType: "text",
        ordinal: 0,
        textContent: fallbackContent,
        metadata: toJson({
          originalRole: role,
          source: "bash-exec",
          command: safeString((message as { command?: unknown }).command),
        }),
      },
    ];
  }

  if (!("content" in message)) {
    return [
      {
        sessionId,
        partType: "agent",
        ordinal: 0,
        textContent: fallbackContent || null,
        metadata: toJson({
          originalRole: role,
          source: "unknown-message-shape",
          raw: message,
        }),
      },
    ];
  }

  if (typeof message.content === "string") {
    return [
      {
        sessionId,
        partType: "text",
        ordinal: 0,
        textContent: message.content,
        metadata: toJson({
          originalRole: role,
          toolCallId: topLevelToolCallId,
          toolName: topLevelToolName,
          isError: topLevelIsError,
          rawPayloadExternalized: rawPayloadExternalized || undefined,
          externalizedFileId,
          originalByteSize,
          externalizationReason,
        }),
      },
    ];
  }

  if (!Array.isArray(message.content)) {
    return [
      {
        sessionId,
        partType: "agent",
        ordinal: 0,
        textContent: fallbackContent || null,
        metadata: toJson({
          originalRole: role,
          source: "non-array-content",
          raw: message.content,
        }),
      },
    ];
  }

  const parts: CreateMessagePartInput[] = [];
  for (let ordinal = 0; ordinal < message.content.length; ordinal++) {
    const block = normalizeUnknownBlock(message.content[ordinal]);
    const metadataRecord = block.metadata.raw as Record<string, unknown> | undefined;
    const rawBlockType = safeString(metadataRecord?.rawType) ?? block.type;
    const partType = toPartType(rawBlockType);
    const rawBlock =
      metadataRecord && rawBlockType !== block.type
        ? {
            ...metadataRecord,
            type: rawBlockType,
          }
        : (metadataRecord ?? message.content[ordinal]);
    const toolCallId =
      safeString(metadataRecord?.toolCallId) ??
      safeString(metadataRecord?.tool_call_id) ??
      safeString(metadataRecord?.toolUseId) ??
      safeString(metadataRecord?.tool_use_id) ??
      safeString(metadataRecord?.call_id) ??
      (partType === "tool" ? safeString(metadataRecord?.id) : undefined) ??
      topLevelToolCallId;

    parts.push({
      sessionId,
      partType,
      ordinal,
      textContent: block.text ?? null,
      toolCallId,
      toolName:
        safeString(metadataRecord?.name) ??
        safeString(metadataRecord?.toolName) ??
        safeString(metadataRecord?.tool_name) ??
        topLevelToolName,
      toolInput:
        metadataRecord?.input !== undefined
          ? toJson(metadataRecord.input)
          : metadataRecord?.arguments !== undefined
            ? toJson(metadataRecord.arguments)
          : metadataRecord?.toolInput !== undefined
            ? toJson(metadataRecord.toolInput)
            : (safeString(metadataRecord?.tool_input) ?? null),
      toolOutput:
        metadataRecord?.output !== undefined
          ? toJson(metadataRecord.output)
          : metadataRecord?.toolOutput !== undefined
            ? toJson(metadataRecord.toolOutput)
            : (safeString(metadataRecord?.tool_output) ?? null),
      metadata: toJson({
        originalRole: role,
        toolCallId: topLevelToolCallId,
        toolName: topLevelToolName,
        isError: topLevelIsError,
        externalizedFileId: safeString(metadataRecord?.externalizedFileId),
        originalByteSize:
          typeof metadataRecord?.originalByteSize === "number"
            ? metadataRecord.originalByteSize
            : undefined,
        toolOutputExternalized: safeBoolean(metadataRecord?.toolOutputExternalized),
        externalizationReason: safeString(metadataRecord?.externalizationReason),
        rawType: rawBlockType,
        raw: rawBlock,
      }),
    });
  }

  return parts;
}

/**
 * Map AgentMessage role to the DB enum.
 *
 *   "user"      -> "user"
 *   "assistant" -> "assistant"
 *
 * AgentMessage only has user/assistant roles, but we keep the mapping
 * explicit for clarity and future-proofing.
 */
function toDbRole(role: string): "user" | "assistant" | "system" | "tool" {
  if (role === "tool" || role === "toolResult") {
    return "tool";
  }
  if (role === "system") {
    return "system";
  }
  if (role === "user") {
    return "user";
  }
  if (role === "assistant") {
    return "assistant";
  }
  // Direct callers should filter unknown roles before storage. Preserve the
  // historical fallback for typed AgentMessage values that reach this helper.
  return "assistant";
}

function hasPersistableMessageRole(message: AgentMessage): boolean {
  const role = (message as { role?: unknown }).role;
  return (
    role === "user" ||
    role === "assistant" ||
    role === "system" ||
    role === "tool" ||
    role === "toolResult"
  );
}

function filterPersistableMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter(hasPersistableMessageRole);
}

type StoredMessage = {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tokenCount: number;
};

/**
 * Normalize AgentMessage variants into the storage shape used by LCM.
 */
function toStoredMessage(message: AgentMessage): StoredMessage {
  const content =
    "content" in message
      ? extractMessageContent(message.content)
      : "output" in message
        ? `$ ${(message as { command: string; output: string }).command}\n${(message as { command: string; output: string }).output}`
        : "";
  const runtimeRole = toRuntimeRoleForTokenEstimate(message.role);
  const normalizedContent =
    "content" in message
      ? normalizeMessageContentForStorage({
          message,
          fallbackContent: content,
        })
      : content;
  const tokenCount =
    "content" in message
      ? estimateContentTokensForRole({
          role: runtimeRole,
          content: normalizedContent,
          fallbackContent: content,
        })
      : estimateTokens(content);

  return {
    role: toDbRole(message.role),
    content,
    tokenCount,
  };
}

function createBootstrapEntryHash(message: StoredMessage | null): string | null {
  if (!message) {
    return null;
  }
  return createHash("sha256")
    .update(JSON.stringify({ role: message.role, content: message.content }))
    .digest("hex");
}

function estimateMessageContentTokensForAfterTurn(content: unknown): number {
  if (typeof content === "string") {
    return estimateTokens(content);
  }
  if (Array.isArray(content)) {
    let total = 0;
    for (const part of content) {
      if (!part || typeof part !== "object") {
        continue;
      }
      const record = part as Record<string, unknown>;
      const text =
        typeof record.text === "string"
          ? record.text
          : typeof record.thinking === "string"
            ? record.thinking
            : "";
      if (text) {
        total += estimateTokens(text);
      }
    }
    return total;
  }
  if (content == null) {
    return 0;
  }
  const serialized = JSON.stringify(content);
  return estimateTokens(typeof serialized === "string" ? serialized : "");
}

function estimateSessionTokenCountForAfterTurn(messages: AgentMessage[]): number {
  let total = 0;
  for (const message of messages) {
    if ("content" in message) {
      total += estimateMessageContentTokensForAfterTurn(message.content);
      continue;
    }
    if ("command" in message || "output" in message) {
      const commandText =
        typeof (message as { command?: unknown }).command === "string"
          ? (message as { command?: string }).command
          : "";
      const outputText =
        typeof (message as { output?: unknown }).output === "string"
          ? (message as { output?: string }).output
          : "";
      total += estimateTokens(`${commandText}\n${outputText}`);
    }
  }
  return total;
}

function normalizeNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

function firstRuntimeTokenCount(record: Record<string, unknown> | null, keys: string[]): number | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const count = normalizeNonNegativeInteger(record[key]);
    if (count !== undefined) {
      return count;
    }
  }
  return undefined;
}

/**
 * Extract the runtime prompt token count from OpenClaw runtimeContext.
 *
 * OpenClaw derives this as: input + cacheRead + cacheWrite from the
 * normalizeUsage() result.  The runtimeContext carries it three ways:
 *   1. runtimeContext.currentTokenCount  — direct value (preferred)
 *   2. runtimeContext.usage             — {input, cacheRead, cacheWrite, ...}
 *   3. runtimeContext.promptCache.lastCallUsage — same normalized shape
 *
 * normalizeUsage() maps provider-specific fields (prompt_tokens, input_tokens,
 * cache_read, etc.) to the canonical {input, cacheRead, cacheWrite} shape,
 * so the lastCallUsage passed to LCM is already provider-normalized.
 */
/**
 * Sum prompt tokens from a usage record.
 *
 * Supports two shapes:
 * - Normalized (OpenClaw internal): {input, cacheRead, cacheWrite}
 * - Raw provider: {prompt_tokens, ...}
 *
 * normalizeUsage() maps raw provider fields (prompt_tokens, cache_read, etc.)
 * to the canonical normalized shape before LCM receives runtimeContext.
 * We accept both shapes to be robust to direct test calls and future changes.
 */
function sumPromptTokensFromUsageRecord(record: Record<string, unknown> | null): number | undefined {
  if (!record) {
    return undefined;
  }
  // Normalized shape: input + cacheRead + cacheWrite
  const input = normalizeNonNegativeInteger(record["input"]);
  const cacheRead = normalizeNonNegativeInteger(record["cacheRead"]);
  const cacheWrite = normalizeNonNegativeInteger(record["cacheWrite"]);
  if (input !== undefined || cacheRead !== undefined || cacheWrite !== undefined) {
    return (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
  }
  // Raw provider shape: prompt_tokens (already includes cache reads)
  const rawPromptTokens = normalizeNonNegativeInteger(
    record["prompt_tokens"] ?? record["promptTokens"] ?? record["input_tokens"] ?? record["inputTokens"],
  );
  if (rawPromptTokens !== undefined) {
    return rawPromptTokens;
  }
  return undefined;
}

function extractRuntimePromptTokenCount(runtimeContext?: Record<string, unknown>): number | undefined {
  const ctx = asRecord(runtimeContext);
  if (!ctx) {
    return undefined;
  }

  // 1. Direct currentTokenCount (already derived by OpenClaw: input+cacheRead+cacheWrite)
  const direct = normalizeNonNegativeInteger(ctx["currentTokenCount"]);
  if (direct !== undefined) {
    return direct;
  }

  // 2. Sum from runtimeContext.usage (normalizeUsage output: {input, cacheRead, cacheWrite})
  const usageSum = sumPromptTokensFromUsageRecord(asRecord(ctx["usage"]) ?? asRecord(ctx["lastCallUsage"]));
  if (usageSum !== undefined && usageSum > 0) {
    return usageSum;
  }

  // 3. Sum from promptCache.lastCallUsage (same normalized shape)
  const promptCache = asRecord(ctx["promptCache"]);
  const promptCacheUsageSum = sumPromptTokensFromUsageRecord(asRecord(promptCache?.["lastCallUsage"]));
  if (promptCacheUsageSum !== undefined && promptCacheUsageSum > 0) {
    return promptCacheUsageSum;
  }

  return undefined;
}

function isBootstrapMessage(value: unknown): value is AgentMessage {
  if (!value || typeof value !== "object") {
    return false;
  }
  const msg = value as { role?: unknown; content?: unknown; command?: unknown; output?: unknown };
  if (typeof msg.role !== "string") {
    return false;
  }
  return "content" in msg || ("command" in msg && "output" in msg);
}

function extractCanonicalBootstrapMessage(value: unknown): AgentMessage | null {
  if (isBootstrapMessage(value)) {
    return value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entry = value as { type?: unknown; message?: unknown };
  if ("message" in entry) {
    if (entry.type !== undefined && entry.type !== "message") {
      return null;
    }
    return isBootstrapMessage(entry.message) ? entry.message : null;
  }
  return null;
}

function extractBootstrapMessageCandidate(value: unknown): AgentMessage | null {
  return extractCanonicalBootstrapMessage(value);
}

/**
 * Resolve the first-time bootstrap token budget.
 *
 * When unset, bootstrap keeps a modest suffix of the parent session rather than
 * inheriting the full raw history into a brand-new conversation.
 */
function resolveBootstrapMaxTokens(config: Pick<LcmConfig, "bootstrapMaxTokens" | "leafChunkTokens">): number {
  if (
    typeof config.bootstrapMaxTokens === "number" &&
    Number.isFinite(config.bootstrapMaxTokens) &&
    config.bootstrapMaxTokens > 0
  ) {
    return Math.floor(config.bootstrapMaxTokens);
  }

  const leafChunkTokens =
    typeof config.leafChunkTokens === "number" &&
    Number.isFinite(config.leafChunkTokens) &&
    config.leafChunkTokens > 0
      ? Math.floor(config.leafChunkTokens)
      : 40_000;
  return Math.max(6000, Math.floor(leafChunkTokens * 0.3));
}

/**
 * Keep only the newest bootstrap messages that fit within the token budget.
 *
 * The newest message is always preserved so a fork never starts empty when the
 * parent transcript has any recoverable content at all.
 */
function trimBootstrapMessagesToBudget(messages: AgentMessage[], maxTokens: number): AgentMessage[] {
  if (messages.length === 0) {
    return [];
  }

  const safeMaxTokens = Number.isFinite(maxTokens) ? Math.floor(maxTokens) : 0;
  if (safeMaxTokens <= 0) {
    return [messages[messages.length - 1]!];
  }

  const kept: AgentMessage[] = [];
  let totalTokens = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const tokenCount = toStoredMessage(message).tokenCount;
    if (kept.length > 0 && totalTokens + tokenCount > safeMaxTokens) {
      break;
    }
    kept.push(message);
    totalTokens += tokenCount;
  }

  // If a single oversized tail message exceeds the budget, return empty
  // rather than silently bypassing the budget cap. An empty bootstrap is
  // safer than an exploding one.
  if (kept.length === 1 && totalTokens > safeMaxTokens) {
    return [];
  }

  kept.reverse();
  return kept;
}

function messageIdentity(role: string, content: string): string {
  return `${role}\u0000${content}`;
}

function isBootstrapReplayCandidateMessage(message: AgentMessage): boolean {
  const role = toStoredMessage(message).role;
  return role === "assistant" || role === "tool";
}

function createLosslessMessageSignature(message: AgentMessage): string {
  const stored = toStoredMessage(message);
  const parts = buildMessageParts({
    sessionId: "lossless-message-signature",
    message,
    fallbackContent: stored.content,
  });

  return JSON.stringify({
    role: stored.role,
    content: stored.content,
    parts: parts.map((part) => ({
      partType: part.partType,
      ordinal: part.ordinal,
      textContent: part.textContent ?? null,
      toolCallId: part.toolCallId ?? null,
      toolName: part.toolName ?? null,
      toolInput: part.toolInput ?? null,
      toolOutput: part.toolOutput ?? null,
      metadata: part.metadata ?? null,
    })),
  });
}

function createBootstrapReplaySignature(message: AgentMessage): string {
  return createLosslessMessageSignature(message);
}

function normalizeSummaryOverlapText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function messageContentCoveredBySummary(params: {
  message: AgentMessage;
  summary: string;
}): boolean {
  const content = normalizeSummaryOverlapText(toStoredMessage(params.message).content);
  if (content.length < 24) {
    return false;
  }
  const summary = normalizeSummaryOverlapText(params.summary);
  if (!summary.includes(content)) {
    return false;
  }
  // Bare substring match is too loose: a 24+ char user instruction can
  // coincidentally appear inside a long narrative summary and get silently
  // dropped. Require one of:
  //   1. content appears at the very start or end of the summary, OR
  //   2. content appears inside a quoted block — double quotes ("..."),
  //      single quotes ('...'), or backticks (`...`). All three quote
  //      styles survive normalization and are emitted by the summarizer
  //      when it embeds verbatim user text.
  // Otherwise treat it as a coincidental collision and keep the message.
  if (summary.startsWith(content) || summary.endsWith(content)) {
    return true;
  }
  // Walk each quote-delimited span (cheap; summaries are bounded) and check
  // membership. Use double-quoted literals to match the rest of the file.
  for (const quoteChar of ["\"", "'", "`"]) {
    let cursor = 0;
    while (cursor < summary.length) {
      const open = summary.indexOf(quoteChar, cursor);
      if (open < 0) break;
      const close = summary.indexOf(quoteChar, open + 1);
      if (close < 0) {
        // Unmatched opening quote: don't break out of the entire scan —
        // a later well-formed quoted span may still contain the content.
        // Skip past this lone opener and continue.
        cursor = open + 1;
        continue;
      }
      const span = summary.slice(open + 1, close);
      if (span.includes(content)) {
        return true;
      }
      cursor = close + 1;
    }
  }
  return false;
}

const INTER_SESSION_MESSAGE_MARKER = "[Inter-session message]";
const INTERNAL_CONTEXT_BEGIN_MARKER = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>";
const INTERNAL_CONTEXT_END_MARKER = "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
const INTERNAL_TASK_COMPLETION_EVENT_MARKER = "[Internal task completion event]";
const FALLBACK_RETRY_PROMPT_MARKER =
  "[Retry after the previous model attempt failed or timed out]";
const NORMALIZED_INTER_SESSION_MESSAGE_MARKER = normalizeSummaryOverlapText(INTER_SESSION_MESSAGE_MARKER);
const NORMALIZED_INTERNAL_TASK_COMPLETION_EVENT_MARKER = normalizeSummaryOverlapText(
  INTERNAL_TASK_COMPLETION_EVENT_MARKER,
);

function hasFallbackRetryPromptMarker(content: string): boolean {
  return content.split(/\r?\n/).some((line) => line.trim() === FALLBACK_RETRY_PROMPT_MARKER);
}

function hasCompleteInternalContextBlock(content: string): boolean {
  const beginIndex = content.indexOf(INTERNAL_CONTEXT_BEGIN_MARKER);
  if (beginIndex < 0) {
    return false;
  }
  return (
    content.indexOf(
      INTERNAL_CONTEXT_END_MARKER,
      beginIndex + INTERNAL_CONTEXT_BEGIN_MARKER.length,
    ) >= 0
  );
}

function isVolatileLiveInputContent(content: string): boolean {
  const trimmed = content.trimStart();
  if (hasFallbackRetryPromptMarker(trimmed)) {
    return true;
  }
  if (!hasCompleteInternalContextBlock(trimmed)) {
    return false;
  }
  const normalized = normalizeSummaryOverlapText(trimmed);
  if (normalized.startsWith(NORMALIZED_INTER_SESSION_MESSAGE_MARKER)) {
    return true;
  }
  return (
    trimmed.startsWith(INTERNAL_CONTEXT_BEGIN_MARKER) &&
    normalized.includes(NORMALIZED_INTERNAL_TASK_COMPLETION_EVENT_MARKER)
  );
}

function estimateAgentMessageTokens(messages: AgentMessage[]): number {
  return messages.reduce((total, message) => total + toStoredMessage(message).tokenCount, 0);
}

function isVolatileLiveInputMessage(message: AgentMessage): boolean {
  const stored = toStoredMessage(message);
  if (stored.role !== "user" && stored.role !== "system") {
    return false;
  }
  if (!stored.content.trim()) {
    return false;
  }
  return isVolatileLiveInputContent(stored.content);
}

function extractToolPairingIdFromRecord(record: Record<string, unknown>): string | undefined {
  return (
    safeString(record.toolCallId) ??
    safeString(record.tool_call_id) ??
    safeString(record.toolUseId) ??
    safeString(record.tool_use_id) ??
    safeString(record.call_id) ??
    safeString(record.id)
  );
}

function extractAssistantToolCallIdsForPairing(message: AgentMessage): string[] {
  if (message.role !== "assistant" || !("content" in message) || !Array.isArray(message.content)) {
    return [];
  }
  const ids: string[] = [];
  for (const block of message.content) {
    const record = asRecord(block);
    if (!record || typeof record.type !== "string" || !TOOL_CALL_RAW_TYPES.has(record.type)) {
      continue;
    }
    const id = extractToolPairingIdFromRecord(record);
    if (id) {
      ids.push(id);
    }
  }
  return ids;
}

function extractToolResultIdForPairing(message: AgentMessage): string | undefined {
  if (message.role !== "tool" && message.role !== "toolResult") {
    return undefined;
  }
  const topLevel = asRecord(message);
  if (topLevel) {
    const direct = extractToolPairingIdFromRecord(topLevel);
    if (direct) {
      return direct;
    }
  }
  if (!("content" in message) || !Array.isArray(message.content)) {
    return undefined;
  }
  for (const block of message.content) {
    const record = asRecord(block);
    if (!record || typeof record.type !== "string" || !TOOL_RESULT_RAW_TYPES.has(record.type)) {
      continue;
    }
    const id = extractToolPairingIdFromRecord(record);
    if (id) {
      return id;
    }
  }
  return undefined;
}

function expandProtectedToolPairIndexes(params: {
  assembledMessages: AgentMessage[];
  protectedAssembledIndexes: Set<number>;
}): Set<number> {
  const protectedIndexes = new Set(params.protectedAssembledIndexes);
  const assistantIndexesByToolCallId = new Map<string, number[]>();
  const toolResultIndexesByToolCallId = new Map<string, number[]>();

  for (let index = 0; index < params.assembledMessages.length; index++) {
    const message = params.assembledMessages[index] as AgentMessage;
    for (const toolCallId of extractAssistantToolCallIdsForPairing(message)) {
      const indexes = assistantIndexesByToolCallId.get(toolCallId);
      if (indexes) {
        indexes.push(index);
      } else {
        assistantIndexesByToolCallId.set(toolCallId, [index]);
      }
    }
    const toolResultId = extractToolResultIdForPairing(message);
    if (toolResultId) {
      const indexes = toolResultIndexesByToolCallId.get(toolResultId);
      if (indexes) {
        indexes.push(index);
      } else {
        toolResultIndexesByToolCallId.set(toolResultId, [index]);
      }
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < params.assembledMessages.length; index++) {
      if (!protectedIndexes.has(index)) {
        continue;
      }
      const message = params.assembledMessages[index] as AgentMessage;
      const relatedIndexes: number[] = [];
      for (const toolCallId of extractAssistantToolCallIdsForPairing(message)) {
        relatedIndexes.push(...(toolResultIndexesByToolCallId.get(toolCallId) ?? []));
      }
      const toolResultId = extractToolResultIdForPairing(message);
      if (toolResultId) {
        relatedIndexes.push(...(assistantIndexesByToolCallId.get(toolResultId) ?? []));
      }
      for (const relatedIndex of relatedIndexes) {
        if (!protectedIndexes.has(relatedIndex)) {
          protectedIndexes.add(relatedIndex);
          changed = true;
        }
      }
    }
  }

  return protectedIndexes;
}

function expandToolPairLiveSortIndexes(params: {
  assembledMessages: AgentMessage[];
  liveSortIndexes: Map<number, number>;
}): Map<number, number> {
  const liveSortIndexes = new Map(params.liveSortIndexes);
  const assistantIndexesByToolCallId = new Map<string, number[]>();
  const toolResultIndexesByToolCallId = new Map<string, number[]>();

  for (let index = 0; index < params.assembledMessages.length; index++) {
    const message = params.assembledMessages[index] as AgentMessage;
    for (const toolCallId of extractAssistantToolCallIdsForPairing(message)) {
      const indexes = assistantIndexesByToolCallId.get(toolCallId);
      if (indexes) {
        indexes.push(index);
      } else {
        assistantIndexesByToolCallId.set(toolCallId, [index]);
      }
    }
    const toolResultId = extractToolResultIdForPairing(message);
    if (toolResultId) {
      const indexes = toolResultIndexesByToolCallId.get(toolResultId);
      if (indexes) {
        indexes.push(index);
      } else {
        toolResultIndexesByToolCallId.set(toolResultId, [index]);
      }
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < params.assembledMessages.length; index++) {
      const liveIndex = liveSortIndexes.get(index);
      if (liveIndex === undefined) {
        continue;
      }
      const message = params.assembledMessages[index] as AgentMessage;
      const relatedIndexes: number[] = [];
      for (const toolCallId of extractAssistantToolCallIdsForPairing(message)) {
        relatedIndexes.push(...(toolResultIndexesByToolCallId.get(toolCallId) ?? []));
      }
      const toolResultId = extractToolResultIdForPairing(message);
      if (toolResultId) {
        relatedIndexes.push(...(assistantIndexesByToolCallId.get(toolResultId) ?? []));
      }
      for (const relatedIndex of relatedIndexes) {
        const existing = liveSortIndexes.get(relatedIndex);
        if (existing === undefined || liveIndex < existing) {
          liveSortIndexes.set(relatedIndex, liveIndex);
          changed = true;
        }
      }
    }
  }

  return liveSortIndexes;
}

function buildToolPairIndexesByAssembledIndex(
  assembledMessages: AgentMessage[],
): Map<number, Set<number>> {
  const assistantIndexesByToolCallId = new Map<string, number[]>();
  const toolResultIndexesByToolCallId = new Map<string, number[]>();

  // First index both sides by tool call id so matching assistant/result turns
  // can be treated as one eviction unit.
  for (let index = 0; index < assembledMessages.length; index++) {
    const message = assembledMessages[index] as AgentMessage;
    for (const toolCallId of extractAssistantToolCallIdsForPairing(message)) {
      const indexes = assistantIndexesByToolCallId.get(toolCallId);
      if (indexes) {
        indexes.push(index);
      } else {
        assistantIndexesByToolCallId.set(toolCallId, [index]);
      }
    }
    const toolResultId = extractToolResultIdForPairing(message);
    if (toolResultId) {
      const indexes = toolResultIndexesByToolCallId.get(toolResultId);
      if (indexes) {
        indexes.push(index);
      } else {
        toolResultIndexesByToolCallId.set(toolResultId, [index]);
      }
    }
  }

  const neighborsByIndex = new Map<number, Set<number>>();
  // Link matched pairs as an undirected graph; the final groups are connected
  // components, which handles multi-tool assistant turns and duplicate ids.
  const linkIndexes = (left: number, right: number) => {
    const leftNeighbors = neighborsByIndex.get(left) ?? new Set<number>([left]);
    leftNeighbors.add(right);
    neighborsByIndex.set(left, leftNeighbors);

    const rightNeighbors = neighborsByIndex.get(right) ?? new Set<number>([right]);
    rightNeighbors.add(left);
    neighborsByIndex.set(right, rightNeighbors);
  };

  for (const [toolCallId, assistantIndexes] of assistantIndexesByToolCallId.entries()) {
    const toolResultIndexes = toolResultIndexesByToolCallId.get(toolCallId) ?? [];
    for (const assistantIndex of assistantIndexes) {
      for (const toolResultIndex of toolResultIndexes) {
        linkIndexes(assistantIndex, toolResultIndex);
      }
    }
  }

  const groupsByIndex = new Map<number, Set<number>>();
  // Materialize every index's component so budget trimming can cheaply ask
  // "what else must be evicted with this message?"
  for (let index = 0; index < assembledMessages.length; index++) {
    const group = new Set<number>();
    const pending = [index];
    while (pending.length > 0) {
      const current = pending.pop() as number;
      if (group.has(current)) {
        continue;
      }
      group.add(current);
      for (const neighbor of neighborsByIndex.get(current) ?? [current]) {
        if (!group.has(neighbor)) {
          pending.push(neighbor);
        }
      }
    }
    groupsByIndex.set(index, group);
  }
  return groupsByIndex;
}

function normalizeLiveMessageForAssemblyReconciliation(message: AgentMessage): AgentMessage {
  const stored = toStoredMessage(message);
  if (stored.role !== "system" && stored.role !== "tool") {
    return message;
  }
  const runtimeRole = stored.role === "system" ? "user" : "toolResult";
  const parts =
    "content" in message
      ? buildMessageParts({
          sessionId: "live-reconciliation",
          message,
          fallbackContent: stored.content,
        }).map((part) => toSyntheticMessagePartRecord(part, 0))
      : [];
  const content = contentFromParts(parts, runtimeRole, stored.content);
  return {
    ...message,
    role: runtimeRole,
    content,
  } as AgentMessage;
}

function countNonOverlappingOccurrences(params: {
  haystack: string;
  needle: string;
}): number {
  if (!params.needle) {
    return 0;
  }
  let count = 0;
  let cursor = 0;
  while (cursor <= params.haystack.length) {
    const found = params.haystack.indexOf(params.needle, cursor);
    if (found < 0) {
      break;
    }
    count++;
    cursor = found + params.needle.length;
  }
  return count;
}

function liveInputCoverageCapacity(params: {
  assembledMessage: AgentMessage;
  liveMessage: AgentMessage;
  /**
   * When true, the live message is a volatile input that was never persisted to
   * DB. Summary substring coverage is insufficient for such messages because a
   * summary that contains similar text is summarizing a *past* turn — it does
   * not prove the current turn's volatile input is already represented.
   */
  isVolatileLiveInput?: boolean;
}): number {
  const assembled = toStoredMessage(params.assembledMessage);
  const live = toStoredMessage(params.liveMessage);
  if (messagesHaveSameLiveCoverageSignature(params.assembledMessage, params.liveMessage)) {
    return 1;
  }

  // Volatile live inputs are never persisted to DB. A summary containing
  // similar text covers a *past* occurrence, not the current live input.
  // Only exact assembled message matches (handled above) can cover a
  // volatile input — a historical summary paraphrase is insufficient.
  if (params.isVolatileLiveInput) {
    return 0;
  }

  // Substring coverage is only safe for LCM summary wrappers. Raw assembled
  // turns must match exactly, otherwise normalized near-matches can hide a
  // distinct volatile live input.
  if (!assembled.content.includes("<summary ") || !assembled.content.includes("</summary>")) {
    return 0;
  }

  const liveText = normalizeSummaryOverlapText(live.content);
  if (liveText.length < 24) {
    return 0;
  }
  const assembledText = normalizeSummaryOverlapText(assembled.content);
  return countNonOverlappingOccurrences({ haystack: assembledText, needle: liveText });
}

function isSummaryWrapperContent(content: string): boolean {
  return content.includes("<summary ") && content.includes("</summary>");
}

type VolatileLiveInputEntry = {
  message: AgentMessage;
  liveIndex: number;
};

type VolatileLiveInputCandidate = VolatileLiveInputEntry & {
  liveText: string;
};

type VolatileLiveInputCoverageSlot = {
  assembledIndex: number;
};

type RetainedAssembledEntry = {
  message: AgentMessage;
  index: number;
};

function materializeVolatileLiveInputEntries(entries: VolatileLiveInputEntry[]): AgentMessage[] {
  return entries
    .slice()
    .sort((a, b) => a.liveIndex - b.liveIndex)
    .map((entry) => entry.message);
}

function hashAgentMessageForAssemblyProtection(message: AgentMessage): string {
  return createHash("sha256").update(JSON.stringify([message])).digest("hex").slice(0, 16);
}

function resolveProtectedFreshTailAssembledIndexes(params: {
  assembledMessages: AgentMessage[];
  freshTailMessageHashes?: string[];
}): Set<number> {
  const protectedIndexes = new Set<number>();
  const usedIndexes = new Set<number>();
  for (const hash of params.freshTailMessageHashes ?? []) {
    for (let index = params.assembledMessages.length - 1; index >= 0; index--) {
      if (usedIndexes.has(index)) {
        continue;
      }
      const message = params.assembledMessages[index] as AgentMessage;
      if (hashAgentMessageForAssemblyProtection(message) === hash) {
        protectedIndexes.add(index);
        usedIndexes.add(index);
        break;
      }
    }
  }
  return protectedIndexes;
}

function messagesHaveSameLosslessSignature(left: AgentMessage, right: AgentMessage): boolean {
  return createLosslessMessageSignature(left) === createLosslessMessageSignature(right);
}

function createLiveCoverageSignature(message: AgentMessage): string {
  const stored = toStoredMessage(message);
  if (
    (stored.role === "user" || stored.role === "system" || stored.role === "assistant") &&
    stored.content.length > 0 &&
    isCanonicalTextOnlyMessage(message, stored.content)
  ) {
    return JSON.stringify({
      kind: "canonical-text",
      role: stored.role,
      content: stored.content,
    });
  }
  const canonicalToolTextSignature = createCanonicalToolTextCoverageSignature(
    message,
    stored.content,
  );
  if (canonicalToolTextSignature) {
    return canonicalToolTextSignature;
  }
  return createLosslessMessageSignature(message);
}

function normalizeToolNameForCoverage(toolName: string | null | undefined): string | null {
  // The assembler fills missing tool names with "unknown" on rehydration.
  // Treat null/undefined/""/"unknown" as equivalent for coverage matching
  // so live and assembled tool-result signatures still match.
  if (!toolName || toolName === "unknown") {
    return null;
  }
  return toolName;
}

function createCanonicalToolTextCoverageSignature(
  message: AgentMessage,
  fallbackContent: string,
): string | undefined {
  const stored = toStoredMessage(message);
  if (stored.role !== "tool" || fallbackContent.length === 0) {
    return undefined;
  }
  const parts = buildMessageParts({
    sessionId: "live-tool-coverage-signature",
    message,
    fallbackContent,
  });
  if (parts.length !== 1) {
    return undefined;
  }
  const part = parts[0] as CreateMessagePartInput;
  if (
    part.partType !== "text" ||
    (part.textContent ?? "") !== fallbackContent ||
    part.toolInput != null ||
    part.toolOutput != null
  ) {
    return undefined;
  }
  return JSON.stringify({
    kind: "canonical-tool-text",
    role: stored.role,
    content: fallbackContent,
    toolCallId: part.toolCallId ?? extractToolResultIdForPairing(message) ?? null,
    toolName: normalizeToolNameForCoverage(part.toolName),
  });
}

function isCanonicalTextOnlyMessage(message: AgentMessage, fallbackContent: string): boolean {
  const parts = buildMessageParts({
    sessionId: "live-coverage-signature",
    message,
    fallbackContent,
  });
  if (parts.length !== 1) {
    return false;
  }
  const part = parts[0] as CreateMessagePartInput;
  return (
    part.partType === "text" &&
    (part.textContent ?? "") === fallbackContent &&
    part.toolCallId == null &&
    part.toolName == null &&
    part.toolInput == null &&
    part.toolOutput == null
  );
}

function messagesHaveSameLiveCoverageSignature(left: AgentMessage, right: AgentMessage): boolean {
  return createLiveCoverageSignature(left) === createLiveCoverageSignature(right);
}

function resolveExactAssembledLiveSortIndexes(params: {
  assembledMessages: AgentMessage[];
  liveMessages: AgentMessage[];
}): Map<number, number> {
  const liveSortIndexes = new Map<number, number>();
  const usedAssembledIndexes = new Set<number>();
  for (let liveIndex = params.liveMessages.length - 1; liveIndex >= 0; liveIndex--) {
    const liveMessage = params.liveMessages[liveIndex] as AgentMessage;
    for (
      let assembledIndex = params.assembledMessages.length - 1;
      assembledIndex >= 0;
      assembledIndex--
    ) {
      if (usedAssembledIndexes.has(assembledIndex)) {
        continue;
      }
      const assembledMessage = params.assembledMessages[assembledIndex] as AgentMessage;
      if (messagesHaveSameLiveCoverageSignature(assembledMessage, liveMessage)) {
        liveSortIndexes.set(assembledIndex, liveIndex);
        usedAssembledIndexes.add(assembledIndex);
        break;
      }
    }
  }
  return liveSortIndexes;
}

function mergeCoveredVolatileLiveSortIndexes(params: {
  exactLiveSortIndexes: Map<number, number>;
  coveredEntriesByAssembledIndex: Map<number, VolatileLiveInputEntry[]>;
}): Map<number, number> {
  const liveSortIndexes = new Map(params.exactLiveSortIndexes);
  for (const [assembledIndex, entries] of params.coveredEntriesByAssembledIndex.entries()) {
    const coveredLiveIndex = Math.min(...entries.map((entry) => entry.liveIndex));
    const existingLiveIndex = liveSortIndexes.get(assembledIndex);
    if (existingLiveIndex === undefined || coveredLiveIndex < existingLiveIndex) {
      liveSortIndexes.set(assembledIndex, coveredLiveIndex);
    }
  }
  return liveSortIndexes;
}

function buildVolatileLiveInputMergedOutput(params: {
  retained: RetainedAssembledEntry[];
  appendedEntries: VolatileLiveInputEntry[];
  liveSortIndexes: Map<number, number>;
}): AgentMessage[] {
  const output: AgentMessage[] = [];
  const appendedEntries = params.appendedEntries
    .slice()
    .sort((left, right) => left.liveIndex - right.liveIndex);
  let appendedCursor = 0;
  for (const retainedEntry of params.retained) {
    const retainedLiveIndex = params.liveSortIndexes.get(retainedEntry.index);
    if (retainedLiveIndex !== undefined) {
      while (
        appendedCursor < appendedEntries.length &&
        (appendedEntries[appendedCursor] as VolatileLiveInputEntry).liveIndex < retainedLiveIndex
      ) {
        output.push((appendedEntries[appendedCursor] as VolatileLiveInputEntry).message);
        appendedCursor++;
      }
    }
    output.push(retainedEntry.message);
  }
  while (appendedCursor < appendedEntries.length) {
    output.push((appendedEntries[appendedCursor] as VolatileLiveInputEntry).message);
    appendedCursor++;
  }
  return sanitizeToolUseResultPairing(output) as AgentMessage[];
}

function matchVolatileLiveInputsToCoverageSlots(params: {
  assembledMessages: AgentMessage[];
  volatileLiveInputs: VolatileLiveInputCandidate[];
}): Map<number, number> {
  const entryIndexesByLiveText = new Map<string, number[]>();
  for (let entryIndex = 0; entryIndex < params.volatileLiveInputs.length; entryIndex++) {
    const entry = params.volatileLiveInputs[entryIndex] as VolatileLiveInputCandidate;
    const entryIndexes = entryIndexesByLiveText.get(entry.liveText);
    if (entryIndexes) {
      entryIndexes.push(entryIndex);
    } else {
      entryIndexesByLiveText.set(entry.liveText, [entryIndex]);
    }
  }

  const slots: VolatileLiveInputCoverageSlot[] = [];
  const candidateSlotIndexesByEntryIndex = params.volatileLiveInputs.map(() => [] as number[]);
  const addCandidateSlots = (entryIndexes: number[], assembledIndex: number, slotCount: number) => {
    const slotIndexes: number[] = [];
    for (let slotOffset = 0; slotOffset < slotCount; slotOffset++) {
      slotIndexes.push(slots.length);
      slots.push({ assembledIndex });
    }
    for (const entryIndex of entryIndexes) {
      candidateSlotIndexesByEntryIndex[entryIndex]?.push(...slotIndexes);
    }
  };

  for (const [liveText, entryIndexes] of entryIndexesByLiveText.entries()) {
    for (let assembledIndex = 0; assembledIndex < params.assembledMessages.length; assembledIndex++) {
      const assembledMessage = params.assembledMessages[assembledIndex] as AgentMessage;
      const assembled = toStoredMessage(assembledMessage);
      if (!isSummaryWrapperContent(assembled.content)) {
        const exactEntryIndexes = entryIndexes.filter((entryIndex) =>
          messagesHaveSameLiveCoverageSignature(
            assembledMessage,
            (params.volatileLiveInputs[entryIndex] as VolatileLiveInputCandidate).message,
          )
        );
        if (exactEntryIndexes.length > 0) {
          addCandidateSlots(exactEntryIndexes, assembledIndex, 1);
        }
        continue;
      }

      const representativeEntry = params.volatileLiveInputs[entryIndexes[0] as number] as VolatileLiveInputCandidate;
      const capacity = liveInputCoverageCapacity({
        assembledMessage,
        liveMessage: representativeEntry.message,
        isVolatileLiveInput: true,
      });
      if (capacity <= 0) {
        continue;
      }

      const entryIndexesBySignature = new Map<string, number[]>();
      for (const entryIndex of entryIndexes) {
        const entry = params.volatileLiveInputs[entryIndex] as VolatileLiveInputCandidate;
        const signature = createLiveCoverageSignature(entry.message);
        const signatureEntryIndexes = entryIndexesBySignature.get(signature);
        if (signatureEntryIndexes) {
          signatureEntryIndexes.push(entryIndex);
        } else {
          entryIndexesBySignature.set(signature, [entryIndex]);
        }
      }

      let exactSlotCount = 0;
      for (const signatureEntryIndexes of entryIndexesBySignature.values()) {
        const firstEntry = params.volatileLiveInputs[signatureEntryIndexes[0] as number] as VolatileLiveInputCandidate;
        const liveContent = toStoredMessage(firstEntry.message).content;
        const exactCapacity = liveContent
          ? countNonOverlappingOccurrences({ haystack: assembled.content, needle: liveContent })
          : 0;
        const slotCount = Math.min(exactCapacity, signatureEntryIndexes.length);
        if (slotCount > 0) {
          addCandidateSlots(signatureEntryIndexes, assembledIndex, slotCount);
          exactSlotCount += slotCount;
        }
      }

      const genericSlotCount = Math.min(
        Math.max(0, capacity - exactSlotCount),
        Math.max(0, entryIndexes.length - exactSlotCount),
      );
      if (genericSlotCount > 0) {
        addCandidateSlots(entryIndexes, assembledIndex, genericSlotCount);
      }
    }
  }

  const slotToEntryIndex = new Map<number, number>();
  const tryAssignEntry = (entryIndex: number, visitedSlots: Set<number>): boolean => {
    const candidateSlotIndexes = candidateSlotIndexesByEntryIndex[entryIndex] ?? [];
    for (const slotIndex of candidateSlotIndexes) {
      if (visitedSlots.has(slotIndex)) {
        continue;
      }
      visitedSlots.add(slotIndex);
      const currentEntryIndex = slotToEntryIndex.get(slotIndex);
      if (
        currentEntryIndex === undefined ||
        tryAssignEntry(currentEntryIndex, visitedSlots)
      ) {
        slotToEntryIndex.set(slotIndex, entryIndex);
        return true;
      }
    }
    return false;
  };

  for (let entryIndex = 0; entryIndex < params.volatileLiveInputs.length; entryIndex++) {
    tryAssignEntry(entryIndex, new Set<number>());
  }

  const entryToAssembledIndex = new Map<number, number>();
  for (const [slotIndex, entryIndex] of slotToEntryIndex.entries()) {
    const slot = slots[slotIndex] as VolatileLiveInputCoverageSlot;
    entryToAssembledIndex.set(entryIndex, slot.assembledIndex);
  }
  return entryToAssembledIndex;
}

function collectUncoveredVolatileLiveInputs(params: {
  assembledMessages: AgentMessage[];
  liveMessages: AgentMessage[];
}): {
  entries: VolatileLiveInputEntry[];
  estimatedTokens: number;
  coveredEntriesByAssembledIndex: Map<number, VolatileLiveInputEntry[]>;
} {
  const volatileLiveInputs = params.liveMessages
    .map((message, liveIndex) => ({ message, liveIndex }))
    .filter((entry) => isVolatileLiveInputMessage(entry.message))
    .map((entry) => ({
      ...entry,
      liveText: normalizeSummaryOverlapText(toStoredMessage(entry.message).content),
    }));
  const uncovered: VolatileLiveInputEntry[] = [];
  const coveredEntriesByAssembledIndex = new Map<number, VolatileLiveInputEntry[]>();
  const entryToAssembledIndex = matchVolatileLiveInputsToCoverageSlots({
    assembledMessages: params.assembledMessages,
    volatileLiveInputs,
  });

  for (let entryIndex = 0; entryIndex < volatileLiveInputs.length; entryIndex++) {
    const entry = volatileLiveInputs[entryIndex] as VolatileLiveInputCandidate;
    const assembledIndex = entryToAssembledIndex.get(entryIndex);
    if (assembledIndex !== undefined) {
      const coveredEntries = coveredEntriesByAssembledIndex.get(assembledIndex);
      if (coveredEntries) {
        coveredEntries.push(entry);
      } else {
        coveredEntriesByAssembledIndex.set(assembledIndex, [entry]);
      }
    } else {
      uncovered.push(entry);
    }
  }

  return {
    entries: uncovered,
    estimatedTokens: estimateAgentMessageTokens(materializeVolatileLiveInputEntries(uncovered)),
    coveredEntriesByAssembledIndex,
  };
}

function appendUncoveredVolatileLiveInputsWithinBudget(params: {
  assembledMessages: AgentMessage[];
  assembledEstimatedTokens: number;
  liveMessages: AgentMessage[];
  protectedAssembledIndexes?: Set<number>;
  tokenBudget: number;
}): {
  messages: AgentMessage[];
  estimatedTokens: number;
  appendedMessages: number;
  appendedTokens: number;
  evictedMessages: number;
  evictedTokens: number;
  overBudget: boolean;
} {
  const liveMessages = params.liveMessages.map(normalizeLiveMessageForAssemblyReconciliation);
  const protectedAssembledIndexes = expandProtectedToolPairIndexes({
    assembledMessages: params.assembledMessages,
    protectedAssembledIndexes: params.protectedAssembledIndexes ?? new Set<number>(),
  });
  const uncovered = collectUncoveredVolatileLiveInputs({
    assembledMessages: params.assembledMessages,
    liveMessages,
  });
  if (uncovered.entries.length === 0) {
    return {
      messages: params.assembledMessages,
      estimatedTokens: params.assembledEstimatedTokens,
      appendedMessages: 0,
      appendedTokens: 0,
      evictedMessages: 0,
      evictedTokens: 0,
      overBudget: params.assembledEstimatedTokens > params.tokenBudget,
    };
  }

  let retained = params.assembledMessages.map((message, index) => ({ message, index }));
  let appendedEntries = uncovered.entries.slice();
  const toolPairIndexesByIndex = buildToolPairIndexesByAssembledIndex(params.assembledMessages);
  const exactLiveSortIndexes = resolveExactAssembledLiveSortIndexes({
    assembledMessages: params.assembledMessages,
    liveMessages,
  });
  const exactLiveProtectedIndexes = expandProtectedToolPairIndexes({
    assembledMessages: params.assembledMessages,
    protectedAssembledIndexes: new Set(exactLiveSortIndexes.keys()),
  });
  const liveSortIndexes = expandToolPairLiveSortIndexes({
    assembledMessages: params.assembledMessages,
    liveSortIndexes: mergeCoveredVolatileLiveSortIndexes({
      exactLiveSortIndexes,
      coveredEntriesByAssembledIndex: uncovered.coveredEntriesByAssembledIndex,
    }),
  });
  let evictedMessages = 0;
  let evictedTokens = 0;
  let output = buildVolatileLiveInputMergedOutput({
    retained,
    appendedEntries,
    liveSortIndexes,
  });
  let estimatedTokens = estimateAgentMessageTokens(output);

  while (retained.length > 0 && estimatedTokens > params.tokenBudget) {
    let bestCandidate:
      | {
          evictAssembledIndexes: Set<number>;
          output: AgentMessage[];
          estimatedTokens: number;
          appendedEntries: VolatileLiveInputEntry[];
        }
      | undefined;
    for (let evictIndex = 0; evictIndex < retained.length; evictIndex++) {
      const entry = retained[evictIndex] as RetainedAssembledEntry;
      const evictAssembledIndexes = toolPairIndexesByIndex.get(entry.index) ?? new Set([entry.index]);
      const candidateEvictsExactLiveTurn = Array.from(evictAssembledIndexes).some((index) =>
        exactLiveProtectedIndexes.has(index)
      );
      const candidateEvictsProtectedTurn = Array.from(evictAssembledIndexes).some((index) =>
        protectedAssembledIndexes.has(index)
      );
      if (candidateEvictsExactLiveTurn || candidateEvictsProtectedTurn) {
        continue;
      }
      const restoredCoveredEntries = Array.from(evictAssembledIndexes).flatMap(
        (index) => uncovered.coveredEntriesByAssembledIndex.get(index) ?? [],
      );
      const candidateRetained = retained.filter(
        (retainedEntry) => !evictAssembledIndexes.has(retainedEntry.index),
      );
      const candidateAppendedEntries =
        restoredCoveredEntries.length > 0
          ? [...appendedEntries, ...restoredCoveredEntries]
          : appendedEntries;
      const candidateOutput = buildVolatileLiveInputMergedOutput({
        retained: candidateRetained,
        appendedEntries: candidateAppendedEntries,
        liveSortIndexes,
      });
      const candidateEstimatedTokens = estimateAgentMessageTokens(candidateOutput);
      const candidateFits = candidateEstimatedTokens <= params.tokenBudget;
      const bestFits =
        bestCandidate !== undefined && bestCandidate.estimatedTokens <= params.tokenBudget;
      if (
        bestCandidate === undefined ||
        (candidateFits && !bestFits) ||
        (candidateFits &&
          bestFits &&
          candidateEstimatedTokens > bestCandidate.estimatedTokens) ||
        (!candidateFits &&
          !bestFits &&
          candidateEstimatedTokens < bestCandidate.estimatedTokens)
      ) {
        bestCandidate = {
          evictAssembledIndexes,
          output: candidateOutput,
          estimatedTokens: candidateEstimatedTokens,
          appendedEntries: candidateAppendedEntries,
        };
      }
    }
    if (!bestCandidate) {
      break;
    }
    const removedEntries = retained.filter((entry) =>
      bestCandidate.evictAssembledIndexes.has(entry.index),
    );
    retained = retained.filter((entry) => !bestCandidate.evictAssembledIndexes.has(entry.index));
    appendedEntries = bestCandidate.appendedEntries;
    for (const removed of removedEntries) {
      uncovered.coveredEntriesByAssembledIndex.delete(removed.index);
      evictedTokens += toStoredMessage(removed.message).tokenCount;
    }
    evictedMessages += removedEntries.length;
    output = bestCandidate.output;
    estimatedTokens = bestCandidate.estimatedTokens;
  }
  const appendedMessages = materializeVolatileLiveInputEntries(appendedEntries);

  return {
    messages: output,
    estimatedTokens,
    appendedMessages: appendedMessages.length,
    appendedTokens: estimateAgentMessageTokens(appendedMessages),
    evictedMessages,
    evictedTokens,
    overBudget: estimatedTokens > params.tokenBudget,
  };
}

// ── LcmContextEngine ────────────────────────────────────────────────────────

type TranscriptReconcileResult = {
  blockedByImportCap: boolean;
  blockedReason?: "import-cap" | "cross-conversation-raw-id";
  importedMessages: number;
  hasOverlap: boolean;
};

export class LcmContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo;

  private config: LcmConfig;

  /** Get the configured timezone, falling back to system timezone. */
  get timezone(): string {
    return this.config.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  /**
   * v4.2 §B — read-only window into the resolved config so tools that
   * need a config-bound value (e.g. `lcm_describe` validating paths
   * under `largeFilesDir`) can ask without mutating engine state.
   */
  get configView(): Pick<LcmConfig, "largeFilesDir" | "stubLargeToolPayloads"> {
    return {
      largeFilesDir: this.config.largeFilesDir,
      stubLargeToolPayloads: this.config.stubLargeToolPayloads,
    };
  }

  private conversationStore: ConversationStore;
  private summaryStore: SummaryStore;
  private focusBriefStore: FocusBriefStore;
  private compactionTelemetryStore: CompactionTelemetryStore;
  private compactionMaintenanceStore: CompactionMaintenanceStore;
  private assembler: ContextAssembler;
  private compaction: CompactionEngine;
  private retrieval: RetrievalEngine;
  private readonly db: DatabaseSync;
  private migrated = false;
  private readonly fts5Available: boolean;
  private readonly ignoreSessionPatterns: RegExp[];
  private readonly statelessSessionPatterns: RegExp[];
  private sessionOperationQueues = new Map<
    string,
    { promise: Promise<void>; refCount: number }
  >();
  private previousAssembledMessagesByConversation = new Map<number, AssemblePrefixSnapshot>();
  private recentBootstrapImportsByConversation = new Map<number, BootstrapImportObservation>();
  private largeFileTextSummarizerResolved = false;
  private largeFileTextSummarizer?: (prompt: string) => Promise<string | null>;
  private deps: LcmDependencies;

  // ── Circuit breaker for compaction auth failures ──
  private circuitBreakerStates = new Map<string, CircuitBreakerState>();

  constructor(deps: LcmDependencies, database: DatabaseSync) {
    this.deps = deps;
    this.config = deps.config;
    this.ignoreSessionPatterns = compileSessionPatterns(this.config.ignoreSessionPatterns);
    this.statelessSessionPatterns = compileSessionPatterns(this.config.statelessSessionPatterns);
    this.db = database;

    // Run migrations eagerly at construction time so the schema exists
    // before any lifecycle hook fires.
    let migrationOk = false;
    const migrationStartedAt = Date.now();
    try {
      runLcmMigrations(this.db, {
        log: this.deps.log,
      });
      this.migrated = true;

      // Verify tables were actually created
      const tables = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>;
      if (tables.length === 0) {
        this.deps.log.warn(
          "[lcm] Migration completed but database has zero tables — DB may be non-functional",
        );
      } else {
        migrationOk = true;
        this.deps.log.debug(
          `[lcm] Migration run completed during engine init: duration=${formatDurationMs(Date.now() - migrationStartedAt)} fts5=${this.fts5Available}`,
        );
        this.deps.log.debug(
          `[lcm] Migration successful — ${tables.length} tables: ${tables.map((t) => t.name).join(", ")}`,
        );
      }
    } catch (err) {
      this.deps.log.error(
        `[lcm] Migration failed after ${formatDurationMs(Date.now() - migrationStartedAt)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.fts5Available = getLcmDbFeatures(this.db).fts5Available;

    // Only claim ownership of compaction when the DB is operational.
    // Without a working schema, ownsCompaction would disable the runtime's
    // built-in compaction safeguard and inflate the context budget.
    this.info = {
      id: "lossless-claw",
      name: "Lossless Context Management Engine",
      version: "0.1.0",
      ownsCompaction: migrationOk,
      turnMaintenanceMode: "background",
      hostRequirements: {
        "agent-run": {
          requiredCapabilities: LOSSLESS_AGENT_RUN_REQUIRED_HOST_CAPABILITIES,
          unsupportedMessage: [
            "lossless-claw requires a native OpenClaw runtime with the full context-engine agent-run lifecycle.",
            "Use the native Codex or Pi embedded runtime, or switch plugins.slots.contextEngine to legacy for CLI harness runs.",
          ].join(" "),
        },
      },
    } as ContextEngineInfo;

    this.conversationStore = new ConversationStore(this.db, {
      fts5Available: this.fts5Available,
    });
    this.summaryStore = new SummaryStore(this.db, { fts5Available: this.fts5Available });
    this.focusBriefStore = new FocusBriefStore(this.db);
    this.compactionTelemetryStore = new CompactionTelemetryStore(this.db);
    this.compactionMaintenanceStore = new CompactionMaintenanceStore(this.db);

    if (!this.fts5Available) {
      this.deps.log.warn(
        "[lcm] FTS5 unavailable in the current Node runtime; full_text search will fall back to LIKE and indexing is disabled",
      );
    }
    if (this.config.ignoreSessionPatterns.length > 0) {
      const source = describeLcmConfigSource(
        this.deps.configDiagnostics?.ignoreSessionPatternsSource ?? "default",
      );
      logStartupBannerOnce({
        key: "ignore-session-patterns",
        log: (message) => this.deps.log.info(message),
        message: `[lcm] Ignoring sessions matching ${this.config.ignoreSessionPatterns.length} pattern(s) from ${source}: ${this.config.ignoreSessionPatterns.join(", ")}`,
      });
    }
    if (this.config.statelessSessionPatterns.length > 0) {
      const source = describeLcmConfigSource(
        this.deps.configDiagnostics?.statelessSessionPatternsSource ?? "default",
      );
      const enforcement = this.config.skipStatelessSessions ? "" : " (skipStatelessSessions=false)";
      logStartupBannerOnce({
        key: "stateless-session-patterns",
        log: (message) => this.deps.log.info(message),
        message: `[lcm] Stateless session patterns${enforcement} from ${source}: ${this.config.statelessSessionPatterns.length} pattern(s): ${this.config.statelessSessionPatterns.join(", ")}`,
      });
    }
    this.assembler = new ContextAssembler(
      this.conversationStore,
      this.summaryStore,
      this.config.timezone,
      this.focusBriefStore,
    );

    const compactionConfig: CompactionConfig = {
      contextThreshold: this.config.contextThreshold,
      freshTailCount: this.config.freshTailCount,
      freshTailMaxTokens: this.config.freshTailMaxTokens,
      leafMinFanout: this.config.leafMinFanout,
      condensedMinFanout: this.config.condensedMinFanout,
      condensedMinFanoutHard: this.config.condensedMinFanoutHard,
      sweepMaxDepth: this.config.sweepMaxDepth,
      incrementalMaxDepth: this.config.incrementalMaxDepth,
      leafChunkTokens: this.config.leafChunkTokens,
      summaryPrefixTargetTokens: this.config.summaryPrefixTargetTokens,
      maxSweepIterations: this.config.maxSweepIterations,
      sweepDeadlineMs: this.config.sweepDeadlineMs,
      compactUntilUnderDeadlineMs: this.config.compactUntilUnderDeadlineMs,
      leafTargetTokens: this.config.leafTargetTokens,
      condensedTargetTokens: this.config.condensedTargetTokens,
      maxRounds: 10,
      timezone: this.config.timezone,
      summaryMaxOverageFactor: this.config.summaryMaxOverageFactor,
    };
    this.compaction = new CompactionEngine(
      this.conversationStore,
      this.summaryStore,
      compactionConfig,
      this.deps.log,
    );

    this.retrieval = new RetrievalEngine(this.conversationStore, this.summaryStore);
  }

  /**
   * Check whether a session should be excluded from LCM processing.
   *
   * We prefer sessionKey matching because the configured glob patterns are
   * documented in terms of session keys, but we fall back to sessionId for
   * older call sites that may not provide the key yet.
   */
  private shouldIgnoreSession(params: { sessionId?: string; sessionKey?: string }): boolean {
    if (this.ignoreSessionPatterns.length === 0) {
      return false;
    }

    const candidate =
      typeof params.sessionKey === "string" && params.sessionKey.trim()
        ? params.sessionKey.trim()
        : (params.sessionId?.trim() ?? "");
    if (!candidate) {
      return false;
    }

    return matchesSessionPattern(candidate, this.ignoreSessionPatterns);
  }

  /** Check whether a session key should skip all LCM writes while remaining readable. */
  isStatelessSession(sessionKey: string | undefined): boolean {
    const trimmedKey = typeof sessionKey === "string" ? sessionKey.trim() : "";
    if (
      !this.config.skipStatelessSessions
      || !trimmedKey
      || this.statelessSessionPatterns.length === 0
    ) {
      return false;
    }
    return matchesSessionPattern(trimmedKey, this.statelessSessionPatterns);
  }

  // ── Circuit breaker helpers ──────────────────────────────────────────────

  private getCircuitBreakerState(key: string): CircuitBreakerState {
    let state = this.circuitBreakerStates.get(key);
    if (!state) {
      state = { failures: 0, openSince: null };
      this.circuitBreakerStates.set(key, state);
    }
    return state;
  }

  private isCircuitBreakerOpen(key: string): boolean {
    const state = this.circuitBreakerStates.get(key);
    if (!state || state.openSince === null) return false;
    const elapsed = Date.now() - state.openSince;
    if (elapsed >= this.config.circuitBreakerCooldownMs) {
      this.resetCircuitBreaker(key);
      return false;
    }
    return true;
  }

  private recordCompactionAuthFailure(key: string): void {
    const state = this.getCircuitBreakerState(key);
    state.failures++;
    const halfThreshold = Math.ceil(this.config.circuitBreakerThreshold / 2);
    if (state.failures === halfThreshold && state.failures < this.config.circuitBreakerThreshold) {
      this.deps.log.warn(
        `[lcm] WARNING: compaction degraded — ${state.failures}/${this.config.circuitBreakerThreshold} consecutive auth failures for ${key}`,
      );
    }
    if (state.failures >= this.config.circuitBreakerThreshold) {
      state.openSince = Date.now();
      const cooldownMin = Math.round(this.config.circuitBreakerCooldownMs / 60000);
      this.deps.log.warn(
        `[lcm] CIRCUIT BREAKER OPEN: compaction disabled for ${key}. Auto-retry in ${cooldownMin}m. LCM is operating in degraded mode.`,
      );
    }
  }

  private recordCompactionSuccess(key: string): void {
    const state = this.circuitBreakerStates.get(key);
    if (!state) {
      return;
    }
    if (state.failures > 0 || state.openSince !== null) {
      this.deps.log.info(
        `[lcm] compaction circuit breaker CLOSED: successful compaction for ${key} after ${state.failures} prior failures.`,
      );
    }
    this.resetCircuitBreaker(key);
  }

  private resetCircuitBreaker(key: string): void {
    this.circuitBreakerStates.delete(key);
  }

  /** Ensure DB schema is up-to-date. Called lazily on first bootstrap/ingest/assemble/compact. */
  private ensureMigrated(): void {
    if (this.migrated) {
      return;
    }
    const migrationStartedAt = Date.now();
    this.deps.log.debug("[lcm] ensureMigrated: running migrations lazily");
    runLcmMigrations(this.db, {
      log: this.deps.log,
    });
    this.migrated = true;
    this.deps.log.debug(
      `[lcm] ensureMigrated: completed in ${formatDurationMs(Date.now() - migrationStartedAt)}`,
    );
  }

  /**
   * Serialize mutating operations per stable session identity to prevent
   * ingest/compaction races across runtime UUID recycling.
   */
  private async withSessionQueue<T>(
    queueKey: string,
    operation: () => Promise<T>,
    options?: { operationName?: string; context?: string },
  ): Promise<T> {
    const entry = this.sessionOperationQueues.get(queueKey);
    const previous = entry?.promise ?? Promise.resolve();
    const queuedAhead = entry?.refCount ?? 0;
    let releaseQueue: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    const next = previous.catch(() => {}).then(() => current);

    if (entry) {
      entry.promise = next;
      entry.refCount++;
    } else {
      this.sessionOperationQueues.set(queueKey, { promise: next, refCount: 1 });
    }

    const waitStartedAt = Date.now();
    await previous.catch(() => {});
    const waitMs = Date.now() - waitStartedAt;
    if (options?.operationName) {
      const detail = options.context ? ` ${options.context}` : "";
      this.deps.log.debug(
        `[lcm] ${options.operationName}: session queue acquired queueKey=${queueKey} queuedAhead=${queuedAhead} wait=${formatDurationMs(waitMs)}${detail}`,
      );
    }
    try {
      return await operation();
    } finally {
      releaseQueue();
      const cur = this.sessionOperationQueues.get(queueKey);
      if (cur && --cur.refCount === 0) {
        this.sessionOperationQueues.delete(queueKey);
      }
    }
  }

  /** Prefer stable session keys for queue serialization when available. */
  private resolveSessionQueueKey(sessionId?: string, sessionKey?: string): string {
    const normalizedSessionKey = sessionKey?.trim();
    const normalizedSessionId = sessionId?.trim();
    return normalizedSessionKey || normalizedSessionId || "__lcm__";
  }

  /** Normalize optional live token estimates supplied by runtime callers. */
  private normalizeObservedTokenCount(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return undefined;
    }
    return Math.floor(value);
  }

  /** Resolve token budget from direct params or legacy fallback input. */
  private resolveTokenBudget(params: {
    tokenBudget?: number;
    runtimeContext?: Record<string, unknown>;
    legacyParams?: Record<string, unknown>;
  }): number | undefined {
    const lp = asRecord(params.runtimeContext) ?? params.legacyParams ?? {};
    if (
      typeof params.tokenBudget === "number" &&
      Number.isFinite(params.tokenBudget) &&
      params.tokenBudget > 0
    ) {
      return Math.floor(params.tokenBudget);
    }
    if (
      typeof lp.tokenBudget === "number" &&
      Number.isFinite(lp.tokenBudget) &&
      lp.tokenBudget > 0
    ) {
      return Math.floor(lp.tokenBudget);
    }
    return undefined;
  }

  /** Cap a resolved token budget against the configured maxAssemblyTokenBudget. */
  private applyAssemblyBudgetCap(budget: number): number {
    const cap = this.config.maxAssemblyTokenBudget;
    return cap != null && cap > 0 ? Math.min(budget, cap) : budget;
  }

  /** Normalize token counters that may legitimately be zero. */
  private normalizeOptionalCount(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return undefined;
    }
    return Math.floor(value);
  }

  /** Extract the current prompt-cache snapshot from runtime context, if present. */
  private readPromptCacheSnapshot(runtimeContext?: Record<string, unknown>): PromptCacheSnapshot | null {
    const promptCache = asRecord(runtimeContext?.promptCache);
    const provider = safeString(runtimeContext?.provider)?.trim()
      ?? safeString(runtimeContext?.providerId)?.trim();
    const model = safeString(runtimeContext?.model)?.trim()
      ?? safeString(runtimeContext?.modelId)?.trim();
    if (!promptCache && !provider && !model) {
      return null;
    }

    const lastCallUsage = asRecord(promptCache?.lastCallUsage);
    const observation = asRecord(promptCache?.observation);
    const cacheRead = this.normalizeOptionalCount(lastCallUsage?.cacheRead);
    const cacheWrite = this.normalizeOptionalCount(lastCallUsage?.cacheWrite);
    const promptTokenCount = (() => {
      const input = this.normalizeOptionalCount(lastCallUsage?.input) ?? 0;
      const total = input + (cacheRead ?? 0) + (cacheWrite ?? 0);
      return total > 0 ? total : undefined;
    })();
    const sawExplicitBreak = safeBoolean(observation?.broke) === true;
    const retention = safeString(promptCache?.retention)?.trim();
    const lastCacheTouchAtRaw = promptCache?.lastCacheTouchAt;
    const lastCacheTouchAt =
      typeof lastCacheTouchAtRaw === "number" && Number.isFinite(lastCacheTouchAtRaw)
        ? new Date(lastCacheTouchAtRaw)
        : undefined;
    const hasUsageSignal = cacheRead !== undefined || cacheWrite !== undefined;
    const hasObservationSignal =
      typeof observation?.cacheRead === "number"
      || typeof observation?.previousCacheRead === "number"
      || sawExplicitBreak;

    let cacheState: CacheState = "unknown";
    if (sawExplicitBreak) {
      cacheState = "cold";
    } else if (typeof cacheRead === "number" && cacheRead > 0) {
      cacheState = "hot";
    } else if (typeof cacheWrite === "number" && cacheWrite > 0) {
      cacheState = "hot";
    } else if (hasUsageSignal || hasObservationSignal) {
      cacheState = "cold";
    }

    return {
      ...(cacheRead !== undefined ? { lastObservedCacheRead: cacheRead } : {}),
      ...(cacheWrite !== undefined ? { lastObservedCacheWrite: cacheWrite } : {}),
      ...(promptTokenCount !== undefined
        ? { lastObservedPromptTokenCount: promptTokenCount }
        : {}),
      cacheState,
      ...(retention ? { retention } : {}),
      sawExplicitBreak,
      ...(lastCacheTouchAt ? { lastCacheTouchAt } : {}),
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
    };
  }

  /** Persist the current turn's compaction telemetry for later policy decisions. */
  private async updateCompactionTelemetry(params: {
    conversationId: number;
    runtimeContext?: Record<string, unknown>;
    tokenBudget?: number;
    rawTokensOutsideTail?: number;
  }): Promise<ConversationCompactionTelemetryRecord | null> {
    const snapshot = this.readPromptCacheSnapshot(params.runtimeContext);
    const existing = await this.compactionTelemetryStore.getConversationCompactionTelemetry(
      params.conversationId,
    );
    if (!snapshot && params.rawTokensOutsideTail === undefined) {
      return existing;
    }

    const now = new Date();
    const turnsSinceLeafCompaction =
      (existing?.turnsSinceLeafCompaction ?? 0) + 1;
    const tokensAccumulatedSinceLeafCompaction =
      params.rawTokensOutsideTail ?? existing?.tokensAccumulatedSinceLeafCompaction ?? 0;
    const touchedPromptCache =
      snapshot?.lastCacheTouchAt
      ?? (
        snapshot
        && (snapshot.lastObservedCacheRead !== undefined || snapshot.lastObservedCacheWrite !== undefined)
          ? now
          : existing?.lastCacheTouchAt ?? null
      );
    const consecutiveColdObservations =
      snapshot?.sawExplicitBreak
        ? Math.max(existing?.consecutiveColdObservations ?? 0, 1)
        : snapshot?.cacheState === "hot"
          ? 0
          : snapshot?.cacheState === "cold"
            ? (existing?.consecutiveColdObservations ?? 0) + 1
            : existing?.consecutiveColdObservations ?? 0;
    await this.compactionTelemetryStore.upsertConversationCompactionTelemetry({
      conversationId: params.conversationId,
      lastObservedCacheRead: snapshot?.lastObservedCacheRead ?? existing?.lastObservedCacheRead ?? null,
      lastObservedCacheWrite:
        snapshot?.lastObservedCacheWrite ?? existing?.lastObservedCacheWrite ?? null,
      lastObservedPromptTokenCount:
        snapshot?.lastObservedPromptTokenCount ?? existing?.lastObservedPromptTokenCount ?? null,
      lastObservedCacheHitAt:
        snapshot?.cacheState === "hot"
          ? now
          : existing?.lastObservedCacheHitAt ?? null,
      lastObservedCacheBreakAt:
        snapshot?.sawExplicitBreak
          ? now
          : existing?.lastObservedCacheBreakAt ?? null,
      cacheState: snapshot?.cacheState ?? existing?.cacheState ?? "unknown",
      consecutiveColdObservations,
      retention: snapshot?.retention ?? existing?.retention ?? null,
      lastLeafCompactionAt: existing?.lastLeafCompactionAt ?? null,
      turnsSinceLeafCompaction,
      tokensAccumulatedSinceLeafCompaction,
      lastActivityBand: existing?.lastActivityBand ?? "low",
      lastApiCallAt: now,
      lastCacheTouchAt: touchedPromptCache,
      provider: snapshot?.provider ?? existing?.provider ?? null,
      model: snapshot?.model ?? existing?.model ?? null,
    });
    const updated = await this.compactionTelemetryStore.getConversationCompactionTelemetry(
      params.conversationId,
    );
    if (updated) {
      this.deps.log.debug(
        `[lcm] compaction telemetry updated: conversation=${params.conversationId} cacheState=${updated.cacheState} coldObservationStreak=${updated.consecutiveColdObservations} cacheRead=${updated.lastObservedCacheRead ?? "null"} cacheWrite=${updated.lastObservedCacheWrite ?? "null"} promptTokenCount=${updated.lastObservedPromptTokenCount ?? "null"} retention=${updated.retention ?? "null"} lastApiCallAt=${updated.lastApiCallAt?.toISOString() ?? "null"} lastCacheTouchAt=${updated.lastCacheTouchAt?.toISOString() ?? "null"} provider=${updated.provider ?? "null"} model=${updated.model ?? "null"} turnsSinceLeafCompaction=${updated.turnsSinceLeafCompaction} tokensSinceLeafCompaction=${updated.tokensAccumulatedSinceLeafCompaction} activityBand=${updated.lastActivityBand} rawTokensOutsideTail=${params.rawTokensOutsideTail ?? "null"} tokenBudget=${params.tokenBudget ?? "null"}`,
      );
    }
    return updated;
  }

  /** Reset refill counters after successful summary-producing compaction. */
  private async markLeafCompactionTelemetrySuccess(params: {
    conversationId: number;
  }): Promise<void> {
    const existing = await this.compactionTelemetryStore.getConversationCompactionTelemetry(
      params.conversationId,
    );
    await this.compactionTelemetryStore.upsertConversationCompactionTelemetry({
      conversationId: params.conversationId,
      lastObservedCacheRead: existing?.lastObservedCacheRead ?? null,
      lastObservedCacheWrite: existing?.lastObservedCacheWrite ?? null,
      lastObservedPromptTokenCount: existing?.lastObservedPromptTokenCount ?? null,
      lastObservedCacheHitAt: existing?.lastObservedCacheHitAt ?? null,
      lastObservedCacheBreakAt: existing?.lastObservedCacheBreakAt ?? null,
      cacheState: existing?.cacheState ?? "unknown",
      consecutiveColdObservations: existing?.consecutiveColdObservations ?? 0,
      retention: existing?.retention ?? null,
      lastLeafCompactionAt: new Date(),
      turnsSinceLeafCompaction: 0,
      tokensAccumulatedSinceLeafCompaction: 0,
      lastActivityBand: existing?.lastActivityBand ?? "low",
      lastApiCallAt: existing?.lastApiCallAt ?? null,
      lastCacheTouchAt: existing?.lastCacheTouchAt ?? null,
      provider: existing?.provider ?? null,
      model: existing?.model ?? null,
    });
    this.deps.log.debug(
      `[lcm] compaction telemetry reset after compaction: conversation=${params.conversationId} cacheState=${existing?.cacheState ?? "unknown"} activityBand=${existing?.lastActivityBand ?? "low"}`,
    );
  }

  /** Persist a coalesced proactive-compaction debt record for later maintenance. */
  private async recordDeferredCompactionDebt(params: {
    conversationId: number;
    reason: string;
    tokenBudget: number;
    currentTokenCount?: number;
  }): Promise<void> {
    await this.compactionMaintenanceStore.requestProactiveCompactionDebt({
      conversationId: params.conversationId,
      reason: params.reason,
      tokenBudget: params.tokenBudget,
      currentTokenCount: params.currentTokenCount ?? null,
    });
    this.deps.log.debug(
      `[lcm] deferred compaction debt recorded: conversation=${params.conversationId} reason=${params.reason} tokenBudget=${params.tokenBudget} currentTokenCount=${params.currentTokenCount ?? "null"}`,
    );
  }

  /** Try deferred compaction later without letting it jump ahead of foreground work. */
  private scheduleDeferredCompactionDebtDrain(params: DeferredCompactionDebtDrainParams): void {
    const queueKey = this.resolveSessionQueueKey(params.sessionId, params.sessionKey);
    setImmediate(() => {
      void this.drainDeferredCompactionDebtIfIdle({
        ...params,
        queueKey,
      }).catch((err) => {
        this.deps.log.warn(
          `[lcm] background deferred compaction failed conversation=${params.conversationId} session=${params.sessionId}: ${describeLogError(err)}`,
        );
      });
    });
  }

  /**
   * Consume durable threshold debt only when the session queue is idle.
   *
   * Any skipped busy-queue attempt leaves the maintenance row pending for
   * assemble() or a later host-approved maintain() pass.
   */
  private async drainDeferredCompactionDebtIfIdle(
    params: DeferredCompactionDebtDrainParams & { queueKey: string },
  ): Promise<void> {
    const sessionLabel = [
      `session=${params.sessionId}`,
      ...(params.sessionKey?.trim() ? [`sessionKey=${params.sessionKey.trim()}`] : []),
    ].join(" ");
    if (this.sessionOperationQueues.has(params.queueKey)) {
      this.deps.log.debug(
        `[lcm] background deferred compaction skipped conversation=${params.conversationId} ${sessionLabel} reason=session-queue-busy debtReason=${params.reason}`,
      );
      return;
    }

    await this.withSessionQueue(
      params.queueKey,
      async () => {
        const maintenance =
          await this.compactionMaintenanceStore.getConversationCompactionMaintenance(
            params.conversationId,
          );
        if (!maintenance?.pending && !maintenance?.running) {
          this.deps.log.debug(
            `[lcm] background deferred compaction skipped conversation=${params.conversationId} ${sessionLabel} reason=no-pending-debt debtReason=${params.reason}`,
          );
          return;
        }

        const cappedTokenBudget = this.applyAssemblyBudgetCap(params.tokenBudget);
        const telemetry =
          await this.compactionTelemetryStore.getConversationCompactionTelemetry(
            params.conversationId,
          );
        const legacyParams =
          telemetry?.provider || telemetry?.model
            ? {
                ...(telemetry.provider ? { provider: telemetry.provider } : {}),
                ...(telemetry.model ? { model: telemetry.model } : {}),
              }
            : undefined;
        const result = await this.consumeDeferredCompactionDebt({
          conversationId: params.conversationId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          tokenBudget: cappedTokenBudget,
          currentTokenCount: params.currentTokenCount,
          legacyParams,
        });
        if (result) {
          this.deps.log.debug(
            `[lcm] background deferred compaction done conversation=${params.conversationId} ${sessionLabel} changed=${result.changed} reason=${result.reason ?? "none"} debtReason=${maintenance.reason ?? params.reason}`,
          );
        }
      },
      {
        operationName: "backgroundDeferredCompaction",
        context: sessionLabel,
      },
    );
  }

  /**
   * Consume deferred proactive-compaction debt while the caller already holds
   * the per-session queue.
   */
  private async consumeDeferredCompactionDebt(params: {
    conversationId: number;
    sessionId: string;
    sessionKey?: string;
    tokenBudget: number;
    currentTokenCount?: number;
    runtimeContext?: ContextEngineMaintenanceRuntimeContext;
    legacyParams?: Record<string, unknown>;
  }): Promise<ContextEngineMaintenanceResult | null> {
    const maintenance = await this.compactionMaintenanceStore.getConversationCompactionMaintenance(
      params.conversationId,
    );
    if (!maintenance?.pending && !maintenance?.running) {
      return null;
    }

    const sessionLabel = [
      `session=${params.sessionId}`,
      ...(params.sessionKey?.trim() ? [`sessionKey=${params.sessionKey.trim()}`] : []),
    ].join(" ");

    await this.compactionMaintenanceStore.markProactiveCompactionRunning({
      conversationId: params.conversationId,
      startedAt: new Date(),
    });

    try {
      const recordedTokenBudget =
        maintenance.tokenBudget && maintenance.tokenBudget > 0
          ? maintenance.tokenBudget
          : null;
      const resolvedTokenBudget = this.applyAssemblyBudgetCap(
        recordedTokenBudget != null
          ? Math.min(params.tokenBudget, recordedTokenBudget)
          : params.tokenBudget,
      );
      const resolvedCurrentTokenCount = this.normalizeObservedTokenCount(
        params.currentTokenCount ?? maintenance.currentTokenCount ?? undefined,
      );

      const isThresholdDebt = maintenance.reason?.trim() === "threshold";
      if (!isThresholdDebt) {
        const thresholdDecision = await this.compaction.evaluate(
          params.conversationId,
          resolvedTokenBudget,
          resolvedCurrentTokenCount,
        );
        if (!thresholdDecision.shouldCompact) {
          const result: CompactResult = {
            ok: true,
            compacted: false,
            reason: "legacy deferred compaction no longer needed",
          };
          await this.compactionMaintenanceStore.markProactiveCompactionFinished({
            conversationId: params.conversationId,
            finishedAt: new Date(),
            failureSummary: null,
            keepPending: false,
          });
          this.deps.log.debug(
            `[lcm] maintain: cleared legacy deferred compaction debt conversation=${params.conversationId} ${sessionLabel} debtReason=${maintenance.reason ?? "null"}`,
          );
          return {
            changed: result.compacted,
            bytesFreed: 0,
            rewrittenEntries: 0,
            reason: result.reason,
          };
        }
      }

      const result = await this.executeCompactionCore({
        conversationId: params.conversationId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        tokenBudget: resolvedTokenBudget,
        currentTokenCount: resolvedCurrentTokenCount,
        compactionTarget: "threshold",
        runtimeContext: params.runtimeContext,
        legacyParams: params.legacyParams,
      });
      await this.compactionMaintenanceStore.markProactiveCompactionFinished({
        conversationId: params.conversationId,
        finishedAt: new Date(),
        failureSummary: result.ok ? null : result.reason ?? "deferred compaction failed",
        keepPending: !result.ok,
      });
      this.deps.log.debug(
        `[lcm] maintain: deferred compaction ${result.compacted ? "completed" : "skipped"} conversation=${params.conversationId} ${sessionLabel} changed=${result.compacted} ok=${result.ok} reason=${result.reason ?? "none"}`,
      );
      return {
        changed: result.compacted,
        bytesFreed: 0,
        rewrittenEntries: 0,
        ...(result.reason ? { reason: result.reason } : {}),
      };
    } catch (error) {
      await this.compactionMaintenanceStore.markProactiveCompactionFinished({
        conversationId: params.conversationId,
        finishedAt: new Date(),
        failureSummary: error instanceof Error ? error.message : String(error),
        keepPending: true,
      });
      this.deps.log.warn(
        `[lcm] maintain: deferred compaction failed conversation=${params.conversationId} ${sessionLabel}: ${describeLogError(error)}`,
      );
      return {
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
        reason: error instanceof Error ? error.message : "deferred compaction failed",
      };
    }
  }

  /**
   * Re-check and consume deferred debt for assemble() while holding the
   * session queue so pre-assembly writes cannot race queued maintenance.
   */
  private async maybeConsumeDeferredCompactionDebtForAssemble(params: {
    conversationId: number;
    sessionId: string;
    sessionKey?: string;
    tokenBudget: number;
    currentTokenCount?: number;
  }): Promise<void> {
    const sessionLabel = [
      `session=${params.sessionId}`,
      ...(params.sessionKey?.trim() ? [`sessionKey=${params.sessionKey.trim()}`] : []),
    ].join(" ");
    await this.withSessionQueue(
      this.resolveSessionQueueKey(params.sessionId, params.sessionKey),
      async () => {
        const maintenance =
          await this.compactionMaintenanceStore.getConversationCompactionMaintenance(
            params.conversationId,
          );
        if (!maintenance?.pending && !maintenance?.running) {
          return;
        }

        const cappedTokenBudget = this.applyAssemblyBudgetCap(params.tokenBudget);
        const normalizedCurrentTokenCount = this.normalizeObservedTokenCount(
          params.currentTokenCount,
        );
        const telemetry =
          await this.compactionTelemetryStore.getConversationCompactionTelemetry(
            params.conversationId,
          );
        const deferredLegacyParams =
          telemetry?.provider || telemetry?.model
            ? {
                ...(telemetry.provider ? { provider: telemetry.provider } : {}),
                ...(telemetry.model ? { model: telemetry.model } : {}),
              }
            : undefined;
        await this.consumeDeferredCompactionDebt({
          conversationId: params.conversationId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          tokenBudget: cappedTokenBudget,
          currentTokenCount: normalizedCurrentTokenCount,
          legacyParams: deferredLegacyParams,
        });
      },
      {
        operationName: "assembleDeferredCompaction",
        context: sessionLabel,
      },
    );
  }

  /** Run the actual compaction body without taking the per-session queue. */
  private async executeCompactionCore(params: CompactionExecutionParams): Promise<CompactResult> {
    const startedAt = Date.now();
    const sessionLabel = [
      `session=${params.sessionId}`,
      ...(params.sessionKey?.trim() ? [`sessionKey=${params.sessionKey.trim()}`] : []),
    ].join(" ");
    const { force = false } = params;
    const legacyParams = asRecord(params.runtimeContext) ?? params.legacyParams;
    const lp = legacyParams ?? {};
    const manualCompactionRequested =
      (
        lp as {
          manualCompaction?: unknown;
        }
      ).manualCompaction === true;
    const forceCompaction = force || manualCompactionRequested;
    const resolvedTokenBudget = this.resolveTokenBudget({
      tokenBudget: params.tokenBudget,
      runtimeContext: params.runtimeContext,
      legacyParams,
    });
    const tokenBudget = resolvedTokenBudget
      ? this.applyAssemblyBudgetCap(resolvedTokenBudget)
      : resolvedTokenBudget;
    if (!tokenBudget) {
      return {
        ok: false,
        compacted: false,
        reason: "missing token budget in compact params",
      };
    }

    const { summarize, summaryModel, breakerKey } = await this.resolveSummarize({
      legacyParams: this.buildSummarizerLegacyParams({
        legacyParams,
        sessionKey: params.sessionKey,
      }),
      customInstructions: params.customInstructions,
      breakerScope: this.resolveSessionQueueKey(params.sessionId, params.sessionKey),
    });
    if (breakerKey && this.isCircuitBreakerOpen(breakerKey)) {
      return {
        ok: true,
        compacted: false,
        reason: "circuit breaker open",
      };
    }

    const conversationId = params.conversationId;
    const observedTokens = this.normalizeObservedTokenCount(
      params.currentTokenCount ??
        (
          lp as {
            currentTokenCount?: unknown;
          }
        ).currentTokenCount,
    );
    const decision =
      observedTokens !== undefined
        ? await this.compaction.evaluate(conversationId, tokenBudget, observedTokens)
        : await this.compaction.evaluate(conversationId, tokenBudget);
    const targetTokens =
      params.compactionTarget === "threshold" ? decision.threshold : tokenBudget;
    const liveContextStillExceedsTarget =
      observedTokens !== undefined && observedTokens >= targetTokens;
    // Codex can report a live prompt count that includes runtime framing,
    // tool schemas, and other overhead not present in Lossless's stored count.
    // If that live count crosses the threshold, compact stored context far
    // enough that stored tokens plus the observed overhead should fit.
    const decisionStoredTokens =
      typeof decision.storedTokens === "number"
      && Number.isFinite(decision.storedTokens)
      && decision.storedTokens >= 0
        ? Math.floor(decision.storedTokens)
        : decision.currentTokens;
    const observedRuntimeOverhead =
      params.compactionTarget === "threshold" && observedTokens !== undefined
        ? Math.max(0, observedTokens - decisionStoredTokens)
        : 0;
    const runtimeAdjustedSweepTargetTokens =
      observedRuntimeOverhead > 0 && observedTokens !== undefined && observedTokens > targetTokens
        ? Math.max(1, targetTokens - observedRuntimeOverhead)
        : undefined;

    this.deps.log.info(
      `[lcm] compact: decision conversation=${conversationId} ${sessionLabel} compactionTarget=${params.compactionTarget ?? "budget"} force=${forceCompaction} tokenBudget=${tokenBudget} targetTokens=${targetTokens} storedTokens=${decisionStoredTokens} currentTokens=${decision.currentTokens} observedTokens=${observedTokens ?? "none"} observedRuntimeOverhead=${observedRuntimeOverhead} shouldCompact=${decision.shouldCompact}`,
    );

    if (!forceCompaction && !decision.shouldCompact) {
      this.deps.log.info(
        `[lcm] compact: done conversation=${conversationId} ${sessionLabel} ok=true compacted=false reason=below_threshold tokensBefore=${decision.currentTokens} duration=${formatDurationMs(Date.now() - startedAt)}`,
      );
      return {
        ok: true,
        compacted: false,
        reason: "below threshold",
        result: {
          tokensBefore: decision.currentTokens,
        },
      };
    }

    // Forced budget recovery should use the capped convergence loop so live
    // overflow counts can drive recovery even when persisted context is already small.
    const useSweep = manualCompactionRequested || params.compactionTarget === "threshold";
    if (useSweep) {
      const sweepResult = await this.compaction.compact({
        conversationId,
        tokenBudget,
        summarize,
        force: forceCompaction || runtimeAdjustedSweepTargetTokens !== undefined,
        hardTrigger: false,
        summaryModel,
        ...(runtimeAdjustedSweepTargetTokens !== undefined
          ? { stopAtTokens: runtimeAdjustedSweepTargetTokens }
          : {}),
      });

      if (sweepResult.authFailure && breakerKey) {
        this.recordCompactionAuthFailure(breakerKey);
      } else if (sweepResult.actionTaken && breakerKey) {
        this.recordCompactionSuccess(breakerKey);
      }
      if (sweepResult.actionTaken) {
        await this.markLeafCompactionTelemetrySuccess({ conversationId });
      }
      const sweepTokensAfter =
        typeof sweepResult.tokensAfter === "number" && Number.isFinite(sweepResult.tokensAfter)
          ? sweepResult.tokensAfter
          : undefined;
      const projectedTokensAfterSweep =
        sweepTokensAfter !== undefined && runtimeAdjustedSweepTargetTokens !== undefined
          ? sweepTokensAfter + observedRuntimeOverhead
          : sweepTokensAfter;
      const isThresholdSweep = params.compactionTarget === "threshold";
      const isUnderTargetAfterSweep =
        projectedTokensAfterSweep !== undefined
          ? projectedTokensAfterSweep <= targetTokens
          : isThresholdSweep
            ? false
            : !liveContextStillExceedsTarget;
      const thresholdSweepStillOverTarget =
        isThresholdSweep && sweepResult.actionTaken && !isUnderTargetAfterSweep;
      const sweepOk =
        !sweepResult.authFailure &&
        (isUnderTargetAfterSweep || (sweepResult.actionTaken && !isThresholdSweep));
      const sweepReason = sweepResult.authFailure
        ? (sweepResult.actionTaken
            ? "provider auth failure after partial compaction"
            : "provider auth failure")
        : thresholdSweepStillOverTarget
          ? "compacted but still over target"
        : sweepResult.actionTaken
          ? "compacted"
          : isUnderTargetAfterSweep
            ? "already under target"
            : manualCompactionRequested
              ? "nothing to compact"
              : "live context still exceeds target";
      this.deps.log.info(
        `[lcm] compact: done conversation=${conversationId} ${sessionLabel} ok=${sweepOk} compacted=${sweepResult.actionTaken} reason=${sweepReason.replaceAll(" ", "_")} tokensBefore=${decision.currentTokens} tokensAfter=${sweepResult.tokensAfter} createdSummaryId=${sweepResult.createdSummaryId ?? "none"} duration=${formatDurationMs(Date.now() - startedAt)}`,
      );

      return {
        ok: sweepOk,
        compacted: sweepResult.actionTaken,
        reason: sweepReason,
        result: {
          tokensBefore: decision.currentTokens,
          tokensAfter: sweepResult.tokensAfter,
          details: {
            rounds: sweepResult.actionTaken ? 1 : 0,
            targetTokens: runtimeAdjustedSweepTargetTokens ?? targetTokens,
            ...(runtimeAdjustedSweepTargetTokens !== undefined
              ? {
                  observedOverheadTokens: observedRuntimeOverhead,
                  projectedTokensAfter: projectedTokensAfterSweep,
                }
              : {}),
          },
        },
      };
    }

    // When forced, use the token budget as target
    const convergenceTargetTokens = forceCompaction
      ? tokenBudget
      : params.compactionTarget === "threshold"
        ? decision.threshold
        : tokenBudget;

    // When forced (overflow recovery) and the caller did not supply an
    // observed token count, assume we are at least at the token budget so
    // compactUntilUnder does not bail with "already under target" while the
    // live context is actually overflowing.
    const effectiveCurrentTokens =
      observedTokens !== undefined
        ? observedTokens
        : forceCompaction
          ? tokenBudget
          : undefined;
    const compactResult = await this.compaction.compactUntilUnder({
      conversationId,
      tokenBudget,
      targetTokens: convergenceTargetTokens,
      ...(effectiveCurrentTokens !== undefined ? { currentTokens: effectiveCurrentTokens } : {}),
      summarize,
      summaryModel,
    });

    if (compactResult.authFailure && breakerKey) {
      this.recordCompactionAuthFailure(breakerKey);
    } else if (compactResult.rounds > 0 && breakerKey) {
      this.recordCompactionSuccess(breakerKey);
    }

    const didCompact = compactResult.rounds > 0;
    if (didCompact) {
      await this.markLeafCompactionTelemetrySuccess({ conversationId });
    }

    const compactUntilReason = compactResult.authFailure
      ? (didCompact
          ? "provider auth failure after partial compaction"
          : "provider auth failure")
      : compactResult.success
        ? didCompact
          ? "compacted"
          : "already under target"
        : "could not reach target";
    this.deps.log.info(
      `[lcm] compact: done conversation=${conversationId} ${sessionLabel} ok=${compactResult.success} compacted=${didCompact} reason=${compactUntilReason.replaceAll(" ", "_")} tokensBefore=${decision.currentTokens} tokensAfter=${compactResult.finalTokens} rounds=${compactResult.rounds} duration=${formatDurationMs(Date.now() - startedAt)}`,
    );

    return {
      ok: compactResult.success,
      compacted: didCompact,
      reason: compactUntilReason,
      result: {
        tokensBefore: decision.currentTokens,
        tokensAfter: compactResult.finalTokens,
        details: {
          rounds: compactResult.rounds,
          targetTokens: convergenceTargetTokens,
        },
      },
    };
  }

  /** Resolve an LCM conversation id from a session key via the session store. */
  private async resolveConversationIdForSessionKey(
    sessionKey: string,
  ): Promise<number | undefined> {
    const trimmedKey = sessionKey.trim();
    if (!trimmedKey) {
      return undefined;
    }
    try {
      const bySessionKey = await this.conversationStore.getConversationForSession({
        sessionKey: trimmedKey,
      });
      if (bySessionKey) {
        return bySessionKey.conversationId;
      }

      const runtimeSessionId = await this.deps.resolveSessionIdFromSessionKey(trimmedKey);
      if (!runtimeSessionId) {
        return undefined;
      }
      const conversation = await this.conversationStore.getConversationForSession({
        sessionId: runtimeSessionId,
      });
      return conversation?.conversationId;
    } catch {
      return undefined;
    }
  }

  /** Format stable session identifiers for LCM diagnostic logs. */
  private formatSessionLogContext(params: {
    conversationId: number;
    sessionId: string;
    sessionKey?: string;
  }): string {
    const parts = [
      `conversation=${params.conversationId}`,
      `session=${params.sessionId}`,
    ];
    const trimmedSessionKey = params.sessionKey?.trim();
    if (trimmedSessionKey) {
      parts.push(`sessionKey=${trimmedSessionKey}`);
    }
    return parts.join(" ");
  }

  /** Attach session identity to summarizer params without mutating host runtimeContext objects. */
  private buildSummarizerLegacyParams(params: {
    legacyParams?: Record<string, unknown>;
    sessionKey?: string;
  }): Record<string, unknown> | undefined {
    const trimmedSessionKey = params.sessionKey?.trim();
    if (!params.legacyParams && !trimmedSessionKey) {
      return undefined;
    }
    const next = { ...(params.legacyParams ?? {}) };
    if (trimmedSessionKey && typeof next.sessionKey !== "string") {
      next.sessionKey = trimmedSessionKey;
    }
    return next;
  }

  /** Build a summarize callback with runtime provider fallback handling. */
  private async resolveSummarize(params: {
    legacyParams?: Record<string, unknown>;
    customInstructions?: string;
    breakerScope: string;
  }): Promise<{
    summarize: (text: string, aggressive?: boolean) => Promise<string>;
    summaryModel: string;
    breakerKey?: string;
  }> {
    const lp = params.legacyParams ?? {};
    if (typeof lp.summarize === "function") {
      return {
        summarize: lp.summarize as (text: string, aggressive?: boolean) => Promise<string>,
        summaryModel: "unknown",
        breakerKey: `custom:${params.breakerScope}`,
      };
    }
    try {
      const customInstructions =
        params.customInstructions !== undefined
          ? params.customInstructions
          : (this.config.customInstructions || undefined);
      const runtimeSummarizer = await createLcmSummarizeFromLegacyParams({
        deps: this.deps,
        legacyParams: lp,
        customInstructions,
      });
      if (runtimeSummarizer) {
        return {
          summarize: runtimeSummarizer.fn,
          summaryModel: runtimeSummarizer.model,
          breakerKey: runtimeSummarizer.breakerKey,
        };
      }
      this.deps.log.error(`[lcm] resolveSummarize: createLcmSummarizeFromLegacyParams returned undefined`);
    } catch (err) {
      this.deps.log.error(
        `[lcm] resolveSummarize failed, using emergency fallback: ${describeLogError(err)}`,
      );
    }
    this.deps.log.error(`[lcm] resolveSummarize: FALLING BACK TO EMERGENCY TRUNCATION`);
    return { summarize: createEmergencyFallbackSummarize(), summaryModel: "unknown" };
  }

  /**
   * Resolve an optional model-backed summarizer for large text file exploration.
   *
   * This is opt-in via env so ingest remains deterministic and lightweight when
   * no summarization model is configured.
   */
  private async resolveLargeFileTextSummarizer(): Promise<
    ((prompt: string) => Promise<string | null>) | undefined
  > {
    if (this.largeFileTextSummarizerResolved) {
      return this.largeFileTextSummarizer;
    }
    this.largeFileTextSummarizerResolved = true;

    const provider = this.deps.config.largeFileSummaryProvider;
    const model = this.deps.config.largeFileSummaryModel;
    if (!provider || !model) {
      return undefined;
    }

    try {
      const result = await createLcmSummarizeFromLegacyParams({
        deps: this.deps,
        legacyParams: {
          provider,
          model,
          modelConfigField: "largeFileSummaryModel",
          modelConfigPath: "plugins.entries.lossless-claw.config.largeFileSummaryModel",
        },
        customInstructions: this.config.customInstructions || undefined,
      });
      if (!result) {
        return undefined;
      }

      this.largeFileTextSummarizer = async (prompt: string): Promise<string | null> => {
        let summary: string;
        try {
          summary = await result.fn(prompt, false);
        } catch (err) {
          if (err instanceof LcmProviderAuthError) {
            return null;
          }
          throw err;
        }
        if (typeof summary !== "string") {
          return null;
        }
        const trimmed = summary.trim();
        return trimmed.length > 0 ? trimmed : null;
      };
      return this.largeFileTextSummarizer;
    } catch {
      return undefined;
    }
  }

  // ── Image detection & externalization ──────────────────────────────────────

  private static readonly BASE64_IMAGE_MAGIC: ReadonlyArray<{
    prefix: string;
    extension: string;
    mimeType: string;
  }> = [
    { prefix: "/9j/", extension: "jpg", mimeType: "image/jpeg" },
    { prefix: "iVBOR", extension: "png", mimeType: "image/png" },
    { prefix: "R0lGOD", extension: "gif", mimeType: "image/gif" },
    { prefix: "UklGR", extension: "webp", mimeType: "image/webp" },
    { prefix: "PHN2Zy", extension: "svg", mimeType: "image/svg+xml" },
  ];

  private static detectBase64ImageType(
    base64Data: string,
  ): { extension: string; mimeType: string } | null {
    for (const sig of LcmContextEngine.BASE64_IMAGE_MAGIC) {
      if (base64Data.startsWith(sig.prefix)) {
        return { extension: sig.extension, mimeType: sig.mimeType };
      }
    }
    return null;
  }

  private static extensionForImageMimeType(mimeType: string): string | null {
    switch (mimeType.toLowerCase()) {
      case "image/jpeg":
      case "image/jpg":
        return "jpg";
      case "image/png":
        return "png";
      case "image/gif":
        return "gif";
      case "image/webp":
        return "webp";
      case "image/svg+xml":
        return "svg";
      case "image/heic":
        return "heic";
      case "image/avif":
        return "avif";
      case "image/bmp":
        return "bmp";
      default:
        return null;
    }
  }

  private static normalizeNativeImageBlock(value: unknown): {
    base64Data: string;
    extension: string;
    mimeType: string;
  } | null {
    const record = asRecord(value);
    if (!record || record.type !== "image") {
      return null;
    }

    const rawData = safeString(record.data);
    if (!rawData) {
      return null;
    }

    const dataUrlMatch = rawData.match(/^data:([^;,]+);base64,(.*)$/s);
    const declaredMimeType =
      dataUrlMatch?.[1] ??
      safeString(record.mimeType) ??
      safeString(record.mime_type) ??
      safeString(record.mediaType) ??
      safeString(record.media_type);
    const base64Data = (dataUrlMatch?.[2] ?? rawData).replace(/\s+/g, "");
    if (!base64Data || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64Data)) {
      return null;
    }

    const detected = LcmContextEngine.detectBase64ImageType(base64Data);
    const mimeType = detected?.mimeType ?? declaredMimeType;
    if (!mimeType?.toLowerCase().startsWith("image/")) {
      return null;
    }

    const extension = detected?.extension ?? LcmContextEngine.extensionForImageMimeType(mimeType);
    return extension ? { base64Data, extension, mimeType } : null;
  }

  private static basenameForImageReference(pathLike: string): string | null {
    const baseName = pathLike.trim().split(/[\\/]/).filter(Boolean).pop();
    if (!baseName) {
      return null;
    }
    return baseName.replace(/[^\w.\-@]+/g, "_") || null;
  }

  private static inferNativeImageFileName(params: {
    content: unknown[];
    imageIndex: number;
    extension: string;
    role?: string;
  }): string {
    for (let index = params.imageIndex - 1; index >= 0; index -= 1) {
      const entry = asRecord(params.content[index]);
      const text = entry?.type === "text" ? safeString(entry.text) : undefined;
      if (!text) {
        continue;
      }

      const mediaMatch = text.match(/\[media attached(?:\s+\d+\/\d+)?:\s*([^\s\]|()]+)/i);
      const fileName = mediaMatch?.[1]
        ? LcmContextEngine.basenameForImageReference(mediaMatch[1])
        : null;
      if (fileName) {
        return fileName;
      }
    }

    const rolePrefix =
      params.role === "assistant"
        ? "assistant"
        : params.role === "system"
          ? "system"
          : params.role === "tool" || params.role === "toolResult"
            ? "tool"
            : "user";
    return `${rolePrefix}-image.${params.extension}`;
  }

  private static isExternalizedImageReference(value: string): boolean {
    if (typeof value !== "string") return false;
    return LcmContextEngine.IMAGE_REFERENCE_REGEX.test(value.trim());
  }

  private static isExternalizedReferenceContent(value: string): boolean {
    const trimmed = value.trim();
    return (
      trimmed.startsWith("[LCM File:") ||
      trimmed.startsWith("[LCM Tool Output:") ||
      trimmed.includes("LCM file: file_") ||
      LcmContextEngine.IMAGE_REFERENCE_REGEX_GLOBAL.test(trimmed)
    );
  }

  /** Image references emitted by `externalizeImage` can use either role-specific
   *  labels (`User image`, `Assistant image`, `System image`, `Tool image`) or
   *  the generic `Image` label used by pure-base64 user/system content. */
  private static readonly IMAGE_REFERENCE_REGEX =
    /^\[(?:(?:User|System|Tool|Assistant) image|Image): [^\]]*LCM file: file_[a-f0-9]{16}\]$/;
  private static readonly IMAGE_REFERENCE_REGEX_GLOBAL =
    /\[(?:(?:User|System|Tool|Assistant) image|Image): [^\]]*LCM file: file_[a-f0-9]{16}\]/;

  /** Stricter form of `isExternalizedReferenceContent` used by the
   *  raw-payload externalizer's skip gate. Returns true when the message's
   *  stored content was produced by a *wholesale-replacement* externalizer
   *  (large-file / tool-output / raw-payload — each emits content that
   *  starts with the canonical reference header, optionally followed by an
   *  exploration-summary preamble), or when the whole trimmed content is a
   *  single image-only reference (rare).
   *
   *  Mixed content like `"...intro... [User image: file_xyz] ... long body
   *  text..."` is NOT considered wholly externalized — those messages must
   *  remain eligible for raw-payload externalization when they exceed the
   *  size threshold. */
  private static isWhollyExternalizedReferenceContent(value: string): boolean {
    const trimmed = value.trim();
    if (trimmed.length === 0) return false;
    if (
      trimmed.startsWith("[LCM File:") ||
      trimmed.startsWith("[LCM Tool Output:") ||
      trimmed.startsWith("[LCM Raw Payload:")
    ) {
      return true;
    }
    return LcmContextEngine.IMAGE_REFERENCE_REGEX.test(trimmed);
  }

  /** Resolve the configured externalized-payload directory for one conversation. */
  private largeFilesDirForConversation(conversationId: number): string {
    return join(this.config.largeFilesDir, String(conversationId));
  }

  private async storeImageFileContent(params: {
    conversationId: number;
    fileId: string;
    extension: string;
    base64Data: string;
  }): Promise<string> {
    const dir = this.largeFilesDirForConversation(params.conversationId);
    await mkdir(dir, { recursive: true });
    const normalized = params.extension.replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin";
    const filePath = join(dir, `${params.fileId}.${normalized}`);
    const buffer = Buffer.from(params.base64Data, "base64");
    await writeFile(filePath, buffer);
    return filePath;
  }

  private async externalizeImage(params: {
    conversationId: number;
    base64Data: string;
    fileName?: string;
    extension: string;
    mimeType: string;
    label: string;
  }): Promise<{ fileId: string; byteSize: number; summary: string; reference: string }> {
    const fileId = `file_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const byteSize = Buffer.from(params.base64Data, "base64").byteLength;
    const storageUri = await this.storeImageFileContent({
      conversationId: params.conversationId,
      fileId,
      extension: params.extension,
      base64Data: params.base64Data,
    });
    const fileName = params.fileName ?? `image.${params.extension}`;
    const summary = `Image file (${params.extension.toUpperCase()}, ${byteSize.toLocaleString("en-US")} bytes)${params.fileName ? ` — ${params.fileName}` : ""}`;

    await this.summaryStore.insertLargeFile({
      fileId,
      conversationId: params.conversationId,
      fileName,
      mimeType: params.mimeType,
      byteSize,
      storageUri,
      explorationSummary: summary,
    });

    const reference = `[${params.label}: ${fileName} (${params.mimeType}, ${byteSize.toLocaleString("en-US")} bytes) | LCM file: ${fileId}]`;
    return { fileId, byteSize, summary, reference };
  }

  private async interceptNativeImageBlocks(params: {
    conversationId: number;
    message: AgentMessage;
  }): Promise<{ rewrittenMessage: AgentMessage; fileIds: string[] } | null> {
    if (!("content" in params.message)) {
      return null;
    }
    const role = (params.message as { role?: unknown }).role;
    // Cover every persistable role — `hasPersistableMessageRole` accepts
    // user/assistant/system/tool/toolResult, so this gate must too. A system
    // message carrying native `{type:"image"}` blocks would otherwise fall
    // through to the generic raw-payload externalizer and be stored as a
    // `raw-system-payload.json` blob with embedded base64.
    if (
      role !== "user" &&
      role !== "assistant" &&
      role !== "system" &&
      role !== "tool" &&
      role !== "toolResult"
    ) {
      return null;
    }
    if (!Array.isArray(params.message.content)) {
      return null;
    }

    const label =
      role === "assistant"
        ? "Assistant image"
        : role === "system"
          ? "System image"
          : role === "tool" || role === "toolResult"
            ? "Tool image"
            : "User image";

    const rewrittenContent: unknown[] = [];
    const fileIds: string[] = [];
    let changed = false;

    for (let index = 0; index < params.message.content.length; index += 1) {
      const block = params.message.content[index];
      const image = LcmContextEngine.normalizeNativeImageBlock(block);
      if (!image) {
        rewrittenContent.push(block);
        continue;
      }

      const externalized = await this.externalizeImage({
        conversationId: params.conversationId,
        base64Data: image.base64Data,
        fileName: LcmContextEngine.inferNativeImageFileName({
          content: params.message.content,
          imageIndex: index,
          extension: image.extension,
          role: typeof role === "string" ? role : undefined,
        }),
        extension: image.extension,
        mimeType: image.mimeType,
        label,
      });

      rewrittenContent.push({ type: "text", text: externalized.reference });
      fileIds.push(externalized.fileId);
      changed = true;
    }

    if (!changed) {
      return null;
    }

    return {
      rewrittenMessage: {
        ...params.message,
        content: rewrittenContent,
      } as AgentMessage,
      fileIds,
    };
  }

  private async interceptInlineImages(params: {
    conversationId: number;
    content: string;
    role: string;
  }): Promise<{ rewrittenContent: string; fileIds: string[] } | null> {
    const mediaResult = await this.interceptUserMediaBase64(params);
    if (mediaResult) {
      return mediaResult;
    }
    return this.interceptPureBase64Image(params);
  }

  private async interceptUserMediaBase64(params: {
    conversationId: number;
    content: string;
  }): Promise<{ rewrittenContent: string; fileIds: string[] } | null> {
    const prefix = "[media attached:";
    if (!params.content.startsWith(prefix)) {
      return null;
    }

    const base64LineRe = /\n([A-Za-z0-9+/]{20,}={0,2})\n/m;
    const base64Match = base64LineRe.exec(params.content);
    if (!base64Match) {
      return null;
    }

    const headerEnd = base64Match.index + 1;
    const header = params.content.slice(0, headerEnd).trim();
    const base64Data = params.content.slice(headerEnd);

    if (estimateTokens(base64Data) < 100) {
      return null;
    }

    const detected = LcmContextEngine.detectBase64ImageType(base64Data);
    if (!detected) {
      return null;
    }

    const pathMatch = header.match(/\[media attached:\s*([^\s(]+)/);
    const fileName = pathMatch ? pathMatch[1] : `user-image.${detected.extension}`;

    const externalized = await this.externalizeImage({
      conversationId: params.conversationId,
      base64Data,
      fileName,
      extension: detected.extension,
      mimeType: detected.mimeType,
      label: "User image",
    });

    return {
      rewrittenContent: `${header}\n\n${externalized.reference}`,
      fileIds: [externalized.fileId],
    };
  }

  private async interceptPureBase64Image(params: {
    conversationId: number;
    content: string;
    role: string;
  }): Promise<{ rewrittenContent: string; fileIds: string[] } | null> {
    const trimmed = params.content.trim();
    if (estimateTokens(trimmed) < 100) {
      return null;
    }

    const detected = LcmContextEngine.detectBase64ImageType(trimmed);
    if (!detected) {
      return null;
    }

    const b64Chars = trimmed.replace(/[^A-Za-z0-9+/=\s]/g, "");
    if (b64Chars.length / trimmed.length < 0.8) {
      return null;
    }

    const label = params.role === "tool" ? "Tool image" :
                  params.role === "assistant" ? "Assistant image" : "Image";
    const fileName = `${params.role}-image.${detected.extension}`;

    const externalized = await this.externalizeImage({
      conversationId: params.conversationId,
      base64Data: trimmed,
      fileName,
      extension: detected.extension,
      mimeType: detected.mimeType,
      label,
    });

    return {
      rewrittenContent: externalized.reference,
      fileIds: [externalized.fileId],
    };
  }

  /**
   * Walk tool-result payload blocks and replace pure inline image strings with
   * compact references before generic text-output externalization runs.
   */
  private async rewriteToolInlineImageValue(params: {
    conversationId: number;
    value: unknown;
  }): Promise<{ rewrittenValue: unknown; fileIds: string[]; changed: boolean }> {
    if (typeof params.value === "string") {
      const intercepted = await this.interceptPureBase64Image({
        conversationId: params.conversationId,
        content: params.value,
        role: "tool",
      });
      if (!intercepted) {
        return { rewrittenValue: params.value, fileIds: [], changed: false };
      }
      return {
        rewrittenValue: intercepted.rewrittenContent,
        fileIds: intercepted.fileIds,
        changed: true,
      };
    }

    if (Array.isArray(params.value)) {
      const rewrittenValues: unknown[] = [];
      const fileIds: string[] = [];
      let changed = false;

      for (const entry of params.value) {
        const rewritten = await this.rewriteToolInlineImageValue({
          conversationId: params.conversationId,
          value: entry,
        });
        rewrittenValues.push(rewritten.rewrittenValue);
        fileIds.push(...rewritten.fileIds);
        changed ||= rewritten.changed;
      }

      return changed
        ? { rewrittenValue: rewrittenValues, fileIds, changed: true }
        : { rewrittenValue: params.value, fileIds: [], changed: false };
    }

    if (!params.value || typeof params.value !== "object") {
      return { rewrittenValue: params.value, fileIds: [], changed: false };
    }

    const record = params.value as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      const intercepted = await this.interceptPureBase64Image({
        conversationId: params.conversationId,
        content: record.text,
        role: "tool",
      });
      if (!intercepted) {
        return { rewrittenValue: params.value, fileIds: [], changed: false };
      }
      return {
        rewrittenValue: {
          ...record,
          text: intercepted.rewrittenContent,
        },
        fileIds: intercepted.fileIds,
        changed: true,
      };
    }

    const nestedKeys = ["output", "content", "result"] as const;
    const rewrittenRecord: Record<string, unknown> = { ...record };
    const fileIds: string[] = [];
    let changed = false;

    for (const key of nestedKeys) {
      if (!(key in record)) {
        continue;
      }
      const rewritten = await this.rewriteToolInlineImageValue({
        conversationId: params.conversationId,
        value: record[key],
      });
      if (!rewritten.changed) {
        continue;
      }
      rewrittenRecord[key] = rewritten.rewrittenValue;
      fileIds.push(...rewritten.fileIds);
      changed = true;
    }

    return changed
      ? { rewrittenValue: rewrittenRecord, fileIds, changed: true }
      : { rewrittenValue: params.value, fileIds: [], changed: false };
  }

  private async interceptInlineImagesInToolMessage(params: {
    conversationId: number;
    message: AgentMessage;
  }): Promise<{ rewrittenMessage: AgentMessage; fileIds: string[] } | null> {
    if (
      (params.message.role !== "toolResult" && params.message.role !== "tool") ||
      !("content" in params.message)
    ) {
      return null;
    }

    if (typeof params.message.content === "string") {
      const intercepted = await this.interceptPureBase64Image({
        conversationId: params.conversationId,
        content: params.message.content,
        role: "tool",
      });
      if (!intercepted) {
        return null;
      }
      return {
        rewrittenMessage: {
          ...params.message,
          content: intercepted.rewrittenContent,
        } as AgentMessage,
        fileIds: intercepted.fileIds,
      };
    }

    if (!Array.isArray(params.message.content)) {
      return null;
    }

    const rewrittenContent: unknown[] = [];
    const fileIds: string[] = [];
    let changed = false;

    for (const item of params.message.content) {
      const rewritten = await this.rewriteToolInlineImageValue({
        conversationId: params.conversationId,
        value: item,
      });
      rewrittenContent.push(rewritten.rewrittenValue);
      fileIds.push(...rewritten.fileIds);
      changed ||= rewritten.changed;
    }

    if (!changed) {
      return null;
    }

    return {
      rewrittenMessage: {
        ...params.message,
        content: rewrittenContent,
      } as AgentMessage,
      fileIds,
    };
  }

  /** Persist intercepted large-file text payloads to the configured lcm-files directory. */
  private async storeLargeFileContent(params: {
    conversationId: number;
    fileId: string;
    extension: string;
    content: string;
  }): Promise<string> {
    const dir = this.largeFilesDirForConversation(params.conversationId);
    await mkdir(dir, { recursive: true });

    const normalizedExtension = params.extension.replace(/[^a-z0-9]/gi, "").toLowerCase() || "txt";
    const filePath = join(dir, `${params.fileId}.${normalizedExtension}`);
    await writeFile(filePath, params.content, "utf8");
    return filePath;
  }

  /** Persist a large text payload and return the resulting compact placeholder. */
  private async externalizeLargeTextPayload(params: {
    conversationId: number;
    content: string;
    fileName?: string;
    mimeType?: string;
    formatReference: (input: { fileId: string; byteSize: number; summary: string }) => string;
  }): Promise<{ fileId: string; byteSize: number; summary: string; reference: string }> {
    const summarizeText = await this.resolveLargeFileTextSummarizer();
    const fileId = `file_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const extension = extensionFromNameOrMime(params.fileName, params.mimeType);
    const storageUri = await this.storeLargeFileContent({
      conversationId: params.conversationId,
      fileId,
      extension,
      content: params.content,
    });
    const byteSize = Buffer.byteLength(params.content, "utf8");
    const explorationSummary = await generateExplorationSummary({
      content: params.content,
      fileName: params.fileName,
      mimeType: params.mimeType,
      summarizeText,
    });

    await this.summaryStore.insertLargeFile({
      fileId,
      conversationId: params.conversationId,
      fileName: params.fileName,
      mimeType: params.mimeType,
      byteSize,
      storageUri,
      explorationSummary,
    });

    return {
      fileId,
      byteSize,
      summary: explorationSummary,
      reference: params.formatReference({
        fileId,
        byteSize,
        summary: explorationSummary,
      }),
    };
  }

  /**
   * Return the most recent assembled snapshot for a conversation and refresh its
   * recency so the bounded debug cache behaves as an LRU.
   */
  private getPreviousAssembledSnapshot(conversationId: number): AssemblePrefixSnapshot | undefined {
    const snapshot = this.previousAssembledMessagesByConversation.get(conversationId);
    if (!snapshot) {
      return undefined;
    }
    this.previousAssembledMessagesByConversation.delete(conversationId);
    this.previousAssembledMessagesByConversation.set(conversationId, snapshot);
    return snapshot;
  }

  /**
   * Retain only a bounded number of recent assembled snapshots so debug-only
   * prefix instrumentation cannot grow without limit on long-lived servers.
   */
  private setPreviousAssembledSnapshot(
    conversationId: number,
    snapshot: AssemblePrefixSnapshot,
  ): void {
    this.previousAssembledMessagesByConversation.delete(conversationId);
    this.previousAssembledMessagesByConversation.set(conversationId, snapshot);
    while (this.previousAssembledMessagesByConversation.size > MAX_PREVIOUS_ASSEMBLED_SNAPSHOTS) {
      const oldestConversationId = this.previousAssembledMessagesByConversation.keys().next().value;
      if (typeof oldestConversationId !== "number") {
        break;
      }
      this.previousAssembledMessagesByConversation.delete(oldestConversationId);
    }
  }

  /** Store the latest bootstrap import count for assembly overflow diagnostics. */
  private recordRecentBootstrapImport(
    conversationId: number,
    importedMessages: number,
    reason: string | null,
  ): void {
    this.recentBootstrapImportsByConversation.delete(conversationId);
    this.recentBootstrapImportsByConversation.set(conversationId, {
      importedMessages: Math.max(0, Math.floor(importedMessages)),
      reason,
      observedAt: new Date(),
    });
    while (this.recentBootstrapImportsByConversation.size > MAX_PREVIOUS_ASSEMBLED_SNAPSHOTS) {
      const oldestConversationId = this.recentBootstrapImportsByConversation.keys().next().value;
      if (typeof oldestConversationId !== "number") {
        break;
      }
      this.recentBootstrapImportsByConversation.delete(oldestConversationId);
    }
  }

  /**
   * Intercept oversized <file> blocks before persistence and replace them with
   * compact file references backed by large_files records.
   */
  private async interceptLargeFiles(params: {
    conversationId: number;
    content: string;
  }): Promise<{ rewrittenContent: string; fileIds: string[] } | null> {
    const blocks = parseFileBlocks(params.content);
    if (blocks.length === 0) {
      return null;
    }

    const threshold = Math.max(1, this.config.largeFileTokenThreshold);
    const fileIds: string[] = [];
    const rewrittenSegments: string[] = [];
    let cursor = 0;
    let interceptedAny = false;

    for (const block of blocks) {
      const blockTokens = estimateTokens(block.text);
      if (blockTokens < threshold) {
        continue;
      }

      interceptedAny = true;
      const externalized = await this.externalizeLargeTextPayload({
        conversationId: params.conversationId,
        content: block.text,
        fileName: block.fileName,
        mimeType: block.mimeType,
        formatReference: ({ fileId, byteSize, summary }) =>
          formatFileReference({
            fileId,
            fileName: block.fileName,
            mimeType: block.mimeType,
            byteSize,
            summary,
          }),
      });

      rewrittenSegments.push(params.content.slice(cursor, block.start));
      rewrittenSegments.push(externalized.reference);
      cursor = block.end;
      fileIds.push(externalized.fileId);
    }

    if (!interceptedAny) {
      return null;
    }

    rewrittenSegments.push(params.content.slice(cursor));
    return {
      rewrittenContent: rewrittenSegments.join(""),
      fileIds,
    };
  }

  /** Externalize oversized textual tool outputs before they are persisted inline. */
  private async interceptLargeToolResults(params: {
    conversationId: number;
    message: AgentMessage;
  }): Promise<{ rewrittenMessage: AgentMessage; fileIds: string[] } | null> {
    if (
      (params.message.role !== "toolResult" && params.message.role !== "tool") ||
      !("content" in params.message)
    ) {
      return null;
    }

    // Convert string content to array format for unified processing.
    if (typeof params.message.content === "string") {
      params = {
        ...params,
        message: {
          ...params.message,
          content: [{ type: "text", text: params.message.content }],
        } as AgentMessage,
      };
    }

    if (!Array.isArray(params.message.content)) {
      return null;
    }

    const threshold = Math.max(1, this.config.largeFileTokenThreshold);
    const rewrittenContent: unknown[] = [];
    const fileIds: string[] = [];
    let interceptedAny = false;
    const topLevel = params.message as Record<string, unknown>;
    const topLevelToolCallId =
      safeString(topLevel.toolCallId) ??
      safeString(topLevel.tool_call_id) ??
      safeString(topLevel.toolUseId) ??
      safeString(topLevel.tool_use_id) ??
      safeString(topLevel.call_id) ??
      safeString(topLevel.id);
    const topLevelToolName =
      safeString(topLevel.toolName) ??
      safeString(topLevel.tool_name);
    const topLevelIsError =
      safeBoolean(topLevel.isError) ??
      safeBoolean(topLevel.is_error);

    for (const item of params.message.content) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        rewrittenContent.push(item);
        continue;
      }

      const record = item as Record<string, unknown>;
      const rawType = safeString(record.type);
      const isStructuredToolResult =
        rawType !== "tool_result" &&
        rawType !== "toolResult" &&
        rawType !== "function_call_output";
      const isPlainTextToolResult =
        rawType === "text" &&
        typeof record.text === "string";
      if (isStructuredToolResult && !isPlainTextToolResult) {
        rewrittenContent.push(item);
        continue;
      }

      const textSource =
        isPlainTextToolResult
          ? record.text
          : record.output !== undefined
          ? record.output
          : record.content !== undefined
            ? record.content
            : record;
      const extractedText = extractStructuredText(textSource);
      if (
        typeof extractedText === "string" &&
        LcmContextEngine.isExternalizedImageReference(extractedText)
      ) {
        rewrittenContent.push(item);
        continue;
      }
      if (typeof extractedText !== "string" || estimateTokens(extractedText) < threshold) {
        rewrittenContent.push(item);
        continue;
      }

      interceptedAny = true;
      const toolName =
        safeString(record.name) ??
        topLevelToolName ??
        "tool-result";
      const externalized = await this.externalizeLargeTextPayload({
        conversationId: params.conversationId,
        content: extractedText,
        fileName: `${toolName}.txt`,
        mimeType: "text/plain",
        formatReference: ({ fileId, byteSize, summary }) =>
          formatToolOutputReference({
            fileId,
            toolName,
            byteSize,
            summary,
          }),
      });

      const normalizedRawType =
        rawType === "function_call_output" ? "function_call_output" : "tool_result";
      const compactBlock: Record<string, unknown> = isPlainTextToolResult
        ? {
            type: "text",
            text: externalized.reference,
            rawType: normalizedRawType,
            externalizedFileId: externalized.fileId,
            originalByteSize: externalized.byteSize,
            toolOutputExternalized: true,
            externalizationReason: "large_tool_result",
          }
        : {
            type: normalizedRawType,
            output: externalized.reference,
            externalizedFileId: externalized.fileId,
            originalByteSize: externalized.byteSize,
            toolOutputExternalized: true,
            externalizationReason: "large_tool_result",
          };
      const callId =
        safeString(record.tool_use_id) ??
        safeString(record.toolUseId) ??
        safeString(record.tool_call_id) ??
        safeString(record.toolCallId) ??
        safeString(record.call_id) ??
        safeString(record.id) ??
        topLevelToolCallId;
      if (callId) {
        if (normalizedRawType === "function_call_output") {
          compactBlock.call_id = callId;
        } else {
          compactBlock.tool_use_id = callId;
        }
      }
      if (typeof record.is_error === "boolean") {
        compactBlock.is_error = record.is_error;
      } else if (typeof record.isError === "boolean") {
        compactBlock.isError = record.isError;
      } else if (typeof topLevelIsError === "boolean") {
        compactBlock.isError = topLevelIsError;
      }
      if (toolName) {
        compactBlock.name = toolName;
      }

      rewrittenContent.push(compactBlock);
      fileIds.push(externalized.fileId);
    }

    if (!interceptedAny) {
      return null;
    }

    return {
      rewrittenMessage: {
        ...params.message,
        content: rewrittenContent,
      } as AgentMessage,
      fileIds,
    };
  }

  /** Externalize oversized raw messages that survived role-specific interceptors. */
  private async interceptLargeRawPayload(params: {
    conversationId: number;
    message: AgentMessage;
    stored: StoredMessage;
  }): Promise<{ rewrittenMessage: AgentMessage; stored: StoredMessage } | null> {
    const threshold = Math.max(1, this.config.largeFileTokenThreshold);
    if (params.stored.tokenCount < threshold) {
      return null;
    }
    if (params.stored.role === "tool") {
      return null;
    }
    // Skip when this message has already been raw-payload-externalized, or
    // when its whole stored content is just an externalized reference.
    // Mixed content that embeds an image reference alongside other oversized
    // content remains eligible for raw-payload externalization.
    const externalizedFlag = (
      params.message as { rawPayloadExternalized?: unknown }
    ).rawPayloadExternalized;
    if (externalizedFlag === true) {
      return null;
    }
    if (LcmContextEngine.isWhollyExternalizedReferenceContent(params.stored.content)) {
      return null;
    }
    if ("content" in params.message && hasReplayCriticalRawBlock(params.message.content)) {
      return null;
    }

    const rawPayload = serializeRawPayloadContent(params.message, params.stored.content);
    if (!rawPayload || rawPayload.content.length === 0) {
      return null;
    }

    const role = typeof params.message.role === "string" ? params.message.role : params.stored.role;
    const externalized = await this.externalizeLargeTextPayload({
      conversationId: params.conversationId,
      content: rawPayload.content,
      fileName: `raw-${role}-payload.${rawPayload.mimeType === "application/json" ? "json" : "txt"}`,
      mimeType: rawPayload.mimeType,
      formatReference: ({ fileId, byteSize, summary }) =>
        formatRawPayloadReference({
          fileId,
          role,
          byteSize,
          reason: RAW_PAYLOAD_EXTERNALIZATION_REASON,
          summary,
        }),
    });

    const rewrittenMessage = {
      ...params.message,
      content: externalized.reference,
      rawPayloadExternalized: true,
      externalizedFileId: externalized.fileId,
      originalByteSize: externalized.byteSize,
      externalizationReason: RAW_PAYLOAD_EXTERNALIZATION_REASON,
    } as AgentMessage;

    return {
      rewrittenMessage,
      stored: {
        ...params.stored,
        content: externalized.reference,
        tokenCount: estimateTokens(externalized.reference),
      },
    };
  }

  // ── ContextEngine interface ─────────────────────────────────────────────

  /**
   * Reconcile a host-provided runtime history snapshot with persisted messages
   * and append only the tail that is missing from LCM.
   */
  private async reconcileSessionTail(params: {
    sessionId: string;
    sessionKey?: string;
    conversationId: number;
    historicalMessages: AgentMessage[];
    checkpointEntryHash?: string | null;
    skipContentAnchorScan?: boolean;
    allowNoAnchorImport?: boolean;
    noAnchorImportReason?: string;
  }): Promise<TranscriptReconcileResult> {
    const { sessionId, conversationId, historicalMessages } = params;
    const startedAt = Date.now();
    const sessionContext = this.formatSessionLogContext({
      conversationId,
      sessionId,
      sessionKey: params.sessionKey,
    });
    if (historicalMessages.length === 0) {
      this.deps.log.debug(
        `[lcm] reconcileSessionTail: skipped for ${sessionContext} duration=${formatDurationMs(Date.now() - startedAt)} historicalMessages=0 reason=empty-history`,
      );
      return { blockedByImportCap: false, importedMessages: 0, hasOverlap: false };
    }

    const latestDbMessage = await this.conversationStore.getLastMessage(conversationId);
    if (!latestDbMessage) {
      this.deps.log.debug(
        `[lcm] reconcileSessionTail: skipped for ${sessionContext} duration=${formatDurationMs(Date.now() - startedAt)} historicalMessages=${historicalMessages.length} reason=no-db-tail`,
      );
      return { blockedByImportCap: false, importedMessages: 0, hasOverlap: false };
    }
    const existingDbCount = await this.conversationStore.getMessageCount(conversationId);

    const storedHistoricalMessages = historicalMessages.map((message) => toStoredMessage(message));

    // Fast path: one tail comparison for the common in-sync case.
    const latestHistorical = storedHistoricalMessages[storedHistoricalMessages.length - 1];
    const latestIdentity = messageIdentity(latestDbMessage.role, latestDbMessage.content);
    if (
      !params.skipContentAnchorScan &&
      latestIdentity === messageIdentity(latestHistorical.role, latestHistorical.content)
    ) {
      const dbOccurrences = await this.conversationStore.countMessagesByIdentity(
        conversationId,
        latestDbMessage.role,
        latestDbMessage.content,
      );
      let historicalOccurrences = 0;
      for (const stored of storedHistoricalMessages) {
        if (messageIdentity(stored.role, stored.content) === latestIdentity) {
          historicalOccurrences += 1;
        }
      }
      if (dbOccurrences === historicalOccurrences) {
        this.deps.log.debug(
          `[lcm] reconcileSessionTail: fast path for ${sessionContext} duration=${formatDurationMs(Date.now() - startedAt)} historicalMessages=${historicalMessages.length} importedMessages=0 overlap=true`,
        );
        return { blockedByImportCap: false, importedMessages: 0, hasOverlap: true };
      }
    }

    // Slow path: walk backward through JSONL to find the most recent anchor
    // message that already exists in LCM, then append everything after it.
    let anchorIndex = -1;
    const historicalIdentityTotals = new Map<string, number>();
    for (const stored of storedHistoricalMessages) {
      const identity = messageIdentity(stored.role, stored.content);
      historicalIdentityTotals.set(identity, (historicalIdentityTotals.get(identity) ?? 0) + 1);
    }

    if (!params.skipContentAnchorScan) {
      const historicalIdentityCountsAfterIndex = new Map<string, number>();
      const dbIdentityCounts = new Map<string, number>();
      for (let index = storedHistoricalMessages.length - 1; index >= 0; index--) {
        const stored = storedHistoricalMessages[index];
        const identity = messageIdentity(stored.role, stored.content);
        const seenAfter = historicalIdentityCountsAfterIndex.get(identity) ?? 0;
        const total = historicalIdentityTotals.get(identity) ?? 0;
        const occurrencesThroughIndex = total - seenAfter;
        const exists = await this.conversationStore.hasMessage(
          conversationId,
          stored.role,
          stored.content,
        );
        historicalIdentityCountsAfterIndex.set(identity, seenAfter + 1);
        if (!exists) {
          continue;
        }

        let dbCountForIdentity = dbIdentityCounts.get(identity);
        if (dbCountForIdentity === undefined) {
          dbCountForIdentity = await this.conversationStore.countMessagesByIdentity(
            conversationId,
            stored.role,
            stored.content,
          );
          dbIdentityCounts.set(identity, dbCountForIdentity);
        }

        // Match the same occurrence index as the DB tail so repeated empty
        // tool messages do not anchor against a later, still-missing entry.
        if (dbCountForIdentity !== occurrencesThroughIndex) {
          continue;
        }

        anchorIndex = index;
        break;
      }
    }

    if (anchorIndex < 0) {
      const checkpointEntryHash = params.checkpointEntryHash;
      if (checkpointEntryHash) {
        // Externalized bootstrap rows no longer match raw JSONL content, so
        // fall back to the raw transcript checkpoint before declaring no overlap.
        for (let index = storedHistoricalMessages.length - 1; index >= 0; index--) {
          if (createBootstrapEntryHash(storedHistoricalMessages[index]) === checkpointEntryHash) {
            anchorIndex = index;
            break;
          }
        }
      }

      if (anchorIndex < 0) {
        if (params.allowNoAnchorImport) {
          const importCap = Math.max(Math.floor(existingDbCount * 0.2), 50);
          if (historicalMessages.length > importCap) {
            this.deps.log.warn(
              `[lcm] reconcileSessionTail: no anchor import cap exceeded for ${sessionContext} - would import ${historicalMessages.length} messages (existing: ${existingDbCount}, cap: ${importCap}, reason: ${params.noAnchorImportReason ?? "unspecified"}). Aborting to prevent flood.`,
            );
            this.deps.log.debug(
              `[lcm] reconcileSessionTail: blocked no-anchor import for ${sessionContext} duration=${formatDurationMs(Date.now() - startedAt)} historicalMessages=${historicalMessages.length} existingDbCount=${existingDbCount} cap=${importCap} overlap=false`,
            );
            return {
              blockedByImportCap: true,
              blockedReason: "import-cap",
              importedMessages: 0,
              hasOverlap: false,
            };
          }

          if (params.noAnchorImportReason === "same-path-shrink") {
            const rawIdMatches = this.countActiveCrossConversationRawIdMatches({
              conversationId,
              sessionId,
              messages: historicalMessages,
            });
            if (rawIdMatches.matchedRawIds > 0) {
              this.deps.log.warn(
                `[lcm] reconcileSessionTail: blocked same-path-shrink no-anchor import for ${sessionContext} because ${rawIdMatches.matchedRawIds}/${rawIdMatches.candidateRawIds} candidate raw ids already exist in other active conversations`,
              );
              this.deps.log.debug(
                `[lcm] reconcileSessionTail: blocked cross-conversation raw-id duplicate for ${sessionContext} duration=${formatDurationMs(Date.now() - startedAt)} historicalMessages=${historicalMessages.length} candidateRawIds=${rawIdMatches.candidateRawIds} matchedRawIds=${rawIdMatches.matchedRawIds} overlap=false`,
              );
              return {
                blockedByImportCap: true,
                blockedReason: "cross-conversation-raw-id",
                importedMessages: 0,
                hasOverlap: false,
              };
            }
          }

          let importedMessages = 0;
          for (const message of historicalMessages) {
            const result = await this.ingestSingle({
              sessionId,
              sessionKey: params.sessionKey,
              message,
              skipReplayTimestampFloodGuard: true,
            });
            if (result.ingested) {
              importedMessages += 1;
            }
          }
          this.deps.log.warn(
            `[lcm] reconcileSessionTail: no anchor for ${sessionContext}; imported transcript as new epoch reason=${params.noAnchorImportReason ?? "unspecified"} duration=${formatDurationMs(Date.now() - startedAt)} historicalMessages=${historicalMessages.length} importedMessages=${importedMessages} overlap=false`,
          );
          return { blockedByImportCap: false, importedMessages, hasOverlap: false };
        }
        this.deps.log.debug(
          `[lcm] reconcileSessionTail: no anchor for ${sessionContext} duration=${formatDurationMs(Date.now() - startedAt)} historicalMessages=${historicalMessages.length} importedMessages=0 overlap=false`,
        );
        return { blockedByImportCap: false, importedMessages: 0, hasOverlap: false };
      }
    }
    if (anchorIndex >= historicalMessages.length - 1) {
      this.deps.log.debug(
        `[lcm] reconcileSessionTail: anchor at tip for ${sessionContext} duration=${formatDurationMs(Date.now() - startedAt)} historicalMessages=${historicalMessages.length} importedMessages=0 overlap=true`,
      );
      return { blockedByImportCap: false, importedMessages: 0, hasOverlap: true };
    }

    const missingTail = await this.filterBootstrapReplayMessages({
      messages: historicalMessages.slice(anchorIndex + 1),
      sessionContext,
      source: "reconcileSessionTail",
      priorMessages: historicalMessages.slice(0, anchorIndex + 1),
    });

    if (existingDbCount > 0 && missingTail.length > Math.max(existingDbCount * 0.2, 50)) {
      this.deps.log.warn(
        `[lcm] reconcileSessionTail: import cap exceeded for ${sessionContext} — would import ${missingTail.length} messages (existing: ${existingDbCount}). Aborting to prevent flood.`,
      );
      this.deps.log.debug(
        `[lcm] reconcileSessionTail: blocked for ${sessionContext} duration=${formatDurationMs(Date.now() - startedAt)} historicalMessages=${historicalMessages.length} missingTail=${missingTail.length} existingDbCount=${existingDbCount}`,
      );
      return {
        blockedByImportCap: true,
        blockedReason: "import-cap",
        importedMessages: 0,
        hasOverlap: true,
      };
    }

    let importedMessages = 0;
    for (const message of missingTail) {
      const result = await this.ingestSingle({ sessionId, sessionKey: params.sessionKey, message });
      if (result.ingested) {
        importedMessages += 1;
      }
    }

    this.deps.log.debug(
      `[lcm] reconcileSessionTail: slow path for ${sessionContext} duration=${formatDurationMs(Date.now() - startedAt)} historicalMessages=${historicalMessages.length} anchorIndex=${anchorIndex} missingTail=${missingTail.length} importedMessages=${importedMessages}`,
    );
    return { blockedByImportCap: false, importedMessages, hasOverlap: true };
  }

  /** Count candidate raw event IDs that already belong to another active conversation. */
  private countActiveCrossConversationRawIdMatches(params: {
    conversationId: number;
    sessionId: string;
    messages: AgentMessage[];
  }): { candidateRawIds: number; matchedRawIds: number } {
    const candidateRawIds = new Set<string>();
    for (const message of params.messages) {
      const stored = toStoredMessage(message);
      const parts = buildMessageParts({
        sessionId: params.sessionId,
        message,
        fallbackContent: stored.content,
      });
      for (const part of parts) {
        for (const rawId of extractRawIdsFromPartMetadata(part.metadata)) {
          candidateRawIds.add(rawId);
        }
      }
    }

    if (candidateRawIds.size === 0) {
      return { candidateRawIds: 0, matchedRawIds: 0 };
    }

    const matchStmt = this.db.prepare(
      `SELECT 1 AS found
       FROM message_parts mp
       JOIN messages m ON m.message_id = mp.message_id
       JOIN conversations c ON c.conversation_id = m.conversation_id
       WHERE c.active = 1
         AND m.conversation_id <> ?
         AND mp.metadata IS NOT NULL
         AND json_valid(mp.metadata)
         AND (
           json_extract(mp.metadata, '$.raw.id') = ?
           OR json_extract(mp.metadata, '$.raw.call_id') = ?
           OR json_extract(mp.metadata, '$.raw.toolCallId') = ?
           OR json_extract(mp.metadata, '$.raw.tool_call_id') = ?
           OR json_extract(mp.metadata, '$.raw.toolUseId') = ?
           OR json_extract(mp.metadata, '$.raw.tool_use_id') = ?
         )
       LIMIT 1`,
    );

    let matchedRawIds = 0;
    for (const rawId of candidateRawIds) {
      const row = matchStmt.get(
        params.conversationId,
        rawId,
        rawId,
        rawId,
        rawId,
        rawId,
        rawId,
      ) as { found: number } | undefined;
      if (row?.found === 1) {
        matchedRawIds += 1;
      }
    }

    return { candidateRawIds: candidateRawIds.size, matchedRawIds };
  }

  /**
   * Existing-conversation bootstrap is a rehydrate path. It may repair small
   * crash gaps, but it must not replay already persisted transcript rows as
   * fresh LCM seqs after a runtime re-instantiation.
   */
  private async filterBootstrapReplayMessages(params: {
    messages: AgentMessage[];
    sessionContext: string;
    source: string;
    priorMessages: AgentMessage[];
  }): Promise<AgentMessage[]> {
    if (params.messages.length < 3) {
      return params.messages;
    }

    let replayCandidateLength = 0;
    while (
      replayCandidateLength < params.messages.length &&
      isBootstrapReplayCandidateMessage(params.messages[replayCandidateLength]!)
    ) {
      replayCandidateLength += 1;
    }
    if (replayCandidateLength < 3) {
      return params.messages;
    }

    const priorMessages = params.priorMessages;
    if (priorMessages.length === 0) {
      return params.messages;
    }

    const replayCandidates = params.messages.slice(0, replayCandidateLength);
    const earlierReplayCandidates = (
      params.priorMessages ? priorMessages : priorMessages.slice(0, Math.max(0, priorMessages.length - params.messages.length))
    ).filter(isBootstrapReplayCandidateMessage);
    if (earlierReplayCandidates.length < 3) {
      return params.messages;
    }

    const incomingSignatures = replayCandidates.map(createBootstrapReplaySignature);
    const earlierSignatures = earlierReplayCandidates.map(createBootstrapReplaySignature);

    let replayPrefixLength = 0;
    prefixLoop:
    for (
      let candidatePrefixLength = incomingSignatures.length;
      candidatePrefixLength >= 3;
      candidatePrefixLength -= 1
    ) {
      for (
        let startIndex = 0;
        startIndex <= earlierSignatures.length - candidatePrefixLength;
        startIndex += 1
      ) {
        let matched = true;
        for (let offset = 0; offset < candidatePrefixLength; offset += 1) {
          if (earlierSignatures[startIndex + offset] !== incomingSignatures[offset]) {
            matched = false;
            break;
          }
        }
        if (matched) {
          replayPrefixLength = candidatePrefixLength;
          break prefixLoop;
        }
      }
    }

    if (replayPrefixLength > 0) {
      this.deps.log.warn(
        `[lcm] bootstrap replay guard: ${params.source} dropped ${replayPrefixLength}/${params.messages.length} replayed transcript messages for ${params.sessionContext}`,
      );
    }

    return replayPrefixLength > 0
      ? params.messages.slice(replayPrefixLength)
      : params.messages;
  }

  async bootstrap(params: {
    sessionId: string;
    sessionKey?: string;
    messages?: AgentMessage[];
  }): Promise<BootstrapResult> {
    if (this.shouldIgnoreSession({ sessionId: params.sessionId, sessionKey: params.sessionKey })) {
      return {
        bootstrapped: false,
        importedMessages: 0,
        reason: "session excluded by pattern",
      };
    }
    if (this.isStatelessSession(params.sessionKey)) {
      return {
        bootstrapped: false,
        importedMessages: 0,
        reason: "stateless session",
      };
    }

    this.ensureMigrated();
    const sessionLabel = [
      `session=${params.sessionId}`,
      ...(params.sessionKey?.trim() ? [`sessionKey=${params.sessionKey.trim()}`] : []),
    ].join(" ");
    const bootstrapMessages = trimBootstrapMessagesToBudget(
      filterPersistableMessages(params.messages ?? []),
      resolveBootstrapMaxTokens(this.config),
    );

    if (bootstrapMessages.length === 0) {
      this.deps.log.debug(
        `[lcm] bootstrap: skipped ${sessionLabel} reason=no_runtime_messages`,
      );
      return {
        bootstrapped: false,
        importedMessages: 0,
        reason: "runtime messages unavailable",
      };
    }

    let importedMessages = 0;
    await this.withSessionQueue(
      this.resolveSessionQueueKey(params.sessionId, params.sessionKey),
      async () => {
        const conversation = await this.conversationStore.getOrCreateConversation(
          params.sessionId,
          { sessionKey: params.sessionKey },
        );
        for (const message of bootstrapMessages) {
          const result = await this.ingestSingle({
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            message,
            skipReplayTimestampFloodGuard: true,
          });
          if (result.ingested) {
            importedMessages += 1;
          }
        }
        if (!conversation.bootstrappedAt) {
          await this.conversationStore.markConversationBootstrapped(conversation.conversationId);
        }
      },
      { operationName: "bootstrap", context: sessionLabel },
    );

    return {
      bootstrapped: importedMessages > 0,
      importedMessages,
      reason: importedMessages > 0 ? "bootstrapped from runtime messages" : "conversation already up to date",
    };
  }

  private async ingestSingle(params: {
    sessionId: string;
    sessionKey?: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
    skipReplayTimestampFloodGuard?: boolean;
  }): Promise<IngestResult> {
    const { sessionId, sessionKey, message, isHeartbeat, skipReplayTimestampFloodGuard } = params;
    if (isHeartbeat) {
      return { ingested: false };
    }
    if (!hasPersistableMessageRole(message)) {
      return { ingested: false };
    }

    const topLevel = message as unknown as Record<string, unknown>;
    if (message.role === "assistant") {
      const stopReason =
        typeof topLevel.stopReason === "string"
          ? topLevel.stopReason
          : typeof topLevel.stop_reason === "string"
            ? topLevel.stop_reason
            : undefined;
      if (stopReason === "error" || stopReason === "aborted") {
        const content = topLevel.content;
        const isEmpty =
          content === undefined ||
          content === null ||
          content === "" ||
          (Array.isArray(content) && content.length === 0);
        if (isEmpty) {
          return { ingested: false };
        }
      }
    }

    let stored = toStoredMessage(message);
    const conversation = await this.conversationStore.getOrCreateConversation(sessionId, {
      sessionKey,
    });
    const conversationId = conversation.conversationId;
    let messageForParts = message;

    const nativeImageIntercepted = await this.interceptNativeImageBlocks({
      conversationId,
      message: messageForParts,
    });
    if (nativeImageIntercepted) {
      messageForParts = nativeImageIntercepted.rewrittenMessage;
      stored = toStoredMessage(messageForParts);
    }

    if (stored.role === "tool") {
      const imageIntercepted = await this.interceptInlineImagesInToolMessage({
        conversationId,
        message: messageForParts,
      });
      if (imageIntercepted) {
        messageForParts = imageIntercepted.rewrittenMessage;
        stored = toStoredMessage(messageForParts);
      }
    } else {
      const imageIntercepted = await this.interceptInlineImages({
        conversationId,
        content: stored.content,
        role: stored.role,
      });
      if (imageIntercepted) {
        stored.content = imageIntercepted.rewrittenContent;
        stored.tokenCount = estimateTokens(stored.content);
        if ("content" in message) {
          messageForParts = {
            ...message,
            content: stored.content,
          } as AgentMessage;
        }
      }
    }

    if (stored.role === "user") {
      const intercepted = await this.interceptLargeFiles({
        conversationId,
        content: stored.content,
      });
      if (intercepted) {
        stored.content = intercepted.rewrittenContent;
        stored.tokenCount = estimateTokens(stored.content);
        if ("content" in message) {
          messageForParts = {
            ...message,
            content: stored.content,
          } as AgentMessage;
        }
      }
    } else if (stored.role === "tool") {
      const intercepted = await this.interceptLargeToolResults({
        conversationId,
        message: messageForParts,
      });
      if (intercepted) {
        messageForParts = intercepted.rewrittenMessage;
        const rewrittenStored = toStoredMessage(intercepted.rewrittenMessage);
        stored.content = rewrittenStored.content;
        stored.tokenCount = rewrittenStored.tokenCount;
      }
    }

    const rawPayloadIntercepted = await this.interceptLargeRawPayload({
      conversationId,
      message: messageForParts,
      stored,
    });
    if (rawPayloadIntercepted) {
      messageForParts = rawPayloadIntercepted.rewrittenMessage;
      stored = rawPayloadIntercepted.stored;
    }

    const seq = (await this.conversationStore.getMaxSeq(conversationId)) + 1;
    const msgRecord = await this.conversationStore.createMessage({
      conversationId,
      seq,
      role: stored.role,
      content: stored.content,
      tokenCount: stored.tokenCount,
      skipReplayTimestampFloodGuard,
    });
    await this.conversationStore.createMessageParts(
      msgRecord.messageId,
      buildMessageParts({
        sessionId,
        message: messageForParts,
        fallbackContent: stored.content,
      }),
    );
    await this.summaryStore.appendContextMessage(conversationId, msgRecord.messageId);

    return { ingested: true };
  }

  async ingest(params: {
    sessionId: string;
    sessionKey?: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    if (this.shouldIgnoreSession({ sessionId: params.sessionId, sessionKey: params.sessionKey })) {
      return { ingested: false };
    }
    if (this.isStatelessSession(params.sessionKey)) {
      return { ingested: false };
    }
    this.ensureMigrated();
    return this.withSessionQueue(
      this.resolveSessionQueueKey(params.sessionId, params.sessionKey),
      () => this.ingestSingle(params),
      {
        operationName: "ingest",
        context: [
          `session=${params.sessionId}`,
          ...(params.sessionKey?.trim() ? [`sessionKey=${params.sessionKey.trim()}`] : []),
        ].join(" "),
      },
    );
  }

  async ingestBatch(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    isHeartbeat?: boolean;
  }): Promise<IngestBatchResult> {
    if (this.shouldIgnoreSession({ sessionId: params.sessionId, sessionKey: params.sessionKey })) {
      return { ingestedCount: 0 };
    }
    if (this.isStatelessSession(params.sessionKey)) {
      return { ingestedCount: 0 };
    }
    this.ensureMigrated();
    if (params.messages.length === 0) {
      return { ingestedCount: 0 };
    }
    return this.withSessionQueue(
      this.resolveSessionQueueKey(params.sessionId, params.sessionKey),
      async () => {
        return this.conversationStore.withTransaction(async () => {
          let ingestedCount = 0;
          for (const message of params.messages) {
            const result = await this.ingestSingle({
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
              message,
              isHeartbeat: params.isHeartbeat,
            });
            if (result.ingested) {
              ingestedCount += 1;
            }
          }
          return { ingestedCount };
        });
      },
      {
        operationName: "ingestBatch",
        context: [
          `session=${params.sessionId}`,
          ...(params.sessionKey?.trim() ? [`sessionKey=${params.sessionKey.trim()}`] : []),
          `messages=${params.messages.length}`,
        ].join(" "),
      },
    );
  }

  private async deduplicateAfterTurnBatch(
    sessionId: string,
    sessionKey: string | undefined,
    batch: AgentMessage[],
    options?: { oversizedNoOverlap?: "ingest" | "skip" },
  ): Promise<AgentMessage[]> {
    if (batch.length === 0) {
      return batch;
    }

    const conversation = await this.conversationStore.getConversationForSession({
      sessionId,
      sessionKey,
    });
    if (!conversation) {
      return batch;
    }

    const conversationId = conversation.conversationId;
    const storedMessageCount = await this.conversationStore.getMessageCount(conversationId);
    if (storedMessageCount === 0) {
      return batch;
    }

    const lastDbMessage = await this.conversationStore.getLastMessage(conversationId);
    if (!lastDbMessage) {
      return batch;
    }

    const storedBatch = batch.map((message) => toStoredMessage(message));
    if (storedMessageCount > batch.length) {
      return this.deduplicateOversizedBatch(
        conversationId,
        batch,
        storedBatch,
        storedMessageCount,
        lastDbMessage,
        options,
      );
    }

    const batchAtBoundary = storedBatch[storedMessageCount - 1];
    if (!batchAtBoundary) {
      return batch;
    }
    if (
      messageIdentity(lastDbMessage.role, lastDbMessage.content) !==
      messageIdentity(batchAtBoundary.role, batchAtBoundary.content)
    ) {
      return this.deduplicateSuffixFallback(
        conversationId,
        batch,
        storedBatch,
        storedMessageCount,
        "prefix-mismatch",
      );
    }

    const storedMessages = await this.conversationStore.getMessages(conversationId, {
      limit: storedMessageCount,
    });
    if (storedMessages.length !== storedMessageCount) {
      return batch;
    }
    for (let i = 0; i < storedMessageCount; i += 1) {
      const storedConversationMessage = storedMessages[i];
      const incomingMessage = storedBatch[i];
      if (
        !storedConversationMessage ||
        !incomingMessage ||
        messageIdentity(storedConversationMessage.role, storedConversationMessage.content) !==
          messageIdentity(incomingMessage.role, incomingMessage.content)
      ) {
        return batch;
      }
    }

    return batch.slice(storedMessageCount);
  }

  private async deduplicateOversizedBatch(
    conversationId: number,
    batch: AgentMessage[],
    storedBatch: ReturnType<typeof toStoredMessage>[],
    storedMessageCount: number,
    lastDbMessage: { role: string; content: string },
    options?: { oversizedNoOverlap?: "ingest" | "skip" },
  ): Promise<AgentMessage[]> {
    const lastStoredBatch = storedBatch[storedBatch.length - 1];
    if (!lastStoredBatch) {
      return batch;
    }
    const lastBatchIdentity = messageIdentity(lastStoredBatch.role, lastStoredBatch.content);
    const lastDbIdentity = messageIdentity(lastDbMessage.role, lastDbMessage.content);

    if (lastDbIdentity === lastBatchIdentity) {
      const storedMessages = await this.conversationStore.getMessages(conversationId, {
        limit: storedMessageCount,
      });
      const tailMessages = storedMessages.slice(-batch.length);
      if (tailMessages.length === batch.length) {
        let tailMatch = true;
        for (let i = 0; i < batch.length; i += 1) {
          if (
            messageIdentity(tailMessages[i]!.role, tailMessages[i]!.content) !==
            messageIdentity(storedBatch[i]!.role, storedBatch[i]!.content)
          ) {
            tailMatch = false;
            break;
          }
        }
        if (tailMatch) {
          this.deps.log.debug(
            `[lcm] dedup: tail-match detected, batch already fully stored ` +
              `(storedCount=${storedMessageCount} batchLen=${batch.length}), skipping entire batch`,
          );
          return [];
        }
      }
    }

    return this.deduplicateSuffixFallback(
      conversationId,
      batch,
      storedBatch,
      storedMessageCount,
      "oversized",
      { onNoOverlap: options?.oversizedNoOverlap ?? "skip" },
    );
  }

  private async deduplicateSuffixFallback(
    conversationId: number,
    batch: AgentMessage[],
    storedBatch: ReturnType<typeof toStoredMessage>[],
    storedMessageCount: number,
    context: string,
    options?: { onNoOverlap?: "ingest" | "skip" },
  ): Promise<AgentMessage[]> {
    const allStored = await this.conversationStore.getMessages(conversationId, {
      limit: storedMessageCount,
    });
    if (allStored.length === 0) {
      return batch;
    }

    const lastStoredIdentity = messageIdentity(
      allStored[allStored.length - 1]!.role,
      allStored[allStored.length - 1]!.content,
    );

    for (let k = batch.length - 1; k >= 0; k -= 1) {
      if (messageIdentity(storedBatch[k]!.role, storedBatch[k]!.content) !== lastStoredIdentity) {
        continue;
      }
      const matchLen = Math.min(k + 1, allStored.length);
      const startDb = allStored.length - matchLen;
      let suffixMatch = true;
      for (let j = 0; j < matchLen; j += 1) {
        if (
          messageIdentity(allStored[startDb + j]!.role, allStored[startDb + j]!.content) !==
          messageIdentity(storedBatch[k - matchLen + 1 + j]!.role, storedBatch[k - matchLen + 1 + j]!.content)
        ) {
          suffixMatch = false;
          break;
        }
      }
      const newSlice = batch.slice(k + 1);
      if (suffixMatch && (newSlice.length > 0 || matchLen > 1)) {
        this.deps.log.debug(
          `[lcm] dedup: ${context} suffix-match at batch[${k}], ` +
            `returning ${newSlice.length} new messages ` +
            `(storedCount=${storedMessageCount} batchLen=${batch.length})`,
        );
        return newSlice;
      }
    }

    if (options?.onNoOverlap === "skip") {
      this.deps.log.warn(
        `[lcm] dedup: ${context}, storedCount=${storedMessageCount} batchLen=${batch.length}, ` +
          `no overlap found — fail-closed skipping full batch`,
      );
      return [];
    }

    this.deps.log.warn(
      `[lcm] dedup: ${context}, storedCount=${storedMessageCount} batchLen=${batch.length}, ` +
        `no overlap found — ingesting full batch`,
    );
    return batch;
  }

  async afterTurn(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    runtimeContext?: ContextEngineRuntimeContext;
    legacyCompactionParams?: Record<string, unknown>;
  }): Promise<void> {
    if (this.shouldIgnoreSession({ sessionId: params.sessionId, sessionKey: params.sessionKey })) {
      return;
    }
    if (this.isStatelessSession(params.sessionKey)) {
      return;
    }

    this.ensureMigrated();
    const startedAt = Date.now();
    const sessionLabel = [
      `session=${params.sessionId}`,
      ...(params.sessionKey?.trim() ? [`sessionKey=${params.sessionKey.trim()}`] : []),
    ].join(" ");

    const newMessages = filterPersistableMessages(
      params.messages.slice(params.prePromptMessageCount),
    );
    const dedupedNewMessages = await this.deduplicateAfterTurnBatch(
      params.sessionId,
      params.sessionKey,
      newMessages,
      { oversizedNoOverlap: "ingest" },
    );

    const summaryCoveredMessages: AgentMessage[] = [];
    const summaryDedupedNewMessages: AgentMessage[] = [];
    if (params.autoCompactionSummary) {
      for (const message of dedupedNewMessages) {
        if (messageContentCoveredBySummary({ message, summary: params.autoCompactionSummary })) {
          summaryCoveredMessages.push(message);
        } else {
          summaryDedupedNewMessages.push(message);
        }
      }
    } else {
      summaryDedupedNewMessages.push(...dedupedNewMessages);
    }
    if (summaryCoveredMessages.length > 0) {
      this.deps.log.debug(
        `[lcm] afterTurn: skipped ${summaryCoveredMessages.length} messages already covered by autoCompactionSummary ${sessionLabel}`,
      );
    }

    const ingestBatch: AgentMessage[] = [];
    if (params.autoCompactionSummary) {
      ingestBatch.push({ role: "user", content: params.autoCompactionSummary } as AgentMessage);
    }
    ingestBatch.push(...summaryDedupedNewMessages);

    if (ingestBatch.length === 0) {
      this.deps.log.debug(
        `[lcm] afterTurn: nothing to ingest ${sessionLabel} newMessages=${newMessages.length} duration=${formatDurationMs(Date.now() - startedAt)}`,
      );
    } else {
      try {
        await this.ingestBatch({
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          messages: ingestBatch,
          isHeartbeat: params.isHeartbeat === true,
        });
      } catch (err) {
        this.deps.log.error(
          `[lcm] afterTurn: ingest failed, skipping compaction: ${describeLogError(err)}`,
        );
        return;
      }
    }

    if (batchLooksLikeHeartbeatAckTurn(ingestBatch)) {
      try {
        const conversation = await this.conversationStore.getConversationForSession({
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
        });
        if (conversation) {
          const pruned = await this.pruneHeartbeatOkTurns(conversation.conversationId);
          if (pruned > 0) {
            const sessionContext = this.formatSessionLogContext({
              conversationId: conversation.conversationId,
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
            });
            this.deps.log.info(
              `[lcm] afterTurn: pruned ${pruned} heartbeat ack messages for ${sessionContext}`,
            );
            return;
          }
        }
      } catch (err) {
        this.deps.log.warn(`[lcm] afterTurn: heartbeat pruning failed: ${describeLogError(err)}`);
      }
    }

    const legacyParams = asRecord(params.runtimeContext) ?? asRecord(params.legacyCompactionParams);
    const DEFAULT_AFTER_TURN_TOKEN_BUDGET = 128_000;
    const resolvedTokenBudget = this.resolveTokenBudget({
      tokenBudget: params.tokenBudget,
      runtimeContext: params.runtimeContext,
      legacyParams,
    });
    const tokenBudget = this.applyAssemblyBudgetCap(resolvedTokenBudget ?? DEFAULT_AFTER_TURN_TOKEN_BUDGET);
    if (resolvedTokenBudget === undefined) {
      this.deps.log.warn(
        `[lcm] afterTurn: tokenBudget not provided; using default ${DEFAULT_AFTER_TURN_TOKEN_BUDGET}`,
      );
    }

    const estimatedContextTokens = estimateSessionTokenCountForAfterTurn(params.messages);
    const runtimePromptTokens = extractRuntimePromptTokenCount(asRecord(params.runtimeContext));
    const suppliedCurrentTokenCount = this.normalizeObservedTokenCount(
      ((legacyParams ?? {}) as { currentTokenCount?: unknown }).currentTokenCount,
    );
    const observedCurrentTokenCount = runtimePromptTokens ?? suppliedCurrentTokenCount ?? estimatedContextTokens;
    if (runtimePromptTokens !== undefined) {
      this.deps.log.debug(
        `[lcm] afterTurn: using runtime prompt token count currentTokenCount=${runtimePromptTokens} estimatedTokenCount=${estimatedContextTokens}`,
      );
    }

    const conversation = await this.conversationStore.getConversationForSession({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    });
    if (!conversation) {
      this.deps.log.debug(
        `[lcm] afterTurn: conversation lookup missed ${sessionLabel} ingestBatch=${ingestBatch.length} duration=${formatDurationMs(Date.now() - startedAt)}`,
      );
      return;
    }

    const recordAfterTurnCompactionRetry = async (reason: string): Promise<void> => {
      try {
        await this.recordDeferredCompactionDebt({
          conversationId: conversation.conversationId,
          reason,
          tokenBudget,
          currentTokenCount: observedCurrentTokenCount,
        });
      } catch (err) {
        this.deps.log.warn(
          `[lcm] afterTurn: failed to persist deferred compaction retry for ${sessionLabel}: ${describeLogError(err)}`,
        );
      }
    };

    let deferredCompactionDrain: { reason: string; tokenBudget: number; currentTokenCount: number } | null = null;
    try {
      await this.updateCompactionTelemetry({
        conversationId: conversation.conversationId,
        runtimeContext: legacyParams,
        tokenBudget,
      });
    } catch (err) {
      this.deps.log.warn(`[lcm] afterTurn: compaction telemetry update failed: ${describeLogError(err)}`);
    }

    try {
      const thresholdDecision = await this.compaction.evaluate(
        conversation.conversationId,
        tokenBudget,
        observedCurrentTokenCount,
      );
      if (this.config.proactiveThresholdCompactionMode === "inline") {
        if (thresholdDecision.shouldCompact) {
          const compactResult = await this.compact({
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            tokenBudget,
            currentTokenCount: observedCurrentTokenCount,
            compactionTarget: "threshold",
            runtimeContext: params.runtimeContext,
            legacyParams,
          });
          if (!compactResult.ok) {
            await recordAfterTurnCompactionRetry("threshold");
          }
        }
      } else if (thresholdDecision.shouldCompact) {
        await this.recordDeferredCompactionDebt({
          conversationId: conversation.conversationId,
          reason: "threshold",
          tokenBudget,
          currentTokenCount: observedCurrentTokenCount,
        });
        deferredCompactionDrain = { tokenBudget, currentTokenCount: observedCurrentTokenCount, reason: "threshold" };
      }
    } catch (err) {
      this.deps.log.warn(
        `[lcm] afterTurn: compaction policy check failed for ${sessionLabel}: ${describeLogError(err)}`,
      );
    }

    if (deferredCompactionDrain) {
      this.scheduleDeferredCompactionDebtDrain({
        conversationId: conversation.conversationId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        tokenBudget: deferredCompactionDrain.tokenBudget,
        currentTokenCount: deferredCompactionDrain.currentTokenCount,
        reason: deferredCompactionDrain.reason,
      });
    }

    this.deps.log.debug(
      `[lcm] afterTurn: done conversation=${conversation.conversationId} ${sessionLabel} newMessages=${newMessages.length} dedupedMessages=${dedupedNewMessages.length} ingestedMessages=${ingestBatch.length} duration=${formatDurationMs(Date.now() - startedAt)}`,
    );
  }

  async maintain(params: {
    sessionId: string;
    sessionKey?: string;
    runtimeContext?: ContextEngineMaintenanceRuntimeContext;
  }): Promise<ContextEngineMaintenanceResult> {
    if (this.shouldIgnoreSession({ sessionId: params.sessionId, sessionKey: params.sessionKey })) {
      return {
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
        reason: "session excluded by pattern",
      };
    }
    if (this.isStatelessSession(params.sessionKey)) {
      return {
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
        reason: "stateless session",
      };
    }

    const sessionLabel = [
      `session=${params.sessionId}`,
      ...(params.sessionKey?.trim() ? [`sessionKey=${params.sessionKey.trim()}`] : []),
    ].join(" ");
    return this.withSessionQueue(
      this.resolveSessionQueueKey(params.sessionId, params.sessionKey),
      async () => {
        const conversation = await this.conversationStore.getConversationForSession({
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
        });
        if (!conversation) {
          return {
            changed: false,
            bytesFreed: 0,
            rewrittenEntries: 0,
            reason: "conversation not found",
          };
        }

        const maintenance = await this.compactionMaintenanceStore.getConversationCompactionMaintenance(
          conversation.conversationId,
        );
        if (params.runtimeContext?.allowDeferredCompactionExecution !== true) {
          if (maintenance?.pending || maintenance?.running) {
            this.deps.log.debug(
              `[lcm] maintain: deferred compaction debt pending conversation=${conversation.conversationId} ${sessionLabel} but host runtimeContext.allowDeferredCompactionExecution is disabled`,
            );
          }
          return {
            changed: false,
            bytesFreed: 0,
            rewrittenEntries: 0,
            reason: "no maintenance work",
          };
        }

        const runtimeTokenBudget = (() => {
          const tokenBudget = asRecord(params.runtimeContext)?.tokenBudget;
          if (typeof tokenBudget === "number" && Number.isFinite(tokenBudget) && tokenBudget > 0) {
            return Math.floor(tokenBudget);
          }
          return 128_000;
        })();
        const cappedTokenBudget = this.applyAssemblyBudgetCap(runtimeTokenBudget);
        const maintainCurrentTokenCount =
          typeof params.runtimeContext?.currentTokenCount === "number"
            ? Math.floor(params.runtimeContext.currentTokenCount as number)
            : undefined;
        if (maintenance?.pending || maintenance?.running) {
          return this.consumeDeferredCompactionDebt({
            conversationId: conversation.conversationId,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            tokenBudget: cappedTokenBudget,
            currentTokenCount: maintainCurrentTokenCount,
            runtimeContext: params.runtimeContext,
            legacyParams: asRecord(params.runtimeContext),
          });
        }

        return {
          changed: false,
          bytesFreed: 0,
          rewrittenEntries: 0,
          reason: "no maintenance work",
        };
      },
      { operationName: "maintain", context: sessionLabel },
    );
  }

  async assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    tokenBudget?: number;
    /** Optional user query for relevance-based eviction (BM25-lite). When absent or unsearchable, falls back to chronological eviction. */
    prompt?: string;
  }): Promise<AssembleResult> {
    // Return a new fallback array so the runtime hook treats this as assembled
    // context, and remove assistant prefill tails from fallback-only paths.
    const safeFallback = (): AssembleResult => {
      const msgs = params.messages.slice();
      while (msgs.length > 0 && msgs[msgs.length - 1]?.role === "assistant") {
        msgs.pop();
      }
      return { messages: msgs, estimatedTokens: 0 };
    };

    if (this.shouldIgnoreSession({ sessionId: params.sessionId, sessionKey: params.sessionKey })) {
      return safeFallback();
    }
    try {
      this.ensureMigrated();
      const startedAt = Date.now();
      const sessionLabel = [
        `session=${params.sessionId}`,
        ...(params.sessionKey?.trim() ? [`sessionKey=${params.sessionKey.trim()}`] : []),
      ].join(" ");

      const conversation = await this.conversationStore.getConversationForSession({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
      });
      if (!conversation) {
        this.deps.log.debug(
          `[lcm] assemble: conversation lookup missed ${sessionLabel} duration=${formatDurationMs(Date.now() - startedAt)}`,
        );
        return safeFallback();
      }

      const tokenBudget = this.applyAssemblyBudgetCap(
        typeof params.tokenBudget === "number" &&
        Number.isFinite(params.tokenBudget) &&
        params.tokenBudget > 0
          ? Math.floor(params.tokenBudget)
          : 128_000,
      );
      const liveContextTokens = estimateSessionTokenCountForAfterTurn(params.messages);
      const maintenance = await this.compactionMaintenanceStore.getConversationCompactionMaintenance(
        conversation.conversationId,
      );
      if (maintenance?.pending || maintenance?.running) {
        try {
          await this.maybeConsumeDeferredCompactionDebtForAssemble({
            conversationId: conversation.conversationId,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            tokenBudget,
            currentTokenCount: liveContextTokens,
          });
        } catch (error) {
          this.deps.log.warn(
            `[lcm] assemble: deferred compaction execution failed for ${sessionLabel}: ${describeLogError(error)}`,
          );
        }
      }

      const contextItems = await this.summaryStore.getContextItems(conversation.conversationId);
      if (contextItems.length === 0) {
        this.deps.log.debug(
          `[lcm] assemble: no context items conversation=${conversation.conversationId} ${sessionLabel} duration=${formatDurationMs(Date.now() - startedAt)}`,
        );
        return safeFallback();
      }

      // Guard against incomplete bootstrap/coverage: if the DB only has
      // raw context items and clearly trails the current live history, keep
      // the live path to avoid dropping prompt context.
      const hasSummaryItems = contextItems.some((item) => item.itemType === "summary");
      if (!hasSummaryItems && contextItems.length < params.messages.length) {
        this.deps.log.debug(
          `[lcm] assemble: falling back to live context conversation=${conversation.conversationId} ${sessionLabel} contextItems=${contextItems.length} liveMessages=${params.messages.length} duration=${formatDurationMs(Date.now() - startedAt)}`,
        );
        return safeFallback();
      }

      const assembled = await this.assembler.assemble({
        conversationId: conversation.conversationId,
        tokenBudget,
        freshTailCount: this.config.freshTailCount,
        freshTailMaxTokens: this.config.freshTailMaxTokens,
        promptAwareEviction: this.config.promptAwareEviction,
        prompt: params.prompt,
        // v4.2 §B — gated by config.stubLargeToolPayloads (default false).
        // Off-by-default so v4.1 behavior is preserved until the migration
        // tool has populated `messages.large_content` for the running DB.
        stubLargeToolPayloads: this.config.stubLargeToolPayloads,
      });

      // If assembly produced no messages for a non-empty live session,
      // fail safe to the live context.
      if (assembled.messages.length === 0 && params.messages.length > 0) {
        this.deps.log.debug(
          `[lcm] assemble: empty assembled output, using live context conversation=${conversation.conversationId} ${sessionLabel} contextItems=${contextItems.length} tokenBudget=${tokenBudget} duration=${formatDurationMs(Date.now() - startedAt)}`,
        );
        return safeFallback();
      }

      // Guard: if assembled context contains no user turns at all (e.g. a new session
      // that starts with an agent greeting before the first user message, cold-cache),
      // fall back to live context to prevent LLM prefill errors.  Summaries always
      // have role "user", so this only fires for raw-message-only DB states where
      // every stored message is role "assistant" or "toolResult".
      const assembledHasUserTurn = assembled.messages.some((m) => m.role === "user");
      if (!assembledHasUserTurn && params.messages.length > 0) {
        this.deps.log.debug(
          `[lcm] assemble: assembled context has no user turns, falling back to live context to prevent prefill errors conversation=${conversation.conversationId} ${sessionLabel} assembledMessages=${assembled.messages.length} duration=${formatDurationMs(Date.now() - startedAt)}`,
        );
        // Use safeFallback() so the result is a *new* array; otherwise the
        // gateway's `assembled.messages !== sourceMessages` reference-equality
        // check falls through to raw sourceMessages (still ending in assistant)
        // and re-introduces the prefill-rejection bug fixed by safeFallback in
        // the other early-return paths.
        return safeFallback();
      }

      const volatileLiveInputAppend = appendUncoveredVolatileLiveInputsWithinBudget({
        assembledMessages: assembled.messages,
        assembledEstimatedTokens: assembled.estimatedTokens,
        liveMessages: params.messages,
        protectedAssembledIndexes: resolveProtectedFreshTailAssembledIndexes({
          assembledMessages: assembled.messages,
          freshTailMessageHashes:
            assembled.debug?.freshTailProtectionMessageHashes ??
            assembled.debug?.preSanitizeFreshTailMessageHashes,
        }),
        tokenBudget,
      });
      if (volatileLiveInputAppend.appendedMessages > 0) {
        this.deps.log.warn(
          `[lcm] assemble: appended unpersisted volatile live input conversation=${conversation.conversationId} ${sessionLabel} appendedMessages=${volatileLiveInputAppend.appendedMessages} appendedTokens=${volatileLiveInputAppend.appendedTokens} evictedMessages=${volatileLiveInputAppend.evictedMessages} evictedTokens=${volatileLiveInputAppend.evictedTokens} overBudget=${volatileLiveInputAppend.overBudget}`,
        );
      }

      // v4.2 §B — surface stub telemetry on the standard "assemble: done" line
      // so live watchers can grep stubbedCount/tokensSaved without needing the
      // full assemble-debug bag.
      const stubStatsLog = assembled.debug?.stubStats
        ? ` stubbed=${assembled.debug.stubStats.stubbedCount} tokensSaved=${assembled.debug.stubStats.tokensSaved}`
        : "";
      const activeFocusBrief = await this.focusBriefStore.getActiveFocusBrief(
        conversation.conversationId,
      );
      const contextProjectionEpoch = buildContextEngineProjectionEpoch(
        conversation.conversationId,
        contextItems,
        activeFocusBrief,
      );
      const summaryContextItems = contextItems.filter((item) => item.itemType === "summary").length;
      const volatileLiveInputLog = volatileLiveInputAppend.appendedMessages > 0
        ? ` volatileLiveInputsAppended=${volatileLiveInputAppend.appendedMessages} volatileLiveInputEvicted=${volatileLiveInputAppend.evictedMessages} volatileLiveInputOverBudget=${volatileLiveInputAppend.overBudget}`
        : "";
      this.deps.log.info(
        `[lcm] assemble: done conversation=${conversation.conversationId} ${sessionLabel} contextItems=${contextItems.length} summaryContextItems=${summaryContextItems} hasSummaryItems=${hasSummaryItems} inputMessages=${params.messages.length} outputMessages=${volatileLiveInputAppend.messages.length} tokenBudget=${tokenBudget} estimatedTokens=${volatileLiveInputAppend.estimatedTokens} contextProjectionMode=thread_bootstrap contextProjectionEpoch=${contextProjectionEpoch}${stubStatsLog}${volatileLiveInputLog} duration=${formatDurationMs(Date.now() - startedAt)}`,

      );
      const prefixChange = describeAssembledPrefixChange(
        this.getPreviousAssembledSnapshot(conversation.conversationId),
        volatileLiveInputAppend.messages,
      );
      this.setPreviousAssembledSnapshot(
        conversation.conversationId,
        prefixChange.currentSnapshot,
      );
      if (assembled.debug) {
        const promotedOrdinals =
          assembled.debug.promotedOrdinals.length > 0
            ? assembled.debug.promotedOrdinals.join(",")
            : "none";
        const overflowDiagnostics = shouldLogOverflowDiagnostics({
          diagnostics: assembled.debug.overflowDiagnostics,
          assembledTokens: assembled.estimatedTokens,
          liveContextTokens,
        })
          ? ` overflowDiagnostics=${formatOverflowDiagnosticsForLog({
              diagnostics: assembled.debug.overflowDiagnostics,
              recentBootstrapImport: this.recentBootstrapImportsByConversation.get(
                conversation.conversationId,
              ),
            })}`
          : "";
        this.deps.log.debug(
          `[lcm] assemble-debug conversation=${conversation.conversationId} ${sessionLabel} messagesHash=${assembled.debug.finalMessagesHash} preSanitizeHash=${assembled.debug.preSanitizeMessagesHash} previousAssembledCount=${prefixChange.previousCount} commonPrefixCount=${prefixChange.commonPrefixCount} commonPrefixHash=${prefixChange.commonPrefixHash} previousWasPrefix=${prefixChange.previousWasPrefix} firstDivergenceIndex=${prefixChange.firstDivergenceIndex} previousDivergenceMessage=${prefixChange.previousDivergenceMessage} currentDivergenceMessage=${prefixChange.currentDivergenceMessage} evictableCount=${assembled.debug.preSanitizeEvictableCount} evictableHash=${assembled.debug.preSanitizeEvictableHash} freshTailSegmentCount=${assembled.debug.preSanitizeFreshTailCount} freshTailSegmentHash=${assembled.debug.preSanitizeFreshTailHash} selectionMode=${assembled.debug.selectionMode} freshTailOrdinal=${assembled.debug.freshTailOrdinal} orphanStrippingOrdinal=${assembled.debug.orphanStrippingOrdinal} baseFreshTailCount=${assembled.debug.baseFreshTailCount} freshTailCount=${assembled.debug.freshTailCount} tailTokens=${assembled.debug.tailTokens} remainingBudget=${assembled.debug.remainingBudget} evictableTotalTokens=${assembled.debug.evictableTotalTokens} promotedToolResults=${assembled.debug.promotedToolResultCount} promotedOrdinals=${promotedOrdinals} removedToolUseBlocks=${assembled.debug.removedToolUseBlockCount} touchedAssistantMessages=${assembled.debug.touchedAssistantMessageCount}${overflowDiagnostics}`,
        );
      }

      const result: AssembleResult = {
        messages: volatileLiveInputAppend.messages,
        estimatedTokens: volatileLiveInputAppend.estimatedTokens,
        contextProjection: {
          mode: "thread_bootstrap",
          epoch: contextProjectionEpoch,
        },

      };
      return result;
    } catch (err) {
      this.deps.log.debug(
        `[lcm] assemble: failed for session=${params.sessionId}${params.sessionKey?.trim() ? ` sessionKey=${params.sessionKey.trim()}` : ""} error=${describeLogError(err)}`,
      );
      return safeFallback();
    }
  }

  /** Evaluate diagnostic raw-history pressure outside the protected fresh tail. */
  async evaluateLeafTrigger(sessionId: string, sessionKey?: string): Promise<{
    shouldCompact: boolean;
    rawTokensOutsideTail: number;
    threshold: number;
  }> {
    this.ensureMigrated();
    const conversation = await this.conversationStore.getConversationForSession({
      sessionId,
      sessionKey,
    });
    if (!conversation) {
      const fallbackThreshold =
        typeof this.config.leafChunkTokens === "number" &&
          Number.isFinite(this.config.leafChunkTokens) &&
          this.config.leafChunkTokens > 0
            ? Math.floor(this.config.leafChunkTokens)
            : 40_000;
      return {
        shouldCompact: false,
        rawTokensOutsideTail: 0,
        threshold: fallbackThreshold,
      };
    }
    return this.compaction.evaluateLeafTrigger(conversation.conversationId);
  }

  async compact(params: {
    sessionId: string;
    sessionKey?: string;
    tokenBudget?: number;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    /** OpenClaw runtime param name (preferred). */
    runtimeContext?: ContextEngineRuntimeContext | Record<string, unknown>;
    /** Back-compat param name. */
    legacyParams?: Record<string, unknown>;
    /** Force compaction even if below threshold */
    force?: boolean;
  }): Promise<CompactResult> {
    if (this.shouldIgnoreSession({ sessionId: params.sessionId, sessionKey: params.sessionKey })) {
      this.deps.log.info(
        `[lcm] compact: skipped session=${params.sessionId}${params.sessionKey?.trim() ? ` sessionKey=${params.sessionKey.trim()}` : ""} reason=session_excluded`,
      );
      return {
        ok: true,
        compacted: false,
        reason: "session excluded",
      };
    }
    if (this.isStatelessSession(params.sessionKey)) {
      this.deps.log.info(
        `[lcm] compact: skipped session=${params.sessionId}${params.sessionKey?.trim() ? ` sessionKey=${params.sessionKey.trim()}` : ""} reason=stateless_session`,
      );
      return {
        ok: true,
        compacted: false,
        reason: "stateless session",
      };
    }
    this.ensureMigrated();
    return this.withSessionQueue(
      this.resolveSessionQueueKey(params.sessionId, params.sessionKey),
      async () => {
        const conversation = await this.conversationStore.getConversationForSession({
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
        });
        if (!conversation) {
          this.deps.log.info(
            `[lcm] compact: skipped session=${params.sessionId}${params.sessionKey?.trim() ? ` sessionKey=${params.sessionKey.trim()}` : ""} reason=no_conversation_found`,
          );
          return {
            ok: true,
            compacted: false,
            reason: "no conversation found for session",
          };
        }
        return this.executeCompactionCore({
          conversationId: conversation.conversationId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          tokenBudget: params.tokenBudget,
          currentTokenCount: params.currentTokenCount,
          compactionTarget: params.compactionTarget,
          customInstructions: params.customInstructions,
          runtimeContext: params.runtimeContext,
          legacyParams: params.legacyParams,
          force: params.force,
        });
      },
    );
  }

  async prepareSubagentSpawn(params: {
    parentSessionKey: string;
    childSessionKey: string;
    ttlMs?: number;
  }): Promise<SubagentSpawnPreparation | undefined> {
    if (
      this.shouldIgnoreSession({ sessionKey: params.parentSessionKey })
      || this.shouldIgnoreSession({ sessionKey: params.childSessionKey })
      || this.isStatelessSession(params.parentSessionKey)
      || this.isStatelessSession(params.childSessionKey)
    ) {
      return undefined;
    }
    this.ensureMigrated();

    const childSessionKey = params.childSessionKey.trim();
    const parentSessionKey = params.parentSessionKey.trim();
    if (!childSessionKey || !parentSessionKey) {
      return undefined;
    }

    const conversationId = await this.resolveConversationIdForSessionKey(parentSessionKey);
    if (typeof conversationId !== "number") {
      return undefined;
    }

    const ttlMs =
      typeof params.ttlMs === "number" && Number.isFinite(params.ttlMs) && params.ttlMs > 0
        ? Math.floor(params.ttlMs)
        : undefined;

    // Inherit scope from parent grant if one exists (prevents privilege escalation)
    const parentGrantId = resolveDelegatedExpansionGrantId(parentSessionKey);
    const parentGrant = parentGrantId
      ? getRuntimeExpansionAuthManager().getGrant(parentGrantId)
      : null;

    const childTokenCap = parentGrant
      ? Math.min(
          getRuntimeExpansionAuthManager().getRemainingTokenBudget(parentGrantId!) ?? this.config.maxExpandTokens,
          this.config.maxExpandTokens,
        )
      : this.config.maxExpandTokens;

    const childMaxDepth = parentGrant
      ? Math.max(0, parentGrant.maxDepth - 1)
      : undefined;

    const childAllowedSummaryIds = parentGrant?.allowedSummaryIds.length
      ? parentGrant.allowedSummaryIds
      : undefined;

    createDelegatedExpansionGrant({
      delegatedSessionKey: childSessionKey,
      issuerSessionId: parentSessionKey,
      allowedConversationIds: [conversationId],
      allowedSummaryIds: childAllowedSummaryIds,
      tokenCap: childTokenCap,
      maxDepth: childMaxDepth,
      ttlMs,
    });

    return {
      rollback: () => {
        revokeDelegatedExpansionGrantForSession(childSessionKey, { removeBinding: true });
      },
    };
  }

  async onSubagentEnded(params: {
    childSessionKey: string;
    reason: SubagentEndReason;
  }): Promise<void> {
    if (
      this.shouldIgnoreSession({ sessionKey: params.childSessionKey })
      || this.isStatelessSession(params.childSessionKey)
    ) {
      return;
    }
    const childSessionKey = params.childSessionKey.trim();
    if (!childSessionKey) {
      return;
    }

    switch (params.reason) {
      case "deleted":
        revokeDelegatedExpansionGrantForSession(childSessionKey, { removeBinding: true });
        break;
      case "completed":
        revokeDelegatedExpansionGrantForSession(childSessionKey);
        break;
      case "released":
      case "swept":
        removeDelegatedExpansionGrantForSession(childSessionKey);
        break;
    }
  }

  async dispose(): Promise<void> {
    // No-op for plugin singleton — the connection is shared across runs.
    // OpenClaw's runner calls dispose() after every run, but the plugin
    // registers a single engine instance reused by the factory. Closing
    // the DB here would break subsequent runs with "database is not open".
    // The shared connection is managed for the lifetime of the plugin process.
  }

  /** Detect the empty replacement row created during a prior lifecycle rollover. */
  private async isFreshLifecycleConversation(conversation: ConversationRecord): Promise<boolean> {
    const currentMessageCount = await this.conversationStore.getMessageCount(conversation.conversationId);
    if (currentMessageCount !== 0) {
      return false;
    }
    const currentContextItems = await this.summaryStore.getContextItems(conversation.conversationId);
    return currentContextItems.length === 0 && !conversation.bootstrappedAt;
  }

  /**
   * Archive the current active conversation and optionally create the replacement
   * row that bootstrap should attach to for the next session transcript.
   */
  private async applySessionReplacement(params: {
    reason: string;
    sessionId?: string;
    sessionKey?: string;
    nextSessionId?: string;
    nextSessionKey?: string;
    createReplacement: boolean;
    createReplacementWhenMissing?: boolean;
  }): Promise<void> {
    const current = await this.conversationStore.getConversationForSession({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    });
    if (!current && !params.createReplacementWhenMissing) {
      return;
    }

    if (current?.active) {
      if (params.createReplacement && await this.isFreshLifecycleConversation(current)) {
        this.deps.log.info(
          `[lcm] ${params.reason} lifecycle no-op for already fresh conversation ${current.conversationId}`,
        );
        return;
      }
      await this.conversationStore.archiveConversation(current.conversationId);
    }

    if (!params.createReplacement) {
      this.deps.log.info(
        `[lcm] ${params.reason} lifecycle archived conversation ${current?.conversationId ?? "(none)"}`,
      );
      return;
    }

    const nextSessionId = params.nextSessionId?.trim() || params.sessionId?.trim() || current?.sessionId;
    if (!nextSessionId) {
      this.deps.log.warn(`[lcm] ${params.reason} lifecycle skipped: no session identity available`);
      return;
    }
    const nextSessionKey = params.nextSessionKey?.trim() || params.sessionKey?.trim() || current?.sessionKey;
    const freshConversation = await this.conversationStore.createConversation({
      sessionId: nextSessionId,
      ...(nextSessionKey ? { sessionKey: nextSessionKey } : {}),
    });
    this.deps.log.info(
      `[lcm] ${params.reason} lifecycle archived prior conversation and created ${freshConversation.conversationId}`,
    );
  }

  /** Apply LCM lifecycle semantics for OpenClaw's /new and /reset commands. */
  async handleBeforeReset(params: {
    reason?: string;
    sessionId?: string;
    sessionKey?: string;
  }): Promise<void> {
    const reason = params.reason?.trim();
    if (reason !== "new" && reason !== "reset") {
      return;
    }
    if (this.shouldIgnoreSession({ sessionId: params.sessionId, sessionKey: params.sessionKey })) {
      return;
    }
    if (this.isStatelessSession(params.sessionKey)) {
      return;
    }

    this.ensureMigrated();
    await this.withSessionQueue(
      this.resolveSessionQueueKey(params.sessionId, params.sessionKey),
      async () =>
        this.conversationStore.withTransaction(async () => {
          if (reason === "new") {
            const conversation = await this.conversationStore.getConversationForSession({
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
            });
            if (!conversation) {
              return;
            }

            const retainDepth =
              typeof this.config.newSessionRetainDepth === "number"
              && Number.isFinite(this.config.newSessionRetainDepth)
                ? this.config.newSessionRetainDepth
                : 2;
            await this.summaryStore.pruneForNewSession(conversation.conversationId, retainDepth);
            this.deps.log.info(
              `[lcm] /new pruned conversation ${conversation.conversationId} to retain depth ${retainDepth}`,
            );
            return;
          }
          await this.applySessionReplacement({
            reason: "/reset",
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            createReplacement: true,
            createReplacementWhenMissing: true,
          });
        }),
    );
  }

  /** Apply generic lifecycle semantics for session rollover and deletion hooks. */
  async handleSessionEnd(params: {
    reason?: string;
    sessionId?: string;
    sessionKey?: string;
    nextSessionId?: string;
    nextSessionKey?: string;
  }): Promise<void> {
    const reason = params.reason?.trim();
    if (
      !reason ||
      reason === "new" ||
      reason === "unknown" ||
      reason === "restart" ||
      reason === "shutdown"
    ) {
      return;
    }
    if (this.shouldIgnoreSession({ sessionId: params.sessionId, sessionKey: params.sessionKey })) {
      return;
    }
    if (this.isStatelessSession(params.sessionKey ?? params.nextSessionKey)) {
      return;
    }

    const createReplacement = reason !== "deleted";
    this.ensureMigrated();
    await this.withSessionQueue(
      this.resolveSessionQueueKey(params.nextSessionId ?? params.sessionId, params.sessionKey ?? params.nextSessionKey),
      async () =>
        this.conversationStore.withTransaction(async () => {
          await this.applySessionReplacement({
            reason: `session_end:${reason}`,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey ?? params.nextSessionKey,
            nextSessionId: params.nextSessionId,
            nextSessionKey: params.nextSessionKey,
            createReplacement,
          });
        }),
    );
  }

  // ── Public accessors for retrieval (used by subagent expansion) ─────────

  getRetrieval(): RetrievalEngine {
    return this.retrieval;
  }

  getConversationStore(): ConversationStore {
    return this.conversationStore;
  }

  getSummaryStore(): SummaryStore {
    return this.summaryStore;
  }

  getFocusBriefStore(): FocusBriefStore {
    return this.focusBriefStore;
  }

  getCompactionTelemetryStore(): CompactionTelemetryStore {
    return this.compactionTelemetryStore;
  }

  getCompactionMaintenanceStore(): CompactionMaintenanceStore {
    return this.compactionMaintenanceStore;
  }

  // ── Heartbeat pruning ──────────────────────────────────────────────────

  /**
   * Detect HEARTBEAT_OK turn cycles in a conversation and delete them.
   *
   * A HEARTBEAT_OK turn is: a user message (the heartbeat prompt), followed by
   * any tool call/result messages, ending with an assistant message that is a
   * heartbeat ack. The entire sequence has no durable information value for LCM.
   *
   * Detection: assistant content (trimmed, lowercased) starts with "heartbeat_ok"
   * and any text after is not alphanumeric (matches OpenClaw core's ack detection).
   * This catches both exact "HEARTBEAT_OK" and chatty variants like
   * "HEARTBEAT_OK — weekend, no market".
   *
   * Returns the number of messages deleted.
   */
  private async pruneHeartbeatOkTurns(conversationId: number): Promise<number> {
    const allMessages = await this.conversationStore.getMessages(conversationId);
    if (allMessages.length === 0) {
      return 0;
    }

    const toDelete: number[] = [];

    // Walk through messages finding HEARTBEAT_OK assistant replies, then
    // collect the entire turn (back to the preceding user message).
    for (let i = 0; i < allMessages.length; i++) {
      const msg = allMessages[i];
      if (msg.role !== "assistant") {
        continue;
      }
      if (!isHeartbeatOkContent(msg.content)) {
        continue;
      }

      // Found an exact HEARTBEAT_OK reply. Walk backward to find the turn start
      // (the preceding user message).
      const turnMessages = [msg];
      for (let j = i - 1; j >= 0; j--) {
        const prev = allMessages[j];
        turnMessages.push(prev);
        if (prev.role === "user") {
          break; // Found turn start
        }
      }

      if (!turnMessages.some((record) => record.role === "user")) {
        continue;
      }
      if (!turnLooksLikeHeartbeatTurn(turnMessages)) {
        continue;
      }

      toDelete.push(...turnMessages.map((record) => record.messageId));
    }

    if (toDelete.length === 0) {
      return 0;
    }

    // Deduplicate (a message could theoretically appear in multiple turns)
    const uniqueIds = [...new Set(toDelete)];
    return this.conversationStore.deleteMessages(uniqueIds);
  }
}

// ── Heartbeat detection ─────────────────────────────────────────────────────

const HEARTBEAT_OK_TOKEN = "heartbeat_ok";
const HEARTBEAT_TURN_MARKER = "heartbeat.md";

/**
 * Detect whether an assistant message is a heartbeat ack.
 *
 * Only exact (case-insensitive) "HEARTBEAT_OK" acknowledgements are pruned.
 * Any additional text indicates the heartbeat carried real content and should remain.
 */
function isHeartbeatOkContent(content: string): boolean {
  return content.trim().toLowerCase() === HEARTBEAT_OK_TOKEN;
}

function batchLooksLikeHeartbeatAckTurn(messages: AgentMessage[]): boolean {
  let sawHeartbeatMarker = false;
  let sawHeartbeatAck = false;

  for (const message of messages) {
    const stored = toStoredMessage(message);
    if (!sawHeartbeatMarker && stored.content.toLowerCase().includes(HEARTBEAT_TURN_MARKER)) {
      sawHeartbeatMarker = true;
    }
    if (!sawHeartbeatAck && stored.role === "assistant" && isHeartbeatOkContent(stored.content)) {
      sawHeartbeatAck = true;
    }
    if (sawHeartbeatMarker && sawHeartbeatAck) {
      return true;
    }
  }

  return false;
}

function turnLooksLikeHeartbeatTurn(turnMessages: Array<{ content: string }>): boolean {
  return turnMessages.some((message) =>
    message.content.toLowerCase().includes(HEARTBEAT_TURN_MARKER),
  );
}

// ── Emergency fallback summarization ────────────────────────────────────────

/**
 * Creates a deterministic truncation summarizer used only as an emergency
 * fallback when the model-backed summarizer cannot be created.
 *
 * CompactionEngine already escalates normal -> aggressive -> fallback for
 * convergence. This function simply provides a stable baseline summarize
 * callback to keep compaction operable when runtime setup is unavailable.
 */
function createEmergencyFallbackSummarize(): (
  text: string,
  aggressive?: boolean,
) => Promise<string> {
  return async (text: string, aggressive?: boolean): Promise<string> => {
    const maxChars = aggressive ? 600 * 4 : 900 * 4;
    if (text.length <= maxChars) {
      return text;
    }
    return text.slice(0, maxChars) + "\n[Truncated for context management]";
  };
}
