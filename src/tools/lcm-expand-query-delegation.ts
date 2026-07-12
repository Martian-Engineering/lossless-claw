import crypto from "node:crypto";
import {
  createDelegatedExpansionGrant,
  revokeDelegatedExpansionGrantForSession,
} from "../expansion-auth.js";
import type { LcmDependencies } from "../types.js";
import { remainingDeadlineMs, type ExpansionDeadline } from "./lcm-expansion-deadline.js";
import { normalizeSummaryIds } from "./lcm-expand-tool.delegation.js";
import {
  clearDelegatedExpansionContext,
  recordExpansionDelegationTelemetry,
  stampDelegatedExpansionContext,
} from "./lcm-expansion-recursion-guard.js";

const GATEWAY_TIMEOUT_MS = 10_000;

export type DelegatedExpandQueryReply = {
  answer: string;
  citedIds: string[];
  expandedSummaryCount: number;
  totalSourceTokens: number;
  truncated: boolean;
};

export type DelegatedFailurePhase = "spawn" | "wait" | "read_reply" | "parse_reply";

export type DelegatedFailureCode =
  | "DELEGATED_EXPANSION_TIMEOUT"
  | "DELEGATED_EXPANSION_SPAWN_FAILED"
  | "DELEGATED_EXPANSION_WAIT_FAILED"
  | "DELEGATED_EXPANSION_REPLY_MISSING"
  | "DELEGATED_EXPANSION_REPLY_INVALID";

export type DelegatedBucketOutcome =
  | {
      status: "success";
      conversationId: number;
      summaryIds: string[];
      elapsedMs: number;
      reply: DelegatedExpandQueryReply;
    }
  | {
      status: "failed";
      conversationId: number;
      summaryIds: string[];
      elapsedMs: number;
      phase: DelegatedFailurePhase;
      code: DelegatedFailureCode;
      error: string;
      timedOut: boolean;
      cleanup: "complete" | "partial";
    };

export type DelegatedConversationBucket = {
  conversationId: number;
  summaryIds: string[];
  messageBackedSummaryIds: string[];
};

type ParsedExpandQueryReply =
  | { ok: true; value: DelegatedExpandQueryReply }
  | { ok: false; error: string };

type RunDelegatedExpandQueryParams = {
  deps: LcmDependencies;
  callerSessionKey: string;
  requesterAgentId: string;
  bucket: DelegatedConversationBucket;
  query?: string;
  prompt: string;
  maxTokens: number;
  tokenCap: number;
  requestId: string;
  childExpansionDepth: number;
  originSessionKey: string;
  deadline: ExpansionDeadline;
  delegatedWaitTimeoutSeconds: number;
};

// Collect nested gateway/provider failure text without exposing object formatting artifacts.
function collectExpansionFailureText(value: unknown, parts: string[], depth = 0): void {
  if (depth > 3 || value == null) {
    return;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) {
      parts.push(trimmed);
    }
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    parts.push(String(value));
    return;
  }
  if (value instanceof Error) {
    if (value.message.trim()) {
      parts.push(value.message.trim());
    }
    collectExpansionFailureText(value.cause, parts, depth + 1);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectExpansionFailureText(entry, parts, depth + 1);
    }
    return;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["message", "error", "reason", "details", "response", "cause", "code"]) {
      collectExpansionFailureText(record[key], parts, depth + 1);
    }
  }
}

