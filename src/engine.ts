import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  AgentMessage,
  ContextEngine,
  ContextEngineInfo,
  AssembleResult,
  BootstrapResult,
  CompactResult,
  IngestBatchResult,
  IngestResult,
  SubagentEndReason,
  SubagentSpawnPreparation,
} from "./openclaw-bridge.js";
import { ContextAssembler } from "./assembler.js";
import { CompactionEngine, type CompactionConfig } from "./compaction.js";
import type { LcmConfig } from "./db/config.js";
import { getLcmConnection, closeLcmConnection } from "./db/connection.js";
import { getLcmDbFeatures } from "./db/features.js";
import { runLcmMigrations } from "./db/migration.js";
import {
  createDelegatedExpansionGrant,
  removeDelegatedExpansionGrantForSession,
  revokeDelegatedExpansionGrantForSession,
} from "./expansion-auth.js";
import {
  extractFileIdsFromContent,
  extensionFromNameOrMime,
  formatFileReference,
  generateExplorationSummary,
  parseFileBlocks,
} from "./large-files.js";
import { RetrievalEngine } from "./retrieval.js";
import {
  extractActiveBranchMessages,
  readSessionEntries,
  selectActiveBranchEntries,
} from "./session-transcript.js";
import {
  ConversationStore,
  type CreateMessagePartInput,
  type MessagePartType,
} from "./store/conversation-store.js";
import { SummaryStore, type LargeFileRecord } from "./store/summary-store.js";
import { createLcmSummarizeFromLegacyParams } from "./summarize.js";
import {
  buildToolResultPreviewText,
  sanitizeToolResultDetails,
} from "./tool-result-offload.js";
import { matchPendingToolResultRewrites } from "./tool-result-rewrite.js";
import type { LcmDependencies } from "./types.js";

type AssembleResultWithSystemPrompt = AssembleResult & { systemPromptAddition?: string };

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Rough token estimate: ~4 chars per token. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function toJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  return typeof encoded === "string" ? encoded : "";
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function safeBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
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
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type?: unknown; text?: unknown } => {
        return !!block && typeof block === "object";
      })
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("\n");
  }

  const serialized = JSON.stringify(content);
  return typeof serialized === "string" ? serialized : "";
}

function extractToolResultOffloadText(message: AgentMessage): string {
  if (!("content" in message)) {
    return "";
  }

  if (typeof message.content === "string") {
    return message.content;
  }

  if (Array.isArray(message.content)) {
    const textOnly = extractMessageContent(message.content);
    if (textOnly.length > 0) {
      return textOnly;
    }
    const serialized = JSON.stringify(message.content);
    return typeof serialized === "string" ? serialized : "";
  }

  const serialized = JSON.stringify(message.content);
  return typeof serialized === "string" ? serialized : "";
}

