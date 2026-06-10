/**
 * Detection and filtering of synthetic heartbeat turns in transcripts.
 *
 * Extracted from engine.ts (Phase 1 of the engine decomposition).
 */
import { toStoredMessage } from "./message-content.js";
import type { AgentMessage } from "./openclaw-bridge.js";

export const HEARTBEAT_OK_TOKEN = "heartbeat_ok";

export const HEARTBEAT_TURN_MARKER = "heartbeat.md";

export const OPENCLAW_HEARTBEAT_POLL = "[openclaw heartbeat poll]";

/**
 * Detect whether an assistant message is a heartbeat ack.
 *
 * Only exact (case-insensitive) "HEARTBEAT_OK" acknowledgements are pruned.
 * Any additional text indicates the heartbeat carried real content and should remain.
 */
export function isHeartbeatOkContent(content: string): boolean {
  return content.trim().toLowerCase() === HEARTBEAT_OK_TOKEN;
}

/**
 * Synthetic heartbeat traffic (poll prompts and HEARTBEAT_OK acks) recurs
 * identically in every session, so it can never discriminate lineage in
 * the ambiguous-rollover freshness check.
 */
export function isHeartbeatNoiseContent(role: string, content: string): boolean {
  const normalized = content.trim().toLowerCase();
  if (role === "user" && normalized === OPENCLAW_HEARTBEAT_POLL) {
    return true;
  }
  return role === "assistant" && normalized === HEARTBEAT_OK_TOKEN;
}

export function batchLooksLikeHeartbeatAckTurn(messages: AgentMessage[]): boolean {
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

export function filterSyntheticHeartbeatMessages(
  messages: AgentMessage[],
): { messages: AgentMessage[]; skipped: number } {
  if (messages.length === 0) {
    return { messages, skipped: 0 };
  }

  const skipIndexes = new Set<number>();
  for (let index = 0; index < messages.length; index += 1) {
    const stored = toStoredMessage(messages[index]!);
    if (
      stored.role === "user" &&
      stored.content.trim().toLowerCase() === OPENCLAW_HEARTBEAT_POLL
    ) {
      skipIndexes.add(index);
    }
  }

  for (let index = 0; index < messages.length; index += 1) {
    const stored = toStoredMessage(messages[index]!);
    if (stored.role !== "assistant" || !isHeartbeatOkContent(stored.content)) {
      continue;
    }

    let turnStart = -1;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const previous = toStoredMessage(messages[cursor]!);
      if (previous.role === "user") {
        turnStart = cursor;
        break;
      }
    }
    if (turnStart < 0) {
      continue;
    }

    const turnMessages = messages
      .slice(turnStart, index + 1)
      .map((message) => toStoredMessage(message));
    if (!turnLooksLikeHeartbeatTurn(turnMessages)) {
      continue;
    }

    for (let cursor = turnStart; cursor <= index; cursor += 1) {
      skipIndexes.add(cursor);
    }
  }

  if (skipIndexes.size === 0) {
    return { messages, skipped: 0 };
  }

  return {
    messages: messages.filter((_, index) => !skipIndexes.has(index)),
    skipped: skipIndexes.size,
  };
}

export function turnLooksLikeHeartbeatTurn(turnMessages: Array<{ content: string }>): boolean {
  return turnMessages.some((message) =>
    message.content.toLowerCase().includes(HEARTBEAT_TURN_MARKER),
  );
}