/** Convert gateway and provider failures to the existing human-readable error text. */
export function formatExpansionFailure(error: unknown): string {
  const parts: string[] = [];
  collectExpansionFailureText(error, parts);
  const message = parts.join(" ").replace(/\s+/g, " ").trim();
  if (message) {
    return message;
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return "Delegated expansion query failed.";
}

// Retry only override/auth/model-selection failures that can succeed on the default route.
function shouldRetryWithoutOverride(message: string): boolean {
  const normalized = message.toLowerCase();
  return [
    "model.request",
    "missing scopes",
    "insufficient scope",
    "unauthorized",
    "not authorized",
    "forbidden",
    "provider/model overrides are not authorized",
    "model override is not authorized",
    "not allowed for agent",
    "not allowlisted for plugin",
    "unknown model",
    "model not found",
    "invalid model",
    "not available",
    "not supported",
    "401",
    "403",
  ].some((signal) => normalized.includes(signal));
}

// Map the phase model to the stable public failure code.
function delegatedFailureCode(
  phase: DelegatedFailurePhase,
  timedOut: boolean,
): DelegatedFailureCode {
  if (timedOut) {
    return "DELEGATED_EXPANSION_TIMEOUT";
  }
  switch (phase) {
    case "spawn":
      return "DELEGATED_EXPANSION_SPAWN_FAILED";
    case "wait":
      return "DELEGATED_EXPANSION_WAIT_FAILED";
    case "read_reply":
      return "DELEGATED_EXPANSION_REPLY_MISSING";
    case "parse_reply":
      return "DELEGATED_EXPANSION_REPLY_INVALID";
  }
}

// Build the child task with explicit scope, budgets, and a machine-readable response contract.
function buildDelegatedExpandQueryTask(params: {
  summaryIds: string[];
  messageBackedSummaryIds: string[];
  conversationId: number;
  query?: string;
  prompt: string;
  maxTokens: number;
  tokenCap: number;
  requestId: string;
  expansionDepth: number;
  originSessionKey: string;
}) {
  const seedSummaryIds = params.summaryIds.length > 0 ? params.summaryIds.join(", ") : "(none)";
  const messageBackedSummaryIds =
    params.messageBackedSummaryIds.length > 0
      ? params.messageBackedSummaryIds.join(", ")
      : "(none)";
  return [
    "You are an autonomous LCM retrieval navigator. Plan and execute retrieval before answering.",
    "",
    "Available tools: lcm_describe, lcm_expand, lcm_grep",
    `Conversation scope: ${params.conversationId}`,
    `Expansion token budget (total across this run): ${params.tokenCap}`,
    `Seed summary IDs: ${seedSummaryIds}`,
    `Seed summaries requiring raw message expansion: ${messageBackedSummaryIds}`,
    params.query ? `Routing query: ${params.query}` : undefined,
    "",
    "Strategy:",
    "1. Start with `lcm_describe` on seed summaries to inspect subtree manifests and branch costs.",
    "2. If additional candidates are needed, use `lcm_grep` scoped to summaries. Prefer `mode: \"full_text\"` for short literal terms, use `mode: \"regex\"` for alternation or other regex syntax, quote exact multi-word phrases, use `sort: \"relevance\"` for older-topic recall, and `sort: \"hybrid\"` when recency should still matter.",
    "3. Select branches that fit remaining budget; prefer high-signal paths first.",
    "4. Call `lcm_expand` selectively (do not expand everything blindly).",
    "5. Keep includeMessages=false by default; use includeMessages=true for the message-backed seed summaries above and any other specific leaf evidence.",
    `6. Stay within ${params.tokenCap} total expansion tokens across all lcm_expand calls.`,
    "",
    "User prompt to answer:",
    params.prompt,
    "",
    "Delegated expansion metadata (for tracing):",
    `- requestId: ${params.requestId}`,
    `- expansionDepth: ${params.expansionDepth}`,
    `- originSessionKey: ${params.originSessionKey}`,
    "",
    "Return ONLY JSON with this shape:",
    "{",
    '  "answer": "string",',
    '  "citedIds": ["sum_xxx"],',
    '  "expandedSummaryCount": 0,',
    '  "totalSourceTokens": 0,',
    '  "truncated": false',
    "}",
    "",
    "Rules:",
    "- In delegated context, call `lcm_expand` directly for source retrieval.",
    "- DO NOT call `lcm_expand_query` from this delegated session.",
    "- Synthesize the final answer from retrieved evidence, not assumptions.",
    `- Keep answer concise and focused (target <= ${params.maxTokens} tokens).`,
    "- citedIds must be unique summary IDs.",
    "- expandedSummaryCount should reflect how many summaries were expanded/used.",
    "- totalSourceTokens should estimate the total source tokens consumed for retrieval. Include both: (a) the `totalTokens` returned by each `lcm_expand` call you made, AND (b) for any explicit leaf summary used as evidence, the leaf summary's own `tok` value from `lcm_describe`, even if you did not call `lcm_expand` for that leaf. This avoids reporting `totalSourceTokens: 0` when the answer was actually derived from a leaf summary's content.",
    "- truncated should indicate whether source expansion appears truncated.",
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}

// Format a bounded reply excerpt for parse failures.
function formatInvalidDelegatedReply(reply: string, reason: string): string {
  const compact = reply.replace(/\s+/g, " ").trim();
  const snippet = compact.length <= 240 ? compact : `${compact.slice(0, 240)}...`;
  return `Delegated expansion query returned ${reason}: ${snippet}`;
}

// Validate the untrusted child reply before using it in the public tool result.
function parseDelegatedExpandQueryReply(
  rawReply: string,
  fallbackExpandedSummaryCount: number,
): ParsedExpandQueryReply {
  const reply = rawReply.trim();
  const candidates: string[] = [reply];
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    candidates.unshift(fenced[1].trim());
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as {
        answer?: unknown;
        citedIds?: unknown;
        expandedSummaryCount?: unknown;
        totalSourceTokens?: unknown;
        truncated?: unknown;
      };
      const answer = typeof parsed.answer === "string" ? parsed.answer.trim() : "";
      if (!answer) {
        return {
          ok: false,
          error: formatInvalidDelegatedReply(reply, 'JSON without a non-empty "answer"'),
        };
      }
      const citedIds = normalizeSummaryIds(
        Array.isArray(parsed.citedIds)
          ? parsed.citedIds.filter((value): value is string => typeof value === "string")
          : undefined,
      );
      const expandedSummaryCount =
        typeof parsed.expandedSummaryCount === "number" &&
        Number.isFinite(parsed.expandedSummaryCount)
          ? Math.max(0, Math.floor(parsed.expandedSummaryCount))
          : fallbackExpandedSummaryCount;
      const totalSourceTokens =
        typeof parsed.totalSourceTokens === "number" && Number.isFinite(parsed.totalSourceTokens)
          ? Math.max(0, Math.floor(parsed.totalSourceTokens))
          : 0;
      return {
        ok: true,
        value: {
          answer,
          citedIds,
          expandedSummaryCount,
          totalSourceTokens,
          truncated: parsed.truncated === true,
        },
      };
    } catch {
      // Try the next plain or fenced JSON candidate.
    }
  }
  return {
    ok: false,
    error: formatInvalidDelegatedReply(reply, "non-JSON output"),
  };
}

