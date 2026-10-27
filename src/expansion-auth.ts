import { DatabaseSync } from "node:sqlite";
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
/** Expired grants stay inspectable briefly so late callers still see "expired". */
const EXPIRED_GRANT_RETENTION_MS = 60 * 60 * 1000;

// ── Storage ──────────────────────────────────────────────────────────────────

type GrantRow = {
  grant_id: string;
  issuer_session_id: string;
  allowed_conversation_ids: string;
  allowed_summary_ids: string;
  max_depth: number;
  token_cap: number;
  consumed_tokens: number;
  expires_at_ms: number;
  revoked: number;
  created_at_ms: number;
};

/**
 * Create the grant tables when missing.
 *
 * Grants and their child-session bindings live in SQLite so a delegated child
 * keeps its authorization when a plugin reload hands its turn to a new plugin
 * generation, which loads a fresh copy of this module.
 */
export function ensureExpansionGrantTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lcm_expansion_grants (
      grant_id TEXT PRIMARY KEY,
      issuer_session_id TEXT NOT NULL,
      allowed_conversation_ids TEXT NOT NULL,
      allowed_summary_ids TEXT NOT NULL,
      max_depth INTEGER NOT NULL,
      token_cap INTEGER NOT NULL,
      consumed_tokens INTEGER NOT NULL DEFAULT 0,
      expires_at_ms INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lcm_expansion_grant_bindings (
      session_key TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL
    );
  `);
}

// Rebuild the public grant shape from one stored row.
function toGrant(row: GrantRow): ExpansionGrant {
  return {
    grantId: row.grant_id,
    issuerSessionId: row.issuer_session_id,
    allowedConversationIds: JSON.parse(row.allowed_conversation_ids) as number[],
    allowedSummaryIds: JSON.parse(row.allowed_summary_ids) as string[],
    maxDepth: row.max_depth,
    tokenCap: row.token_cap,
    expiresAt: new Date(row.expires_at_ms),
    revoked: row.revoked === 1,
    createdAt: new Date(row.created_at_ms),
  };
}

// ── ExpansionAuthManager ─────────────────────────────────────────────────────

/**
 * Issue, validate, and meter expansion grants.
 *
 * Grants are stored in the given SQLite database. Without one, the manager
 * uses a private in-memory database, which suits unit tests and callers that
 * never share grants across plugin generations.
 */
export class ExpansionAuthManager {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync = new DatabaseSync(":memory:")) {
    this.db = db;
    ensureExpansionGrantTables(db);
  }

  /** True when this manager stores grants in the given database. */
  usesDatabase(db: DatabaseSync): boolean {
    return this.db === db;
  }

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

    this.pruneLongExpired(now.getTime());
    this.db
      .prepare(
        `INSERT INTO lcm_expansion_grants (
           grant_id, issuer_session_id, allowed_conversation_ids, allowed_summary_ids,
           max_depth, token_cap, consumed_tokens, expires_at_ms, revoked, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, ?)`,
      )
      .run(
        grant.grantId,
        grant.issuerSessionId,
        JSON.stringify(grant.allowedConversationIds),
        JSON.stringify(grant.allowedSummaryIds),
        grant.maxDepth,
        grant.tokenCap,
        grant.expiresAt.getTime(),
        grant.createdAt.getTime(),
      );
    return grant;
  }

  // Read one stored grant regardless of revocation or expiry.
  private readGrant(grantId: string): ExpansionGrant | null {
    const row = this.db
      .prepare(`SELECT * FROM lcm_expansion_grants WHERE grant_id = ?`)
      .get(grantId) as GrantRow | undefined;
    return row ? toGrant(row) : null;
  }

  // Drop grants (and their bindings) that expired well before now. These are
  // short-lived authorization tokens, not conversation data.
  private pruneLongExpired(nowMs: number): void {
    const cutoff = nowMs - EXPIRED_GRANT_RETENTION_MS;
    this.db.prepare(`DELETE FROM lcm_expansion_grants WHERE expires_at_ms <= ?`).run(cutoff);
    this.db
      .prepare(
        `DELETE FROM lcm_expansion_grant_bindings
         WHERE grant_id NOT IN (SELECT grant_id FROM lcm_expansion_grants)`,
      )
      .run();
  }

  /**
   * Retrieve a grant by ID. Returns null if the grant does not exist,
   * has been revoked, or has expired.
   */
  getGrant(grantId: string): ExpansionGrant | null {
    const grant = this.readGrant(grantId);
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
    const result = this.db
      .prepare(`UPDATE lcm_expansion_grants SET revoked = 1 WHERE grant_id = ?`)
      .run(grantId);
    return Number(result.changes) > 0;
  }

  /**
   * Resolve remaining token budget for an active grant.
   */
  getRemainingTokenBudget(grantId: string): number | null {
    const grant = this.getGrant(grantId);
    if (!grant) {
      return null;
    }
    const row = this.db
      .prepare(`SELECT consumed_tokens FROM lcm_expansion_grants WHERE grant_id = ?`)
      .get(grantId) as { consumed_tokens: number } | undefined;
    const consumed = Math.max(0, row?.consumed_tokens ?? 0);
    return Math.max(0, Math.floor(grant.tokenCap) - consumed);
  }

  /**
   * Consume token budget for a grant, clamped to the grant token cap.
   */
  consumeTokenBudget(grantId: string, consumedTokens: number): number | null {
    const grant = this.getGrant(grantId);
    if (!grant) {
      return null;
    }
    const safeConsumed =
      typeof consumedTokens === "number" && Number.isFinite(consumedTokens)
        ? Math.max(0, Math.floor(consumedTokens))
        : 0;
    // One statement keeps the read-add-clamp atomic for concurrent consumers.
    this.db
      .prepare(
        `UPDATE lcm_expansion_grants
         SET consumed_tokens = MIN(?, MAX(0, consumed_tokens) + ?)
         WHERE grant_id = ?`,
      )
      .run(Math.max(1, Math.floor(grant.tokenCap)), safeConsumed, grantId);
    return this.getRemainingTokenBudget(grantId);
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
    const grant = this.readGrant(grantId);

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

    // 6. Depth and tokenCap are enforced via clamping in wrapWithAuth, not
    // rejected here. This allows callers to request more than the grant
    // permits — the values will be clamped to the grant limits at execution time.

    return { valid: true };
  }

  /**
   * Remove all expired and revoked grants from the store.
   * Returns the number of grants removed.
   */
  cleanup(): number {
    const result = this.db
      .prepare(`DELETE FROM lcm_expansion_grants WHERE revoked = 1 OR expires_at_ms <= ?`)
      .run(Date.now());
    return Number(result.changes);
  }

  /** Bind a delegated child session key to its grant, replacing any earlier binding. */
  bindSession(sessionKey: string, grantId: string): void {
    this.db
      .prepare(
        `INSERT INTO lcm_expansion_grant_bindings (session_key, grant_id) VALUES (?, ?)
         ON CONFLICT(session_key) DO UPDATE SET grant_id = excluded.grant_id`,
      )
      .run(sessionKey, grantId);
  }

  /** Resolve the grant id bound to a delegated child session key. */
  resolveSessionGrantId(sessionKey: string): string | null {
    const row = this.db
      .prepare(`SELECT grant_id FROM lcm_expansion_grant_bindings WHERE session_key = ?`)
      .get(sessionKey) as { grant_id: string } | undefined;
    return row?.grant_id ?? null;
  }

  /** Remove a session binding. Returns true when one existed. */
  removeSessionBinding(sessionKey: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM lcm_expansion_grant_bindings WHERE session_key = ?`)
      .run(sessionKey);
    return Number(result.changes) > 0;
  }

  /** Remove every session binding. */
  clearSessionBindings(): void {
    this.db.exec(`DELETE FROM lcm_expansion_grant_bindings`);
  }
}

