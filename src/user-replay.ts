import type { AgentMessage } from "./openclaw-bridge.js";
import type { VisibleSessionTranscriptMessageEntry } from "./types.js";
import { attachTranscriptEntryMeta, getTranscriptEntryId, getTranscriptEntryMeta } from "./transcript.js";
import { messagesHaveSameLiveCoverageSignature } from "./message-signatures.js";
import { estimateAgentMessageTokens } from "./token-accounting.js";

/** Replace a retained current user only when the host proves the same occurrence. */
export function restoreCurrentUserTurn(
  assembled: AgentMessage[],
  live: AgentMessage[],
  entries: VisibleSessionTranscriptMessageEntry[],
): { messages: AgentMessage[]; currentTurn?: AgentMessage; replacedIndex: number; tokenDelta: number } {
  const unchanged = { messages: assembled, replacedIndex: -1, tokenDelta: 0 };
  const current = live.findLast(message => message.role === "user");
  const key = current && Reflect.get(current, "idempotencyKey");
  if (!current || typeof key !== "string" || !key.trim()) return unchanged;

  // Keys identify occurrences, not bodies. Reject collisions on either side,
  // including inconsistent envelope/message keys from a transcript projection.
  if (live.filter(message => message.role === "user" && Reflect.get(message, "idempotencyKey") === key).length !== 1) return unchanged;
  const matches = entries.filter(entry => entry.role === "user" &&
    (entry.idempotencyKey === key || Reflect.get(entry.message, "idempotencyKey") === key));
  if (matches.length !== 1) return unchanged;
  const entry = matches[0]!;
  const messageKey = Reflect.get(entry.message, "idempotencyKey");
  if (entry.message.role !== "user" ||
      (entry.idempotencyKey !== undefined && entry.idempotencyKey !== key) ||
      (messageKey !== undefined && messageKey !== key)) return unchanged;

  // Only raw users carry a trusted entry anchor. Summaries, ambiguous anchors,
  // and externalized payloads must not be replaced with full live content.
  if (entries.filter(candidate => candidate.entryId === entry.entryId).length !== 1) return unchanged;
  const indexes = assembled.flatMap((message, index) =>
    message.role === "user" && getTranscriptEntryId(message) === entry.entryId ? [index] : []);
  if (indexes.length !== 1) return unchanged;
  const replacedIndex = indexes[0]!;
  const stored = assembled[replacedIndex]!;
  if (!messagesHaveSameLiveCoverageSignature(stored, entry.message) ||
      messagesHaveSameLiveCoverageSignature(stored, current)) return unchanged;

  // Copy the provider form without mutating the host's array or message. The
  // retained anchor lets downstream replay attach this occurrence's carriers.
  const currentTurn = attachTranscriptEntryMeta({ ...current }, getTranscriptEntryMeta(stored)!);
  const messages = assembled.slice();
  messages[replacedIndex] = currentTurn;
  return {
    messages, currentTurn, replacedIndex,
    tokenDelta: estimateAgentMessageTokens([currentTurn]) - estimateAgentMessageTokens([stored]),
  };
}

/** Restore host replay metadata only for retained, canonically identified raw users. */
export function restoreRawUserReplay(
  assembled: AgentMessage[],
  live: AgentMessage[],
  entries: VisibleSessionTranscriptMessageEntry[],
  currentTurn?: AgentMessage,
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
    const key = message === currentTurn
      ? Reflect.get(currentTurn, "idempotencyKey")
      : entry && Reflect.get(entry.message, "idempotencyKey");
    if (!entry || entry.message.role !== "user" || typeof key !== "string" || duplicateKeys.has(key)) return [message];
    const index = liveByKey.get(key);
    const source = index !== undefined ? live[index] : undefined;
    // Never graft replay identity by matching text alone, nor undo externalization.
    // A current-turn replacement has already proved its canonical occurrence;
    // its provider-only injections intentionally differ from transcript text.
    if (!source || (message !== currentTurn &&
        (!messagesHaveSameLiveCoverageSignature(message, entry.message) ||
         !messagesHaveSameLiveCoverageSignature(source, entry.message)))) return [message];
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
