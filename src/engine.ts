import { createHash, randomUUID } from "node:crypto";
import { closeSync, createReadStream, openSync, readSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createInterface } from "node:readline";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type {
  ContextEngine,
  ContextEngineInfo,
  AssembleResult,
  BootstrapResult,
  CompactResult,
  IngestBatchResult,
  IngestResult,
  SubagentEndReason,
  SubagentSpawnPreparation,
} from "openclaw/plugin-sdk";
import {
  blockFromPart,
  contentFromParts,
  ContextAssembler,
  pickToolCallId,
  pickToolIsError,
  pickToolName,
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
  type ActivityBand,
} from "./store/compaction-telemetry-store.js";
import {
  ConversationStore,
  type ConversationRecord,
  type CreateMessagePartInput,
  type MessagePartRecord,
  type MessagePartType,
} from "./store/conversation-store.js";
import { SummaryStore } from "./store/summary-store.js";
import { createLcmSummarizeFromLegacyParams, LcmProviderAuthError } from "./summarize.js";
import type { LcmDependencies } from "./types.js";
import { estimateTokens } from "./estimate-tokens.js";

type AgentMessage = Parameters<ContextEngine["ingest"]>[0]["message"];
type AssembleResultWithSystemPrompt = AssembleResult & { systemPromptAddition?: string };
type CircuitBreakerState = {
  failures: number;
  openSince: number | null;
};
type PromptCacheSnapshot = {
  lastObservedCacheRead?: number;
  lastObservedCacheWrite?: number;
  cacheState: CacheState;
  retention?: string;
  sawExplicitBreak: boolean;
};
type IncrementalCompactionDecision = {
  shouldCompact: boolean;
  cacheState: CacheState;
  maxPasses: number;
  rawTokensOutsideTail: number;
  threshold: number;
  leafChunkTokens: number;
  fallbackLeafChunkTokens: number[];
  activityBand: ActivityBand;
  allowCondensedPasses: boolean;
};
type DynamicLeafChunkBounds = {
  floor: number;
  medium: number;
  high: number;
  max: number;
};
type TranscriptRewriteReplacement = {
  entryId: string;
  message: AgentMessage;
};
type TranscriptRewriteRequest = {
  replacements: TranscriptRewriteReplacement[];
};
type ContextEngineMaintenanceResult = {
  changed: boolean;
  bytesFreed: number;
  rewrittenEntries: number;
  reason?: string;
};
type ContextEngineMaintenanceRuntimeContext = Record<string, unknown> & {
  rewriteTranscriptEntries?: (
    request: TranscriptRewriteRequest,
  ) => Promise<ContextEngineMaintenanceResult>;
};

const TRANSCRIPT_GC_BATCH_SIZE = 12;
const HOT_CACHE_HYSTERESIS_TURNS = 2;
const DYNAMIC_LEAF_CHUNK_MEDIUM_MULTIPLIER = 1.5;
const DYNAMIC_LEAF_CHUNK_HIGH_MULTIPLIER = 2;
const DYNAMIC_ACTIVITY_MEDIUM_UPSHIFT_FACTOR = 0.5;
const DYNAMIC_ACTIVITY_MEDIUM_DOWNSHIFT_FACTOR = 0.35;
const DYNAMIC_ACTIVITY_HIGH_UPSHIFT_FACTOR = 1.0;
const DYNAMIC_ACTIVITY_HIGH_DOWNSHIFT_FACTOR = 0.75;

// ── Helpers ──────────────────────────────────────────────────────────────────

function toJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  return typeof encoded === "string" ? encoded : "";
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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

function listTranscriptToolResultEntryIdsByCallId(sessionFile: string): Map<string, string> {
  const sessionManager = SessionManager.open(sessionFile);
  const branch = sessionManager.getBranch();
  const entryIdsByCallId = new Map<string, string>();
  const duplicateCallIds = new Set<string>();

  for (const entry of branch) {
    if (entry.type !== "message" || entry.message.role !== "toolResult") {
      continue;
    }
    const toolCallId = extractTranscriptToolCallId(entry.message as AgentMessage);
    if (!toolCallId) {
      continue;
    }
    if (entryIdsByCallId.has(toolCallId)) {
      duplicateCallIds.add(toolCallId);
      continue;
    }
    entryIdsByCallId.set(toolCallId, entry.id);
  }

  for (const duplicateCallId of duplicateCallIds) {
    entryIdsByCallId.delete(duplicateCallId);
  }

  return entryIdsByCallId;
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
const TOOL_RAW_TYPES: ReadonlySet<string> = new Set([
  "tool_use",
  "toolUse",
  "tool-use",
  "toolCall",
  "tool_call",
  "functionCall",
  "function_call",
  "function_call_output",
  "tool_result",
  "toolResult",
  "tool_use_result",
]);

function looksLikeJsonPayload(value: string): boolean {
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
  // Unknown roles are preserved via message_parts metadata and treated as assistant.
  return "assistant";
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

function parseBootstrapJsonl(raw: string, options?: {
  strict?: boolean;
}): { messages: AgentMessage[]; sawNonWhitespace: boolean; hadMalformedLine: boolean } {
  const messages: AgentMessage[] = [];
  const lines = raw.split(/\r?\n/);
  let sawNonWhitespace = false;
  let hadMalformedLine = false;
  for (const line of lines) {
    const item = line.trim();
    if (!item) {
      continue;
    }
    sawNonWhitespace = true;
    try {
      const parsed = JSON.parse(item);
      const candidate = extractBootstrapMessageCandidate(parsed);
      if (candidate) {
        messages.push(candidate);
        continue;
      }
    } catch {
      if (options?.strict) {
        hadMalformedLine = true;
      }
    }
  }
  return { messages, sawNonWhitespace, hadMalformedLine };
}

/** Load recoverable messages from a JSON/JSONL session file without full-file reads for JSONL. */
async function readLeafPathMessages(sessionFile: string): Promise<AgentMessage[]> {
  try {
    let sawNonWhitespace = false;
    let jsonArrayMode = false;
    let jsonArrayBuffer = "";
    const messages: AgentMessage[] = [];
    const stream = createReadStream(sessionFile, { encoding: "utf8" });
    const lines = createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    for await (const line of lines) {
      if (!sawNonWhitespace) {
        const trimmed = line.trim();
        if (trimmed) {
          sawNonWhitespace = true;
          if (trimmed.startsWith("[")) {
            jsonArrayMode = true;
          }
        }
      }

      if (jsonArrayMode) {
        jsonArrayBuffer += `${line}\n`;
        continue;
      }

      const parsed = parseBootstrapJsonl(line);
      if (parsed.messages.length > 0) {
        messages.push(...parsed.messages);
      }
    }

    if (jsonArrayMode) {
      const trimmed = jsonArrayBuffer.trim();
      if (!trimmed) {
        return [];
      }
      try {
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) {
          return [];
        }
        return parsed.filter(isBootstrapMessage);
      } catch {
        return [];
      }
    }

    return messages;
  } catch {
    return [];
  }
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
      : 20_000;
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

function readFileSegment(sessionFile: string, offset: number): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(sessionFile, "r");
    const stats = statSync(sessionFile);
    const safeOffset = Math.max(0, Math.min(Math.floor(offset), stats.size));
    const length = stats.size - safeOffset;
    if (length <= 0) {
      return "";
    }
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, safeOffset);
    return buffer.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd != null) {
      closeSync(fd);
    }
  }
}

function readLastJsonlEntryBeforeOffset(
  sessionFile: string,
  offset: number,
  messageOnly = false,
  matcher?: (message: AgentMessage) => boolean,
): string | null {
  const chunkSize = 16_384;
  let fd: number | null = null;
  try {
    const safeOffset = Math.max(0, Math.floor(offset));
    if (safeOffset <= 0) {
      return null;
    }

    fd = openSync(sessionFile, "r");
    let cursor = safeOffset;
    let carry = "";
    let reachedStart = false;
    while (cursor > 0 || (reachedStart && carry.length > 0)) {
      if (!reachedStart) {
        const start = Math.max(0, cursor - chunkSize);
        const length = cursor - start;
        const buffer = Buffer.alloc(length);
        readSync(fd, buffer, 0, length, start);
        carry = buffer.toString("utf8") + carry;
        cursor = start;
        if (start === 0) {
          reachedStart = true;
        }
      }

      const trimmedEnd = carry.replace(/\s+$/u, "");
      if (!trimmedEnd) {
        if (reachedStart) break;
        carry = "";
        continue;
      }

      const newlineIndex = Math.max(trimmedEnd.lastIndexOf("\n"), trimmedEnd.lastIndexOf("\r"));
      if (newlineIndex >= 0) {
        const candidate = trimmedEnd.slice(newlineIndex + 1).trim();
        if (candidate) {
          if (messageOnly) {
            let matchedMessage: AgentMessage | null = null;
            try {
              matchedMessage = extractBootstrapMessageCandidate(JSON.parse(candidate));
            } catch { /* not valid JSON, skip */ }
            if (!matchedMessage || (matcher && !matcher(matchedMessage))) {
              carry = trimmedEnd.slice(0, newlineIndex);
              continue;
            }
          }
          return candidate;
        }
        carry = trimmedEnd.slice(0, newlineIndex);
        continue;
      }

      // No newline found — entire trimmedEnd is one line
      if (reachedStart) {
        const firstLine = trimmedEnd.trim() || null;
        if (firstLine && messageOnly) {
          let matchedMessage: AgentMessage | null = null;
          try {
            matchedMessage = extractBootstrapMessageCandidate(JSON.parse(firstLine));
          } catch { /* not valid JSON */ }
          if (!matchedMessage || (matcher && !matcher(matchedMessage))) return null;
        }
        return firstLine;
      }
      // Need more data from earlier in the file
      continue;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd != null) {
      closeSync(fd);
    }
  }
}

