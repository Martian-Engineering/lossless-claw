import crypto from "node:crypto";
import { resolveDelegatedExpansionGrantId } from "../expansion-auth.js";
import type { LcmDependencies } from "../types.js";

export const EXPANSION_RECURSION_ERROR_CODE = "EXPANSION_RECURSION_BLOCKED";
const EXPANSION_DELEGATION_DEPTH_CAP = 1;

type TelemetryEvent = "start" | "block" | "timeout" | "success";

const telemetryCounters: Record<TelemetryEvent, number> = {
  start: 0,
  block: 0,
  timeout: 0,
  success: 0,
};

export type DelegatedExpansionContext = {
  requestId: string;
  expansionDepth: number;
  originSessionKey: string;
  stampedBy: string;
  createdAt: string;
};

export type ExpansionRecursionBlockReason = "depth_cap" | "idempotent_reentry";

export type ExpansionRecursionGuardDecision =
  | {
      blocked: false;
      requestId: string;
      expansionDepth: number;
      originSessionKey: string;
    }
  | {
      blocked: true;
      code: typeof EXPANSION_RECURSION_ERROR_CODE;
      reason: ExpansionRecursionBlockReason;
      message: string;
      requestId: string;
      expansionDepth: number;
      originSessionKey: string;
    };

const delegatedContextBySessionKey = new Map<string, DelegatedExpansionContext>();
const blockedRequestIdsBySessionKey = new Map<string, Set<string>>();

function normalizeSessionKey(sessionKey?: string): string {
  return typeof sessionKey === "string" ? sessionKey.trim() : "";
}

function getOrInitBlockedRequestIds(sessionKey: string): Set<string> {
  const existing = blockedRequestIdsBySessionKey.get(sessionKey);
  if (existing) {
    return existing;
  }
  const created = new Set<string>();
  blockedRequestIdsBySessionKey.set(sessionKey, created);
  return created;
}

function resolveFallbackDelegatedContext(
  sessionKey: string,
  requestId: string,
): DelegatedExpansionContext | undefined {
  if (!sessionKey) {
    return undefined;
  }
  const grantId = resolveDelegatedExpansionGrantId(sessionKey);
  if (!grantId) {
    return undefined;
  }
  return {
    requestId,
    expansionDepth: EXPANSION_DELEGATION_DEPTH_CAP,
    originSessionKey: sessionKey,
    stampedBy: "delegated_grant",
    createdAt: new Date().toISOString(),
  };
}

/**
 * Build actionable recovery guidance for recursion-blocked delegated calls.
 */
function buildExpansionRecursionRecoveryGuidance(originSessionKey: string): string {
  return (
    "Recovery: In delegated sub-agent sessions, call `lcm_expand` directly and synthesize " +
    "your answer from that result. Do NOT call `lcm_expand_query` from delegated context. " +
    `If deeper delegation is required, return to the origin session (${originSessionKey}) ` +
    "and call `lcm_expand_query` there."
  );
}

/**
 * Create a stable request identifier for delegated expansion orchestration.
 */
export function createExpansionRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Resolve the active expansion request id for a session, inheriting from any
 * stamped delegated context when present.
 */
export function resolveExpansionRequestId(sessionKey?: string): string {
  const key = normalizeSessionKey(sessionKey);
  return delegatedContextBySessionKey.get(key)?.requestId ?? createExpansionRequestId();
}

/**
 * Resolve the next delegated expansion depth to stamp onto a child session.
 */
export function resolveNextExpansionDepth(sessionKey?: string): number {
  const key = normalizeSessionKey(sessionKey);
  if (!key) {
    return 1;
  }
  const existing = delegatedContextBySessionKey.get(key);
  if (existing) {
    return existing.expansionDepth + 1;
  }
  return resolveDelegatedExpansionGrantId(key) ? EXPANSION_DELEGATION_DEPTH_CAP + 1 : 1;
}

/**
 * Stamp delegated expansion metadata for a child session so re-entry checks can
 * enforce recursion and depth policies deterministically.
 */
export function stampDelegatedExpansionContext(params: {
  sessionKey: string;
  requestId: string;
  expansionDepth: number;
  originSessionKey: string;
  stampedBy: string;
}): DelegatedExpansionContext {
  const sessionKey = normalizeSessionKey(params.sessionKey);
  const context: DelegatedExpansionContext = {
    requestId: params.requestId,
    expansionDepth: Math.max(0, Math.trunc(params.expansionDepth)),
    originSessionKey: params.originSessionKey.trim() || "main",
    stampedBy: params.stampedBy,
    createdAt: new Date().toISOString(),
  };
  if (sessionKey) {
    delegatedContextBySessionKey.set(sessionKey, context);
  }
  return context;
}

