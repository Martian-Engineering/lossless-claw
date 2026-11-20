/** Derive a retrieval principal from a host-supplied, agent-scoped session key. */
export function resolveSessionPrincipal(sessionKey: string | undefined): string | undefined {
  const key = sessionKey?.trim();
  if (!key) return undefined;
  const parts = key.split(":");
  if (parts.length < 3 || parts[0] !== "agent" || parts.some((part) => !part)) {
    return undefined;
  }
  if (parts.at(-1) === "heartbeat") parts.pop();
  if (parts.length < 3) return undefined;
  if (parts.length >= 5
    && ["telegram", "discord", "line"].includes(parts[2]!)
    && ["direct", "group", "channel"].includes(parts[3]!)) {
    return parts.slice(0, 5).join(":");
  }
  return parts.join(":");
}
