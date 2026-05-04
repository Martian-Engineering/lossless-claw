import type { LcmContextEngine } from "../engine.js";
import type { LcmDependencies } from "../types.js";

export type LcmConversationScope = {
  conversationId?: number;
  conversationIds?: number[];
  allConversations: boolean;
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
  deps?: Pick<LcmDependencies, "resolveSessionIdFromSessionKey">;
}): Promise<LcmConversationScope> {
  const { lcm, params } = input;

  const explicitConversationId =
    typeof params.conversationId === "number" && Number.isFinite(params.conversationId)
      ? Math.trunc(params.conversationId)
      : undefined;
  if (explicitConversationId != null) {
    return {
      conversationId: explicitConversationId,
      conversationIds: [explicitConversationId],
      allConversations: false,
    };
  }

  if (params.allConversations === true) {
    return { conversationId: undefined, conversationIds: undefined, allConversations: true };
  }

  const normalizedSessionKey = input.sessionKey?.trim();
  if (normalizedSessionKey) {
    const bySessionKey =
      await lcm.getConversationStore().getConversationBySessionKey(normalizedSessionKey);
    if (bySessionKey) {
      const familyIds =
        typeof (lcm.getConversationStore() as ConversationScopeStore).getConversationFamilyIds === "function"
          ? await (lcm.getConversationStore() as ConversationScopeStore).getConversationFamilyIds({
              conversationId: bySessionKey.conversationId,
              sessionKey: normalizedSessionKey,
            })
          : [bySessionKey.conversationId];
      return {
        conversationId: bySessionKey.conversationId,
        conversationIds: familyIds.length > 0 ? familyIds : [bySessionKey.conversationId],
        allConversations: false,
      };
    }
  }

  let normalizedSessionId = input.sessionId?.trim();
  if (!normalizedSessionId && normalizedSessionKey && input.deps) {
    normalizedSessionId = await input.deps.resolveSessionIdFromSessionKey(normalizedSessionKey);
  }
  if (!normalizedSessionId && !input.sessionKey?.trim()) {
    return { conversationId: undefined, conversationIds: undefined, allConversations: false };
  }

  const conversation = await lookupConversationForSession({
    lcm,
    sessionId: normalizedSessionId,
    sessionKey: input.sessionKey,
  });
  if (!conversation) {
    return { conversationId: undefined, conversationIds: undefined, allConversations: false };
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

  return {
    conversationId: conversation.conversationId,
    conversationIds: familyIds.length > 0 ? familyIds : [conversation.conversationId],
    allConversations: false,
  };
}
