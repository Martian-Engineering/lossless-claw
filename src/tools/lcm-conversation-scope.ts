import type { LcmContextEngine } from "../engine.js";
import {
  getRuntimeExpansionAuthManager,
  resolveDelegatedExpansionGrantId,
} from "../expansion-auth.js";
import type { LcmDependencies } from "../types.js";

export type LcmConversationScope = {
  conversationId?: number;
  conversationIds?: number[];
  allConversations: boolean;
  delegated: boolean;
  error?: string;
};

type ConversationScopeStore = ReturnType<LcmContextEngine["getConversationStore"]> & {
  getConversationForSession?: (input: {
    sessionId?: string;
    sessionKey?: string;
  }) => Promise<{ conversationId: number } | null>;
  getConversationBySessionKey?: (sessionKey: string) => Promise<{ conversationId: number } | null>;
  getConversationFamilyIds?: (input: {
    conversationId?: number;
    sessionId?: string;
    sessionKey?: string;
  }) => Promise<number[]>;
};

async function lookupConversationForSession(input: {
  lcm: LcmContextEngine;
  sessionId?: string;
  sessionKey?: string;
}): Promise<{ conversationId: number } | null> {
  const store = input.lcm.getConversationStore() as ConversationScopeStore;

  if (typeof store.getConversationForSession === "function") {
    return store.getConversationForSession({
      sessionId: input.sessionId,
      sessionKey: input.sessionKey,
    });
  }

  const normalizedSessionKey = input.sessionKey?.trim();
  if (normalizedSessionKey && typeof store.getConversationBySessionKey === "function") {
    const byKey = await store.getConversationBySessionKey(normalizedSessionKey);
    if (byKey) {
      return byKey;
    }
  }

  const normalizedSessionId = input.sessionId?.trim();
  if (!normalizedSessionId) {
    return null;
  }

  return store.getConversationBySessionId(normalizedSessionId);
}

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
 * 3. Current session's LCM conversation
 */
