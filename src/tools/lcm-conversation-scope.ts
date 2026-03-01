import {
  DEFAULT_AGENT_MEMORY_SCOPE_OPTIONS,
  resolveAgentScopedConversations,
  type ScopeResultProvenance,
} from "../plugins/agent-memory-scope/index.js";
import type { LcmContextEngine } from "../engine.js";
import type { LcmDependencies } from "../types.js";

export type LcmConversationScope = {
  conversationId?: number;
  conversationIds?: number[];
  allConversations: boolean;
  mode: "current" | "agent" | "all" | "explicit";
  agentId?: string;
  warnings: string[];
  provenance: ScopeResultProvenance[];
};

/**
 * Parse an ISO-8601 timestamp tool parameter into a Date.
 *
 * Throws when the value is not a parseable timestamp string.
 */
export function parseIsoTimestampParam(
  params: Record<string, unknown>,
  key: string,
): Date | undefined {
  const raw = params[key];
  if (typeof raw !== "string") {
    return undefined;
  }
  const value = raw.trim();
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${key} must be a valid ISO timestamp.`);
  }
  return parsed;
}

/**
 * Resolve LCM conversation scope for tool calls.
 *
 * Priority:
 * 1. Explicit conversationId parameter
 * 2. allConversations=true (cross-conversation mode)
 * 3. requestedScope=agent (same-agent cross-conversation mode)
 * 4. Current session's LCM conversation
 */
export async function resolveLcmConversationScope(input: {
  lcm: LcmContextEngine;
  params: Record<string, unknown>;
  requestedScope?: "current" | "agent";
  sessionId?: string;
  sessionKey?: string;
  deps?: Pick<
    LcmDependencies,
    | "resolveSessionIdFromSessionKey"
    | "resolveAgentIdFromSessionKey"
    | "listAgentSessionIds"
    | "resolveSessionMeta"
    | "normalizeAgentId"
  >;
}): Promise<LcmConversationScope> {
  const { lcm, params } = input;

  const explicitConversationId =
    typeof params.conversationId === "number" && Number.isFinite(params.conversationId)
      ? Math.trunc(params.conversationId)
      : undefined;
  if (explicitConversationId != null) {
    return {
      conversationId: explicitConversationId,
      allConversations: false,
      mode: "explicit",
      warnings: [],
      provenance: [{ conversationId: explicitConversationId }],
    };
  }

  if (params.allConversations === true) {
    return {
      conversationId: undefined,
      allConversations: true,
      mode: "all",
      warnings: [],
      provenance: [],
    };
  }

  const requestedScope = input.requestedScope ?? DEFAULT_AGENT_MEMORY_SCOPE_OPTIONS.defaultScope;
  const warnings: string[] = [];

  let normalizedSessionId = input.sessionId?.trim();
  if (!normalizedSessionId && input.sessionKey && input.deps) {
    normalizedSessionId = await input.deps.resolveSessionIdFromSessionKey(input.sessionKey.trim());
  }

  const getCurrentConversationScope = async (): Promise<LcmConversationScope> => {
    if (!normalizedSessionId) {
      return {
        conversationId: undefined,
        allConversations: false,
        mode: "current",
        warnings,
        provenance: [],
      };
    }

    const conversation = await lcm
      .getConversationStore()
      .getConversationBySessionId(normalizedSessionId);
    if (!conversation) {
      return {
        conversationId: undefined,
        allConversations: false,
        mode: "current",
        warnings,
        provenance: [],
      };
    }

    const sessionMeta = input.deps?.resolveSessionMeta
      ? await input.deps.resolveSessionMeta(conversation.sessionId)
      : undefined;

    return {
      conversationId: conversation.conversationId,
      allConversations: false,
      mode: "current",
      warnings,
      provenance: [
        {
          conversationId: conversation.conversationId,
          sessionId: conversation.sessionId,
          sessionKey: sessionMeta?.sessionKey,
          channel: sessionMeta?.channel,
          chatType: sessionMeta?.chatType,
        },
      ],
    };
  };

  if (!DEFAULT_AGENT_MEMORY_SCOPE_OPTIONS.allowAgentScope || requestedScope !== "agent") {
    return getCurrentConversationScope();
  }

  const agentScope = await resolveAgentScopedConversations({
    deps: input.deps,
    lcm,
    sessionKey: input.sessionKey,
    agentIdOverride: typeof params.agentId === "string" ? params.agentId : undefined,
    maxAgentConversations: DEFAULT_AGENT_MEMORY_SCOPE_OPTIONS.maxAgentConversations,
    sortBy: DEFAULT_AGENT_MEMORY_SCOPE_OPTIONS.sortAgentConversationsBy,
  });

  if (agentScope.conversationIds.length > 0) {
    return {
      conversationId: undefined,
      conversationIds: agentScope.conversationIds,
      allConversations: false,
      mode: "agent",
      agentId: agentScope.agentId,
      warnings,
      provenance: agentScope.provenance,
    };
  }

  warnings.push(
    "No conversations found for inferred agent scope; falling back to current conversation.",
  );
  if (agentScope.fallbackReason) {
    warnings.push(`Agent scope fallback reason: ${agentScope.fallbackReason}.`);
  }

  const current = await getCurrentConversationScope();
  return {
    ...current,
    warnings,
  };
}
