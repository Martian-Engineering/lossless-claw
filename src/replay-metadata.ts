/**
 * Extraction and canonicalization of raw replay metadata (tool call/result ids, raw block ids and signatures) carried on stored message parts.
 *
 * Extracted from engine.ts (Phase 1 of the engine decomposition).
 */
import { extractStructuredText } from "./message-content.js";
import type { AgentMessage } from "./openclaw-bridge.js";
import { getTranscriptEntryId, readLeafPathMessages } from "./transcript.js";
import { asRecord, safeString, toJson } from "./value-utils.js";

export function extractRawIdsFromPartMetadata(metadata: string | null | undefined): string[] {
  if (!metadata) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return [];
  }

  const record = asRecord(parsed);
  const raw = asRecord(record?.raw);

  // Replay IDs can be preserved either inside the raw transcript block or
  // as top-level metadata for string-content tool messages.
  return [
    safeString(raw?.id),
    safeString(raw?.call_id),
    safeString(raw?.toolCallId),
    safeString(raw?.tool_call_id),
    safeString(raw?.toolUseId),
    safeString(raw?.tool_use_id),
    safeString(record?.id),
    safeString(record?.call_id),
    safeString(record?.toolCallId),
    safeString(record?.tool_call_id),
    safeString(record?.toolUseId),
    safeString(record?.tool_use_id),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

export function extractRawBlockIdsFromPartMetadata(metadata: string | null | undefined): string[] {
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
  return [
    safeString(raw?.id),
    safeString(raw?.call_id),
    safeString(raw?.toolCallId),
    safeString(raw?.tool_call_id),
    safeString(raw?.toolUseId),
    safeString(raw?.tool_use_id),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}

export function extractRawBlockSignatureFromPartMetadata(metadata: string | null | undefined): string | null {
  if (!metadata) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return null;
  }

  const raw = asRecord(asRecord(parsed)?.raw);
  return raw ? toJson(raw) : null;
}

export function extractPlainToolReplayTextsById(message: AgentMessage): Map<string, string> {
  const textsById = new Map<string, string>();
  const duplicateIds = new Set<string>();
  const addText = (replayId: string, text: string): void => {
    if (duplicateIds.has(replayId)) {
      return;
    }
    if (textsById.has(replayId)) {
      textsById.delete(replayId);
      duplicateIds.add(replayId);
      return;
    }
    textsById.set(replayId, text);
  };
  if (
    (message.role !== "toolResult" && message.role !== "tool") ||
    !("content" in message)
  ) {
    return textsById;
  }
  const topLevel = message as unknown as Record<string, unknown>;
  const topLevelToolCallId =
    safeString(topLevel.toolCallId) ??
    safeString(topLevel.tool_call_id) ??
    safeString(topLevel.toolUseId) ??
    safeString(topLevel.tool_use_id) ??
    safeString(topLevel.call_id) ??
    safeString(topLevel.id);
  if (typeof message.content === "string") {
    if (topLevelToolCallId) {
      addText(topLevelToolCallId, message.content);
    }
    return textsById;
  }
  if (!Array.isArray(message.content)) {
    return textsById;
  }

  for (const item of message.content) {
    const record = asRecord(item);
    if (!record) {
      continue;
    }
    const rawType = safeString(record.type);
    const replayId =
      safeString(record.tool_use_id) ??
      safeString(record.toolUseId) ??
      safeString(record.tool_call_id) ??
      safeString(record.toolCallId) ??
      safeString(record.call_id) ??
      safeString(record.id) ??
      (message.content.length === 1 ? topLevelToolCallId : undefined);
    if (!replayId) {
      continue;
    }

    if (record.type === "text") {
      const text = safeString(record.text);
      if (text !== undefined) {
        addText(replayId, text);
      }
      continue;
    }
    if (
      rawType !== "tool_result" &&
      rawType !== "toolResult" &&
      rawType !== "function_call_output"
    ) {
      continue;
    }
    const textSource =
      record.output !== undefined
        ? record.output
        : record.content !== undefined
          ? record.content
          : record;
    const text = extractStructuredText(textSource);
    if (text !== undefined) {
      addText(replayId, text);
    }
  }
  return textsById;
}

export function stripExternalizedReplayMetadata(record: Record<string, unknown>): Record<string, unknown> {
  const stripped = { ...record };
  delete stripped.raw;
  delete stripped.output;
  delete stripped.content;
  delete stripped.text;
  delete stripped.externalizedFileId;
  delete stripped.originalByteSize;
  delete stripped.toolOutputExternalized;
  delete stripped.externalizationReason;
  delete stripped.rawType;
  return stripped;
}

export function canonicalizeReplayRawMetadata(record: Record<string, unknown>): Record<string, unknown> {
  const canonical = stripExternalizedReplayMetadata(record);
  const rawType = safeString(canonical.type);
  if (rawType === "toolResult") {
    canonical.type = "tool_result";
  }

  const replayId =
    safeString(canonical.tool_use_id) ??
    safeString(canonical.toolUseId) ??
    safeString(canonical.tool_call_id) ??
    safeString(canonical.toolCallId) ??
    safeString(canonical.call_id) ??
    safeString(canonical.id);
  delete canonical.tool_use_id;
  delete canonical.toolUseId;
  delete canonical.tool_call_id;
  delete canonical.toolCallId;
  delete canonical.call_id;
  delete canonical.id;
  if (replayId) {
    canonical[canonical.type === "function_call_output" ? "call_id" : "tool_use_id"] = replayId;
  }

  const isError = canonical.isError ?? canonical.is_error;
  delete canonical.isError;
  delete canonical.is_error;
  if (typeof isError === "boolean") {
    canonical.isError = isError;
  }

  return canonical;
}

export function pickTopLevelReplayMetadata(record: Record<string, unknown>): Record<string, unknown> {
  return {
    originalRole: record.originalRole,
    toolCallId: record.toolCallId,
    toolName: record.toolName,
    isError: record.isError,
  };
}

export function externalizedReplayMetadataMatches(
  persistedMetadata: string | null,
  incomingMetadata: string | null | undefined,
): boolean {
  let persistedParsed: unknown;
  let incomingParsed: unknown;
  try {
    persistedParsed = persistedMetadata ? JSON.parse(persistedMetadata) : undefined;
    incomingParsed = incomingMetadata ? JSON.parse(incomingMetadata) : undefined;
  } catch {
    return false;
  }

  const persistedRecord = asRecord(persistedParsed);
  const incomingRecord = asRecord(incomingParsed);
  if (!persistedRecord || !incomingRecord) {
    return false;
  }
  const incomingRaw = asRecord(incomingRecord.raw);
  if (!incomingRaw) {
    return toJson(pickTopLevelReplayMetadata(persistedRecord)) ===
      toJson(pickTopLevelReplayMetadata(incomingRecord));
  }
  if (
    toJson(stripExternalizedReplayMetadata(persistedRecord)) !==
    toJson(stripExternalizedReplayMetadata(incomingRecord))
  ) {
    return false;
  }

  const persistedRaw = asRecord(persistedRecord.raw);
  return !!persistedRaw &&
    toJson(canonicalizeReplayRawMetadata(persistedRaw)) ===
      toJson(canonicalizeReplayRawMetadata(incomingRaw));
}

export function extractTranscriptToolCallId(message: AgentMessage): string | undefined {
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

export async function listTranscriptToolResultEntryIdsByCallId(
  sessionFile: string,
): Promise<Map<string, string>> {
  const leafPathMessages = await readLeafPathMessages(sessionFile);
  const entryIdsByCallId = new Map<string, string>();
  const duplicateCallIds = new Set<string>();

  for (const message of leafPathMessages) {
    if (message.role !== "toolResult") {
      continue;
    }
    const entryId = getTranscriptEntryId(message);
    if (!entryId) {
      continue;
    }
    const toolCallId = extractTranscriptToolCallId(message);
    if (!toolCallId) {
      continue;
    }
    if (entryIdsByCallId.has(toolCallId)) {
      duplicateCallIds.add(toolCallId);
      continue;
    }
    entryIdsByCallId.set(toolCallId, entryId);
  }

  for (const duplicateCallId of duplicateCallIds) {
    entryIdsByCallId.delete(duplicateCallId);
  }

  return entryIdsByCallId;
}
