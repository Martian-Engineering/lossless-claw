import type { LcmContextEngine } from "../engine.js";
import type { LcmDependencies } from "../types.js";

export type LcmConversationScope = {
  conversationId?: number;
  allConversations: boolean;
  /**
   * All conversation IDs under the same session_key as the resolved
   * conversationId, ordered newest-first by created_at. Includes
   * `conversationId` itself plus any archived/rotated predecessors.
   *
   * Used by lcm_recent and other read-side tools to span /new and /reset
   * boundaries — the whole point of LCM is being lossless across session
   * lifecycle events.
   *
   * Empty array if no session_key was used for resolution (eg. explicit
   * `conversationId` parameter).
   */
  relatedConversationIds: number[];
};

type ConversationScopeStore = ReturnType<LcmContextEngine["getConversationStore"]> & {
  getConversationForSession?: (input: {
    sessionId?: string;
    sessionKey?: string;
  }) => Promise<{ conversationId: number } | null>;
  getConversationBySessionKey?: (sessionKey: string) => Promise<{ conversationId: number } | null>;
  listConversationsBySessionKey?: (
    sessionKey: string,
  ) => Promise<Array<{ conversationId: number }>>;
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
      allConversations: false,
      relatedConversationIds: [],
    };
  }

  if (params.allConversations === true) {
    return {
      conversationId: undefined,
      allConversations: true,
      relatedConversationIds: [],
    };
  }

  const normalizedSessionKey = input.sessionKey?.trim();
  if (normalizedSessionKey) {
    const bySessionKey =
      await lcm.getConversationStore().getConversationBySessionKey(normalizedSessionKey);
    if (bySessionKey) {
      const related = await collectRelatedConversationIds(lcm, normalizedSessionKey);
      return {
        conversationId: bySessionKey.conversationId,
        allConversations: false,
        relatedConversationIds: related,
      };
    }
  }

  let normalizedSessionId = input.sessionId?.trim();
  if (!normalizedSessionId && normalizedSessionKey && input.deps) {
    normalizedSessionId = await input.deps.resolveSessionIdFromSessionKey(normalizedSessionKey);
  }
  if (!normalizedSessionId && !input.sessionKey?.trim()) {
    return {
      conversationId: undefined,
      allConversations: false,
      relatedConversationIds: [],
    };
  }

  const conversation = await lookupConversationForSession({
    lcm,
    sessionId: normalizedSessionId,
    sessionKey: input.sessionKey,
  });
  if (!conversation) {
    return {
      conversationId: undefined,
      allConversations: false,
      relatedConversationIds: [],
    };
  }

  const related = normalizedSessionKey
    ? await collectRelatedConversationIds(lcm, normalizedSessionKey)
    : [conversation.conversationId];
  return {
    conversationId: conversation.conversationId,
    allConversations: false,
    relatedConversationIds: related,
  };
}

/**
 * Get all conversation IDs under a given session_key (active + archived),
 * ordered newest-first by created_at. Empty array if listing isn't supported
 * by the store implementation.
 */
async function collectRelatedConversationIds(
  lcm: LcmContextEngine,
  sessionKey: string,
): Promise<number[]> {
  const store = lcm.getConversationStore() as ConversationScopeStore;
  if (typeof store.listConversationsBySessionKey !== "function") {
    return [];
  }
  const records = await store.listConversationsBySessionKey(sessionKey);
  return records.map((record) => record.conversationId);
}
