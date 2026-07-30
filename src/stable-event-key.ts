import type { AgentMessage } from "./openclaw-bridge.js";
import { extractSingleToolResultIdForPairing } from "./tool-pairing.js";
import { safeString } from "./value-utils.js";

/**
 * Extracts a message identity that remains stable across transcript and
 * runtime representations.
 *
 * Assistant response ids take priority, followed by tool call ids. Messages
 * without either identifier return `null` and use the existing content-based
 * and redaction-aware deduplication paths.
 */
export function extractStableEventKey(message: AgentMessage): string | null {
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
    const toolCallId = extractSingleToolResultIdForPairing(message);
    if (toolCallId) {
      return `tool-result:${toolCallId}`;
    }
  }

  // No stable event identity available — fall back to null.
  // The message will use existing identity_hash-based dedup and
  // messagesDifferOnlyByHostRedaction for redaction handling.
  return null;
}
