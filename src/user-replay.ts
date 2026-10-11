import { createHash } from "node:crypto";
import type { AgentMessage } from "./openclaw-bridge.js";
import { getTranscriptEntryId } from "./transcript.js";
import { createLiveCoverageSignature } from "./message-signatures.js";

/** Replay identity of one visible transcript user entry, as persisted by the host. */
export type UserReplayIdentity = {
  idempotencyKey: string;
  /** Digest of the entry's live-coverage signature. */
  signature: string;
};

/** Digest of a message's live-coverage signature, comparable across stored and live copies. */
function replaySignatureOf(message: AgentMessage): string {
  return createHash("sha256").update(createLiveCoverageSignature(message)).digest("hex");
}

/**
 * Observe the replay identity carried by a transcript user message. Entries
 * without a key observe '' for both fields so they are never restored.
 */
export function observeUserReplayIdentity(message: AgentMessage): UserReplayIdentity {
  const key = Reflect.get(message, "idempotencyKey");
  return typeof key === "string" && key
    ? { idempotencyKey: key, signature: replaySignatureOf(message) }
    : { idempotencyKey: "", signature: "" };
}

/**
 * Restore host replay metadata only for retained, canonically identified raw
 * users. `identities` maps visible transcript entry ids to the replay identity
 * observed on that user entry.
 */
export function restoreRawUserReplay(
  assembled: AgentMessage[],
  live: AgentMessage[],
  identities: ReadonlyMap<string, UserReplayIdentity>,
): { messages: AgentMessage[]; carrierParents: Map<AgentMessage, AgentMessage> } {
  const carrierParents = new Map<AgentMessage, AgentMessage>();
  if (identities.size === 0) return { messages: assembled, carrierParents };
  const liveByKey = new Map<string, number>();
  const duplicateKeys = new Set<string>();
  for (const [index, message] of live.entries()) {
    const key = Reflect.get(message, "idempotencyKey");
    if (message.role !== "user" || typeof key !== "string" || !key) continue;
    if (liveByKey.has(key)) duplicateKeys.add(key);
    liveByKey.set(key, index);
  }
  const messages = assembled.flatMap(message => {
    if (message.role !== "user") return [message];
    const entryId = getTranscriptEntryId(message);
    const identity = entryId ? identities.get(entryId) : undefined;
    const key = identity?.idempotencyKey;
    if (!identity || !key || duplicateKeys.has(key)) return [message];
    const index = liveByKey.get(key);
    const source = index !== undefined ? live[index] : undefined;
    // Never graft replay identity by matching text alone, nor undo externalization.
    if (!source || replaySignatureOf(message) !== identity.signature ||
        replaySignatureOf(source) !== identity.signature) return [message];
    const restored = { ...message, timestamp: source.timestamp, idempotencyKey: key } as AgentMessage;
    const replay = [restored];
    for (let next = index! + 1; next < live.length; next++) {
      const carrier = live[next]!;
      const details = Reflect.get(carrier, "details");
      if (carrier.role !== "custom" || Reflect.get(carrier, "customType") !== "openclaw.runtime-context" ||
          !details || details.runtimeContextCarrier !== true || details.source !== "openclaw-runtime-context") break;
      replay.push(carrier);
      carrierParents.set(carrier, restored);
    }
    return replay;
  });
  return { messages, carrierParents };
}
