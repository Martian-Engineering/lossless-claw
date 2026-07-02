/**
 * Tool call/result pairing across assembled and live message indexes.
 *
 * Extracted from engine.ts (Phase 1 of the engine decomposition).
 */
import { TOOL_CALL_RAW_TYPES, TOOL_RESULT_RAW_TYPES } from "./message-content.js";
import type { AgentMessage } from "./openclaw-bridge.js";
import { asRecord, safeString } from "./value-utils.js";

export function extractToolPairingIdFromRecord(record: Record<string, unknown>): string | undefined {
  return (
    safeString(record.toolCallId) ??
    safeString(record.tool_call_id) ??
    safeString(record.toolUseId) ??
    safeString(record.tool_use_id) ??
    safeString(record.call_id) ??
    safeString(record.id)
  );
}

export function extractAssistantToolCallIdsForPairing(message: AgentMessage): string[] {
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

export function extractToolResultIdForPairing(message: AgentMessage): string | undefined {
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

export type ToolCallInputMap = ReadonlyMap<
  string,
  { name?: string; input?: Record<string, unknown> }
>;

function parseToolCallInput(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const directInput = asRecord(record.input);
  if (directInput) {
    return directInput;
  }
  const directArguments = asRecord(record.arguments);
  if (directArguments) {
    return directArguments;
  }
  if (typeof record.arguments !== "string") {
    return undefined;
  }
  try {
    return asRecord(JSON.parse(record.arguments));
  } catch {
    return undefined;
  }
}

export function buildToolCallInputMap(
  messages: AgentMessage[],
): ToolCallInputMap {
  const map = new Map<string, { name?: string; input?: Record<string, unknown> }>();
  const seenIds = new Set<string>();
  const ambiguousIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      const record = asRecord(block);
      if (!record || typeof record.type !== "string" || !TOOL_CALL_RAW_TYPES.has(record.type)) {
        continue;
      }
      const id = extractToolPairingIdFromRecord(record);
      const name = safeString(record.name);
      const input = parseToolCallInput(record);
      if (!id) {
        continue;
      }
      if (seenIds.has(id)) {
        map.delete(id);
        ambiguousIds.add(id);
        continue;
      }
      seenIds.add(id);
      if (input && !ambiguousIds.has(id)) {
        map.set(id, { name, input });
      }
    }
  }
  return map;
}

export function expandProtectedToolPairIndexes(params: {
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

export function expandToolPairLiveSortIndexes(params: {
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

export function buildToolPairIndexesByAssembledIndex(
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