// Run one child session, classify its terminal state, and finish owned cleanup.
async function runDelegatedQueryAttempt(
  params: RunDelegatedExpandQueryParams & { task: string; provider?: string; model?: string },
): Promise<DelegatedBucketOutcome> {
  const attemptStartedAtMs = performance.now();
  const childSessionKey = `agent:${params.requesterAgentId}:subagent:${crypto.randomUUID()}`;
  const childIdem = crypto.randomUUID();
  let grantCreated = false;
  let runId = "";
  let phase: DelegatedFailurePhase = "spawn";
  let timedOut = false;
  let sessionCleanupComplete = false;
  let outcome: DelegatedBucketOutcome;

  try {
    // Refuse new child work after candidate resolution has consumed the work budget.
    if (remainingDeadlineMs(params.deadline.workDeadlineMs, performance.now()) <= 0) {
      phase = "wait";
      timedOut = true;
      throw new Error(
        `lcm_expand_query timed out waiting for delegated expansion (${params.delegatedWaitTimeoutSeconds}s).`,
      );
    }

    // Bind the temporary child to this bucket and the preallocated token cap.
    createDelegatedExpansionGrant({
      delegatedSessionKey: childSessionKey,
      issuerSessionId: params.callerSessionKey || "main",
      allowedConversationIds: [params.bucket.conversationId],
      tokenCap: params.tokenCap,
      ttlMs: Math.max(
        1,
        remainingDeadlineMs(params.deadline.totalDeadlineMs, performance.now()),
      ),
    });
    stampDelegatedExpansionContext({
      sessionKey: childSessionKey,
      requestId: params.requestId,
      expansionDepth: params.childExpansionDepth,
      originSessionKey: params.originSessionKey,
      stampedBy: "lcm_expand_query",
    });
    grantCreated = true;

    // Spawn and wait consume the same absolute work deadline.
    const spawnTimeoutMs = Math.max(
      1,
      Math.min(
        GATEWAY_TIMEOUT_MS,
        remainingDeadlineMs(params.deadline.workDeadlineMs, performance.now()),
      ),
    );
    const response = (await params.deps.callGateway({
      method: "agent",
      params: {
        message: params.task,
        sessionKey: childSessionKey,
        deliver: false,
        lane: params.deps.agentLaneSubagent,
        idempotencyKey: childIdem,
        ...(params.provider ? { provider: params.provider } : {}),
        ...(params.model ? { model: params.model } : {}),
        extraSystemPrompt: params.deps.buildSubagentSystemPrompt({
          depth: 1,
          maxDepth: 8,
          taskSummary: "Run lcm_expand and return prompt-focused JSON answer",
        }),
      },
      timeoutMs: spawnTimeoutMs,
    })) as { runId?: unknown; error?: unknown };

    runId = typeof response?.runId === "string" ? response.runId.trim() : "";
    if (!runId) {
      throw new Error(
        response?.error == null
          ? "Delegated expansion did not return a runId."
          : formatExpansionFailure(response.error),
      );
    }

    phase = "wait";
    const waitTimeoutMs = Math.max(
      1,
      remainingDeadlineMs(params.deadline.workDeadlineMs, performance.now()),
    );
    const wait = (await params.deps.callGateway({
      method: "agent.wait",
      params: { runId, timeoutMs: waitTimeoutMs },
      timeoutMs: waitTimeoutMs,
    })) as { status?: string; error?: unknown };
    const status = typeof wait?.status === "string" ? wait.status : "error";
    if (status === "timeout") {
      timedOut = true;
      recordExpansionDelegationTelemetry({
        deps: params.deps,
        component: "lcm_expand_query",
        event: "timeout",
        requestId: params.requestId,
        sessionKey: params.callerSessionKey,
        expansionDepth: params.childExpansionDepth,
        originSessionKey: params.originSessionKey,
        runId,
      });
      throw new Error(
        `lcm_expand_query timed out waiting for delegated expansion (${params.delegatedWaitTimeoutSeconds}s).`,
      );
    }
    if (status !== "ok") {
      throw new Error(formatExpansionFailure(wait?.error));
    }

    // Read and validate the terminal child reply before treating the bucket as evidence.
    const replyTimeoutMs = remainingDeadlineMs(
      params.deadline.workDeadlineMs,
      performance.now(),
    );
    if (replyTimeoutMs <= 0) {
      timedOut = true;
      throw new Error(
        `lcm_expand_query timed out waiting for delegated expansion (${params.delegatedWaitTimeoutSeconds}s).`,
      );
    }
    phase = "read_reply";
    const replyPayload = (await params.deps.callGateway({
      method: "sessions.get",
      params: { key: childSessionKey, limit: 80 },
      timeoutMs: Math.min(GATEWAY_TIMEOUT_MS, replyTimeoutMs),
    })) as { messages?: unknown[] };
    const reply = params.deps.readLatestAssistantReply(
      Array.isArray(replyPayload.messages) ? replyPayload.messages : [],
    );
    if (!reply?.trim()) {
      throw new Error("Delegated expansion query returned an empty reply.");
    }
    phase = "parse_reply";
    const parsed = parseDelegatedExpandQueryReply(reply, params.bucket.summaryIds.length);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    recordExpansionDelegationTelemetry({
      deps: params.deps,
      component: "lcm_expand_query",
      event: "success",
      requestId: params.requestId,
      sessionKey: params.callerSessionKey,
      expansionDepth: params.childExpansionDepth,
      originSessionKey: params.originSessionKey,
      runId,
    });
    outcome = {
      status: "success",
      conversationId: params.bucket.conversationId,
      summaryIds: params.bucket.summaryIds,
      elapsedMs: 0,
      reply: parsed.value,
    };
  } catch (error) {
    // Expected gateway and reply failures become typed outcomes for public accounting.
    outcome = {
      status: "failed",
      conversationId: params.bucket.conversationId,
      summaryIds: params.bucket.summaryIds,
      elapsedMs: 0,
      phase,
      code: delegatedFailureCode(phase, timedOut),
      error: formatExpansionFailure(error),
      timedOut,
      cleanup: "partial",
    };
  } finally {
    // The host-owned deletion path cancels active child work before removing its session.
    // Cleanup may use only the headroom left before the total tool deadline.
    const cleanupTimeoutMs = remainingDeadlineMs(
      params.deadline.totalDeadlineMs,
      performance.now(),
    );
    if (!grantCreated) {
      sessionCleanupComplete = true;
    } else if (cleanupTimeoutMs > 0) {
      try {
        await params.deps.callGateway({
          method: "sessions.delete",
          params: { key: childSessionKey, deleteTranscript: true },
          timeoutMs: Math.min(GATEWAY_TIMEOUT_MS, cleanupTimeoutMs),
        });
        sessionCleanupComplete = true;
      } catch {
        // Cleanup is best-effort.
      }
    }
    if (grantCreated) {
      revokeDelegatedExpansionGrantForSession(childSessionKey, { removeBinding: true });
    }
    clearDelegatedExpansionContext(childSessionKey);
  }

  const elapsedMs = Math.max(0, Math.floor(performance.now() - attemptStartedAtMs));
  if (outcome.status === "success") {
    return { ...outcome, elapsedMs };
  }
  return {
    ...outcome,
    elapsedMs,
    cleanup: sessionCleanupComplete ? "complete" : "partial",
  };
}

