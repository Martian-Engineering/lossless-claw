/**
 * Stable event identity for a single message across transcript and runtime
 * representations. Used to short-circuit duplicate ingestion when the
 * transcript (typically redacted) and the live afterTurn batch (typically
 * original) describe the same event.
 *
 * Priority:
 * 1. assistant: `responseId` (or `response_id`).
 * 2. tool / toolResult: tool call id (paired id preferred; fall back to
 *    top-level `toolCallId` / `tool_call_id` / `toolUseId` / `tool_use_id`
 *    / `call_id` / `id`).
 * 3. no stable id available → `null` (falls back to existing
 *    identity_hash-based dedup and messagesDifferOnlyByHostRedaction).
 */
import type { AgentMessage } from "./openclaw-bridge.js";
import { extractToolResultIdForPairing } from "./tool-pairing.js";
import { safeString } from "./value-utils.js";

export function extractStableEventKey(
  message: AgentMessage,
  conversationId: number,
): string | null {
  const role = message.role;

  if (role === "assistant") {
    const responseId =
      safeString((message as Record<string, unknown>).responseId) ??
      safeString((message as Record<string, unknown>).response_id);
    if (responseId) {
      return `assistant-response:${responseId}`;
    }
  }

  if (role === "tool" || role === "toolResult") {
    const toolCallId = extractToolResultIdForPairing(message);
    if (toolCallId) {
      return `tool-result:${toolCallId}`;
    }
  }

  // No stable event identity available — fall back to null.
  // The message will use existing identity_hash-based dedup and
  // messagesDifferOnlyByHostRedaction for redaction handling.
  return null;
}

/** Batch chunk size consumed by the store query helper for batched lookups. */
export const STABLE_EVENT_KEY_BATCH_CHUNK = 200;