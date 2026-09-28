import type { AgentMessage } from "./openclaw-bridge.js";
import { extractAssistantToolCallIdsForPairing } from "./tool-pairing.js";

/** Build oldest-first atomic eviction groups, including tool turns' initiating users. */
export function buildVolatileInputEvictionGroups(
  messages: AgentMessage[],
  toolPairIndexes: Map<number, Set<number>>,
): number[][] {
  const parents = messages.map((_, index) => index);
  // Path compression keeps overlapping multi-call groups cheap to coalesce.
  const root = (index: number): number => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]!]!;
      index = parents[index]!;
    }
    return index;
  };
  const link = (left: number, right: number) => {
    parents[root(right)] = root(left);
  };

  // Pair components can span multiple user turns when IDs repeat. Visit each
  // component once, then join each call to its own preceding user boundary.
  const visited = new Set<number>();
  let initiatingUser: number | undefined;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role === "user" || message.role === "system") {
      initiatingUser = index;
    }
    if (initiatingUser !== undefined && extractAssistantToolCallIdsForPairing(message).length > 0) {
      link(initiatingUser, index);
    }
    if (visited.has(index)) continue;
    for (const member of toolPairIndexes.get(index) ?? [index]) {
      visited.add(member);
      link(index, member);
    }
  }

  // Iterating the original order orders groups by their earliest occurrence.
  const groups = new Map<number, number[]>();
  for (let index = 0; index < messages.length; index++) {
    const key = root(index);
    const group = groups.get(key) ?? [];
    group.push(index);
    groups.set(key, group);
  }
  return [...groups.values()];
}
