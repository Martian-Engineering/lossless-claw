import type { ExpansionOrchestrator, ExpansionRequest, ExpansionResult } from "./expansion.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type ExpansionGrant = {
  /** Unique grant ID */
  grantId: string;
  /** Session ID that issued the grant */
  issuerSessionId: string;
  /** Conversation IDs the grantee is allowed to traverse */
  allowedConversationIds: number[];
  /** Specific summary IDs the grantee is allowed to expand (if empty, all within conversation are allowed) */
  allowedSummaryIds: string[];
  /** Maximum traversal depth */
  maxDepth: number;
  /** Maximum tokens the grantee can retrieve */
  tokenCap: number;
  /** When the grant expires */
  expiresAt: Date;
  /** Whether this grant has been revoked */
  revoked: boolean;
  /** Creation timestamp */
  createdAt: Date;
};

export type CreateGrantInput = {
  issuerSessionId: string;
  allowedConversationIds: number[];
  allowedSummaryIds?: string[];
  maxDepth?: number;
  tokenCap?: number;
  /** TTL in milliseconds (default: 5 minutes) */
  ttlMs?: number;
};

export type CreateDelegatedExpansionGrantInput = CreateGrantInput & {
  delegatedSessionKey: string;
};

export type ValidationResult = {
  valid: boolean;
  reason?: string;
};

export type AuthorizedExpansionOrchestrator = {
  expand(grantId: string, request: ExpansionRequest): Promise<ExpansionResult>;
};

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_TOKEN_CAP = 4000;
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── ExpansionAuthManager ─────────────────────────────────────────────────────

export class ExpansionAuthManager {
  private grants: Map<string, ExpansionGrant> = new Map();

  /**
   * Create a new expansion grant with the given parameters.
   * Generates a unique grant ID and applies defaults for optional fields.
   */
  createGrant(input: CreateGrantInput): ExpansionGrant {
    const grantId = "grant_" + crypto.randomUUID().slice(0, 12);
    const now = new Date();
    const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;

    const grant: ExpansionGrant = {
      grantId,
      issuerSessionId: input.issuerSessionId,
      allowedConversationIds: input.allowedConversationIds,
      allowedSummaryIds: input.allowedSummaryIds ?? [],
      maxDepth: input.maxDepth ?? DEFAULT_MAX_DEPTH,
      tokenCap: input.tokenCap ?? DEFAULT_TOKEN_CAP,
      expiresAt: new Date(now.getTime() + ttlMs),
      revoked: false,
      createdAt: now,
    };

    this.grants.set(grantId, grant);
    return grant;
  }

  /**
   * Retrieve a grant by ID. Returns null if the grant does not exist,
   * has been revoked, or has expired.
   */
  getGrant(grantId: string): ExpansionGrant | null {
    const grant = this.grants.get(grantId);
    if (!grant) {
      return null;
    }
    if (grant.revoked) {
      return null;
    }
    if (grant.expiresAt.getTime() <= Date.now()) {
      return null;
    }
    return grant;
  }

  /**
   * Revoke a grant, preventing any further use.
   * Returns true if the grant was found and revoked, false if not found.
   */
  revokeGrant(grantId: string): boolean {
    const grant = this.grants.get(grantId);
    if (!grant) {
      return false;
    }
    grant.revoked = true;
    return true;
  }

  /**
   * Validate an expansion request against a grant.
   * Checks existence, expiry, revocation, conversation scope, and summary scope.
   */
  validateExpansion(
    grantId: string,
    request: {
      conversationId: number;
      summaryIds: string[];
      depth: number;
      tokenCap: number;
    },
  ): ValidationResult {
    const grant = this.grants.get(grantId);

    // 1. Grant must exist
    if (!grant) {
      return { valid: false, reason: "Grant not found" };
    }

    // 2. Grant must not be revoked
    if (grant.revoked) {
      return { valid: false, reason: "Grant has been revoked" };
    }

    // 3. Grant must not be expired
    if (grant.expiresAt.getTime() <= Date.now()) {
      return { valid: false, reason: "Grant has expired" };
    }

    // 4. Conversation ID must be in the allowed set
    if (!grant.allowedConversationIds.includes(request.conversationId)) {
      return {
        valid: false,
        reason: `Conversation ${request.conversationId} is not in the allowed set`,
      };
    }

    // 5. If allowedSummaryIds is non-empty, all requested summaryIds must be allowed
    if (grant.allowedSummaryIds.length > 0) {
      const allowedSet = new Set(grant.allowedSummaryIds);
      const unauthorized = request.summaryIds.filter((id) => !allowedSet.has(id));
      if (unauthorized.length > 0) {
        return {
          valid: false,
          reason: `Summary IDs not authorized: ${unauthorized.join(", ")}`,
        };
      }
    }

    return { valid: true };
  }

