import type { ContextEngine } from "../openclaw-bridge.js";
import type { ConversationStore } from "../store/conversation-store.js";
import { toStoredMessage } from "./message-normalization.js";

type AgentMessage = Parameters<ContextEngine["ingest"]>[0]["message"];

const HEARTBEAT_OK_TOKEN = "heartbeat_ok";
const HEARTBEAT_TURN_MARKER = "heartbeat.md";

/**
 * Detect whether an assistant message is a heartbeat ack.
 */
export function isHeartbeatOkContent(content: string): boolean {
  return content.trim().toLowerCase() === HEARTBEAT_OK_TOKEN;
}

/**
 * Detect heartbeat acknowledgement turns in a newly ingested batch.
 */
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

function turnLooksLikeHeartbeatTurn(turnMessages: Array<{ content: string }>): boolean {
  return turnMessages.some((message) =>
    message.content.toLowerCase().includes(HEARTBEAT_TURN_MARKER),
  );
}

/**
 * Detect HEARTBEAT_OK turn cycles in a conversation and delete them.
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

  for (let i = 0; i < allMessages.length; i++) {
    const msg = allMessages[i];
    if (msg.role !== "assistant") {
      continue;
    }
    if (!isHeartbeatOkContent(msg.content)) {
      continue;
    }

    const turnMessages = [msg];
    for (let j = i - 1; j >= 0; j--) {
      const prev = allMessages[j];
      turnMessages.push(prev);
      if (prev.role === "user") {
        break;
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

  const uniqueIds = [...new Set(toDelete)];
  return conversationStore.deleteMessages(uniqueIds);
}
