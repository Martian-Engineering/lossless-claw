/**
 * Detection and filtering of synthetic heartbeat turns in transcripts.
 *
 * Extracted from engine.ts (Phase 1 of the engine decomposition).
 */
import { toStoredMessage } from "./message-content.js";
import type { AgentMessage } from "./openclaw-bridge.js";
import type { ConversationStore } from "./store/conversation-store.js";

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
  let sawHeartbeatMdMarker = false;
  let sawExactHeartbeatPoll = false;
  let sawHeartbeatAck = false;
  let sawNonExactPollTurnContent = false;

  for (const message of messages) {
    const stored = toStoredMessage(message);
    const normalized = stored.content.trim().toLowerCase();
    if (!sawHeartbeatMdMarker && normalized.includes(HEARTBEAT_TURN_MARKER)) {
      sawHeartbeatMdMarker = true;
    }
    if (stored.role === "user" && normalized === OPENCLAW_HEARTBEAT_POLL) {
      sawExactHeartbeatPoll = true;
    }
    if (!sawHeartbeatAck && stored.role === "assistant" && isHeartbeatOkContent(stored.content)) {
      sawHeartbeatAck = true;
    }
    if (
      normalized !== OPENCLAW_HEARTBEAT_POLL &&
      !(stored.role === "assistant" && isHeartbeatOkContent(stored.content))
    ) {
      sawNonExactPollTurnContent = true;
    }
    if (sawHeartbeatMdMarker && sawHeartbeatAck) {
      return true;
    }
  }

  return sawExactHeartbeatPoll && sawHeartbeatAck && !sawNonExactPollTurnContent;
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
  return turnMessages.some((message) => {
    const normalized = message.content.trim().toLowerCase();
    return (
      normalized === OPENCLAW_HEARTBEAT_POLL ||
      normalized.includes(HEARTBEAT_TURN_MARKER)
    );
  });
}


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
export async function pruneHeartbeatOkTurns(
conversationStore: ConversationStore,
conversationId: number,
): Promise<number> {
  const allMessages = await conversationStore.getMessages(conversationId);
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
  return conversationStore.deleteMessages(uniqueIds);
}
