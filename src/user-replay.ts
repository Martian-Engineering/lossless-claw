import type { AgentMessage } from "./openclaw-bridge.js";
import type { VisibleSessionTranscriptMessageEntry } from "./types.js";
import { getTranscriptEntryId } from "./transcript.js";
import { messagesHaveSameLiveCoverageSignature } from "./message-signatures.js";

/** Restore host replay metadata only for retained, canonically identified raw users. */
export function restoreRawUserReplay(
  assembled: AgentMessage[],
  live: AgentMessage[],
  entries: VisibleSessionTranscriptMessageEntry[],
): { messages: AgentMessage[]; carrierParents: Map<AgentMessage, AgentMessage> } {
  const carrierParents = new Map<AgentMessage, AgentMessage>();
  if (entries.length === 0) return { messages: assembled, carrierParents };
  const entriesById = new Map(entries.map(entry => [entry.entryId, entry]));
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
    const entry = entryId ? entriesById.get(entryId) : undefined;
    const key = entry && Reflect.get(entry.message, "idempotencyKey");
    if (!entry || entry.message.role !== "user" || typeof key !== "string" || duplicateKeys.has(key)) return [message];
    const index = liveByKey.get(key);
    const source = index !== undefined ? live[index] : undefined;
    // Never graft replay identity by matching text alone, nor undo externalization.
    if (!source || !messagesHaveSameLiveCoverageSignature(message, entry.message) ||
        !messagesHaveSameLiveCoverageSignature(source, entry.message)) return [message];
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