let runtimeExpansionAuthManager = new ExpansionAuthManager();

/**
 * Return the singleton auth manager used by runtime delegated expansion flows.
 */
export function getRuntimeExpansionAuthManager(): ExpansionAuthManager {
  return runtimeExpansionAuthManager;
}

/**
 * Store runtime grants in the plugin database so they outlive this module.
 *
 * Returns an unbind function. Unbinding restores a private in-memory store,
 * but only while this database is still the bound one.
 */
export function bindRuntimeExpansionGrantDatabase(db: DatabaseSync): () => void {
  runtimeExpansionAuthManager = new ExpansionAuthManager(db);
  return () => {
    if (runtimeExpansionAuthManager.usesDatabase(db)) {
      runtimeExpansionAuthManager = new ExpansionAuthManager();
    }
  };
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
  runtimeExpansionAuthManager.bindSession(delegatedSessionKey, grant.grantId);
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
  return runtimeExpansionAuthManager.resolveSessionGrantId(key);
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
  const grantId = runtimeExpansionAuthManager.resolveSessionGrantId(key);
  if (!grantId) {
    return false;
  }
  const didRevoke = runtimeExpansionAuthManager.revokeGrant(grantId);
  if (opts?.removeBinding) {
    runtimeExpansionAuthManager.removeSessionBinding(key);
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
  return runtimeExpansionAuthManager.removeSessionBinding(key);
}

/**
 * Test-only reset helper for delegated runtime grants.
 */
export function resetDelegatedExpansionGrantsForTests(): void {
  runtimeExpansionAuthManager.clearSessionBindings();
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

      const remainingBudget = authManager.getRemainingTokenBudget(grantId);
      if (remainingBudget == null) {
        throw new Error("Expansion authorization failed: Grant not found");
      }
      if (remainingBudget <= 0) {
        throw new Error("Expansion authorization failed: Grant token budget exhausted");
      }

      // Clamp depth to grant maxDepth
      const grant = authManager.getGrant(grantId);
      const grantMaxDepth = grant?.maxDepth ?? DEFAULT_MAX_DEPTH;
      const requestedDepth =
        typeof request.maxDepth === "number" && Number.isFinite(request.maxDepth)
          ? Math.max(1, Math.trunc(request.maxDepth))
          : grantMaxDepth;
      const effectiveDepth = Math.min(requestedDepth, grantMaxDepth);

      const requestedTokenCap =
        typeof request.tokenCap === "number" && Number.isFinite(request.tokenCap)
          ? Math.max(1, Math.trunc(request.tokenCap))
          : remainingBudget;
      const effectiveTokenCap = Math.max(1, Math.min(requestedTokenCap, remainingBudget));
      const result = await orchestrator.expand({
        ...request,
        maxDepth: effectiveDepth,
        tokenCap: effectiveTokenCap,
      });
      authManager.consumeTokenBudget(grantId, result.totalTokens);
      return result;
    },
  };
}
