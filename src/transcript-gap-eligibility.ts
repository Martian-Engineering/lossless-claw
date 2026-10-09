/**
 * Decide whether a visible transcript entry that LCM never stored counts
 * toward a history gap. Only entries the storage policy would have kept
 * count; entries it skips by design (non-persisted roles, delivery mirrors,
 * empty errored replies, runtime-context leaks, heartbeat noise) would
 * otherwise mark a "gap" after every turn.
 */
import { isHeartbeatNoiseContent } from "./heartbeat-filter.js";
import {
  hasPersistableMessageRole,
  isOpenClawRuntimeContextLeak,
  toStoredMessageIdentity,
} from "./message-content.js";
import type { AgentMessage } from "./openclaw-bridge.js";

/** True when an unstored entry would have been stored by the normal ingest policy. */
export function isGapEligibleMessage(message: AgentMessage): boolean {
  if (!hasPersistableMessageRole(message)) {
    return false;
  }
  const record = message as unknown as Record<string, unknown>;
  if (message.role === "assistant" && (record.model === "delivery-mirror" || isEmptyErroredReply(record))) {
    return false;
  }
  const stored = toStoredMessageIdentity(message);
  return !isOpenClawRuntimeContextLeak(stored) && !isHeartbeatNoiseContent(stored.role, stored.content);
}

// Assistant replies that failed or aborted with no content are never stored.
function isEmptyErroredReply(record: Record<string, unknown>): boolean {
  const stopReason = record.stopReason ?? record.stop_reason;
  if (stopReason !== "error" && stopReason !== "aborted") {
    return false;
  }
  const content = record.content;
  return (
    content === undefined ||
    content === null ||
    content === "" ||
    (Array.isArray(content) && content.length === 0)
  );
}
