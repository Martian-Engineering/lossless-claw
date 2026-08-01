/**
 * Message content extraction and normalization: structured-text extraction, raw block classification, message-part construction, and storage normalization.
 *
 * Extracted from engine.ts (Phase 1 of the engine decomposition).
 */
import { blockFromPart } from "./assembler.js";
import { estimateTokens } from "./estimate-tokens.js";
import type { AgentMessage } from "./openclaw-bridge.js";
import type { CreateMessagePartInput, MessagePartRecord, MessagePartType } from "./store/conversation-store.js";
import { estimateContentTokensForRole, toRuntimeRoleForTokenEstimate } from "./token-accounting.js";
import { safeBoolean, safeString, toJson } from "./value-utils.js";
import { join } from "node:path";

export function appendTextValue(value: unknown, out: string[]): void {
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

export const STRUCTURED_TEXT_FIELD_KEYS = ["text", "transcript", "transcription", "message", "summary"];

export const STRUCTURED_ARRAY_FIELD_KEYS = [
  "segments",
  "utterances",
  "paragraphs",
  "alternatives",
  "words",
  "items",
  "results",
];

export const STRUCTURED_NESTED_FIELD_KEYS = ["content", "output", "result", "payload", "data", "value"];

export const MAX_STRUCTURED_TEXT_DEPTH = 6;

export const TOOL_CALL_RAW_TYPES: ReadonlySet<string> = new Set([
  "tool_use",
  "toolUse",
  "tool-use",
  "toolCall",
  "tool_call",
  "functionCall",
  "function_call",
]);

export const TOOL_RESULT_RAW_TYPES: ReadonlySet<string> = new Set([
  "function_call_output",
  "tool_result",
  "toolResult",
  "tool_use_result",
]);

export const TOOL_RAW_TYPES: ReadonlySet<string> = new Set([
  ...TOOL_CALL_RAW_TYPES,
  ...TOOL_RESULT_RAW_TYPES,
]);

export const REASONING_RAW_TYPES: ReadonlySet<string> = new Set([
  "thinking",
  "redacted_thinking",
  "reasoning",
]);

export const REPLAY_CRITICAL_RAW_TYPES: ReadonlySet<string> = new Set([
  ...TOOL_RAW_TYPES,
  ...REASONING_RAW_TYPES,
]);

export const RAW_PAYLOAD_EXTERNALIZATION_REASON = "large_raw_message";

/**
 * Part-metadata keys that persist the assistant message's model identity
 * (written by buildMessageParts on ordinal-0 parts). Identity is replay-
 * affinity data, not message identity: any comparison path that treats
 * metadata as identity (replay detection, live-coverage signatures, dedup)
 * must strip these keys so rows persisted before identity stamping still
 * match the post-upgrade representation of the same logical message.
 */
export const MODEL_IDENTITY_METADATA_KEYS = [
  "modelProvider",
  "modelApi",
  "modelId",
  "responseModelId",
] as const;

/**
 * Remove model-identity keys from a serialized part-metadata JSON object.
 *
 * Returns the input byte-identical when no identity keys are present, so
 * pre-upgrade rows keep their exact stored serialization. When keys are
 * present, deleting them restores the pre-identity key order (buildMessageParts
 * splices identity keys immediately after `originalRole`), so the stripped
 * form of a post-upgrade serialization is byte-identical to the pre-upgrade
 * serialization of the same message.
 */
export function stripModelIdentityFromMetadataJson(
  metadata: string | null | undefined,
): string | null {
  if (typeof metadata !== "string" || metadata.length === 0) {
    return metadata == null ? null : metadata;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return metadata;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return metadata;
  }
  const record = parsed as Record<string, unknown>;
  if (!MODEL_IDENTITY_METADATA_KEYS.some((key) => key in record)) {
    return metadata;
  }
  for (const key of MODEL_IDENTITY_METADATA_KEYS) {
    delete record[key];
  }
  return JSON.stringify(record);
}

/**
 * Strip model-identity keys from every `"metadata":"..."` value embedded in an
 * already-serialized parts-signature payload, without re-serializing the
 * surrounding content. This preserves byte-exact metadata equality across the
 * pre/post-upgrade boundary inside comparison blobs like
 * createLosslessMessageSignature output.
 */
export function stripModelIdentityFromSerializedPartsSignature(serialized: string): string {
  const metadataPattern = /"metadata":"((?:[^"\\]|\\.)*)"/g;
  return serialized.replace(metadataPattern, (whole, escaped: string) => {
    let metadata: string;
    try {
      metadata = JSON.parse(`"${escaped}"`) as string;
    } catch {
      return whole;
    }
    const stripped = stripModelIdentityFromMetadataJson(metadata);
    if (stripped == null || stripped === metadata) {
      return whole;
    }
    return `"metadata":${JSON.stringify(stripped)}`;
  });
}

/**
 * Read the assistant model identity carried at message (top) level on an
 * incoming AgentMessage (`provider`/`api`/`model`/`responseModel`). Shared by
 * buildMessageParts (persistence) and normalizeMessageContentForStorage
 * (message-level signature-preservation gate).
 */
