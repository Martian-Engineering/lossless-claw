import type { LcmContextEngine } from "../engine.js";
import type { LcmDependencies } from "../types.js";

export type LcmConversationScope = {
  conversationId?: number;
  conversationIds?: number[];
  allConversations: boolean;
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
 * 3. Current session's LCM conversation
 */
export async function resolveLcmConversationScope(input: {
  lcm: LcmContextEngine;
  params: Record<string, unknown>;
  sessionId?: string;
  sessionKey?: string;
  deps?: Pick<LcmDependencies, "resolveSessionIdFromSessionKey">;
  grantContext?: {
    isSubagent: boolean;
    allowedConversationIds?: number[];
  };
}): Promise<LcmConversationScope> {
  const { lcm, params } = input;
  const allowedConversationIds = input.grantContext?.allowedConversationIds;
  const isSubagent = input.grantContext?.isSubagent === true;
  const hasDelegatedGrant =
    isSubagent && Array.isArray(allowedConversationIds) && allowedConversationIds.length > 0;

  let cachedSessionConversationId: number | undefined;
  let resolvedSessionConversationId = false;

  const resolveSessionConversationId = async (): Promise<number | undefined> => {
    if (resolvedSessionConversationId) {
      return cachedSessionConversationId;
    }

    let normalizedSessionId = input.sessionId?.trim();
    if (!normalizedSessionId && input.sessionKey && input.deps) {
      normalizedSessionId = await input.deps.resolveSessionIdFromSessionKey(input.sessionKey.trim());
    }
    if (!normalizedSessionId) {
      resolvedSessionConversationId = true;
      return undefined;
    }

    const conversation = await lcm.getConversationStore().getConversationBySessionId(normalizedSessionId);
    cachedSessionConversationId = conversation?.conversationId;
    resolvedSessionConversationId = true;
    return cachedSessionConversationId;
  };

  const enforceConversationAccess = async (conversationId: number): Promise<void> => {
    if (hasDelegatedGrant) {
      if (!allowedConversationIds.includes(conversationId)) {
        throw new Error(`Conversation ${conversationId} is not in delegated grant scope.`);
      }
      return;
    }

    if (isSubagent) {
      const sessionConversationId = await resolveSessionConversationId();
      if (sessionConversationId == null || sessionConversationId !== conversationId) {
        throw new Error(`Conversation ${conversationId} is not available in this session.`);
      }
    }
  };

  const explicitConversationId =
    typeof params.conversationId === "number" && Number.isFinite(params.conversationId)
      ? Math.trunc(params.conversationId)
      : undefined;
  if (explicitConversationId != null) {
    await enforceConversationAccess(explicitConversationId);
    return { conversationId: explicitConversationId, allConversations: false };
  }

  if (params.allConversations === true) {
    if (hasDelegatedGrant) {
      return { conversationIds: [...allowedConversationIds], allConversations: false };
    }
    if (isSubagent) {
      const sessionConversationId = await resolveSessionConversationId();
      return { conversationId: sessionConversationId, allConversations: false };
    }
    return { conversationId: undefined, allConversations: true };
  }

  const conversationId = await resolveSessionConversationId();
  if (conversationId == null) {
    return { conversationId: undefined, allConversations: false };
  }

  await enforceConversationAccess(conversationId);
  return { conversationId, allConversations: false };
}
