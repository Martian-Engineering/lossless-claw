function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Return a stable agent id for validated OpenClaw configuration values. */
export function normalizeAgentId(agentId: string | undefined): string {
  const normalized = (agentId ?? "").trim();
  return normalized.length > 0 ? normalized : "main";
}

/** List enabled OpenClaw agent ids, using a fallback config before the default agent. */
export function listConfiguredAgentIds(config: unknown, fallbackConfig?: unknown): string[] {
  const agents = isRecord(config) ? config.agents : undefined;
  const list = isRecord(agents) && Array.isArray(agents.list) ? agents.list : undefined;
  if (!list) {
    return fallbackConfig === undefined
      ? ["main"]
      : listConfiguredAgentIds(fallbackConfig);
  }
  const seen = new Set<string>();
  const ids: string[] = [];

  for (const entry of list) {
    if (!isRecord(entry) || entry.enabled === false || typeof entry.id !== "string") {
      continue;
    }
    const agentId = normalizeAgentId(entry.id);
    if (seen.has(agentId)) {
      continue;
    }
    seen.add(agentId);
    ids.push(agentId);
  }

  return ids.length > 0 ? ids : ["main"];
}
