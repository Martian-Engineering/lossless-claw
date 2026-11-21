import type { LcmContextEngine } from "../engine.js";
import {
  getRuntimeExpansionAuthManager,
  resolveDelegatedExpansionGrantId,
} from "../expansion-auth.js";
import {
  DISCLOSURE_CONVERSATION_UNAVAILABLE,
  type LcmDisclosureGate,
} from "../disclosure.js";
import { isIsolatedCronSessionKey } from "../session-patterns.js";
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
export type ResolveLcmConversationScopeInput = {
  lcm: LcmContextEngine;
  params: Record<string, unknown>;
  sessionId?: string;
  sessionKey?: string;
  deps?: Pick<LcmDependencies, "isSubagentSessionKey" | "log">;
  /**
   * Host-bound disclosure gate. When present the resolved scope is intersected
   * with live host authority; `allConversations` becomes the authorized set
   * instead of the whole database.
   */
  disclosure?: LcmDisclosureGate | null;
};

export async function resolveLcmConversationScope(
  input: ResolveLcmConversationScopeInput,
): Promise<LcmConversationScope> {
  const scope = await resolveUngatedConversationScope(input);
  return applyDisclosureToScope(input, scope);
}

async function applyDisclosureToScope(
  input: ResolveLcmConversationScopeInput,
  scope: LcmConversationScope,
): Promise<LcmConversationScope> {
  const gate = input.disclosure;
  if (!gate || scope.error) {
    return scope;
  }
  const denied = (): LcmConversationScope => ({
    allConversations: false,
    delegated: scope.delegated,
    error: DISCLOSURE_CONVERSATION_UNAVAILABLE,
  });

  if (scope.allConversations) {
    // A global request selects targets; it never grants access to them.
    const ids = await gate.listAuthorizedConversationIds(input.lcm);
    if (ids.length === 0) {
      return denied();
    }
    return {
      conversationId: ids.length === 1 ? ids[0] : undefined,
      conversationIds: ids,
      allConversations: true,
      delegated: scope.delegated,
    };
  }

  const requested =
    scope.conversationIds && scope.conversationIds.length > 0
      ? scope.conversationIds
      : scope.conversationId != null
        ? [scope.conversationId]
        : undefined;
  if (!requested) {
    return scope;
  }
  const allowed = await gate.authorizeConversationIds(input.lcm, requested);
  const explicit =
    typeof input.params.conversationId === "number"
    && Number.isFinite(input.params.conversationId)
      ? Math.trunc(input.params.conversationId)
      : undefined;
  if (explicit != null && !allowed.has(explicit)) {
    return denied();
  }
  const filtered = requested.filter((id) => allowed.has(id));
  if (filtered.length === 0) {
    return denied();
  }
  return {
    // Never invent a single-conversation scope the ungated resolver did not have.
    conversationId:
      scope.conversationId != null
        ? allowed.has(scope.conversationId)
          ? scope.conversationId
          : filtered.length === 1
            ? filtered[0]
            : undefined
        : undefined,
    conversationIds: filtered,
    allConversations: false,
    delegated: scope.delegated,
  };
}

async function resolveUngatedConversationScope(
  input: ResolveLcmConversationScopeInput,
): Promise<LcmConversationScope> {
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
  const isolateCurrentSessionFamily = isIsolatedCronSessionKey(normalizedSessionKey);
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

    // A delegated session may create its own active LCM conversation while
    // processing the delegated task. Large tool outputs written into that
    // conversation must remain retrievable by the same session, even when the
    // propagated grant only names the parent/source conversation.
    // Scope expansion requires the exact child key, without runtime-ID fallback.
    const delegatedSessionConversation = await lcm.getConversationStore()
      .getConversationBySessionKey(normalizedSessionKey!);
    if (
      delegatedSessionConversation?.active === true
      && !allowedConversationIds.includes(delegatedSessionConversation.conversationId)
    ) {
      allowedConversationIds.push(delegatedSessionConversation.conversationId);
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
    const store = lcm.getConversationStore();
    const bySessionKey = await store.getConversationBySessionKey(normalizedSessionKey);
    if (bySessionKey) {
      const byRuntimeSession =
        !isDelegatedSession && normalizedInputSessionId && !sessionIdAsSessionKey
          ? await store.getConversationBySessionId(normalizedInputSessionId)
          : null;
      const runtimeSessionOverridesStaleKey =
        byRuntimeSession?.active === true
        && byRuntimeSession.conversationId !== bySessionKey.conversationId;
      const conversation = runtimeSessionOverridesStaleKey ? byRuntimeSession : bySessionKey;
      const conversationSessionKey = conversation.sessionKey?.trim();
      if (runtimeSessionOverridesStaleKey) {
        input.deps?.log.warn(
          `[lcm] recall scope: active runtime session overrides stale tool session key requestedSessionKey=${normalizedSessionKey} resolvedConversation=${bySessionKey.conversationId} resolvedSessionKey=${bySessionKey.sessionKey ?? ""} resolvedActive=${bySessionKey.active} runtimeSessionId=${normalizedInputSessionId} alternativeConversation=${byRuntimeSession.conversationId} alternativeSessionKey=${byRuntimeSession.sessionKey ?? ""} alternativeActive=${byRuntimeSession.active}`,
        );
      }
      if (isDelegatedSession && !allowedConversationIds.includes(bySessionKey.conversationId)) {
        return {
          allConversations: false,
          delegated: true,
          error: `Conversation ${bySessionKey.conversationId} is outside delegated conversation scope.`,
        };
      }
      const isolateResolvedSessionFamily = isIsolatedCronSessionKey(conversationSessionKey);
      const familyIds = isolateResolvedSessionFamily
        ? [conversation.conversationId]
        : typeof (lcm.getConversationStore() as ConversationScopeStore).getConversationFamilyIds === "function"
          ? await (lcm.getConversationStore() as ConversationScopeStore).getConversationFamilyIds({
              conversationId: conversation.conversationId,
              sessionId: runtimeSessionOverridesStaleKey ? normalizedInputSessionId : undefined,
              sessionKey: conversationSessionKey,
            })
          : [conversation.conversationId];
      const scopedFamilyIds = familyIds.length > 0 ? familyIds : [conversation.conversationId];
      const conversationIds = isDelegatedSession
        ? scopedFamilyIds.filter((conversationId) => allowedConversationIds.includes(conversationId))
        : scopedFamilyIds;
      return {
        conversationId: conversation.conversationId,
        conversationIds: conversationIds.length > 0 ? conversationIds : [conversation.conversationId],
        allConversations: false,
        delegated: isDelegatedSession,
      };
    }
  }

  const normalizedSessionId = sessionIdAsSessionKey ? undefined : normalizedInputSessionId;
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
  const familyIds = isolateCurrentSessionFamily
    ? [conversation.conversationId]
    : typeof store.getConversationFamilyIds === "function"
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
