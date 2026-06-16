import type { AgentMessage } from "./openclaw-bridge.js";
import { safeString } from "./value-utils.js";

/**
 * Extract a content-independent deduplication key from an AgentMessage.
 *
 * These keys are immune to sanitization/redaction — they rely on IDs that
 * are assigned by the LLM API or tool-calling framework, not on message
 * content, so they match identically between the live (raw) path and the
 * transcript-reconcile (redacted) path.
 *
 * Fallback chain, by role:
 *
 *   assistant:
 *     1) responseId / response_id  (API-level unique response id)
 *     2) toolUseId                 (tool-use event id within an assistant turn)
 *     3) null → caller falls back to content-hash dedup
 *
 *   tool / toolResult:
 *     1) toolCallId / tool_call_id / toolUseId / tool_use_id
 *
 *   user:
 *     1) timestamp
 *
 * Returns a namespaced string key (`assistant:<id>`, `tool:<id>`,
 * `user:<ts>`) so that ids from different roles cannot collide.
 * Returns null when no content-independent key can be extracted,
 * signalling the caller to fall back to content-hash dedup.
 */
export function extractDedupKey(message: AgentMessage): string | null {
  // AgentMessage is a structural type; runtime messages may carry extra
  // top-level properties (e.g. responseId / response_id) that are not
  // declared.  Read them through a Record<string, unknown> view.
  const raw = message as Record<string, unknown>;

  // --- assistant ---
  if (message.role === "assistant") {
    const responseId =
      safeString(raw.responseId) ?? safeString(raw.response_id);
    if (responseId) {
      return `assistant:${responseId}`;
    }
    if (message.toolUseId) {
      return `tool_use:${message.toolUseId}`;
    }
    return null; // pure-text reply — fall back to content-hash dedup
  }

  // --- tool / toolResult ---
  if (message.role === "toolResult" || message.role === "tool") {
    const toolId =
      safeString(raw.toolCallId) ??
      safeString(raw.tool_call_id) ??
      safeString(raw.toolUseId) ??
      safeString(raw.tool_use_id);
    if (toolId) {
      return `tool:${toolId}`;
    }
    return null;
  }

  // --- user ---
  if (message.role === "user") {
    const ts = typeof raw.timestamp === "number" ? raw.timestamp : undefined;
    if (ts !== undefined) {
      return `user:${ts}`;
    }
    return null;
  }

  return null;
}

/**
 * Batch extract dedup keys from an array of messages.
 * Messages that cannot produce a key are silently skipped.
 */
export function extractDedupKeys(messages: AgentMessage[]): Set<string> {
  const keys = new Set<string>();
  for (const msg of messages) {
    const key = extractDedupKey(msg);
    if (key) keys.add(key);
  }
  return keys;
}