function readAppendedLeafPathMessages(params: {
  sessionFile: string;
  offset: number;
}): { messages: AgentMessage[]; canUseAppendOnly: boolean; sawNonWhitespace: boolean } {
  const raw = readFileSegment(params.sessionFile, params.offset);
  if (raw == null) {
    return { messages: [], canUseAppendOnly: false, sawNonWhitespace: false };
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return { messages: [], canUseAppendOnly: true, sawNonWhitespace: false };
  }

  if (trimmed.startsWith("[")) {
    return { messages: [], canUseAppendOnly: false, sawNonWhitespace: true };
  }

  const parsed = parseBootstrapJsonl(raw, { strict: true });
  if (parsed.hadMalformedLine) {
    return { messages: [], canUseAppendOnly: false, sawNonWhitespace: parsed.sawNonWhitespace };
  }

  return {
    messages: parsed.messages,
    canUseAppendOnly: true,
    sawNonWhitespace: parsed.sawNonWhitespace,
  };
}

function readBootstrapMessageFromJsonLine(line: string | null): AgentMessage | null {
  if (!line) {
    return null;
  }
  try {
    return extractBootstrapMessageCandidate(JSON.parse(line));
  } catch {
    return null;
  }
}

function messageIdentity(role: string, content: string): string {
  return `${role}\u0000${content}`;
}

// ── LcmContextEngine ────────────────────────────────────────────────────────