export function extractModelIdentityMetadata(
  message: AgentMessage,
):
  | {
      modelProvider?: string;
      modelApi?: string;
      modelId?: string;
      responseModelId?: string;
    }
  | undefined {
  const role = typeof message.role === "string" ? message.role : "unknown";
  if (role !== "assistant") {
    return undefined;
  }
  const topLevel = message as unknown as Record<string, unknown>;
  const identity = {
    modelProvider: safeString(topLevel.provider),
    modelApi: safeString(topLevel.api),
    modelId: safeString(topLevel.model),
    responseModelId: safeString(topLevel.responseModel),
  };
  // The host's same-model replay check (transformMessages) requires
  // `provider`, `api`, and `model` to ALL match; `responseModel` is
  // supplemental and never consulted by that predicate. Treat an identity as
  // stored only when the three host-required fields are present — a partial
  // identity (e.g. responseModel alone) would preserve a sentinel signature
  // that the host later classifies as cross-model and downgrades to response
  // text, reintroducing the contamination this gate exists to prevent.
  return identity.modelProvider !== undefined &&
    identity.modelApi !== undefined &&
    identity.modelId !== undefined
    ? identity
    : undefined;
}

export function looksLikeJsonPayload(value: string): boolean {
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

export function extractStructuredText(value: unknown, depth: number = 0): string | undefined {
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

  if (typeof record.type === "string" && REASONING_RAW_TYPES.has(record.type)) {
    return undefined;
  }

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

export function extractReasoningText(record: Record<string, unknown>): string | undefined {
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
export function hasReplayCriticalRawBlock(value: unknown): boolean {
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
export function serializeRawPayloadContent(message: AgentMessage, fallbackContent: string): {
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

export function normalizeUnknownBlock(value: unknown): {
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

export function extractTopLevelReasoningContent(
  role: string,
  topLevel: Record<string, unknown>,
): { field: "reasoning_content"; content: string } | null {
  if (role !== "assistant") {
    return null;
  }
  const content = safeString(topLevel.reasoning_content);
  return content && content.trim().length > 0
    ? { field: "reasoning_content", content }
    : null;
}

export function topLevelReasoningMetadata(
  reasoning: { field: "reasoning_content"; content: string } | null,
  only = false,
): Record<string, unknown> {
  if (!reasoning) {
    return {};
  }
  return {
    topLevelReasoningField: reasoning.field,
    topLevelReasoningContent: reasoning.content,
    topLevelReasoningOnly: only || undefined,
  };
}

export function toPartType(type: string): MessagePartType {
  switch (type) {
    case "text":
      return "text";
    case "thinking":
    case "redacted_thinking":
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
export function extractMessageContent(content: unknown): string {
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
  // If content is an array of only tool call/result/reasoning objects, store as empty
  // (structured data is preserved in the message parts table)
  if (Array.isArray(content) && content.length > 0 && content.every(
    (item) => typeof item === "object" && item !== null && !Array.isArray(item) &&
      typeof (item as Record<string, unknown>).type === "string" &&
      (
        TOOL_RAW_TYPES.has((item as Record<string, unknown>).type as string) ||
        REASONING_RAW_TYPES.has((item as Record<string, unknown>).type as string)
      )
  )) {
    return "";
  }

  const serialized = JSON.stringify(content);
  return typeof serialized === "string" ? serialized : "";
}

export function isTextBlock(value: unknown): value is { type: "text"; text: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.type === "text" && typeof record.text === "string";
}

export function toSyntheticMessagePartRecord(
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

export function normalizeMessageContentForStorage(params: {
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

  // Resolve the signature-preservation gate at message level: identity is
  // persisted on ordinal-0 metadata only, but a signature-bearing thinking
  // block may sit at any ordinal. Using the incoming message's top-level
  // identity mirrors contentFromParts' message-level decision so blocks at
  // any ordinal see the same verdict.
  const messageHasStoredModelIdentity = extractModelIdentityMetadata(message) !== undefined;
  const blocks = parts
    .map((part) => blockFromPart(part, messageHasStoredModelIdentity))
    .filter((block): block is NonNullable<typeof block> => block != null);
  if (blocks.length === 0) {
    if (role === "assistant") {
      return fallbackContent ? [{ type: "text", text: fallbackContent }] : [];
    }
    if (role === "toolResult") {
      return [{ type: "text", text: fallbackContent }];
    }
    return fallbackContent;
  }
  if (role === "user" && blocks.length === 1 && isTextBlock(blocks[0])) {
    return blocks[0].text;
  }
  return blocks;
}

export function buildMessageParts(params: {
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
  const topLevelReasoning = extractTopLevelReasoningContent(role, topLevel);
  const rawPayloadExternalized = safeBoolean(topLevel.rawPayloadExternalized);
  const externalizedFileId = safeString(topLevel.externalizedFileId);
  // Assistant model identity (provider/api/model/responseModel). Persisted in
  // part metadata so assembly can reconstruct messages that survive the host's
  // model-bound thinking-replay checks (OpenClaw transformMessages treats a
  // missing identity as a cross-model switch and downgrades thinking blocks to
  // plain text, which corrupts reasoning-native models like Kimi K3).
  const modelIdentityMetadata = extractModelIdentityMetadata(message);
  const externalizedFileIds = Array.isArray(topLevel.externalizedFileIds)
    ? topLevel.externalizedFileIds.filter((fileId): fileId is string => typeof fileId === "string")
    : undefined;
  const fileBlocksExternalized = safeBoolean(topLevel.fileBlocksExternalized);
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
          ...(modelIdentityMetadata ?? {}),
          toolCallId: topLevelToolCallId,
          toolName: topLevelToolName,
          isError: topLevelIsError,
          ...topLevelReasoningMetadata(topLevelReasoning),
          rawPayloadExternalized: rawPayloadExternalized || undefined,
          externalizedFileId,
          externalizedFileIds,
          fileBlocksExternalized: fileBlocksExternalized || undefined,
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
          ...topLevelReasoningMetadata(topLevelReasoning),
        }),
      },
    ];
  }

  const parts: CreateMessagePartInput[] = [];
  if (message.content.length === 0 && topLevelReasoning) {
    parts.push({
      sessionId,
      partType: "reasoning",
      ordinal: 0,
      textContent: null,
      metadata: toJson({
        originalRole: role,
        ...(modelIdentityMetadata ?? {}),
        rawType: topLevelReasoning.field,
        ...topLevelReasoningMetadata(topLevelReasoning, true),
      }),
    });
  }
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
        ...(ordinal === 0 ? (modelIdentityMetadata ?? {}) : {}),
        toolCallId: topLevelToolCallId,
        toolName: topLevelToolName,
        isError: topLevelIsError,
        ...(ordinal === 0 ? topLevelReasoningMetadata(topLevelReasoning) : {}),
        externalizedFileId: safeString(metadataRecord?.externalizedFileId),
        originalByteSize:
          typeof metadataRecord?.originalByteSize === "number"
            ? metadataRecord.originalByteSize
            : undefined,
        imageExternalized: safeBoolean(metadataRecord?.imageExternalized),
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
export function toDbRole(role: string): "user" | "assistant" | "system" | "tool" {
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

export function hasPersistableMessageRole(message: AgentMessage): boolean {
  const role = (message as { role?: unknown }).role;
  return (
    role === "user" ||
    role === "assistant" ||
    role === "system" ||
    role === "tool" ||
    role === "toolResult"
  );
}

export function filterPersistableMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter(hasPersistableMessageRole);
}

export type StoredMessage = {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tokenCount: number;
};

export const DELIVERY_ONLY_TRANSCRIPT_MAX_MESSAGES = 4;

export const INJECTED_DELIVERY_TRANSCRIPT_PATTERN = /\b(?:delivery[-_\s]?mirror|config[-_\s]?audit)\b/i;

export const INJECTED_METADATA_PREAMBLE_PREFIX = "Conversation info (untrusted metadata)";

export const OPENCLAW_RUNTIME_CONTEXT_SENTINEL =
  "OpenClaw runtime context for the immediately preceding user message. This context is runtime-generated, not user-author.";

/**
 * Normalize AgentMessage variants into the storage shape used by LCM.
 */
export function toStoredMessage(message: AgentMessage): StoredMessage {
  const content =
    "content" in message
      ? extractMessageContent(message.content)
      : "output" in message
        ? `$ ${String(message.command ?? "")}\n${String(message.output)}`
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
  const topLevelReasoning = extractTopLevelReasoningContent(
    typeof message.role === "string" ? message.role : "",
    message as unknown as Record<string, unknown>,
  );

  return {
    role: toDbRole(message.role),
    content,
    tokenCount: tokenCount + (topLevelReasoning ? estimateTokens(topLevelReasoning.content) : 0),
  };
}

export function isLikelyInjectedDeliveryMessage(message: AgentMessage): boolean {
  const stored = toStoredMessage(message);
  return stored.role === "system" && INJECTED_DELIVERY_TRANSCRIPT_PATTERN.test(stored.content);
}

export function isOpenClawRuntimeContextLeak(stored: StoredMessage): boolean {
  return (
    stored.role === "assistant" &&
    stored.content.trimStart().startsWith(OPENCLAW_RUNTIME_CONTEXT_SENTINEL)
  );
}

export function isLikelyInjectedDeliveryOnlyTranscript(messages: AgentMessage[]): boolean {
  return (
    messages.length > 0 &&
    messages.length <= DELIVERY_ONLY_TRANSCRIPT_MAX_MESSAGES &&
    messages.every(isLikelyInjectedDeliveryMessage)
  );
}

export function isLikelyInjectedMetadataPreambleRecord(message: {
  role: string;
  content: string;
}): boolean {
  return (
    message.role === "user" &&
    message.content.trimStart().startsWith(INJECTED_METADATA_PREAMBLE_PREFIX)
  );
}