export async function resolveLcmConversationScope(input: {
  lcm: LcmContextEngine;
  params: Record<string, unknown>;
  sessionId?: string;
  sessionKey?: string;
  deps?: Pick<LcmDependencies, "isSubagentSessionKey" | "resolveSessionIdFromSessionKey">;
}): Promise<LcmConversationScope> {
  const { lcm, params } = input;
  const explicitSessionKey = input.sessionKey?.trim();
  const normalizedInputSessionId = input.sessionId?.trim();
  const sessionIdAsSessionKey =
    !explicitSessionKey
    && normalizedInputSessionId
    && input.deps?.isSubagentSessionKey(normalizedInputSessionId)
      ? normalizedInputSessionId
      : undefined;
  const normalizedSessionKey = explicitSessionKey || sessionIdAsSessionKey;
  const isDelegatedSession =
    Boolean(normalizedSessionKey) && Boolean(input.deps?.isSubagentSessionKey(normalizedSessionKey!));
  let allowedConversationIds: number[] = [];

  const explicitConversationId =
    typeof params.conversationId === "number" && Number.isFinite(params.conversationId)
      ? Math.trunc(params.conversationId)
      : undefined;

  if (isDelegatedSession) {
    const delegatedGrantId = resolveDelegatedExpansionGrantId(normalizedSessionKey!);
    const authManager = getRuntimeExpansionAuthManager();
    const delegatedGrant =
      delegatedGrantId != null
        ? authManager.getGrant(delegatedGrantId)
        : null;
    if (!delegatedGrant) {
      if (delegatedGrantId) {
        const validation = authManager.validateExpansion(delegatedGrantId, {
          conversationId: explicitConversationId ?? 0,
          summaryIds: [],
          depth: 1,
          tokenCap: 1,
        });
        return {
          allConversations: false,
          delegated: true,
          error: `Expansion authorization failed: ${validation.reason ?? "Grant is unavailable"}`,
        };
      }
      return {
        allConversations: false,
        delegated: true,
        error:
          "Delegated LCM retrieval requires a valid grant. This sub-agent session has no propagated expansion grant.",
      };
    }

    allowedConversationIds = Array.from(
      new Set(
        delegatedGrant.allowedConversationIds
          .map((conversationId) => Math.trunc(conversationId))
          .filter((conversationId) => Number.isInteger(conversationId)),
      ),
    );
    if (allowedConversationIds.length === 0) {
      return {
        allConversations: false,
        delegated: true,
        error: "Delegated LCM retrieval grant has no allowed conversation scope.",
      };
    }

    if (explicitConversationId != null) {
      if (!allowedConversationIds.includes(explicitConversationId)) {
        return {
          allConversations: false,
          delegated: true,
          error: `Conversation ${explicitConversationId} is outside delegated conversation scope.`,
        };
      }
      return {
        conversationId: explicitConversationId,
        conversationIds: [explicitConversationId],
        allConversations: false,
        delegated: true,
      };
    }

    if (params.allConversations === true) {
      return {
        conversationId: allowedConversationIds.length === 1 ? allowedConversationIds[0] : undefined,
        conversationIds: allowedConversationIds,
        allConversations: false,
        delegated: true,
      };
    }
  }

  if (explicitConversationId != null) {
    return {
      conversationId: explicitConversationId,
      conversationIds: [explicitConversationId],
      allConversations: false,
      delegated: false,
    };
  }

  if (params.allConversations === true) {
    return {
      conversationId: undefined,
      conversationIds: undefined,
      allConversations: true,
      delegated: false,
    };
  }

  if (normalizedSessionKey) {
    const bySessionKey =
      await lcm.getConversationStore().getConversationBySessionKey(normalizedSessionKey);
    if (bySessionKey) {
      if (isDelegatedSession && !allowedConversationIds.includes(bySessionKey.conversationId)) {
        return {
          allConversations: false,
          delegated: true,
          error: `Conversation ${bySessionKey.conversationId} is outside delegated conversation scope.`,
        };
      }
      const familyIds =
        typeof (lcm.getConversationStore() as ConversationScopeStore).getConversationFamilyIds === "function"
          ? await (lcm.getConversationStore() as ConversationScopeStore).getConversationFamilyIds({
              conversationId: bySessionKey.conversationId,
              sessionKey: normalizedSessionKey,
            })
          : [bySessionKey.conversationId];
      const scopedFamilyIds = familyIds.length > 0 ? familyIds : [bySessionKey.conversationId];
      const conversationIds = isDelegatedSession
        ? scopedFamilyIds.filter((conversationId) => allowedConversationIds.includes(conversationId))
        : scopedFamilyIds;
      return {
        conversationId: bySessionKey.conversationId,
        conversationIds: conversationIds.length > 0 ? conversationIds : [bySessionKey.conversationId],
        allConversations: false,
        delegated: isDelegatedSession,
      };
    }
  }

  let normalizedSessionId = sessionIdAsSessionKey ? undefined : normalizedInputSessionId;
  if (!normalizedSessionId && normalizedSessionKey && input.deps) {
    normalizedSessionId = await input.deps.resolveSessionIdFromSessionKey(normalizedSessionKey);
  }
  if (!normalizedSessionId && !input.sessionKey?.trim()) {
    return {
      conversationId:
        isDelegatedSession && allowedConversationIds.length === 1
          ? allowedConversationIds[0]
          : undefined,
      conversationIds: isDelegatedSession ? allowedConversationIds : undefined,
      allConversations: false,
      delegated: isDelegatedSession,
    };
  }

  const conversation = await lookupConversationForSession({
    lcm,
    sessionId: normalizedSessionId,
    sessionKey: input.sessionKey,
  });
  if (!conversation) {
    return {
      conversationId:
        isDelegatedSession && allowedConversationIds.length === 1
          ? allowedConversationIds[0]
          : undefined,
      conversationIds: isDelegatedSession ? allowedConversationIds : undefined,
      allConversations: false,
      delegated: isDelegatedSession,
    };
  }

  const store = lcm.getConversationStore() as ConversationScopeStore;
  const familyIds =
    typeof store.getConversationFamilyIds === "function"
      ? await store.getConversationFamilyIds({
          conversationId: conversation.conversationId,
          sessionId: normalizedSessionId,
          sessionKey: input.sessionKey,
        })
      : [conversation.conversationId];

  const scopedFamilyIds = familyIds.length > 0 ? familyIds : [conversation.conversationId];
  const conversationIds = isDelegatedSession
    ? scopedFamilyIds.filter((conversationId) => allowedConversationIds.includes(conversationId))
    : scopedFamilyIds;
  if (isDelegatedSession && !allowedConversationIds.includes(conversation.conversationId)) {
    return {
      allConversations: false,
      delegated: true,
      error: `Conversation ${conversation.conversationId} is outside delegated conversation scope.`,
    };
  }

  return {
    conversationId: conversation.conversationId,
    conversationIds: conversationIds.length > 0 ? conversationIds : [conversation.conversationId],
    allConversations: false,
    delegated: isDelegatedSession,
  };
}