export class LcmContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo;

  private config: LcmConfig;

  /** Get the configured timezone, falling back to system timezone. */
  get timezone(): string {
    return this.config.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  private conversationStore: ConversationStore;
  private summaryStore: SummaryStore;
  private compactionTelemetryStore: CompactionTelemetryStore;
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
        this.deps.log.info(
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
      id: "lcm",
      name: "Lossless Context Management Engine",
      version: "0.1.0",
      ownsCompaction: migrationOk,
    };

    this.conversationStore = new ConversationStore(this.db, {
      fts5Available: this.fts5Available,
    });
    this.summaryStore = new SummaryStore(this.db, { fts5Available: this.fts5Available });
    this.compactionTelemetryStore = new CompactionTelemetryStore(this.db);

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
    );

    const compactionConfig: CompactionConfig = {
      contextThreshold: this.config.contextThreshold,
      freshTailCount: this.config.freshTailCount,
      freshTailMaxTokens: this.config.freshTailMaxTokens,
      leafMinFanout: this.config.leafMinFanout,
      condensedMinFanout: this.config.condensedMinFanout,
      condensedMinFanoutHard: this.config.condensedMinFanoutHard,
      incrementalMaxDepth: this.config.incrementalMaxDepth,
      leafChunkTokens: this.config.leafChunkTokens,
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
    this.deps.log.info("[lcm] ensureMigrated: running migrations lazily");
    runLcmMigrations(this.db, {
      log: this.deps.log,
    });
    this.migrated = true;
    this.deps.log.info(
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
      this.deps.log.info(
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

  /** Treat a recent cache hit as still-hot for a couple of turns unless telemetry observed a later break. */
  private shouldApplyHotCacheHysteresis(
    telemetry: ConversationCompactionTelemetryRecord | null,
  ): boolean {
    if (!telemetry?.lastObservedCacheHitAt) {
      return false;
    }
    if (
      telemetry.lastObservedCacheBreakAt
      && telemetry.lastObservedCacheBreakAt >= telemetry.lastObservedCacheHitAt
    ) {
      return false;
    }
    return telemetry.turnsSinceLeafCompaction <= HOT_CACHE_HYSTERESIS_TURNS;
  }

  /** Resolve the effective cache state the incremental compaction policy should react to. */
  private resolveCacheAwareState(
    telemetry: ConversationCompactionTelemetryRecord | null,
  ): CacheState {
    if (!telemetry) {
      return "unknown";
    }
    if (telemetry.cacheState === "hot") {
      return "hot";
    }
    if (this.shouldApplyHotCacheHysteresis(telemetry)) {
      return "hot";
    }
    return telemetry.cacheState;
  }

  /** Decide whether a hot cache still has enough real token-budget headroom to skip incremental maintenance. */
  private isComfortablyUnderTokenBudget(params: {
    currentTokenCount?: number;
    tokenBudget: number;
  }): boolean {
    if (
      typeof params.currentTokenCount !== "number"
      || !Number.isFinite(params.currentTokenCount)
      || params.currentTokenCount < 0
    ) {
      return false;
    }
    const budget = Math.max(1, Math.floor(params.tokenBudget));
    const safeBudget = Math.floor(
      budget * (1 - this.config.cacheAwareCompaction.hotCacheBudgetHeadroomRatio),
    );
    return params.currentTokenCount <= safeBudget;
  }

  /** Resolve bounded dynamic leaf chunk sizes from config and the active token budget. */
  private resolveDynamicLeafChunkBounds(tokenBudget?: number): DynamicLeafChunkBounds {
    const floor = Math.max(1, Math.floor(this.config.leafChunkTokens));
    const configuredMax = this.config.dynamicLeafChunkTokens.enabled
      ? Math.max(floor, Math.floor(this.config.dynamicLeafChunkTokens.max))
      : floor;
    const budgetCap =
      typeof tokenBudget === "number" &&
      Number.isFinite(tokenBudget) &&
      tokenBudget > 0
        ? Math.max(floor, Math.floor(tokenBudget * this.config.contextThreshold))
        : configuredMax;
    const max = Math.max(floor, Math.min(configuredMax, budgetCap));
    const medium = Math.max(
      floor,
      Math.min(max, Math.floor(floor * DYNAMIC_LEAF_CHUNK_MEDIUM_MULTIPLIER)),
    );
    const high = Math.max(
      floor,
      Math.min(max, Math.floor(floor * DYNAMIC_LEAF_CHUNK_HIGH_MULTIPLIER)),
    );
    return { floor, medium, high, max };
  }

  /** Classify the current refill rate into a simple step band with downshift hysteresis. */
  private classifyDynamicLeafActivityBand(params: {
    lastActivityBand?: ActivityBand;
    tokensAccumulatedSinceLeafCompaction: number;
    turnsSinceLeafCompaction: number;
    floor: number;
  }): ActivityBand {
    const turns = Math.max(1, params.turnsSinceLeafCompaction);
    const tokensPerTurn = params.tokensAccumulatedSinceLeafCompaction / turns;
    const mediumUpshift = params.floor * DYNAMIC_ACTIVITY_MEDIUM_UPSHIFT_FACTOR;
    const mediumDownshift = params.floor * DYNAMIC_ACTIVITY_MEDIUM_DOWNSHIFT_FACTOR;
    const highUpshift = params.floor * DYNAMIC_ACTIVITY_HIGH_UPSHIFT_FACTOR;
    const highDownshift = params.floor * DYNAMIC_ACTIVITY_HIGH_DOWNSHIFT_FACTOR;
    const lastBand = params.lastActivityBand ?? "low";

    if (lastBand === "high") {
      if (tokensPerTurn >= highDownshift) {
        return "high";
      }
      return tokensPerTurn >= mediumDownshift ? "medium" : "low";
    }
    if (lastBand === "medium") {
      if (tokensPerTurn >= highUpshift) {
        return "high";
      }
      if (tokensPerTurn < mediumDownshift) {
        return "low";
      }
      return "medium";
    }
    if (tokensPerTurn >= highUpshift) {
      return "high";
    }
    if (tokensPerTurn >= mediumUpshift) {
      return "medium";
    }
    return "low";
  }

  /** Map an activity band to the corresponding working leaf chunk size. */
  private resolveLeafChunkTokensForBand(
    band: ActivityBand,
    bounds: DynamicLeafChunkBounds,
  ): number {
    switch (band) {
      case "high":
        return bounds.high;
      case "medium":
        return bounds.medium;
      default:
        return bounds.floor;
    }
  }

  /** Build descending fallback chunk sizes used when a provider rejects a larger chunk. */
  private buildLeafChunkFallbacks(params: {
    preferred: number;
    bounds: DynamicLeafChunkBounds;
  }): number[] {
    const ordered = [params.preferred, params.bounds.max, params.bounds.high, params.bounds.medium, params.bounds.floor];
    const seen = new Set<number>();
    const fallbacks: number[] = [];
    for (const value of ordered) {
      const normalized = Math.max(params.bounds.floor, Math.floor(value));
      if (seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      fallbacks.push(normalized);
    }
    return fallbacks.sort((a, b) => b - a);
  }

  /** Detect provider/model token-limit failures that should trigger a lower chunk retry. */
  private isRecoverableLeafChunkOverflowError(error: unknown): boolean {
    const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
    if (!message) {
      return false;
    }
    return [
      "context length",
      "context window",
      "maximum context",
      "max context",
      "too many tokens",
      "too many input tokens",
      "input tokens",
      "token limit",
      "context limit",
      "input is too large",
      "input too large",
      "prompt is too long",
      "request too large",
      "exceeds the model",
      "exceeds context",
    ].some((fragment) => message.includes(fragment));
  }

  /** Extract the current prompt-cache snapshot from runtime context, if present. */
  private readPromptCacheSnapshot(runtimeContext?: Record<string, unknown>): PromptCacheSnapshot | null {
    const promptCache = asRecord(runtimeContext?.promptCache);
    if (!promptCache) {
      return null;
    }

    const lastCallUsage = asRecord(promptCache.lastCallUsage);
    const observation = asRecord(promptCache.observation);
    const cacheRead = this.normalizeOptionalCount(lastCallUsage?.cacheRead);
    const cacheWrite = this.normalizeOptionalCount(lastCallUsage?.cacheWrite);
    const sawExplicitBreak = safeBoolean(observation?.broke) === true;
    const retention = safeString(promptCache.retention)?.trim();
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
    } else if (hasUsageSignal || hasObservationSignal) {
      cacheState = "cold";
    }

    return {
      ...(cacheRead !== undefined ? { lastObservedCacheRead: cacheRead } : {}),
      ...(cacheWrite !== undefined ? { lastObservedCacheWrite: cacheWrite } : {}),
      cacheState,
      ...(retention ? { retention } : {}),
      sawExplicitBreak,
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
    const bounds = this.resolveDynamicLeafChunkBounds(params.tokenBudget);
    const turnsSinceLeafCompaction =
      (existing?.turnsSinceLeafCompaction ?? 0) + 1;
    const tokensAccumulatedSinceLeafCompaction =
      params.rawTokensOutsideTail ?? existing?.tokensAccumulatedSinceLeafCompaction ?? 0;
    const lastActivityBand = this.classifyDynamicLeafActivityBand({
      lastActivityBand: existing?.lastActivityBand,
      tokensAccumulatedSinceLeafCompaction,
      turnsSinceLeafCompaction,
      floor: bounds.floor,
    });
    await this.compactionTelemetryStore.upsertConversationCompactionTelemetry({
      conversationId: params.conversationId,
      lastObservedCacheRead: snapshot?.lastObservedCacheRead ?? existing?.lastObservedCacheRead ?? null,
      lastObservedCacheWrite:
        snapshot?.lastObservedCacheWrite ?? existing?.lastObservedCacheWrite ?? null,
      lastObservedCacheHitAt:
        snapshot?.cacheState === "hot"
          ? now
          : existing?.lastObservedCacheHitAt ?? null,
      lastObservedCacheBreakAt:
        snapshot?.sawExplicitBreak
          ? now
          : existing?.lastObservedCacheBreakAt ?? null,
      cacheState: snapshot?.cacheState ?? existing?.cacheState ?? "unknown",
      retention: snapshot?.retention ?? existing?.retention ?? null,
      lastLeafCompactionAt: existing?.lastLeafCompactionAt ?? null,
      turnsSinceLeafCompaction,
      tokensAccumulatedSinceLeafCompaction,
      lastActivityBand,
    });
    const updated = await this.compactionTelemetryStore.getConversationCompactionTelemetry(
      params.conversationId,
    );
    if (updated) {
      this.deps.log.debug(
        `[lcm] compaction telemetry updated: conversation=${params.conversationId} cacheState=${updated.cacheState} cacheRead=${updated.lastObservedCacheRead ?? "null"} cacheWrite=${updated.lastObservedCacheWrite ?? "null"} retention=${updated.retention ?? "null"} turnsSinceLeafCompaction=${updated.turnsSinceLeafCompaction} tokensSinceLeafCompaction=${updated.tokensAccumulatedSinceLeafCompaction} activityBand=${updated.lastActivityBand} rawTokensOutsideTail=${params.rawTokensOutsideTail ?? "null"} tokenBudget=${params.tokenBudget ?? "null"}`,
      );
    }
    return updated;
  }

  /** Reset refill counters after any successful leaf-producing compaction. */
  private async markLeafCompactionTelemetrySuccess(params: {
    conversationId: number;
    activityBand?: ActivityBand;
  }): Promise<void> {
    const existing = await this.compactionTelemetryStore.getConversationCompactionTelemetry(
      params.conversationId,
    );
    await this.compactionTelemetryStore.upsertConversationCompactionTelemetry({
      conversationId: params.conversationId,
      lastObservedCacheRead: existing?.lastObservedCacheRead ?? null,
      lastObservedCacheWrite: existing?.lastObservedCacheWrite ?? null,
      lastObservedCacheHitAt: existing?.lastObservedCacheHitAt ?? null,
      lastObservedCacheBreakAt: existing?.lastObservedCacheBreakAt ?? null,
      cacheState: existing?.cacheState ?? "unknown",
      retention: existing?.retention ?? null,
      lastLeafCompactionAt: new Date(),
      turnsSinceLeafCompaction: 0,
      tokensAccumulatedSinceLeafCompaction: 0,
      lastActivityBand: params.activityBand ?? existing?.lastActivityBand ?? "low",
    });
    this.deps.log.debug(
      `[lcm] compaction telemetry reset after leaf compaction: conversation=${params.conversationId} cacheState=${existing?.cacheState ?? "unknown"} activityBand=${params.activityBand ?? existing?.lastActivityBand ?? "low"}`,
    );
  }

  /** Emit an operational trace for the incremental compaction policy decision. */
  private logIncrementalCompactionDecision(params: {
    conversationId: number;
    cacheState: CacheState;
    activityBand: ActivityBand;
    triggerLeafChunkTokens: number;
    preferredLeafChunkTokens: number;
    fallbackLeafChunkTokens: number[];
    rawTokensOutsideTail: number;
    threshold: number;
    shouldCompact: boolean;
    maxPasses: number;
    allowCondensedPasses: boolean;
    reason: string;
  }): IncrementalCompactionDecision {
    this.deps.log.info(
      `[lcm] incremental compaction decision: conversation=${params.conversationId} cacheState=${params.cacheState} activityBand=${params.activityBand} triggerLeafChunkTokens=${params.triggerLeafChunkTokens} preferredLeafChunkTokens=${params.preferredLeafChunkTokens} fallbackLeafChunkTokens=${params.fallbackLeafChunkTokens.join(",")} rawTokensOutsideTail=${params.rawTokensOutsideTail} threshold=${params.threshold} shouldCompact=${params.shouldCompact} maxPasses=${params.maxPasses} allowCondensedPasses=${params.allowCondensedPasses} reason=${params.reason}`,
    );
    return {
      shouldCompact: params.shouldCompact,
      cacheState: params.cacheState,
      maxPasses: params.maxPasses,
      rawTokensOutsideTail: params.rawTokensOutsideTail,
      threshold: params.threshold,
      leafChunkTokens: params.preferredLeafChunkTokens,
      fallbackLeafChunkTokens: params.fallbackLeafChunkTokens,
      activityBand: params.activityBand,
      allowCondensedPasses: params.allowCondensedPasses,
    };
  }

  /** Resolve the cache-aware incremental-compaction policy for the current session. */
  private async evaluateIncrementalCompaction(params: {
    conversationId: number;
    tokenBudget: number;
    currentTokenCount?: number;
  }): Promise<IncrementalCompactionDecision> {
    const telemetry = await this.compactionTelemetryStore.getConversationCompactionTelemetry(
      params.conversationId,
    );
    const cacheState =
      this.config.cacheAwareCompaction.enabled
        ? this.resolveCacheAwareState(telemetry)
        : "unknown";
    const bounds = this.resolveDynamicLeafChunkBounds(params.tokenBudget);
    const activityBand =
      this.config.dynamicLeafChunkTokens.enabled
        ? this.classifyDynamicLeafActivityBand({
          lastActivityBand: telemetry?.lastActivityBand,
          tokensAccumulatedSinceLeafCompaction:
            telemetry?.tokensAccumulatedSinceLeafCompaction ?? 0,
          turnsSinceLeafCompaction: telemetry?.turnsSinceLeafCompaction ?? 0,
          floor: bounds.floor,
        })
        : "low";
    const triggerLeafChunkTokens =
      this.config.dynamicLeafChunkTokens.enabled && cacheState === "hot"
        ? bounds.max
        : this.config.dynamicLeafChunkTokens.enabled
          ? this.resolveLeafChunkTokensForBand(activityBand, bounds)
          : bounds.floor;
    const preferredLeafChunkTokens =
      this.config.cacheAwareCompaction.enabled && (cacheState === "cold" || cacheState === "hot")
        ? bounds.max
        : triggerLeafChunkTokens;
    const fallbackLeafChunkTokens = this.buildLeafChunkFallbacks({
      preferred: preferredLeafChunkTokens,
      bounds,
    });
    const leafTrigger = await this.compaction.evaluateLeafTrigger(
      params.conversationId,
      triggerLeafChunkTokens,
    );
    if (!leafTrigger.shouldCompact) {
      return this.logIncrementalCompactionDecision({
        conversationId: params.conversationId,
        cacheState,
        activityBand,
        triggerLeafChunkTokens,
        preferredLeafChunkTokens,
        fallbackLeafChunkTokens,
        rawTokensOutsideTail: leafTrigger.rawTokensOutsideTail,
        threshold: leafTrigger.threshold,
        shouldCompact: false,
        maxPasses: 1,
        allowCondensedPasses: false,
        reason: "below-leaf-trigger",
      });
    }

    const budgetDecision = await this.compaction.evaluate(
      params.conversationId,
      params.tokenBudget,
      params.currentTokenCount,
    );
    if (budgetDecision.shouldCompact) {
      return this.logIncrementalCompactionDecision({
        conversationId: params.conversationId,
        cacheState,
        activityBand,
        triggerLeafChunkTokens,
        preferredLeafChunkTokens,
        fallbackLeafChunkTokens,
        rawTokensOutsideTail: leafTrigger.rawTokensOutsideTail,
        threshold: leafTrigger.threshold,
        shouldCompact: true,
        maxPasses: 1,
        allowCondensedPasses: true,
        reason: "budget-trigger",
      });
    }

    if (
      cacheState === "hot"
      && this.isComfortablyUnderTokenBudget({
        currentTokenCount: params.currentTokenCount,
        tokenBudget: params.tokenBudget,
      })
    ) {
      return this.logIncrementalCompactionDecision({
        conversationId: params.conversationId,
        cacheState,
        activityBand,
        triggerLeafChunkTokens,
        preferredLeafChunkTokens,
        fallbackLeafChunkTokens,
        rawTokensOutsideTail: leafTrigger.rawTokensOutsideTail,
        threshold: leafTrigger.threshold,
        shouldCompact: false,
        maxPasses: 1,
        allowCondensedPasses: false,
        reason: "hot-cache-budget-headroom",
      });
    }

    if (
      cacheState === "hot"
      && leafTrigger.rawTokensOutsideTail
        < Math.floor(
          leafTrigger.threshold * this.config.cacheAwareCompaction.hotCachePressureFactor,
        )
    ) {
      return this.logIncrementalCompactionDecision({
        conversationId: params.conversationId,
        cacheState,
        activityBand,
        triggerLeafChunkTokens,
        preferredLeafChunkTokens,
        fallbackLeafChunkTokens,
        rawTokensOutsideTail: leafTrigger.rawTokensOutsideTail,
        threshold: leafTrigger.threshold,
        shouldCompact: false,
        maxPasses: 1,
        allowCondensedPasses: false,
        reason: "hot-cache-defer",
      });
    }

    const maxPasses =
      cacheState === "cold"
        ? Math.max(1, this.config.cacheAwareCompaction.maxColdCacheCatchupPasses)
        : 1;
    return this.logIncrementalCompactionDecision({
      conversationId: params.conversationId,
      cacheState,
      activityBand,
      triggerLeafChunkTokens,
      preferredLeafChunkTokens,
      fallbackLeafChunkTokens,
      rawTokensOutsideTail: leafTrigger.rawTokensOutsideTail,
      threshold: leafTrigger.threshold,
      shouldCompact: true,
      maxPasses,
      allowCondensedPasses: cacheState !== "hot",
      reason: cacheState === "cold" ? "cold-cache-catchup" : "leaf-trigger",
    });
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
        legacyParams: { provider, model },
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

  /** Persist intercepted large-file text payloads to the configured lcm-files directory. */
  private async storeLargeFileContent(params: {
    conversationId: number;
    fileId: string;
    extension: string;
    content: string;
  }): Promise<string> {
    const dir = join(this.config.largeFilesDir, String(params.conversationId));
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

  // ── ContextEngine interface ─────────────────────────────────────────────

  /**
   * Reconcile session-file history with persisted messages and append only the
   * tail that is present in JSONL but missing from LCM.
   */
  private async reconcileSessionTail(params: {
    sessionId: string;
    sessionKey?: string;
    conversationId: number;
    historicalMessages: AgentMessage[];
  }): Promise<{
    blockedByImportCap: boolean;
    importedMessages: number;
    hasOverlap: boolean;
  }> {
    const { sessionId, conversationId, historicalMessages } = params;
    const startedAt = Date.now();
    const sessionContext = this.formatSessionLogContext({
      conversationId,
      sessionId,
      sessionKey: params.sessionKey,
    });
    if (historicalMessages.length === 0) {
      this.deps.log.info(
        `[lcm] reconcileSessionTail: skipped for ${sessionContext} duration=${formatDurationMs(Date.now() - startedAt)} historicalMessages=0 reason=empty-history`,
      );
      return { blockedByImportCap: false, importedMessages: 0, hasOverlap: false };
    }

    const latestDbMessage = await this.conversationStore.getLastMessage(conversationId);
    if (!latestDbMessage) {
      this.deps.log.info(
        `[lcm] reconcileSessionTail: skipped for ${sessionContext} duration=${formatDurationMs(Date.now() - startedAt)} historicalMessages=${historicalMessages.length} reason=no-db-tail`,
      );
      return { blockedByImportCap: false, importedMessages: 0, hasOverlap: false };
    }

    const storedHistoricalMessages = historicalMessages.map((message) => toStoredMessage(message));

    // Fast path: one tail comparison for the common in-sync case.
    const latestHistorical = storedHistoricalMessages[storedHistoricalMessages.length - 1];
    const latestIdentity = messageIdentity(latestDbMessage.role, latestDbMessage.content);
    if (latestIdentity === messageIdentity(latestHistorical.role, latestHistorical.content)) {
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
        this.deps.log.info(
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

    if (anchorIndex < 0) {
      this.deps.log.info(
        `[lcm] reconcileSessionTail: no anchor for ${sessionContext} duration=${formatDurationMs(Date.now() - startedAt)} historicalMessages=${historicalMessages.length} importedMessages=0 overlap=false`,
      );
      return { blockedByImportCap: false, importedMessages: 0, hasOverlap: false };
    }
    if (anchorIndex >= historicalMessages.length - 1) {
      this.deps.log.info(
        `[lcm] reconcileSessionTail: anchor at tip for ${sessionContext} duration=${formatDurationMs(Date.now() - startedAt)} historicalMessages=${historicalMessages.length} importedMessages=0 overlap=true`,
      );
      return { blockedByImportCap: false, importedMessages: 0, hasOverlap: true };
    }

    const missingTail = historicalMessages.slice(anchorIndex + 1);

    const existingDbCount = await this.conversationStore.getMessageCount(conversationId);
    if (existingDbCount > 0 && missingTail.length > Math.max(existingDbCount * 0.2, 50)) {
      this.deps.log.warn(
        `[lcm] reconcileSessionTail: import cap exceeded for ${sessionContext} — would import ${missingTail.length} messages (existing: ${existingDbCount}). Aborting to prevent flood.`,
      );
      this.deps.log.info(
        `[lcm] reconcileSessionTail: blocked for ${sessionContext} duration=${formatDurationMs(Date.now() - startedAt)} historicalMessages=${historicalMessages.length} missingTail=${missingTail.length} existingDbCount=${existingDbCount}`,
      );
      return { blockedByImportCap: true, importedMessages: 0, hasOverlap: true };
    }

    let importedMessages = 0;
    for (const message of missingTail) {
      const result = await this.ingestSingle({ sessionId, sessionKey: params.sessionKey, message });
      if (result.ingested) {
        importedMessages += 1;
      }
    }

    this.deps.log.info(
      `[lcm] reconcileSessionTail: slow path for ${sessionContext} duration=${formatDurationMs(Date.now() - startedAt)} historicalMessages=${historicalMessages.length} anchorIndex=${anchorIndex} missingTail=${missingTail.length} importedMessages=${importedMessages}`,
    );
    return { blockedByImportCap: false, importedMessages, hasOverlap: true };
  }

  /**
   * Persist bootstrap checkpoint metadata anchored to the current DB frontier.
   *
   * We intentionally checkpoint the session file's current EOF while hashing the
   * latest persisted DB message. This keeps append-only recovery aligned with the
   * canonical LCM frontier even when trailing transcript entries are pruned or
   * otherwise noncanonical.
   */
  private async refreshBootstrapState(params: {
    conversationId: number;
    sessionFile: string;
    fileStats?: { size: number; mtimeMs: number };
  }): Promise<void> {
    const latestDbMessage = await this.conversationStore.getLastMessage(params.conversationId);
    const fileStats = params.fileStats ?? statSync(params.sessionFile);
    await this.summaryStore.upsertConversationBootstrapState({
      conversationId: params.conversationId,
      sessionFilePath: params.sessionFile,
      lastSeenSize: fileStats.size,
      lastSeenMtimeMs: Math.trunc(fileStats.mtimeMs),
      lastProcessedOffset: fileStats.size,
      lastProcessedEntryHash: latestDbMessage
        ? createBootstrapEntryHash({
            role: latestDbMessage.role,
            content: latestDbMessage.content,
            tokenCount: latestDbMessage.tokenCount,
          })
        : null,
    });
  }

  async bootstrap(params: {
    sessionId: string;
    sessionFile: string;
    sessionKey?: string;
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
    const startedAt = Date.now();
    const sessionLabel = [
      `session=${params.sessionId}`,
      ...(params.sessionKey?.trim() ? [`sessionKey=${params.sessionKey.trim()}`] : []),
    ].join(" ");
    const sessionFileStats = statSync(params.sessionFile);
    const sessionFileSize = sessionFileStats.size;
    const sessionFileMtimeMs = Math.trunc(sessionFileStats.mtimeMs);

    const result = await this.withSessionQueue(
      this.resolveSessionQueueKey(params.sessionId, params.sessionKey),
      async () =>
        this.conversationStore.withTransaction(async () => {
          const persistBootstrapState = async (
            conversationId: number,
          ): Promise<void> => {
            await this.refreshBootstrapState({
              conversationId,
              sessionFile: params.sessionFile,
              fileStats: {
                size: sessionFileSize,
                mtimeMs: sessionFileMtimeMs,
              },
            });
          };

          const conversation = await this.conversationStore.getOrCreateConversation(params.sessionId, {
            sessionKey: params.sessionKey,
          });
          const conversationId = conversation.conversationId;
          let existingCount = await this.conversationStore.getMessageCount(conversationId);
          let bootstrapState =
            existingCount > 0
              ? await this.summaryStore.getConversationBootstrapState(conversationId)
              : null;

          if (
            bootstrapState &&
            bootstrapState.sessionFilePath !== params.sessionFile
          ) {
            this.deps.log.warn(
              `[lcm] bootstrap: session file rotated conversation=${conversationId} ${sessionLabel} oldFile=${bootstrapState.sessionFilePath} newFile=${params.sessionFile}`,
            );
            bootstrapState = null;
          }

          // If the transcript file is byte-for-byte unchanged from the last
          // successful bootstrap checkpoint, skip reopening and reparsing it.
          if (
            bootstrapState &&
            bootstrapState.sessionFilePath === params.sessionFile &&
            bootstrapState.lastSeenSize === sessionFileSize &&
            bootstrapState.lastSeenMtimeMs === sessionFileMtimeMs
          ) {
            if (!conversation.bootstrappedAt) {
              await this.conversationStore.markConversationBootstrapped(conversationId);
            }
            this.deps.log.info(
              `[lcm] bootstrap: checkpoint hit conversation=${conversationId} ${sessionLabel} existingCount=${existingCount} duration=${formatDurationMs(Date.now() - startedAt)}`,
            );
            return {
              bootstrapped: false,
              importedMessages: 0,
              reason: conversation.bootstrappedAt ? "already bootstrapped" : "conversation already up to date",
            };
          }

          if (
            existingCount > 0 &&
            bootstrapState &&
            bootstrapState.sessionFilePath === params.sessionFile &&
            sessionFileSize > bootstrapState.lastSeenSize &&
            sessionFileMtimeMs >= bootstrapState.lastSeenMtimeMs
          ) {
            const latestDbMessage = await this.conversationStore.getLastMessage(conversationId);
            const latestDbHash = latestDbMessage
              ? createBootstrapEntryHash({
                  role: latestDbMessage.role,
                  content: latestDbMessage.content,
                  tokenCount: latestDbMessage.tokenCount,
                })
              : null;
            const tailEntryRaw = readLastJsonlEntryBeforeOffset(
              params.sessionFile,
              bootstrapState.lastProcessedOffset,
              true,
              (message) => createBootstrapEntryHash(toStoredMessage(message)) === latestDbHash,
            );
            const tailEntryMessage = readBootstrapMessageFromJsonLine(tailEntryRaw);
            const tailEntryHash = tailEntryMessage
              ? createBootstrapEntryHash(toStoredMessage(tailEntryMessage))
              : null;

            if (
              latestDbHash &&
              latestDbHash === bootstrapState.lastProcessedEntryHash &&
              tailEntryHash &&
              tailEntryHash === bootstrapState.lastProcessedEntryHash
            ) {
              const appended = readAppendedLeafPathMessages({
                sessionFile: params.sessionFile,
                offset: bootstrapState.lastProcessedOffset,
              });
              if (appended.canUseAppendOnly) {
                if (!conversation.bootstrappedAt) {
                  await this.conversationStore.markConversationBootstrapped(conversationId);
                }

                let importedMessages = 0;
                for (const message of appended.messages) {
                  const ingestResult = await this.ingestSingle({
                    sessionId: params.sessionId,
                    sessionKey: params.sessionKey,
                    message,
                  });
                  if (ingestResult.ingested) {
                    importedMessages += 1;
                  }
                }

                await persistBootstrapState(conversationId);
                this.deps.log.info(
                  `[lcm] bootstrap: append-only conversation=${conversationId} ${sessionLabel} existingCount=${existingCount} appendedMessages=${appended.messages.length} importedMessages=${importedMessages} duration=${formatDurationMs(Date.now() - startedAt)}`,
                );

                if (importedMessages > 0) {
                  return {
                    bootstrapped: true,
                    importedMessages,
                    reason: "reconciled missing session messages",
                  };
                }

                return {
                  bootstrapped: false,
                  importedMessages: 0,
                  reason: conversation.bootstrappedAt ? "already bootstrapped" : "conversation already up to date",
                };
              }
            }
          }

          const historicalMessages = await readLeafPathMessages(params.sessionFile);
          this.deps.log.info(
            `[lcm] bootstrap: full transcript read conversation=${conversationId} ${sessionLabel} existingCount=${existingCount} historicalMessages=${historicalMessages.length} duration=${formatDurationMs(Date.now() - startedAt)}`,
          );

          // First-time import path: no LCM rows yet, so seed directly from the
          // active leaf context snapshot.
          if (existingCount === 0) {
            const bootstrapMessages = trimBootstrapMessagesToBudget(
              historicalMessages,
              resolveBootstrapMaxTokens(this.config),
            );

            if (bootstrapMessages.length === 0) {
              await this.conversationStore.markConversationBootstrapped(conversationId);
              await persistBootstrapState(conversationId);
              return {
                bootstrapped: false,
                importedMessages: 0,
                reason: "no leaf-path messages in session",
              };
            }

            const nextSeq = (await this.conversationStore.getMaxSeq(conversationId)) + 1;
            const bulkInput = bootstrapMessages.map((message, index) => {
              const stored = toStoredMessage(message);
              return {
                conversationId,
                seq: nextSeq + index,
                role: stored.role,
                content: stored.content,
                tokenCount: stored.tokenCount,
              };
            });

            const inserted = await this.conversationStore.createMessagesBulk(bulkInput);
            await this.summaryStore.appendContextMessages(
              conversationId,
              inserted.map((record) => record.messageId),
            );
            await this.conversationStore.markConversationBootstrapped(conversationId);

            // Prune HEARTBEAT_OK turns from the freshly imported data
            if (this.config.pruneHeartbeatOk) {
              const pruned = await this.pruneHeartbeatOkTurns(conversationId);
              if (pruned > 0) {
                this.deps.log.info(
                  `[lcm] bootstrap: pruned ${pruned} HEARTBEAT_OK messages from conversation ${conversationId}`,
                );
              }
            }

            await persistBootstrapState(conversationId);
            this.deps.log.info(
              `[lcm] bootstrap: initial import conversation=${conversationId} ${sessionLabel} importedMessages=${inserted.length} sourceMessages=${historicalMessages.length} duration=${formatDurationMs(Date.now() - startedAt)}`,
            );

            return {
              bootstrapped: true,
              importedMessages: inserted.length,
            };
          }

          // Existing conversation path: reconcile crash gaps by appending JSONL
          // messages that were never persisted to LCM.
          const reconcile = await this.reconcileSessionTail({
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            conversationId,
            historicalMessages,
          });
          this.deps.log.info(
            `[lcm] bootstrap: reconcile finished conversation=${conversationId} ${sessionLabel} importedMessages=${reconcile.importedMessages} overlap=${reconcile.hasOverlap} blockedByImportCap=${reconcile.blockedByImportCap} duration=${formatDurationMs(Date.now() - startedAt)}`,
          );

          if (reconcile.blockedByImportCap) {
            return {
              bootstrapped: false,
              importedMessages: 0,
              reason: "reconcile import capped",
            };
          }

          if (!conversation.bootstrappedAt) {
            await this.conversationStore.markConversationBootstrapped(conversationId);
          }

          if (reconcile.importedMessages > 0) {
            await persistBootstrapState(conversationId);
            return {
              bootstrapped: true,
              importedMessages: reconcile.importedMessages,
              reason: "reconciled missing session messages",
            };
          }

          if (reconcile.hasOverlap) {
            await persistBootstrapState(conversationId);
          }

          if (conversation.bootstrappedAt) {
            return {
              bootstrapped: false,
              importedMessages: 0,
              reason: "already bootstrapped",
            };
          }

          return {
            bootstrapped: false,
            importedMessages: 0,
            reason: reconcile.hasOverlap
              ? "conversation already up to date"
              : "conversation already has messages",
          };
        }),
      { operationName: "bootstrap", context: sessionLabel },
    );

    // Post-bootstrap pruning: clean HEARTBEAT_OK turns that were already
    // in the DB from prior bootstrap cycles (before pruning was enabled).
    if (this.config.pruneHeartbeatOk && result.bootstrapped === false) {
      try {
        const conversation = await this.conversationStore.getConversationForSession({
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
        });
        if (conversation) {
          const pruned = await this.pruneHeartbeatOkTurns(conversation.conversationId);
          if (pruned > 0) {
            await this.refreshBootstrapState({
              conversationId: conversation.conversationId,
              sessionFile: params.sessionFile,
            });
            this.deps.log.info(
              `[lcm] bootstrap: retroactively pruned ${pruned} HEARTBEAT_OK messages from conversation ${conversation.conversationId}`,
            );
          }
        }
      } catch (err) {
        this.deps.log.warn(
          `[lcm] bootstrap: heartbeat pruning failed: ${describeLogError(err)}`,
        );
      }
    }

    this.deps.log.info(
      `[lcm] bootstrap: done ${sessionLabel} bootstrapped=${result.bootstrapped} importedMessages=${result.importedMessages} reason=${result.reason ?? "none"} duration=${formatDurationMs(Date.now() - startedAt)}`,
    );
    return result;
  }

  /**
   * Remove messages from the batch that already exist in the DB for this session.
   * Conservative replay detection: only strip a prefix when the incoming
   * batch begins with the entire stored transcript for the session.
   *
   * Fixes two issues from #246:
   * 1. Replaced hasMessage() fast-path with aligned-tail check — the old
   *    approach false-positives on legitimate repeated first messages
   * 2. Dedup now runs on newMessages only, before autoCompactionSummary
   *    is prepended — synthetic summaries can no longer interfere with
   *    replay detection
   */
  private async deduplicateAfterTurnBatch(
    sessionId: string,
    sessionKey: string | undefined,
    batch: AgentMessage[],
  ): Promise<AgentMessage[]> {
    if (batch.length === 0) return batch;

    const conversation = await this.conversationStore.getConversationForSession({
      sessionId,
      sessionKey,
    });
    if (!conversation) return batch;

    const conversationId = conversation.conversationId;
    const storedMessageCount = await this.conversationStore.getMessageCount(conversationId);
    if (storedMessageCount === 0 || storedMessageCount > batch.length) {
      return batch;
    }

    // Aligned-tail check: DB's last message must match the message at the
    // exact replay boundary in the incoming batch. This replaces the
    // hasMessage() check which could false-positive on any repeated content.
    const lastDbMessage = await this.conversationStore.getLastMessage(conversationId);
    if (!lastDbMessage) return batch;

    const storedBatch = batch.map((m) => toStoredMessage(m));
    const batchAtBoundary = storedBatch[storedMessageCount - 1]!;
    if (
      messageIdentity(lastDbMessage.role, lastDbMessage.content) !==
      messageIdentity(batchAtBoundary.role, batchAtBoundary.content)
    ) {
      return batch;
    }

    // Full proof: incoming batch must start with the entire stored transcript
    // in exact order before we trim anything.
    const storedMessages = await this.conversationStore.getMessages(conversationId, {
      limit: storedMessageCount,
    });
    if (storedMessages.length !== storedMessageCount) {
      return batch;
    }
    for (let i = 0; i < storedMessageCount; i += 1) {
      const storedConversationMessage = storedMessages[i]!;
      const incomingMessage = storedBatch[i]!;
      if (
        messageIdentity(storedConversationMessage.role, storedConversationMessage.content) !==
        messageIdentity(incomingMessage.role, incomingMessage.content)
      ) {
        return batch;
      }
    }

    return batch.slice(storedMessageCount);
  }
  /**
   * Rebuild a compact tool-result message from stored message parts.
   *
   * The first transcript-GC pass only rewrites tool results that were already
   * externalized into large_files during ingest, so the stored placeholder is
   * the canonical replacement content.
   */
  private async buildTranscriptGcReplacementMessage(
    messageId: number,
  ): Promise<AgentMessage | null> {
    const message = await this.conversationStore.getMessageById(messageId);
    if (!message) {
      return null;
    }

    const parts = await this.conversationStore.getMessageParts(messageId);
    const toolCallId = pickToolCallId(parts);
    if (!toolCallId) {
      return null;
    }

    const content = contentFromParts(parts, "toolResult", message.content);
    const toolName = pickToolName(parts) ?? "unknown";
    const isError = pickToolIsError(parts);

    return {
      role: "toolResult",
      toolCallId,
      toolName,
      content,
      ...(isError !== undefined ? { isError } : {}),
    } as AgentMessage;
  }

  /**
   * Run transcript GC for summarized tool-result messages that already have a
   * large_files-backed placeholder stored in LCM.
   */
  async maintain(params: {
    sessionId: string;
    sessionFile: string;
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
    if (!this.config.transcriptGcEnabled) {
      return {
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
        reason: "transcript GC disabled",
      };
    }
    if (typeof params.runtimeContext?.rewriteTranscriptEntries !== "function") {
      return {
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
        reason: "runtime rewrite helper unavailable",
      };
    }

    const rewriteTranscriptEntries = params.runtimeContext.rewriteTranscriptEntries;
    const startedAt = Date.now();
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

        const candidates = await this.summaryStore.listTranscriptGcCandidates(
          conversation.conversationId,
          { limit: TRANSCRIPT_GC_BATCH_SIZE },
        );
        if (candidates.length === 0) {
          this.deps.log.info(
            `[lcm] maintain: no transcript GC candidates conversation=${conversation.conversationId} ${sessionLabel} duration=${formatDurationMs(Date.now() - startedAt)}`,
          );
          return {
            changed: false,
            bytesFreed: 0,
            rewrittenEntries: 0,
            reason: "no transcript GC candidates",
          };
        }

        const transcriptEntryIdsByCallId = listTranscriptToolResultEntryIdsByCallId(
          params.sessionFile,
        );
        const replacements: TranscriptRewriteReplacement[] = [];
        const seenEntryIds = new Set<string>();

        for (const candidate of candidates) {
          const entryId = transcriptEntryIdsByCallId.get(candidate.toolCallId);
          if (!entryId || seenEntryIds.has(entryId)) {
            continue;
          }

          const replacementMessage = await this.buildTranscriptGcReplacementMessage(
            candidate.messageId,
          );
          if (!replacementMessage) {
            continue;
          }

          seenEntryIds.add(entryId);
          replacements.push({
            entryId,
            message: replacementMessage,
          });
        }

        if (replacements.length === 0) {
          this.deps.log.info(
            `[lcm] maintain: no matching transcript entries conversation=${conversation.conversationId} ${sessionLabel} candidates=${candidates.length} duration=${formatDurationMs(Date.now() - startedAt)}`,
          );
          return {
            changed: false,
            bytesFreed: 0,
            rewrittenEntries: 0,
            reason: "no matching transcript entries",
          };
        }

        const result = await rewriteTranscriptEntries({
          replacements,
        });

        if (result.changed) {
          try {
            await this.refreshBootstrapState({
              conversationId: conversation.conversationId,
              sessionFile: params.sessionFile,
            });
          } catch (e) {
            this.deps.log.warn(
              `[lcm] Failed to update bootstrap checkpoint after maintain: ${describeLogError(e)}`,
            );
          }
        }

        this.deps.log.info(
          `[lcm] maintain: done conversation=${conversation.conversationId} ${sessionLabel} candidates=${candidates.length} replacements=${replacements.length} changed=${result.changed} rewrittenEntries=${result.rewrittenEntries} bytesFreed=${result.bytesFreed} duration=${formatDurationMs(Date.now() - startedAt)}`,
        );
        return result;
      },
      { operationName: "maintain", context: sessionLabel },
    );
  }
  private async ingestSingle(params: {
    sessionId: string;
    sessionKey?: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    const { sessionId, sessionKey, message, isHeartbeat } = params;
    if (isHeartbeat) {
      return { ingested: false };
    }

    // Skip assistant messages that failed with an error and have no useful content.
    // These occur when an API call returns a 500 or similar transient error.
    // Ingesting them pollutes the LCM database: on retry, the error messages
    // accumulate and get assembled into context, creating a positive feedback
    // loop where each retry sends an increasingly large (and malformed) payload
    // that continues to fail.
    if (message.role === "assistant") {
      const topLevel = message as unknown as Record<string, unknown>;
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

    const stored = toStoredMessage(message);

    // Get or create conversation for this session
    const conversation = await this.conversationStore.getOrCreateConversation(sessionId, {
      sessionKey,
    });
    const conversationId = conversation.conversationId;

    let messageForParts = message;
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
        message,
      });
      if (intercepted) {
        messageForParts = intercepted.rewrittenMessage;
        const rewrittenStored = toStoredMessage(intercepted.rewrittenMessage);
        stored.content = rewrittenStored.content;
        stored.tokenCount = rewrittenStored.tokenCount;
      }
    }

    // Determine next sequence number
    const maxSeq = await this.conversationStore.getMaxSeq(conversationId);
    const seq = maxSeq + 1;

    // Persist the message
    const msgRecord = await this.conversationStore.createMessage({
      conversationId,
      seq,
      role: stored.role,
      content: stored.content,
      tokenCount: stored.tokenCount,
    });
    await this.conversationStore.createMessageParts(
      msgRecord.messageId,
      buildMessageParts({
        sessionId,
        message: messageForParts,
        fallbackContent: stored.content,
      }),
    );

    // Append to context items so assembler can see it
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

  async afterTurn(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    /** OpenClaw runtime param name (preferred). */
    runtimeContext?: Record<string, unknown>;
    /** Back-compat param name. */
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

    // Dedup guard: prevent duplicate ingestion when gateway restart replays
    // full history. Run on newMessages BEFORE prepending autoCompactionSummary
    // so synthetic summaries cannot interfere with replay detection.
    const newMessages = params.messages.slice(params.prePromptMessageCount);
    const dedupedNewMessages = await this.deduplicateAfterTurnBatch(
      params.sessionId,
      params.sessionKey,
      newMessages,
    );

    const ingestBatch: AgentMessage[] = [];
    if (params.autoCompactionSummary) {
      ingestBatch.push({
        role: "user",
        content: params.autoCompactionSummary,
      } as AgentMessage);
    }

    ingestBatch.push(...dedupedNewMessages);
    if (ingestBatch.length === 0) {
      this.deps.log.info(
        `[lcm] afterTurn: nothing to ingest ${sessionLabel} newMessages=${newMessages.length} duration=${formatDurationMs(Date.now() - startedAt)}`,
      );
      return;
    }

    try {
      await this.ingestBatch({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        messages: ingestBatch,
        isHeartbeat: params.isHeartbeat === true,
      });
    } catch (err) {
      // Never compact a stale or partially ingested frontier.
      this.deps.log.error(
        `[lcm] afterTurn: ingest failed, skipping compaction: ${describeLogError(err)}`,
      );
      return;
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
            try {
              await this.refreshBootstrapState({
                conversationId: conversation.conversationId,
                sessionFile: params.sessionFile,
              });
            } catch (err) {
              this.deps.log.warn(
                `[lcm] afterTurn: heartbeat pruning checkpoint refresh failed for ${sessionContext}: ${describeLogError(err)}`,
              );
            }
            this.deps.log.info(
              `[lcm] afterTurn: pruned ${pruned} heartbeat ack messages for ${sessionContext}`,
            );
            return;
          }
        }
      } catch (err) {
        this.deps.log.warn(
          `[lcm] afterTurn: heartbeat pruning failed: ${describeLogError(err)}`,
        );
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

    const liveContextTokens = estimateSessionTokenCountForAfterTurn(params.messages);
    const conversation = await this.conversationStore.getConversationForSession({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    });
    if (!conversation) {
      this.deps.log.info(
        `[lcm] afterTurn: conversation lookup missed ${sessionLabel} ingestBatch=${ingestBatch.length} duration=${formatDurationMs(Date.now() - startedAt)}`,
      );
      return;
    }

    try {
      const rawLeafTrigger = await this.compaction.evaluateLeafTrigger(conversation.conversationId);
      await this.updateCompactionTelemetry({
        conversationId: conversation.conversationId,
        runtimeContext: asRecord(params.runtimeContext),
        tokenBudget,
        rawTokensOutsideTail: rawLeafTrigger.rawTokensOutsideTail,
      });
    } catch (err) {
      this.deps.log.warn(
        `[lcm] afterTurn: compaction telemetry update failed: ${describeLogError(err)}`,
      );
    }

    try {
      const leafDecision = await this.evaluateIncrementalCompaction({
        conversationId: conversation.conversationId,
        tokenBudget,
        currentTokenCount: liveContextTokens,
      });
      if (leafDecision.shouldCompact) {
        this.compactLeafAsync({
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          sessionFile: params.sessionFile,
          tokenBudget,
          currentTokenCount: liveContextTokens,
          legacyParams,
          maxPasses: leafDecision.maxPasses,
          leafChunkTokens: leafDecision.leafChunkTokens,
          fallbackLeafChunkTokens: leafDecision.fallbackLeafChunkTokens,
          activityBand: leafDecision.activityBand,
          allowCondensedPasses: leafDecision.allowCondensedPasses,
        }).catch(() => {
          // Leaf compaction is best-effort and should not fail the caller.
        });
      }
    } catch {
      // Leaf trigger checks are best-effort.
    }

    try {
      await this.compact({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        sessionFile: params.sessionFile,
        tokenBudget,
        currentTokenCount: liveContextTokens,
        compactionTarget: "threshold",
        legacyParams,
      });
    } catch {
      // Proactive compaction is best-effort in the post-turn lifecycle.
    }

    this.deps.log.info(
      `[lcm] afterTurn: done conversation=${conversation.conversationId} ${sessionLabel} newMessages=${newMessages.length} dedupedMessages=${dedupedNewMessages.length} ingestedMessages=${ingestBatch.length} duration=${formatDurationMs(Date.now() - startedAt)}`,
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
    if (this.shouldIgnoreSession({ sessionId: params.sessionId, sessionKey: params.sessionKey })) {
      return {
        messages: params.messages,
        estimatedTokens: 0,
      };
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
        this.deps.log.info(
          `[lcm] assemble: conversation lookup missed ${sessionLabel} duration=${formatDurationMs(Date.now() - startedAt)}`,
        );
        return {
          messages: params.messages,
          estimatedTokens: 0,
        };
      }

      const contextItems = await this.summaryStore.getContextItems(conversation.conversationId);
      if (contextItems.length === 0) {
        this.deps.log.info(
          `[lcm] assemble: no context items conversation=${conversation.conversationId} ${sessionLabel} duration=${formatDurationMs(Date.now() - startedAt)}`,
        );
        return {
          messages: params.messages,
          estimatedTokens: 0,
        };
      }

      // Guard against incomplete bootstrap/coverage: if the DB only has
      // raw context items and clearly trails the current live history, keep
      // the live path to avoid dropping prompt context.
      const hasSummaryItems = contextItems.some((item) => item.itemType === "summary");
      if (!hasSummaryItems && contextItems.length < params.messages.length) {
        this.deps.log.info(
          `[lcm] assemble: falling back to live context conversation=${conversation.conversationId} ${sessionLabel} contextItems=${contextItems.length} liveMessages=${params.messages.length} duration=${formatDurationMs(Date.now() - startedAt)}`,
        );
        return {
          messages: params.messages,
          estimatedTokens: 0,
        };
      }

      const tokenBudget = this.applyAssemblyBudgetCap(
        typeof params.tokenBudget === "number" &&
        Number.isFinite(params.tokenBudget) &&
        params.tokenBudget > 0
          ? Math.floor(params.tokenBudget)
          : 128_000,
      );

      const assembled = await this.assembler.assemble({
        conversationId: conversation.conversationId,
        tokenBudget,
        freshTailCount: this.config.freshTailCount,
        freshTailMaxTokens: this.config.freshTailMaxTokens,
        prompt: params.prompt,
      });

      // If assembly produced no messages for a non-empty live session,
      // fail safe to the live context.
      if (assembled.messages.length === 0 && params.messages.length > 0) {
        this.deps.log.info(
          `[lcm] assemble: empty assembled output, using live context conversation=${conversation.conversationId} ${sessionLabel} contextItems=${contextItems.length} tokenBudget=${tokenBudget} duration=${formatDurationMs(Date.now() - startedAt)}`,
        );
        return {
          messages: params.messages,
          estimatedTokens: 0,
        };
      }

      this.deps.log.info(
        `[lcm] assemble: done conversation=${conversation.conversationId} ${sessionLabel} contextItems=${contextItems.length} hasSummaryItems=${hasSummaryItems} inputMessages=${params.messages.length} outputMessages=${assembled.messages.length} tokenBudget=${tokenBudget} estimatedTokens=${assembled.estimatedTokens} duration=${formatDurationMs(Date.now() - startedAt)}`,
      );

      const result: AssembleResultWithSystemPrompt = {
        messages: assembled.messages,
        estimatedTokens: assembled.estimatedTokens,
        ...(assembled.systemPromptAddition
          ? { systemPromptAddition: assembled.systemPromptAddition }
          : {}),
      };
      return result;
    } catch (err) {
      this.deps.log.info(
        `[lcm] assemble: failed for session=${params.sessionId}${params.sessionKey?.trim() ? ` sessionKey=${params.sessionKey.trim()}` : ""} error=${describeLogError(err)}`,
      );
      return {
        messages: params.messages,
        estimatedTokens: 0,
      };
    }
  }

  /** Evaluate whether incremental leaf compaction should run for a session. */
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
          : 20_000;
      return {
        shouldCompact: false,
        rawTokensOutsideTail: 0,
        threshold: fallbackThreshold,
      };
    }
    return this.compaction.evaluateLeafTrigger(conversation.conversationId);
  }

  /** Run one or more incremental leaf compaction passes in the per-session queue. */
  async compactLeafAsync(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    tokenBudget?: number;
    currentTokenCount?: number;
    customInstructions?: string;
    /** OpenClaw runtime param name (preferred). */
    runtimeContext?: Record<string, unknown>;
    /** Back-compat param name. */
    legacyParams?: Record<string, unknown>;
    force?: boolean;
    previousSummaryContent?: string;
    maxPasses?: number;
    leafChunkTokens?: number;
    fallbackLeafChunkTokens?: number[];
    activityBand?: ActivityBand;
    allowCondensedPasses?: boolean;
  }): Promise<CompactResult> {
    if (this.isStatelessSession(params.sessionKey)) {
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
          return {
            ok: true,
            compacted: false,
            reason: "no conversation found for session",
          };
        }

        const legacyParams = asRecord(params.runtimeContext) ?? params.legacyParams;
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

        const lp = legacyParams ?? {};
        const observedTokens = this.normalizeObservedTokenCount(
          params.currentTokenCount ??
            (
              lp as {
                currentTokenCount?: unknown;
              }
            ).currentTokenCount,
        );
        const { summarize, summaryModel, breakerKey } = await this.resolveSummarize({
          legacyParams,
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

        const storedTokensBefore = await this.summaryStore.getContextTokenCount(
          conversation.conversationId,
        );
        const maxPasses =
          typeof params.maxPasses === "number" &&
          Number.isFinite(params.maxPasses) &&
          params.maxPasses > 0
            ? Math.floor(params.maxPasses)
            : 1;
        const fallbackLeafChunkTokens = Array.isArray(params.fallbackLeafChunkTokens)
          ? [...new Set(params.fallbackLeafChunkTokens
            .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0)
            .map((value) => Math.floor(value)))]
              .sort((a, b) => b - a)
          : [];
        let activeLeafChunkTokens =
          typeof params.leafChunkTokens === "number" &&
          Number.isFinite(params.leafChunkTokens) &&
          params.leafChunkTokens > 0
            ? Math.floor(params.leafChunkTokens)
            : fallbackLeafChunkTokens[0];
        this.deps.log.info(
          `[lcm] compactLeafAsync start: conversation=${conversation.conversationId} session=${params.sessionId} leafChunkTokens=${activeLeafChunkTokens ?? "null"} fallbackLeafChunkTokens=${fallbackLeafChunkTokens.join(",")} maxPasses=${maxPasses} activityBand=${params.activityBand ?? "unknown"} allowCondensedPasses=${params.allowCondensedPasses !== false}`,
        );

        let rounds = 0;
        let finalTokens = observedTokens ?? storedTokensBefore;
        let authFailure = false;

        for (let pass = 0; pass < maxPasses; pass += 1) {
          let leafResult: Awaited<ReturnType<typeof this.compaction.compactLeaf>> | undefined;
          while (true) {
            try {
              leafResult = await this.compaction.compactLeaf({
                conversationId: conversation.conversationId,
                tokenBudget,
                summarize,
                ...(activeLeafChunkTokens !== undefined ? { leafChunkTokens: activeLeafChunkTokens } : {}),
                force: params.force,
                previousSummaryContent: pass === 0 ? params.previousSummaryContent : undefined,
                summaryModel,
                allowCondensedPasses: params.allowCondensedPasses,
              });
              break;
            } catch (err) {
              const nextLeafChunkTokens = fallbackLeafChunkTokens.find(
                (value) => activeLeafChunkTokens !== undefined && value < activeLeafChunkTokens,
              );
              if (!this.isRecoverableLeafChunkOverflowError(err) || nextLeafChunkTokens === undefined) {
                throw err;
              }
              this.deps.log.warn(
                `[lcm] compactLeafAsync: retrying with smaller leafChunkTokens=${nextLeafChunkTokens} after provider token-limit error: ${err instanceof Error ? err.message : String(err)}`,
              );
              activeLeafChunkTokens = nextLeafChunkTokens;
            }
          }
          if (!leafResult) {
            break;
          }
          finalTokens = leafResult.tokensAfter;

          if (leafResult.authFailure) {
            authFailure = true;
            break;
          }
          if (!leafResult.actionTaken) {
            break;
          }
          rounds += 1;
          if (leafResult.tokensAfter >= leafResult.tokensBefore) {
            break;
          }
        }

        if (authFailure && breakerKey) {
          this.recordCompactionAuthFailure(breakerKey);
        } else if (rounds > 0 && breakerKey) {
          this.recordCompactionSuccess(breakerKey);
        }
        if (rounds > 0) {
          await this.markLeafCompactionTelemetrySuccess({
            conversationId: conversation.conversationId,
            activityBand: params.activityBand,
          });
        }

        const tokensBefore = observedTokens ?? storedTokensBefore;
        this.deps.log.debug(
          `[lcm] compactLeafAsync result: conversation=${conversation.conversationId} session=${params.sessionId} rounds=${rounds} compacted=${rounds > 0} authFailure=${authFailure} finalLeafChunkTokens=${activeLeafChunkTokens ?? "null"} finalTokens=${finalTokens}`,
        );

        return {
          ok: true,
          compacted: rounds > 0,
          reason: authFailure
            ? "provider auth failure"
            : rounds > 0
              ? "compacted"
              : "below threshold",
          result: {
            tokensBefore,
            tokensAfter: finalTokens,
            details: {
              rounds,
              targetTokens: tokenBudget,
              mode: "leaf",
              maxPasses,
            },
          },
        };
      },
    );
  }

  async compact(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
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
  }): Promise<CompactResult> {
    if (this.shouldIgnoreSession({ sessionId: params.sessionId, sessionKey: params.sessionKey })) {
      return {
        ok: true,
        compacted: false,
        reason: "session excluded",
      };
    }
    if (this.isStatelessSession(params.sessionKey)) {
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
        const { sessionId, force = false } = params;

        // Look up conversation
        const conversation = await this.conversationStore.getConversationForSession({
          sessionId,
          sessionKey: params.sessionKey,
        });
        if (!conversation) {
          return {
            ok: true,
            compacted: false,
            reason: "no conversation found for session",
          };
        }

        const conversationId = conversation.conversationId;

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
          legacyParams,
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

        // Evaluate whether compaction is needed (unless forced)
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

        if (!forceCompaction && !decision.shouldCompact) {
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
            force: forceCompaction,
            hardTrigger: false,
            summaryModel,
          });

          if (sweepResult.authFailure && breakerKey) {
            this.recordCompactionAuthFailure(breakerKey);
          } else if (sweepResult.actionTaken && breakerKey) {
            this.recordCompactionSuccess(breakerKey);
          }
          if (sweepResult.actionTaken) {
            await this.markLeafCompactionTelemetrySuccess({ conversationId });
          }

          return {
            ok: !sweepResult.authFailure && (sweepResult.actionTaken || !liveContextStillExceedsTarget),
            compacted: sweepResult.actionTaken,
            reason: sweepResult.authFailure
              ? (sweepResult.actionTaken
                  ? "provider auth failure after partial compaction"
                  : "provider auth failure")
              : sweepResult.actionTaken
                ? "compacted"
                : manualCompactionRequested
                  ? "nothing to compact"
                  : liveContextStillExceedsTarget
                    ? "live context still exceeds target"
                    : "already under target",
            result: {
              tokensBefore: decision.currentTokens,
              tokensAfter: sweepResult.tokensAfter,
              details: {
                rounds: sweepResult.actionTaken ? 1 : 0,
                targetTokens,
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

        return {
          ok: compactResult.success,
          compacted: didCompact,
          reason: compactResult.authFailure
            ? (didCompact
                ? "provider auth failure after partial compaction"
                : "provider auth failure")
            : compactResult.success
              ? didCompact
                ? "compacted"
                : "already under target"
              : "could not reach target",
          result: {
            tokensBefore: decision.currentTokens,
            tokensAfter: compactResult.finalTokens,
            details: {
              rounds: compactResult.rounds,
              targetTokens: convergenceTargetTokens,
            },
          },
        };
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
    if (!reason || reason === "new" || reason === "unknown") {
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

  getCompactionTelemetryStore(): CompactionTelemetryStore {
    return this.compactionTelemetryStore;
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

/** @internal Exposed for unit tests only. */
export const __testing = { readLastJsonlEntryBeforeOffset };
