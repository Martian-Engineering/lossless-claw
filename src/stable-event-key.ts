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
 * 3. any role without a stable id: millisecond-truncated inner source
 *    timestamp combined with the conversation id and normalized role.
 * 4. nothing → `null` (existing compatibility path is used).
 */
import type { AgentMessage } from "./openclaw-bridge.js";
import { toDbRole } from "./message-content.js";
import { extractToolResultIdForPairing } from "./tool-pairing.js";
import { resolveTranscriptMessageInnerTimestamp } from "./transcript.js";
import { safeString } from "./value-utils.js";

function toEpochMs(value: number | string | null): number | null {
  if (value === null) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

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

  const inner = resolveTranscriptMessageInnerTimestamp(message);
  const ms = toEpochMs(inner);
  if (ms === null) {
    return null;
  }
  const normalizedRole = toDbRole(role);
  return `${normalizedRole}-event:${conversationId}:${normalizedRole}:${ms}`;
}

/** Batch chunk size consumed by the store query helper for batched lookups. */
export const STABLE_EVENT_KEY_BATCH_CHUNK = 200;