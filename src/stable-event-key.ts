import type { AgentMessage } from "./openclaw-bridge.js";
import { extractSingleToolResultIdForPairing } from "./tool-pairing.js";
import { safeString } from "./value-utils.js";

/**
 * Tool-call id shapes that are PROVABLY unique per event: minted by the
 * provider/transport, never authored by the model. Only these may be used as
 * conversation-global stable event keys.
 *
 *   - `toolu_…`  Anthropic tool_use ids (also Bedrock-hosted Anthropic).
 *   - `call_…`   OpenAI chat/responses tool-call ids.
 *
 * Everything else — most importantly model-authored counter patterns such
 * as Kimi K3's `name:N` ids (`exec:101`, `read:92`, `web_search:45`) — is
 * deliberately excluded. Model-authored ids are only ADJACENCY-unique: the
 * same id recurs across turns (K3 cycles through the same counters within
 * the hour), so treating them as global event identities classifies
 * DISTINCT events as duplicates and silently drops their tool results at
 * ingest time (2026-08-02 incident: all recurrent-id tool results skipped
 * by the stable-event short-circuit while their calls persisted, leaving
 * the assembler to synthesize "missing tool result" errors). Non-listed
 * formats return null here and fall back to the content/adjacency/rawId
 * bound dedup paths, which may duplicate a redacted twin but never lose an
 * event (repair-time dedup handles the duplicates).
 */
const PROVIDER_UNIQUE_TOOL_CALL_ID_PATTERN = /^(?:toolu_|call_)[A-Za-z0-9]{12,}$/;

export function isProviderUniqueToolCallId(toolCallId: string): boolean {
  return PROVIDER_UNIQUE_TOOL_CALL_ID_PATTERN.test(toolCallId);
}

/**
 * Extracts a message identity that remains stable across transcript and
 * runtime representations.
 *
 * Assistant response ids take priority, followed by tool call ids that are
 * provably provider-unique (see PROVIDER_UNIQUE_TOOL_CALL_ID_PATTERN).
 * Messages without such an identifier return `null` and use the existing
 * content-based and redaction-aware deduplication paths.
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
