import type { AgentMessage } from "./openclaw-bridge.js";
import { extractSingleToolResultIdForPairing } from "./tool-pairing.js";
import { safeString } from "./value-utils.js";

/** Provider-minted tool-call ids that are unique for one tool event. */
const PROVIDER_UNIQUE_TOOL_CALL_ID_PATTERN = /^(?:toolu_|call_)[A-Za-z0-9]{12,}$/;

/** Return whether a tool-call id is safe as a conversation-global identity. */
export function isProviderUniqueToolCallId(toolCallId: string): boolean {
  return PROVIDER_UNIQUE_TOOL_CALL_ID_PATTERN.test(toolCallId);
}

/**
 * Extracts a message identity that remains stable across transcript and
 * runtime representations.
 *
 * Assistant response ids take priority, followed by provider-minted tool-call
 * ids. Model-authored ids such as `exec:101` can recur across turns, so they
 * return `null` and use occurrence-scoped ingestion instead of global dedup.
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
    if (toolCallId && isProviderUniqueToolCallId(toolCallId)) {
      return `tool-result:${toolCallId}`;
    }
  }

  // No stable event identity available — fall back to null.
  // The message will use existing identity_hash-based dedup and
  // messagesDifferOnlyByHostRedaction for redaction handling.
  return null;
}