/** Run one delegated expansion bucket, including authorized override fallback. */
export async function runDelegatedExpandQuery(
  params: RunDelegatedExpandQueryParams,
): Promise<DelegatedBucketOutcome> {
  const task = buildDelegatedExpandQueryTask({
    summaryIds: params.bucket.summaryIds,
    messageBackedSummaryIds: params.bucket.messageBackedSummaryIds,
    conversationId: params.bucket.conversationId,
    query: params.query,
    prompt: params.prompt,
    maxTokens: params.maxTokens,
    tokenCap: params.tokenCap,
    requestId: params.requestId,
    expansionDepth: params.childExpansionDepth,
    originSessionKey: params.originSessionKey,
  });
  const expansionProvider = params.deps.config.expansionProvider || undefined;
  const expansionModel = params.deps.config.expansionModel || undefined;
  const canonicalExpansionModel = expansionModel?.includes("/") ? expansionModel : undefined;
  const overrideProvider = canonicalExpansionModel ? undefined : expansionProvider;
  const overrideModel = canonicalExpansionModel || expansionModel;
  if (!expansionProvider && !expansionModel) {
    return await runDelegatedQueryAttempt({ ...params, task });
  }

  const outcome = await runDelegatedQueryAttempt({
    ...params,
    task,
    provider: overrideProvider,
    model: overrideModel,
  });
  if (outcome.status === "success") {
    return outcome;
  }
  const overrideLabel =
    overrideProvider && overrideModel
      ? `${overrideProvider}/${overrideModel}`
      : overrideModel || overrideProvider || "configured override";
  params.deps.log.warn(
    `[lcm] delegated expansion override failed (${overrideLabel}) for conversation ${params.bucket.conversationId}: ${outcome.error}`,
  );
  if (!shouldRetryWithoutOverride(outcome.error)) {
    return outcome;
  }
  params.deps.log.warn(
    `[lcm] retrying delegated expansion without provider/model override after: ${outcome.error}`,
  );
  return await runDelegatedQueryAttempt({ ...params, task });
}