function emptyMaintenanceResult(reason: string): {
  changed: false;
  bytesFreed: 0;
  rewrittenEntries: 0;
  reason: string;
} {
  return {
    changed: false,
    bytesFreed: 0,
    rewrittenEntries: 0,
    reason,
  };
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
    const partType = toPartType(block.type);
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
        rawType: block.type,
        raw: metadataRecord ?? message.content[ordinal],
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

type CanonicalizedMessage = {
  storedMessage: StoredMessage;
  messageForParts: AgentMessage;
  offloadId?: number;
  cleanupFilePaths: string[];
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
  const tokenCount =
    "content" in message
      ? estimateContentTokensForRole({
          role: runtimeRole,
          content: message.content,
          fallbackContent: content,
        })
      : estimateTokens(content);

  return {
    role: toDbRole(message.role),
    content,
    tokenCount,
  };
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

/** Load recoverable messages from a JSON/JSONL session file. */
function readLeafPathMessages(sessionFile: string): AgentMessage[] {
  return extractActiveBranchMessages(
    selectActiveBranchEntries(readSessionEntries(sessionFile)),
  ).filter(isBootstrapMessage);
}

function messageIdentity(role: string, content: string): string {
  return `${role}\u0000${content}`;
}

function toolResultOffloadIdentity(toolCallId: string, messageTimestamp: number): string {
  return `toolResultOffload\u0000${toolCallId}\u0000${messageTimestamp}`;
}

function interceptedUserFileToken(params: {
  fileName?: string | null;
  mimeType?: string | null;
  text: string;
}): string {
  const fileName = params.fileName?.trim() || "unknown";
  const mimeType = params.mimeType?.trim() || "unknown";
  const byteSize = Buffer.byteLength(params.text, "utf8");
  const contentHash = createHash("sha256").update(params.text).digest("hex");
  return `lcmfile:${fileName}:${mimeType}:${byteSize}:${contentHash}`;
}

function interceptedUserMessageIdentityFromRawContent(params: {
  content: string;
  threshold: number;
}): string | null {
  const blocks = parseFileBlocks(params.content);
  if (blocks.length === 0) {
    return null;
  }

  const rewrittenSegments: string[] = [];
  let cursor = 0;
  let interceptedAny = false;
  for (const block of blocks) {
    rewrittenSegments.push(params.content.slice(cursor, block.start));
    const blockTokens = estimateTokens(block.text);
    if (blockTokens >= params.threshold) {
      interceptedAny = true;
      rewrittenSegments.push(
        `[[LCM_INTERCEPTED_FILE:${interceptedUserFileToken({
          fileName: block.fileName,
          mimeType: block.mimeType,
          text: block.text,
        })}]]`,
      );
    } else {
      rewrittenSegments.push(block.fullMatch);
    }
    cursor = block.end;
  }

  if (!interceptedAny) {
    return null;
  }

  rewrittenSegments.push(params.content.slice(cursor));
  return `interceptedUser\u0000${rewrittenSegments.join("")}`;
}

function extractToolResultOffloadIdentity(
  message: AgentMessage,
): { toolCallId: string; messageTimestamp: number } | null {
  const topLevel = message as unknown as Record<string, unknown>;
  const topLevelRole = typeof topLevel.role === "string" ? topLevel.role : "";
  if (topLevelRole !== "toolResult") {
    return null;
  }

  const toolCallId =
    safeString(topLevel.toolCallId) ??
    safeString(topLevel.tool_call_id);
  const messageTimestamp =
    typeof topLevel.timestamp === "number" && Number.isFinite(topLevel.timestamp)
      ? Math.floor(topLevel.timestamp)
      : undefined;

  if (!toolCallId || messageTimestamp === undefined) {
    return null;
  }

  return {
    toolCallId,
    messageTimestamp,
  };
}

function isTranscriptMessageAlreadyRewritten(params: {
  activeBranchEntry: unknown;
  replacementMessage: AgentMessage;
}): boolean {
  const entry = params.activeBranchEntry as { type?: unknown; message?: unknown } | null;
  if (!entry || entry.type !== "message") {
    return false;
  }

  const normalize = (message: unknown):
    | {
        toolCallId: string;
        toolName: string;
        isError: boolean;
        messageTimestamp?: number;
        contentText: string;
        offloadFileId?: string;
      }
    | null => {
      if (!message || typeof message !== "object") {
        return null;
      }
      const record = message as Record<string, unknown>;
      if (record.role !== "toolResult") {
        return null;
      }
      const toolCallId =
        safeString(record.toolCallId) ??
        safeString(record.tool_call_id);
      if (!toolCallId) {
        return null;
      }
      const contentText = extractToolResultOffloadText(message as AgentMessage);
      const details = record.details as { lcmOffload?: { fileId?: unknown } } | undefined;
      const contentFileId = contentText.match(/\bfile_[a-f0-9]{16}\b/i)?.[0]?.toLowerCase();
      const detailsFileId =
        typeof details?.lcmOffload?.fileId === "string"
          ? details.lcmOffload.fileId.match(/\bfile_[a-f0-9]{16}\b/i)?.[0]?.toLowerCase()
          : undefined;
      return {
        toolCallId,
        toolName:
          safeString(record.toolName) ??
          safeString(record.tool_name) ??
          "",
        isError:
          safeBoolean(record.isError) ??
          safeBoolean(record.is_error) ??
          false,
        messageTimestamp:
          typeof record.timestamp === "number" && Number.isFinite(record.timestamp)
            ? Math.floor(record.timestamp)
            : undefined,
        contentText,
        offloadFileId: detailsFileId ?? contentFileId,
      };
    };

  const activeMessage = normalize(entry.message);
  const replacementMessage = normalize(params.replacementMessage);
  if (activeMessage && replacementMessage) {
    return activeMessage.toolCallId === replacementMessage.toolCallId
      && activeMessage.toolName === replacementMessage.toolName
      && activeMessage.isError === replacementMessage.isError
      && activeMessage.messageTimestamp === replacementMessage.messageTimestamp
      && activeMessage.contentText === replacementMessage.contentText
      && activeMessage.offloadFileId === replacementMessage.offloadFileId;
  }

  return JSON.stringify(entry.message) === JSON.stringify(params.replacementMessage);
}

type ReconcileMessageDescriptor = {
  message: AgentMessage;
  stored: StoredMessage;
  identity: string;
  dbCount: number;
};

type InterceptedUserIdentityCaches = {
  largeFiles: Map<string, LargeFileRecord | null>;
  largeFileContents: Map<string, string | null>;
};

// ── LcmContextEngine ────────────────────────────────────────────────────────

export class LcmContextEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "lossless-claw",
    name: "Lossless Context Management Engine",
    version: "0.1.0",
    ownsCompaction: true,
  };

  private config: LcmConfig;

  /** Get the configured timezone, falling back to system timezone. */
  get timezone(): string {
    return this.config.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  private conversationStore: ConversationStore;
  private summaryStore: SummaryStore;
  private assembler: ContextAssembler;
  private compaction: CompactionEngine;
  private retrieval: RetrievalEngine;
  private migrated = false;
  private readonly fts5Available: boolean;
  private sessionOperationQueues = new Map<string, Promise<void>>();
  private largeFileTextSummarizerResolved = false;
  private largeFileTextSummarizer?: (prompt: string) => Promise<string | null>;
  private deps: LcmDependencies;

  constructor(deps: LcmDependencies) {
    this.deps = deps;
    this.config = deps.config;

    const db = getLcmConnection(this.config.databasePath);
    this.fts5Available = getLcmDbFeatures(db).fts5Available;

    this.conversationStore = new ConversationStore(db, { fts5Available: this.fts5Available });
    this.summaryStore = new SummaryStore(db, { fts5Available: this.fts5Available });

    if (!this.fts5Available) {
      this.deps.log.warn(
        "[lcm] FTS5 unavailable in the current Node runtime; full_text search will fall back to LIKE and indexing is disabled",
      );
    }

    this.assembler = new ContextAssembler(
      this.conversationStore,
      this.summaryStore,
      this.config.timezone,
    );

    const compactionConfig: CompactionConfig = {
      contextThreshold: this.config.contextThreshold,
      freshTailCount: this.config.freshTailCount,
      leafMinFanout: this.config.leafMinFanout,
      condensedMinFanout: this.config.condensedMinFanout,
      condensedMinFanoutHard: this.config.condensedMinFanoutHard,
      incrementalMaxDepth: this.config.incrementalMaxDepth,
      leafChunkTokens: this.config.leafChunkTokens,
      leafTargetTokens: this.config.leafTargetTokens,
      condensedTargetTokens: this.config.condensedTargetTokens,
      maxRounds: 10,
      timezone: this.config.timezone,
    };
    this.compaction = new CompactionEngine(
      this.conversationStore,
      this.summaryStore,
      compactionConfig,
    );

    this.retrieval = new RetrievalEngine(this.conversationStore, this.summaryStore);
  }

  /** Ensure DB schema is up-to-date. Called lazily on first bootstrap/ingest/assemble/compact. */
  private ensureMigrated(): void {
    if (this.migrated) {
      return;
    }
    const db = getLcmConnection(this.config.databasePath);
    runLcmMigrations(db, { fts5Available: this.fts5Available });
    this.migrated = true;
  }

  /**
   * Serialize mutating operations per session to prevent ingest/compaction races.
   */
  private async withSessionQueue<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionOperationQueues.get(sessionId) ?? Promise.resolve();
    let releaseQueue: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    const next = previous.catch(() => {}).then(() => current);
    this.sessionOperationQueues.set(sessionId, next);

    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      releaseQueue();
      void next.finally(() => {
        if (this.sessionOperationQueues.get(sessionId) === next) {
          this.sessionOperationQueues.delete(sessionId);
        }
      });
    }
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
    legacyParams?: Record<string, unknown>;
  }): number | undefined {
    const lp = params.legacyParams ?? {};
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

  /** Resolve an LCM conversation id from a session key via the session store. */
  private async resolveConversationIdForSessionKey(
    sessionKey: string,
  ): Promise<number | undefined> {
    const trimmedKey = sessionKey.trim();
    if (!trimmedKey) {
      return undefined;
    }
    try {
      const runtimeSessionId = await this.deps.resolveSessionIdFromSessionKey(trimmedKey);
      if (!runtimeSessionId) {
        return undefined;
      }
      const conversation =
        await this.conversationStore.getConversationBySessionId(runtimeSessionId);
      return conversation?.conversationId;
    } catch {
      return undefined;
    }
  }

  /** Build a summarize callback with runtime provider fallback handling. */
  private async resolveSummarize(params: {
    legacyParams?: Record<string, unknown>;
    customInstructions?: string;
  }): Promise<(text: string, aggressive?: boolean) => Promise<string>> {
    const lp = params.legacyParams ?? {};
    if (typeof lp.summarize === "function") {
      return lp.summarize as (text: string, aggressive?: boolean) => Promise<string>;
    }
    try {
      const runtimeSummarizer = await createLcmSummarizeFromLegacyParams({
        deps: this.deps,
        legacyParams: lp,
        customInstructions: params.customInstructions,
      });
      if (runtimeSummarizer) {
        return runtimeSummarizer;
      }
      console.error(`[lcm] resolveSummarize: createLcmSummarizeFromLegacyParams returned undefined`);
    } catch (err) {
      console.error(`[lcm] resolveSummarize failed, using emergency fallback:`, err instanceof Error ? err.message : err);
    }
    console.error(`[lcm] resolveSummarize: FALLING BACK TO EMERGENCY TRUNCATION`);
    return createEmergencyFallbackSummarize();
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
      const summarize = await createLcmSummarizeFromLegacyParams({
        deps: this.deps,
        legacyParams: { provider, model },
      });
      if (!summarize) {
        return undefined;
      }

      this.largeFileTextSummarizer = async (prompt: string): Promise<string | null> => {
        const summary = await summarize(prompt, false);
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

  /** Persist intercepted large-file text payloads to ~/.openclaw/lcm-files. */
  private async storeLargeFileContent(params: {
    conversationId: number;
    fileId: string;
    extension: string;
    content: string;
  }): Promise<string> {
    const dir = join(homedir(), ".openclaw", "lcm-files", String(params.conversationId));
    await mkdir(dir, { recursive: true });

    const normalizedExtension = params.extension.replace(/[^a-z0-9]/gi, "").toLowerCase() || "txt";
    const filePath = join(dir, `${params.fileId}.${normalizedExtension}`);
    await writeFile(filePath, params.content, "utf8");
    return filePath;
  }

  /**
   * Intercept oversized <file> blocks before persistence and replace them with
   * compact file references backed by large_files records.
   */
  private async interceptLargeFiles(params: {
    conversationId: number;
    content: string;
  }): Promise<{ rewrittenContent: string; fileIds: string[]; storageUris: string[] } | null> {
    const blocks = parseFileBlocks(params.content);
    if (blocks.length === 0) {
      return null;
    }

    const threshold = Math.max(1, this.config.largeFileTokenThreshold);
    const summarizeText = await this.resolveLargeFileTextSummarizer();
    const fileIds: string[] = [];
    const storageUris: string[] = [];
    const rewrittenSegments: string[] = [];
    let cursor = 0;
    let interceptedAny = false;

    for (const block of blocks) {
      const blockTokens = estimateTokens(block.text);
      if (blockTokens < threshold) {
        continue;
      }

      interceptedAny = true;
      const fileId = `file_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const extension = extensionFromNameOrMime(block.fileName, block.mimeType);
      const storageUri = await this.storeLargeFileContent({
        conversationId: params.conversationId,
        fileId,
        extension,
        content: block.text,
      });
      const byteSize = Buffer.byteLength(block.text, "utf8");
      const explorationSummary = await generateExplorationSummary({
        content: block.text,
        fileName: block.fileName,
        mimeType: block.mimeType,
        summarizeText,
      });

      await this.summaryStore.insertLargeFile({
        fileId,
        conversationId: params.conversationId,
        fileName: block.fileName,
        mimeType: block.mimeType,
        byteSize,
        storageUri,
        explorationSummary,
      });

      rewrittenSegments.push(params.content.slice(cursor, block.start));
      rewrittenSegments.push(
        formatFileReference({
          fileId,
          fileName: block.fileName,
          mimeType: block.mimeType,
          byteSize,
          summary: explorationSummary,
        }),
      );
      cursor = block.end;
      fileIds.push(fileId);
      storageUris.push(storageUri);
    }

    if (!interceptedAny) {
      return null;
    }

    rewrittenSegments.push(params.content.slice(cursor));
    return {
      rewrittenContent: rewrittenSegments.join(""),
      fileIds,
      storageUris,
    };
  }

  /**
   * Persist one canonicalized message and attach the corresponding message_parts/context item rows.
   */
  private async persistCanonicalMessage(params: {
    conversationId: number;
    sessionId: string;
    storedMessage: StoredMessage;
    messageForParts: AgentMessage;
  }): Promise<number> {
    const maxSeq = await this.conversationStore.getMaxSeq(params.conversationId);
    const seq = maxSeq + 1;

    const msgRecord = await this.conversationStore.createMessage({
      conversationId: params.conversationId,
      seq,
      role: params.storedMessage.role,
      content: params.storedMessage.content,
      tokenCount: params.storedMessage.tokenCount,
    });
    await this.conversationStore.createMessageParts(
      msgRecord.messageId,
      buildMessageParts({
        sessionId: params.sessionId,
        message: params.messageForParts,
        fallbackContent: params.storedMessage.content,
      }),
    );
    await this.summaryStore.appendContextMessage(params.conversationId, msgRecord.messageId);
    return msgRecord.messageId;
  }

  private async cleanupStoredFiles(filePaths: string[]): Promise<void> {
    const uniquePaths = [...new Set(filePaths.filter((filePath) => filePath.length > 0))];
    await Promise.all(
      uniquePaths.map(async (filePath) => {
        try {
          await rm(filePath, { force: true });
        } catch {
          // Best-effort cleanup only.
        }
      }),
    );
  }

  private async getLargeFileCached(
    fileId: string,
    cache: Map<string, LargeFileRecord | null>,
  ): Promise<LargeFileRecord | null> {
    let record = cache.get(fileId);
    if (record === undefined) {
      record = await this.summaryStore.getLargeFile(fileId);
      cache.set(fileId, record);
    }
    return record;
  }

  private async getLargeFileContentCached(
    record: LargeFileRecord,
    cache: Map<string, string | null>,
  ): Promise<string | null> {
    let content = cache.get(record.fileId);
    if (content === undefined) {
      try {
        content = await readFile(record.storageUri, "utf8");
      } catch {
        content = null;
      }
      cache.set(record.fileId, content);
    }
    return content;
  }

  private async buildStoredInterceptedUserMessageIdentity(params: {
    content: string;
    caches: InterceptedUserIdentityCaches;
  }): Promise<string | null> {
    const fileIds = extractFileIdsFromContent(params.content);
    if (fileIds.length === 0) {
      return null;
    }

    let rewritten = params.content;
    let replacedAny = false;
    for (const fileId of fileIds) {
      const record = await this.getLargeFileCached(fileId, params.caches.largeFiles);
      if (!record) {
        continue;
      }
      const fileText = await this.getLargeFileContentCached(record, params.caches.largeFileContents);
      if (fileText === null) {
        continue;
      }
      const referenceText = formatFileReference({
        fileId: record.fileId,
        fileName: record.fileName ?? undefined,
        mimeType: record.mimeType ?? undefined,
        byteSize: record.byteSize ?? Buffer.byteLength(fileText, "utf8"),
        summary: record.explorationSummary ?? "",
      });
      if (!rewritten.includes(referenceText)) {
        continue;
      }
      rewritten = rewritten.split(referenceText).join(
        `[[LCM_INTERCEPTED_FILE:${interceptedUserFileToken({
          fileName: record.fileName,
          mimeType: record.mimeType,
          text: fileText,
        })}]]`,
      );
      replacedAny = true;
    }

    if (!replacedAny) {
      return null;
    }
    return `interceptedUser\u0000${rewritten}`;
  }

  private async buildStoredInterceptedUserIdentityCounts(params: {
    conversationId: number;
    messages: Array<{ role: string; content: string }>;
    caches: InterceptedUserIdentityCaches;
  }): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const message of params.messages) {
      if (message.role !== "user") {
        continue;
      }
      const identity = await this.buildStoredInterceptedUserMessageIdentity({
        content: message.content,
        caches: params.caches,
      });
      if (!identity) {
        continue;
      }
      counts.set(identity, (counts.get(identity) ?? 0) + 1);
    }
    return counts;
  }

  private async persistCanonicalizedMessage(params: {
    conversationId: number;
    sessionId: string;
    canonicalized: CanonicalizedMessage;
  }): Promise<number> {
    try {
      const messageId = await this.persistCanonicalMessage({
        conversationId: params.conversationId,
        sessionId: params.sessionId,
        storedMessage: params.canonicalized.storedMessage,
        messageForParts: params.canonicalized.messageForParts,
      });
      if (typeof params.canonicalized.offloadId === "number") {
        await this.summaryStore.attachToolResultOffloadMessageId(
          params.canonicalized.offloadId,
          messageId,
        );
      }
      return messageId;
    } catch (error) {
      await this.cleanupStoredFiles(params.canonicalized.cleanupFilePaths);
      throw error;
    }
  }

  /**
   * Import a historical message batch through the same canonical path used by
   * live ingest so bootstrap rows also receive message_parts/context items.
   */
  private async importCanonicalMessages(params: {
    conversationId: number;
    sessionId: string;
    messages: AgentMessage[];
  }): Promise<number> {
    const cleanupFilePaths: string[] = [];
    let importedMessages = 0;
    try {
      for (const message of params.messages) {
        const canonicalized = await this.canonicalizeMessageForStorage({
          conversationId: params.conversationId,
          sessionId: params.sessionId,
          message,
        });
        await this.persistCanonicalizedMessage({
          conversationId: params.conversationId,
          sessionId: params.sessionId,
          canonicalized,
        });
        cleanupFilePaths.push(...canonicalized.cleanupFilePaths);
        importedMessages += 1;
      }
    } catch (error) {
      await this.cleanupStoredFiles(cleanupFilePaths);
      throw error;
    }
    return importedMessages;
  }

  /**
   * Normalize one message into the canonical storage form used by LCM.
   */
  private async canonicalizeMessageForStorage(params: {
    conversationId: number;
    sessionId: string;
    message: AgentMessage;
  }): Promise<CanonicalizedMessage> {
    const stored = toStoredMessage(params.message);
    let messageForParts = params.message;
    const cleanupFilePaths: string[] = [];

    try {
      if (stored.role === "user") {
        const intercepted = await this.interceptLargeFiles({
          conversationId: params.conversationId,
          content: stored.content,
        });
        if (intercepted && "content" in params.message) {
          cleanupFilePaths.push(...intercepted.storageUris);
          stored.content = intercepted.rewrittenContent;
          stored.tokenCount = estimateTokens(stored.content);
          messageForParts = {
            ...params.message,
            content: stored.content,
          } as AgentMessage;
        }
      }

      const topLevel = params.message as unknown as Record<string, unknown>;
      const topLevelRole = typeof topLevel.role === "string" ? topLevel.role : "";
      if (topLevelRole === "toolResult" && this.config.toolResultPersistEnabled) {
        const originalText = extractToolResultOffloadText(params.message);
        const threshold = Math.max(1, this.config.toolResultPersistThresholdChars);
        const toolCallId =
          safeString(topLevel.toolCallId) ??
          safeString(topLevel.tool_call_id);
        const toolName =
          safeString(topLevel.toolName) ??
          safeString(topLevel.tool_name) ??
          "unknown";
        const isError =
          safeBoolean(topLevel.isError) ??
          safeBoolean(topLevel.is_error) ??
          false;
        const messageTimestamp =
          typeof topLevel.timestamp === "number" && Number.isFinite(topLevel.timestamp)
            ? Math.floor(topLevel.timestamp)
            : Date.now();

        if (toolCallId && originalText.length >= threshold) {
          const fileId = `file_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
          const originalByteSize = Buffer.byteLength(originalText, "utf8");
          const previewText = buildToolResultPreviewText({
            fileId,
            toolName,
            originalByteSize,
            isError,
            originalText,
            previewChars: this.config.toolResultPreviewChars,
          });
          const storageUri = await this.storeLargeFileContent({
            conversationId: params.conversationId,
            fileId,
            extension: "txt",
            content: originalText,
          });
          cleanupFilePaths.push(storageUri);

          await this.summaryStore.insertLargeFile({
            fileId,
            conversationId: params.conversationId,
            fileName: `tool-result-${toolName}.txt`,
            mimeType: "text/plain",
            byteSize: originalByteSize,
            storageUri,
            explorationSummary: `Offloaded ${toolName} tool result.`,
          });

          const sanitizedDetails = sanitizeToolResultDetails({
            toolName,
            details: topLevel.details,
            meta: {
              fileId,
              originalChars: originalText.length,
              originalBytes: originalByteSize,
              previewChars: this.config.toolResultPreviewChars,
              strategy: "deterministic_head_tail",
            },
          });

          const replacementMessage = {
            ...params.message,
            role: "toolResult",
            toolCallId,
            toolName,
            isError,
            timestamp: messageTimestamp,
            content: previewText,
            details: sanitizedDetails,
          } as AgentMessage;

          stored.content = previewText;
          stored.tokenCount = estimateTokens(stored.content);
          messageForParts = replacementMessage;

          const offload = await this.summaryStore.insertToolResultOffload({
            conversationId: params.conversationId,
            sessionId: params.sessionId,
            fileId,
            toolCallId,
            toolName,
            messageTimestamp,
            originalCharCount: originalText.length,
            originalByteSize,
            previewText,
            replacementMessageJson: JSON.stringify(replacementMessage),
          });

          return {
            storedMessage: stored,
            messageForParts,
            offloadId: offload.offloadId,
            cleanupFilePaths,
          };
        }
      }

      return {
        storedMessage: stored,
        messageForParts,
        cleanupFilePaths,
      };
    } catch (error) {
      await this.cleanupStoredFiles(cleanupFilePaths);
      throw error;
    }
  }

  // ── ContextEngine interface ─────────────────────────────────────────────

  /**
   * Reconcile session-file history with persisted messages and append only the
   * tail that is present in JSONL but missing from LCM.
   */
  private async reconcileSessionTail(params: {
    sessionId: string;
    conversationId: number;
    historicalMessages: AgentMessage[];
  }): Promise<{
    importedMessages: number;
    hasOverlap: boolean;
  }> {
    const { sessionId, conversationId, historicalMessages } = params;
    if (historicalMessages.length === 0) {
      return { importedMessages: 0, hasOverlap: false };
    }

    const dbMessages = await this.conversationStore.getMessages(conversationId);
    const latestDbMessage = dbMessages.at(-1) ?? null;
    if (!latestDbMessage) {
      return { importedMessages: 0, hasOverlap: false };
    }

    const dbIdentityCounts = new Map<string, number>();
    const offloadIdentityCache = new Map<string, boolean>();
    const interceptedUserCaches: InterceptedUserIdentityCaches = {
      largeFiles: new Map<string, LargeFileRecord | null>(),
      largeFileContents: new Map<string, string | null>(),
    };
    const interceptedUserIdentityCounts = await this.buildStoredInterceptedUserIdentityCounts({
      conversationId,
      messages: dbMessages,
      caches: interceptedUserCaches,
    });
    const historicalDescriptors: ReconcileMessageDescriptor[] = [];

    for (const message of historicalMessages) {
      const stored = toStoredMessage(message);
      const offloadIdentity = extractToolResultOffloadIdentity(message);
      if (offloadIdentity) {
        const identity = toolResultOffloadIdentity(
          offloadIdentity.toolCallId,
          offloadIdentity.messageTimestamp,
        );
        let exists = offloadIdentityCache.get(identity);
        if (exists === undefined) {
          const offload = await this.summaryStore.getToolResultOffloadByIdentity({
            conversationId,
            toolCallId: offloadIdentity.toolCallId,
            messageTimestamp: offloadIdentity.messageTimestamp,
          });
          exists = !!offload;
          offloadIdentityCache.set(identity, exists);
        }
        if (exists) {
          historicalDescriptors.push({
            message,
            stored,
            identity,
            dbCount: 1,
          });
          continue;
        }
      }

      const historicalInterceptedUserIdentity =
        stored.role === "user"
          ? interceptedUserMessageIdentityFromRawContent({
              content: stored.content,
              threshold: Math.max(1, this.config.largeFileTokenThreshold),
            })
          : null;
      if (historicalInterceptedUserIdentity) {
        historicalDescriptors.push({
          message,
          stored,
          identity: historicalInterceptedUserIdentity,
          dbCount: interceptedUserIdentityCounts.get(historicalInterceptedUserIdentity) ?? 0,
        });
        continue;
      }

      const identity = messageIdentity(stored.role, stored.content);
      let dbCount = dbIdentityCounts.get(identity);
      if (dbCount === undefined) {
        dbCount = await this.conversationStore.countMessagesByIdentity(
          conversationId,
          stored.role,
          stored.content,
        );
        dbIdentityCounts.set(identity, dbCount);
      }
      historicalDescriptors.push({
        message,
        stored,
        identity,
        dbCount,
      });
    }

    const latestDbOffload = await this.summaryStore.getToolResultOffloadByMessageId(
      latestDbMessage.messageId,
    );
    const latestDbInterceptedUserIdentity =
      latestDbMessage.role === "user"
        ? await this.buildStoredInterceptedUserMessageIdentity({
            content: latestDbMessage.content,
            caches: interceptedUserCaches,
          })
        : null;
    const latestDbIdentity = latestDbOffload
      ? toolResultOffloadIdentity(latestDbOffload.toolCallId, latestDbOffload.messageTimestamp)
      : latestDbInterceptedUserIdentity
        ? latestDbInterceptedUserIdentity
      : messageIdentity(latestDbMessage.role, latestDbMessage.content);

    // Fast path: one tail comparison for the common in-sync case.
    const latestHistorical = historicalDescriptors[historicalDescriptors.length - 1];
    if (latestHistorical && latestDbIdentity === latestHistorical.identity) {
      let historicalOccurrences = 0;
      for (const descriptor of historicalDescriptors) {
        if (descriptor.identity === latestDbIdentity) {
          historicalOccurrences += 1;
        }
      }
      if (latestHistorical.dbCount === historicalOccurrences) {
        return { importedMessages: 0, hasOverlap: true };
      }
    }

    // Slow path: walk backward through JSONL to find the most recent anchor
    // message that already exists in LCM, then append everything after it.
    let anchorIndex = -1;
    const historicalIdentityTotals = new Map<string, number>();
    for (const descriptor of historicalDescriptors) {
      historicalIdentityTotals.set(
        descriptor.identity,
        (historicalIdentityTotals.get(descriptor.identity) ?? 0) + 1,
      );
    }

    const historicalIdentityCountsAfterIndex = new Map<string, number>();
    for (let index = historicalDescriptors.length - 1; index >= 0; index--) {
      const descriptor = historicalDescriptors[index];
      const identity = descriptor.identity;
      const seenAfter = historicalIdentityCountsAfterIndex.get(identity) ?? 0;
      const total = historicalIdentityTotals.get(identity) ?? 0;
      const occurrencesThroughIndex = total - seenAfter;
      historicalIdentityCountsAfterIndex.set(identity, seenAfter + 1);
      if (descriptor.dbCount === 0) {
        continue;
      }

      // Match the same occurrence index as the DB tail so repeated empty
      // tool messages do not anchor against a later, still-missing entry.
      if (descriptor.dbCount !== occurrencesThroughIndex) {
        continue;
      }

      anchorIndex = index;
      break;
    }

    if (anchorIndex < 0) {
      return { importedMessages: 0, hasOverlap: false };
    }
    if (anchorIndex >= historicalMessages.length - 1) {
      return { importedMessages: 0, hasOverlap: true };
    }

    const missingTail = historicalDescriptors.slice(anchorIndex + 1).map((descriptor) => descriptor.message);
    const cleanupFilePaths: string[] = [];
    let importedMessages = 0;
    try {
      for (const message of missingTail) {
        const result = await this.ingestSingle({ sessionId, message });
        if (result.ingested) {
          cleanupFilePaths.push(...result.cleanupFilePaths);
          importedMessages += 1;
        }
      }
    } catch (error) {
      await this.cleanupStoredFiles(cleanupFilePaths);
      throw error;
    }

    return { importedMessages, hasOverlap: true };
  }

  async bootstrap(params: { sessionId: string; sessionFile: string }): Promise<BootstrapResult> {
    this.ensureMigrated();

    const result = await this.withSessionQueue(params.sessionId, async () =>
      this.conversationStore.withTransaction(async () => {
        const conversation = await this.conversationStore.getOrCreateConversation(params.sessionId);
        const conversationId = conversation.conversationId;
        const historicalMessages = readLeafPathMessages(params.sessionFile);

        // First-time import path: no LCM rows yet, so seed directly from the
        // active leaf context snapshot.
        const existingCount = await this.conversationStore.getMessageCount(conversationId);
        if (existingCount === 0) {
          if (historicalMessages.length === 0) {
            await this.conversationStore.markConversationBootstrapped(conversationId);
            return {
              bootstrapped: false,
              importedMessages: 0,
              reason: "no leaf-path messages in session",
            };
          }

          const importedMessages = await this.importCanonicalMessages({
            conversationId,
            sessionId: params.sessionId,
            messages: historicalMessages,
          });
          await this.conversationStore.markConversationBootstrapped(conversationId);

          // Prune HEARTBEAT_OK turns from the freshly imported data
          if (this.config.pruneHeartbeatOk) {
            const pruned = await this.pruneHeartbeatOkTurns(conversationId);
            if (pruned > 0) {
              console.error(
                `[lcm] bootstrap: pruned ${pruned} HEARTBEAT_OK messages from conversation ${conversationId}`,
              );
            }
          }

          return {
            bootstrapped: true,
            importedMessages,
          };
        }

        // Existing conversation path: reconcile crash gaps by appending JSONL
        // messages that were never persisted to LCM.
        const reconcile = await this.reconcileSessionTail({
          sessionId: params.sessionId,
          conversationId,
          historicalMessages,
        });

        if (!conversation.bootstrappedAt) {
          await this.conversationStore.markConversationBootstrapped(conversationId);
        }

        if (reconcile.importedMessages > 0) {
          return {
            bootstrapped: true,
            importedMessages: reconcile.importedMessages,
            reason: "reconciled missing session messages",
          };
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
    );

    // Post-bootstrap pruning: clean HEARTBEAT_OK turns that were already
    // in the DB from prior bootstrap cycles (before pruning was enabled).
    if (this.config.pruneHeartbeatOk && result.bootstrapped === false) {
      try {
        const conversation = await this.conversationStore.getConversationBySessionId(
          params.sessionId,
        );
        if (conversation) {
          const pruned = await this.pruneHeartbeatOkTurns(conversation.conversationId);
          if (pruned > 0) {
            console.error(
              `[lcm] bootstrap: retroactively pruned ${pruned} HEARTBEAT_OK messages from conversation ${conversation.conversationId}`,
            );
          }
        }
      } catch (err) {
        console.error(
          `[lcm] bootstrap: heartbeat pruning failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    return result;
  }

  private async ingestSingle(params: {
    sessionId: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult & { cleanupFilePaths: string[] }> {
    const { sessionId, message, isHeartbeat } = params;
    if (isHeartbeat) {
      return { ingested: false, cleanupFilePaths: [] };
    }

    // Get or create conversation for this session
    const conversation = await this.conversationStore.getOrCreateConversation(sessionId);
    const conversationId = conversation.conversationId;

    const canonicalized = await this.canonicalizeMessageForStorage({
      conversationId,
      sessionId,
      message,
    });

    await this.persistCanonicalizedMessage({
      conversationId,
      sessionId,
      canonicalized,
    });

    return { ingested: true, cleanupFilePaths: canonicalized.cleanupFilePaths };
  }

  async ingest(params: {
    sessionId: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    this.ensureMigrated();
    return this.withSessionQueue(params.sessionId, () =>
      this.conversationStore.withTransaction(async () => {
        const result = await this.ingestSingle(params);
        return { ingested: result.ingested };
      }),
    );
  }

  async ingestBatch(params: {
    sessionId: string;
    messages: AgentMessage[];
    isHeartbeat?: boolean;
  }): Promise<IngestBatchResult> {
    this.ensureMigrated();
    if (params.messages.length === 0) {
      return { ingestedCount: 0 };
    }
    return this.withSessionQueue(params.sessionId, async () => {
      let ingestedCount = 0;
      for (const message of params.messages) {
        const result = await this.conversationStore.withTransaction(async () =>
          this.ingestSingle({
            sessionId: params.sessionId,
            message,
            isHeartbeat: params.isHeartbeat,
          }),
        );
        if (result.ingested) {
          ingestedCount += 1;
        }
      }
      return { ingestedCount };
    });
  }

  async maintain(params: {
    sessionId: string;
    sessionFile: string;
    runtimeContext?: { rewriteTranscriptEntries?: (request: {
      replacements: Array<{ entryId: string; message: AgentMessage }>;
    }) => Promise<{ changed: boolean; bytesFreed: number; rewrittenEntries: number; reason?: string }> };
  }): Promise<{ changed: boolean; bytesFreed: number; rewrittenEntries: number; reason?: string }> {
    this.ensureMigrated();

    return this.withSessionQueue(params.sessionId, async () => {
      const rewriteTranscriptEntries = params.runtimeContext?.rewriteTranscriptEntries;
      if (typeof rewriteTranscriptEntries !== "function") {
        return emptyMaintenanceResult("rewrite helper unavailable");
      }

      const pending = await this.summaryStore.getPendingToolResultOffloads(params.sessionId);
      if (pending.length === 0) {
        return emptyMaintenanceResult("no pending tool-result offloads");
      }

      const activeBranchEntries = selectActiveBranchEntries(readSessionEntries(params.sessionFile));
      if (activeBranchEntries.length === 0) {
        return emptyMaintenanceResult("no active branch entries in session");
      }

      const matches = matchPendingToolResultRewrites({
        activeBranchEntries,
        pending: pending.map((record) => ({
          offloadId: record.offloadId,
          toolCallId: record.toolCallId,
          toolName: record.toolName,
          messageTimestamp: record.messageTimestamp,
        })),
      });
      if (matches.length === 0) {
        return emptyMaintenanceResult("no matching active-branch tool results");
      }

      const pendingByOffloadId = new Map(pending.map((record) => [record.offloadId, record]));
      const activeBranchEntriesById = new Map(activeBranchEntries.map((entry) => [entry.id, entry]));
      const replacements: Array<{ offloadId: number; entryId: string; message: AgentMessage }> = [];

      for (const match of matches) {
        const record = pendingByOffloadId.get(match.offloadId);
        if (!record) {
          continue;
        }

        try {
          replacements.push({
            offloadId: record.offloadId,
            entryId: match.entryId,
            message: JSON.parse(record.replacementMessageJson) as AgentMessage,
          });
        } catch {
          await this.summaryStore.markToolResultOffloadFailed(
            record.offloadId,
            "invalid replacement_message_json",
          );
        }
      }

      if (replacements.length === 0) {
        return emptyMaintenanceResult("no valid replacement payloads");
      }

      const replacementsNeedingRewrite: Array<{ offloadId: number; entryId: string; message: AgentMessage }> = [];
      let healedRewrites = 0;
      for (const replacement of replacements) {
        const activeBranchEntry = activeBranchEntriesById.get(replacement.entryId);
        if (isTranscriptMessageAlreadyRewritten({
          activeBranchEntry,
          replacementMessage: replacement.message,
        })) {
          await this.summaryStore.markToolResultOffloadRewritten(
            replacement.offloadId,
            replacement.entryId,
          );
          healedRewrites += 1;
          continue;
        }
        replacementsNeedingRewrite.push(replacement);
      }

      if (replacementsNeedingRewrite.length === 0) {
        return {
          changed: healedRewrites > 0,
          bytesFreed: 0,
          rewrittenEntries: healedRewrites,
          reason: "pending offloads already reflected in transcript",
        };
      }

      const result = await rewriteTranscriptEntries({
        replacements: replacementsNeedingRewrite.map((replacement) => ({
          entryId: replacement.entryId,
          message: replacement.message,
        })),
      });

      if (result.changed && result.rewrittenEntries === replacementsNeedingRewrite.length) {
        for (const replacement of replacementsNeedingRewrite) {
          await this.summaryStore.markToolResultOffloadRewritten(
            replacement.offloadId,
            replacement.entryId,
          );
        }
      }

      return {
        ...result,
        changed: result.changed || healedRewrites > 0,
        rewrittenEntries: result.rewrittenEntries + healedRewrites,
      };
    });
  }

  async afterTurn(params: {
    sessionId: string;
    sessionFile: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    legacyCompactionParams?: Record<string, unknown>;
  }): Promise<void> {
    this.ensureMigrated();

    const ingestBatch: AgentMessage[] = [];
    if (params.autoCompactionSummary) {
      ingestBatch.push({
        role: "user",
        content: params.autoCompactionSummary,
      } as AgentMessage);
    }

    const newMessages = params.messages.slice(params.prePromptMessageCount);
    ingestBatch.push(...newMessages);
    if (ingestBatch.length === 0) {
      return;
    }

    try {
      await this.ingestBatch({
        sessionId: params.sessionId,
        messages: ingestBatch,
        isHeartbeat: params.isHeartbeat === true,
      });
    } catch (error) {
      // Surface ingest failures so the caller can mark post-turn finalization
      // as incomplete; compaction must not continue against partial state.
      throw error;
    }

    const tokenBudget =
      typeof params.tokenBudget === "number" &&
      Number.isFinite(params.tokenBudget) &&
      params.tokenBudget > 0
        ? Math.floor(params.tokenBudget)
        : undefined;
    if (!tokenBudget) {
      return;
    }

    const liveContextTokens = estimateSessionTokenCountForAfterTurn(params.messages);

    try {
      const leafTrigger = await this.evaluateLeafTrigger(params.sessionId);
      if (leafTrigger.shouldCompact) {
        this.compactLeafAsync({
          sessionId: params.sessionId,
          sessionFile: params.sessionFile,
          tokenBudget,
          currentTokenCount: liveContextTokens,
          legacyParams: params.legacyCompactionParams,
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
        sessionFile: params.sessionFile,
        tokenBudget,
        currentTokenCount: liveContextTokens,
        compactionTarget: "threshold",
        legacyParams: params.legacyCompactionParams,
      });
    } catch {
      // Proactive compaction is best-effort in the post-turn lifecycle.
    }
  }

  async assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult> {
    try {
      this.ensureMigrated();

      const conversation = await this.conversationStore.getConversationBySessionId(
        params.sessionId,
      );
      if (!conversation) {
        return {
          messages: params.messages,
          estimatedTokens: 0,
        };
      }

      const contextItems = await this.summaryStore.getContextItems(conversation.conversationId);
      if (contextItems.length === 0) {
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
        return {
          messages: params.messages,
          estimatedTokens: 0,
        };
      }

      const tokenBudget =
        typeof params.tokenBudget === "number" &&
        Number.isFinite(params.tokenBudget) &&
        params.tokenBudget > 0
          ? Math.floor(params.tokenBudget)
          : 128_000;

      const assembled = await this.assembler.assemble({
        conversationId: conversation.conversationId,
        tokenBudget,
        freshTailCount: this.config.freshTailCount,
      });

      // If assembly produced no messages for a non-empty live session,
      // fail safe to the live context.
      if (assembled.messages.length === 0 && params.messages.length > 0) {
        return {
          messages: params.messages,
          estimatedTokens: 0,
        };
      }

      const result: AssembleResultWithSystemPrompt = {
        messages: assembled.messages,
        estimatedTokens: assembled.estimatedTokens,
        ...(assembled.systemPromptAddition
          ? { systemPromptAddition: assembled.systemPromptAddition }
          : {}),
      };
      return result;
    } catch {
      return {
        messages: params.messages,
        estimatedTokens: 0,
      };
    }
  }

  /** Evaluate whether incremental leaf compaction should run for a session. */
  async evaluateLeafTrigger(sessionId: string): Promise<{
    shouldCompact: boolean;
    rawTokensOutsideTail: number;
    threshold: number;
  }> {
    this.ensureMigrated();
    const conversation = await this.conversationStore.getConversationBySessionId(sessionId);
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

  /** Run one incremental leaf compaction pass in the per-session queue. */
  async compactLeafAsync(params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    currentTokenCount?: number;
    customInstructions?: string;
    legacyParams?: Record<string, unknown>;
    force?: boolean;
    previousSummaryContent?: string;
  }): Promise<CompactResult> {
    this.ensureMigrated();
    return this.withSessionQueue(params.sessionId, async () => {
      const conversation = await this.conversationStore.getConversationBySessionId(
        params.sessionId,
      );
      if (!conversation) {
        return {
          ok: true,
          compacted: false,
          reason: "no conversation found for session",
        };
      }

      const tokenBudget = this.resolveTokenBudget(params);
      if (!tokenBudget) {
        return {
          ok: false,
          compacted: false,
          reason: "missing token budget in compact params",
        };
      }

      const lp = params.legacyParams ?? {};
      const observedTokens = this.normalizeObservedTokenCount(
        params.currentTokenCount ??
          (
            lp as {
              currentTokenCount?: unknown;
            }
          ).currentTokenCount,
      );
      const summarize = await this.resolveSummarize({
        legacyParams: params.legacyParams,
        customInstructions: params.customInstructions,
      });

      const leafResult = await this.compaction.compactLeaf({
        conversationId: conversation.conversationId,
        tokenBudget,
        summarize,
        force: params.force,
        previousSummaryContent: params.previousSummaryContent,
      });
      const tokensBefore = observedTokens ?? leafResult.tokensBefore;

      return {
        ok: true,
        compacted: leafResult.actionTaken,
        reason: leafResult.actionTaken ? "compacted" : "below threshold",
        result: {
          tokensBefore,
          tokensAfter: leafResult.tokensAfter,
          details: {
            rounds: leafResult.actionTaken ? 1 : 0,
            targetTokens: tokenBudget,
            mode: "leaf",
          },
        },
      };
    });
  }

  async compact(params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    legacyParams?: Record<string, unknown>;
    /** Force compaction even if below threshold */
    force?: boolean;
  }): Promise<CompactResult> {
    this.ensureMigrated();
    return this.withSessionQueue(params.sessionId, async () => {
      const { sessionId, force = false } = params;

      // Look up conversation
      const conversation = await this.conversationStore.getConversationBySessionId(sessionId);
      if (!conversation) {
        return {
          ok: true,
          compacted: false,
          reason: "no conversation found for session",
        };
      }

      const conversationId = conversation.conversationId;

      const lp = params.legacyParams ?? {};
      const manualCompactionRequested =
        (
          lp as {
            manualCompaction?: unknown;
          }
        ).manualCompaction === true;
      const forceCompaction = force || manualCompactionRequested;
      const tokenBudget = this.resolveTokenBudget(params);
      if (!tokenBudget) {
        return {
          ok: false,
          compacted: false,
          reason: "missing token budget in compact params",
        };
      }

      const summarize = await this.resolveSummarize({
        legacyParams: params.legacyParams,
        customInstructions: params.customInstructions,
      });

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

      const useSweep =
        manualCompactionRequested || forceCompaction || params.compactionTarget === "threshold";
      if (useSweep) {
        const sweepResult = await this.compaction.compactFullSweep({
          conversationId,
          tokenBudget,
          summarize,
          force: forceCompaction,
          hardTrigger: false,
        });

        return {
          ok: sweepResult.actionTaken || !liveContextStillExceedsTarget,
          compacted: sweepResult.actionTaken,
          reason: sweepResult.actionTaken
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

      const compactResult = await this.compaction.compactUntilUnder({
        conversationId,
        tokenBudget,
        targetTokens: convergenceTargetTokens,
        ...(observedTokens !== undefined ? { currentTokens: observedTokens } : {}),
        summarize,
      });
      const didCompact = compactResult.rounds > 0;

      return {
        ok: compactResult.success,
        compacted: didCompact,
        reason: compactResult.success
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
    });
  }

  async prepareSubagentSpawn(params: {
    parentSessionKey: string;
    childSessionKey: string;
    ttlMs?: number;
  }): Promise<SubagentSpawnPreparation | undefined> {
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

    createDelegatedExpansionGrant({
      delegatedSessionKey: childSessionKey,
      issuerSessionId: parentSessionKey,
      allowedConversationIds: [conversationId],
      tokenCap: this.config.maxExpandTokens,
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
    // The connection is cleaned up on process exit via closeLcmConnection().
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

      // Found a HEARTBEAT_OK reply. Walk backward to find the turn start
      // (the preceding user message).
      const turnMessageIds: number[] = [msg.messageId];
      for (let j = i - 1; j >= 0; j--) {
        const prev = allMessages[j];
        turnMessageIds.push(prev.messageId);
        if (prev.role === "user") {
          break; // Found turn start
        }
      }

      toDelete.push(...turnMessageIds);
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

/**
 * Detect whether an assistant message is a heartbeat ack.
 *
 * Matches the same pattern as OpenClaw core's heartbeat-events-filter:
 * content starts with "heartbeat_ok" (case-insensitive) and any character
 * immediately after is not alphanumeric or underscore.
 *
 * This catches:
 *   - "HEARTBEAT_OK"
 *   - "  HEARTBEAT_OK  "
 *   - "HEARTBEAT_OK — weekend, no market."
 *   - "Saturday 10:48 AM PT — weekend, no market. HEARTBEAT_OK"
 *
 * But not:
 *   - "HEARTBEAT_OK_EXTENDED" (alphanumeric continuation)
 */
function isHeartbeatOkContent(content: string): boolean {
  const trimmed = content.trim().toLowerCase();
  if (!trimmed) {
    return false;
  }

  // Check if it starts with the token
  if (trimmed.startsWith(HEARTBEAT_OK_TOKEN)) {
    const suffix = trimmed.slice(HEARTBEAT_OK_TOKEN.length);
    if (suffix.length === 0) {
      return true;
    }
    return !/[a-z0-9_]/.test(suffix[0]);
  }

  // Also check if it ends with the token (chatty prefix + HEARTBEAT_OK)
  if (trimmed.endsWith(HEARTBEAT_OK_TOKEN)) {
    return true;
  }

  return false;
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