  /**
   * Remove all expired and revoked grants from the store.
   * Returns the number of grants removed.
   */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;

    for (const [grantId, grant] of this.grants) {
      if (grant.revoked || grant.expiresAt.getTime() <= now) {
        this.grants.delete(grantId);
        removed++;
      }
    }

    return removed;
  }
}

const runtimeExpansionAuthManager = new ExpansionAuthManager();
const delegatedSessionGrantIds = new Map<string, string>();

/**
 * Return the singleton auth manager used by runtime delegated expansion flows.
 */
export function getRuntimeExpansionAuthManager(): ExpansionAuthManager {
  return runtimeExpansionAuthManager;
}

/**
 * Create a delegated expansion grant and bind it to the child session key.
 */
export function createDelegatedExpansionGrant(
  input: CreateDelegatedExpansionGrantInput,
): ExpansionGrant {
  const delegatedSessionKey = input.delegatedSessionKey.trim();
  if (!delegatedSessionKey) {
    throw new Error("delegatedSessionKey is required for delegated expansion grants");
  }

  const grant = runtimeExpansionAuthManager.createGrant({
    issuerSessionId: input.issuerSessionId,
    allowedConversationIds: input.allowedConversationIds,
    allowedSummaryIds: input.allowedSummaryIds,
    maxDepth: input.maxDepth,
    tokenCap: input.tokenCap,
    ttlMs: input.ttlMs,
  });
  delegatedSessionGrantIds.set(delegatedSessionKey, grant.grantId);
  return grant;
}

/**
 * Resolve the delegated expansion grant id bound to a session key.
 */
export function resolveDelegatedExpansionGrantId(sessionKey: string): string | null {
  const key = sessionKey.trim();
  if (!key) {
    return null;
  }
  return delegatedSessionGrantIds.get(key) ?? null;
}

/**
 * Revoke the delegated grant bound to a session key.
 * Optionally remove the binding after revocation.
 */
export function revokeDelegatedExpansionGrantForSession(
  sessionKey: string,
  opts?: { removeBinding?: boolean },
): boolean {
  const key = sessionKey.trim();
  if (!key) {
    return false;
  }
  const grantId = delegatedSessionGrantIds.get(key);
  if (!grantId) {
    return false;
  }
  const didRevoke = runtimeExpansionAuthManager.revokeGrant(grantId);
  if (opts?.removeBinding) {
    delegatedSessionGrantIds.delete(key);
  }
  return didRevoke;
}

/**
 * Remove delegated grant binding for a session key without revoking.
 */
export function removeDelegatedExpansionGrantForSession(sessionKey: string): boolean {
  const key = sessionKey.trim();
  if (!key) {
    return false;
  }
  return delegatedSessionGrantIds.delete(key);
}

/**
 * Test-only reset helper for delegated runtime grants.
 */
export function resetDelegatedExpansionGrantsForTests(): void {
  delegatedSessionGrantIds.clear();
}

// ── Authorized wrapper ───────────────────────────────────────────────────────

/**
 * Create a thin authorization wrapper around an ExpansionOrchestrator.
 * The wrapper validates the grant before delegating to the underlying
 * orchestrator.
 */
export function wrapWithAuth(
  orchestrator: ExpansionOrchestrator,
  authManager: ExpansionAuthManager,
): AuthorizedExpansionOrchestrator {
  return {
    async expand(grantId: string, request: ExpansionRequest): Promise<ExpansionResult> {
      const validation = authManager.validateExpansion(grantId, {
        conversationId: request.conversationId,
        summaryIds: request.summaryIds,
        depth: request.maxDepth ?? DEFAULT_MAX_DEPTH,
        tokenCap: request.tokenCap ?? DEFAULT_TOKEN_CAP,
      });

      if (!validation.valid) {
        throw new Error(`Expansion authorization failed: ${validation.reason}`);
      }
      return orchestrator.expand(request);
    },
  };
}
