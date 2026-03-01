export type AgentMemoryScopeOptions = {
  baseEngine: "lcm";
  defaultScope: "current" | "agent";
  allowAgentScope: boolean;
  maxAgentConversations: number;
  maxScopeResults: number;
  sortAgentConversationsBy: "updated_at" | "created_at";
};

export const DEFAULT_AGENT_MEMORY_SCOPE_OPTIONS: AgentMemoryScopeOptions = {
  baseEngine: "lcm",
  defaultScope: "current",
  allowAgentScope: true,
  maxAgentConversations: 200,
  maxScopeResults: 200,
  sortAgentConversationsBy: "updated_at",
};

export function resolveAgentMemoryScopeOptions(
  raw?: Partial<AgentMemoryScopeOptions>,
): AgentMemoryScopeOptions {
  return {
    ...DEFAULT_AGENT_MEMORY_SCOPE_OPTIONS,
    ...(raw ?? {}),
    maxAgentConversations: Math.max(
      1,
      Math.floor(raw?.maxAgentConversations ?? DEFAULT_AGENT_MEMORY_SCOPE_OPTIONS.maxAgentConversations),
    ),
    maxScopeResults: Math.max(
      1,
      Math.floor(raw?.maxScopeResults ?? DEFAULT_AGENT_MEMORY_SCOPE_OPTIONS.maxScopeResults),
    ),
  };
}
