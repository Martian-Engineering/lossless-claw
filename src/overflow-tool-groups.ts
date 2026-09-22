import type { ContextItemRecord } from "./store/summary-store.js";
import type {
  MessagePartRecord,
  MessageRecord,
} from "./store/conversation-store.js";

/** Stored context plus tool identities needed to select a complete recovery group. */
export type OverflowContextItem = {
  item: ContextItemRecord;
  message: MessageRecord | null;
  parts: MessagePartRecord[];
};

/** Select an older contiguous chunk of complete tool groups after the latest raw user. */
export function selectOverflowToolGroup(
  context: OverflowContextItem[],
  freshTailCount: number,
  freshTailMaxTokens?: number,
  afterOrdinal?: number,
  chunkTokens = Infinity
): ContextItemRecord[] {
  const userIndex = context.findLastIndex(
    ({ message }) => message?.role === "user"
  );
  if (userIndex < 0) return [];
  const suffix = context.slice(userIndex + 1);
  const tailOrdinal = recoveryTailOrdinal(
    suffix,
    freshTailCount,
    freshTailMaxTokens
  );

  // Reused call IDs cannot prove which result belongs to a retained occurrence.
  const counts = new Map<string, number>();
  for (const row of suffix) {
    if (row.message?.role !== "assistant") continue;
    for (const part of row.parts.filter((part) => part.partType === "tool")) {
      if (part.toolCallId)
        counts.set(part.toolCallId, (counts.get(part.toolCallId) ?? 0) + 1);
    }
  }

  const selected: ContextItemRecord[] = [];
  let selectedTokens = 0;
  for (let index = 0; index < suffix.length; index++) {
    const row = suffix[index]!;
    if (row.item.ordinal >= tailOrdinal) break;
    if (!row.message) continue;
    // Orphan results and incomplete groups are barriers; never summarize past them.
    if (row.message.role === "tool") return selected;
    if (row.message.role !== "assistant") continue;
    const calls = row.parts.filter((part) => part.partType === "tool");
    if (calls.length === 0) continue;
    if (
      calls.some(
        (part) => !part.toolCallId || counts.get(part.toolCallId) !== 1
      )
    )
      return selected;
    const pending = new Set(calls.map((part) => part.toolCallId!));
    const group = [row.item];
    let groupTokens = Math.max(0, row.message.tokenCount);

    // A group contains one assistant invocation and every immediately following result.
    while (pending.size > 0) {
      const result = suffix[++index];
      if (
        !result ||
        result.item.ordinal >= tailOrdinal ||
        result.message?.role !== "tool"
      )
        return selected;
      const resultIds = new Set(
        result.parts
          .map((part) => part.toolCallId)
          .filter((id): id is string => !!id)
      );
      if (resultIds.size === 0) return selected;
      for (const id of resultIds) {
        if (!pending.delete(id)) return selected;
      }
      group.push(result.item);
      groupTokens += Math.max(0, result.message.tokenCount);
    }
    if (suffix[index + 1]?.message?.role === "tool") return selected;
    if (afterOrdinal !== undefined && group[0]!.ordinal <= afterOrdinal)
      continue;
    if (selected.length > 0 && selectedTokens + groupTokens > chunkTokens)
      return selected;
    // A source range must stay contiguous: never absorb skipped text or summary items.
    if (
      selected.length > 0 &&
      selected.at(-1)!.ordinal + 1 !== group[0]!.ordinal
    )
      return selected;
    selected.push(...group);
    selectedTokens += groupTokens;
    if (selectedTokens >= chunkTokens) return selected;
  }
  return selected;
}

/** Bound the recent raw suffix independently of the retained initiating user. */
function recoveryTailOrdinal(
  suffix: OverflowContextItem[],
  freshTailCount: number,
  maxTokens?: number
): number {
  const countLimit = Math.max(1, Math.floor(freshTailCount));
  let count = 0;
  let tokens = 0;
  let ordinal = Infinity;
  for (let index = suffix.length - 1; index >= 0; index--) {
    const row = suffix[index]!;
    if (!row.message) continue;
    const nextTokens = Math.max(0, row.message.tokenCount);
    if (
      count > 0 &&
      (count >= countLimit ||
        (typeof maxTokens === "number" && tokens + nextTokens > maxTokens))
    )
      break;
    ordinal = row.item.ordinal;
    count++;
    tokens += nextTokens;
  }
  return ordinal;
}