/**
 * Remove delegated expansion metadata for a child session after cleanup.
 */
export function clearDelegatedExpansionContext(sessionKey: string): void {
  const key = normalizeSessionKey(sessionKey);
  if (!key) {
    return;
  }
  delegatedContextBySessionKey.delete(key);
  blockedRequestIdsBySessionKey.delete(key);
}

/**
 * Evaluate whether a session is allowed to delegate expansion work.
 * Delegated contexts are blocked at depth >= 1, with repeated request id
 * re-entry mapped to an explicit idempotency block reason.
 */
export function evaluateExpansionRecursionGuard(params: {
  sessionKey?: string;
  requestId: string;
}): ExpansionRecursionGuardDecision {
  const sessionKey = normalizeSessionKey(params.sessionKey);
  const requestId = params.requestId.trim();
  const delegatedContext =
    delegatedContextBySessionKey.get(sessionKey) ??
    resolveFallbackDelegatedContext(sessionKey, requestId || createExpansionRequestId());

  if (!delegatedContext) {
    return {
      blocked: false,
      requestId,
      expansionDepth: 0,
      originSessionKey: sessionKey || "main",
    };
  }

  if (delegatedContext.expansionDepth < EXPANSION_DELEGATION_DEPTH_CAP) {
    return {
      blocked: false,
      requestId,
      expansionDepth: delegatedContext.expansionDepth,
      originSessionKey: delegatedContext.originSessionKey,
    };
  }

  const seenRequestIds = getOrInitBlockedRequestIds(sessionKey);
  const isIdempotentReentry = seenRequestIds.has(requestId);
  seenRequestIds.add(requestId);
  const reason: ExpansionRecursionBlockReason = isIdempotentReentry
    ? "idempotent_reentry"
    : "depth_cap";

  return {
    blocked: true,
    code: EXPANSION_RECURSION_ERROR_CODE,
    reason,
    message:
      `${EXPANSION_RECURSION_ERROR_CODE}: Expansion delegation blocked at depth ` +
      `${delegatedContext.expansionDepth} (${reason}; requestId=${requestId}; ` +
      `origin=${delegatedContext.originSessionKey}). ` +
      buildExpansionRecursionRecoveryGuidance(delegatedContext.originSessionKey),
    requestId,
    expansionDepth: delegatedContext.expansionDepth,
    originSessionKey: delegatedContext.originSessionKey,
  };
}

/**
 * Emit structured delegated expansion telemetry with monotonic counters.
 */
export function recordExpansionDelegationTelemetry(params: {
  deps: Pick<LcmDependencies, "log">;
  component: string;
  event: TelemetryEvent;
  requestId: string;
  sessionKey?: string;
  expansionDepth: number;
  originSessionKey: string;
  reason?: string;
  runId?: string;
}): void {
  telemetryCounters[params.event] += 1;
  const payload = {
    component: params.component,
    event: params.event,
    requestId: params.requestId,
    sessionKey: normalizeSessionKey(params.sessionKey) || undefined,
    expansionDepth: params.expansionDepth,
    originSessionKey: params.originSessionKey,
    reason: params.reason,
    runId: params.runId,
    counters: {
      start: telemetryCounters.start,
      block: telemetryCounters.block,
      timeout: telemetryCounters.timeout,
      success: telemetryCounters.success,
    },
  };
  const line = `[lcm][expansion_delegation] ${JSON.stringify(payload)}`;
  if (params.event === "start" || params.event === "success") {
    params.deps.log.info(line);
    return;
  }
  params.deps.log.warn(line);
}

/**
 * Return the currently stamped delegated expansion context for test assertions.
 */
export function getDelegatedExpansionContextForTests(
  sessionKey: string,
): DelegatedExpansionContext | undefined {
  return delegatedContextBySessionKey.get(normalizeSessionKey(sessionKey));
}

/**
 * Return the delegated expansion telemetry counters for tests.
 */
export function getExpansionDelegationTelemetrySnapshotForTests(): Record<TelemetryEvent, number> {
  return {
    start: telemetryCounters.start,
    block: telemetryCounters.block,
    timeout: telemetryCounters.timeout,
    success: telemetryCounters.success,
  };
}

/**
 * Reset delegated expansion context and telemetry state between tests.
 */
export function resetExpansionDelegationGuardForTests(): void {
  delegatedContextBySessionKey.clear();
  blockedRequestIdsBySessionKey.clear();
  telemetryCounters.start = 0;
  telemetryCounters.block = 0;
  telemetryCounters.timeout = 0;
  telemetryCounters.success = 0;
}
