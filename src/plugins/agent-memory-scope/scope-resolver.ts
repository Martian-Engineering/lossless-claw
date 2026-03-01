import type { LcmContextEngine } from "../../engine.js";
import type { LcmDependencies } from "../../types.js";
import type { ScopeResultProvenance } from "./provenance.js";
import { makeScopeResultProvenance } from "./provenance.js";

export type AgentScopeResolutionInput = {
  deps?: Pick<
    LcmDependencies,
    | "resolveAgentIdFromSessionKey"
    | "listAgentSessionIds"
    | "resolveSessionMeta"
    | "normalizeAgentId"
  >;
  lcm: LcmContextEngine;
  sessionKey?: string;
  agentIdOverride?: string;
  maxAgentConversations: number;
  sortBy: "updated_at" | "created_at";
};

export type AgentScopeResolutionResult = {
  conversationIds: number[];
  agentId?: string;
  provenance: ScopeResultProvenance[];
  fallbackReason?: string;
};

export async function resolveAgentScopedConversations(
  input: AgentScopeResolutionInput,
): Promise<AgentScopeResolutionResult> {
  const explicitAgentId = input.agentIdOverride?.trim();

  let resolvedAgentId = explicitAgentId;
  if (!resolvedAgentId && input.sessionKey && input.deps?.resolveAgentIdFromSessionKey) {
    resolvedAgentId = await input.deps.resolveAgentIdFromSessionKey(input.sessionKey.trim());
  }
  const normalizedAgentId = input.deps?.normalizeAgentId
    ? input.deps.normalizeAgentId(resolvedAgentId)
    : resolvedAgentId?.trim();

  if (!normalizedAgentId) {
    return {
      conversationIds: [],
      provenance: [],
      fallbackReason: "agent-id-unresolved",
    };
  }

  if (!input.deps?.listAgentSessionIds) {
    return {
      conversationIds: [],
      agentId: normalizedAgentId,
      provenance: [],
      fallbackReason: "list-agent-sessions-unavailable",
    };
  }

  const sessionIds = Array.from(
    new Set(
      (await input.deps.listAgentSessionIds(normalizedAgentId))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );

  if (sessionIds.length === 0) {
    return {
      conversationIds: [],
      agentId: normalizedAgentId,
      provenance: [],
      fallbackReason: "agent-has-no-sessions",
    };
  }

  const conversationStore = input.lcm.getConversationStore();
  const mapped = await Promise.all(
    sessionIds.map(async (sessionId) => {
      const conversation = await conversationStore.getConversationBySessionId(sessionId);
      if (!conversation) {
        return undefined;
      }
      const meta = input.deps?.resolveSessionMeta
        ? await input.deps.resolveSessionMeta(conversation.sessionId)
        : undefined;
      return {
        conversation,
        provenance: makeScopeResultProvenance({
          conversationId: conversation.conversationId,
          sessionId: conversation.sessionId,
          meta,
        }),
      };
    }),
  );

  const rows = mapped.filter(
    (value): value is { conversation: { conversationId: number; createdAt: Date; updatedAt: Date }; provenance: ScopeResultProvenance } =>
      Boolean(value),
  );

  rows.sort((a, b) => {
    const aTs =
      input.sortBy === "created_at"
        ? a.conversation.createdAt.getTime()
        : a.conversation.updatedAt.getTime();
    const bTs =
      input.sortBy === "created_at"
        ? b.conversation.createdAt.getTime()
        : b.conversation.updatedAt.getTime();
    return bTs - aTs;
  });

  const limited = rows.slice(0, Math.max(1, input.maxAgentConversations));

  return {
    conversationIds: limited.map((row) => row.conversation.conversationId),
    agentId: normalizedAgentId,
    provenance: limited.map((row) => row.provenance),
    fallbackReason: limited.length === 0 ? "agent-conversations-empty" : undefined,
  };
}
