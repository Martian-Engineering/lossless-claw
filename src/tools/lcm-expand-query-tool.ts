import { Type } from "@sinclair/typebox";
import crypto from "node:crypto";
import type { LcmContextEngine } from "../engine.js";
import {
  createDelegatedExpansionGrant,
  revokeDelegatedExpansionGrantForSession,
} from "../expansion-auth.js";
import type { LcmDependencies } from "../types.js";
import { jsonResult, type AnyAgentTool } from "./common.js";
import { resolveLcmConversationScope } from "./lcm-conversation-scope.js";
import {
  normalizeSummaryIds,
  resolveRequesterConversationScopeId,
} from "./lcm-expand-tool.delegation.js";
import {
  acquireExpansionConcurrencySlot,
  clearDelegatedExpansionContext,
  evaluateExpansionRecursionGuard,
  recordExpansionDelegationTelemetry,
  releaseExpansionConcurrencySlot,
  resolveExpansionRequestId,
  resolveNextExpansionDepth,
  stampDelegatedExpansionContext,
} from "./lcm-expansion-recursion-guard.js";

const DEFAULT_DELEGATED_WAIT_TIMEOUT_MS = 120_000;
const GATEWAY_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ANSWER_TOKENS = 2_000;
const DEFAULT_MAX_CONVERSATION_BUCKETS = 3;

const LcmExpandQuerySchema = Type.Object({
  summaryIds: Type.Optional(
    Type.Array(Type.String(), {
      description: "Summary IDs to expand (sum_xxx). Required when query is not provided.",
    }),
  ),
  query: Type.Optional(
    Type.String({
      description:
        "FTS5 query used to find summaries via the same full-text search path as lcm_grep before expansion. Use 1-3 distinctive terms or a quoted phrase; FTS5 defaults to AND matching, so extra terms make matches stricter. Required when summaryIds is not provided.",
    }),
  ),
  prompt: Type.String({
    description:
      "Natural-language question or task to answer using expanded context. Put the answer request here, not in query.",
  }),
  conversationId: Type.Optional(
    Type.Number({
      description:
        "Conversation ID to scope expansion to. If omitted, uses the current session conversation.",
    }),
  ),
  allConversations: Type.Optional(
    Type.Boolean({
      description:
        "Set true to explicitly allow cross-conversation lookup. Ignored when conversationId is provided.",
    }),
  ),
  maxTokens: Type.Optional(
    Type.Number({
      description: `Maximum answer tokens to target (default: ${DEFAULT_MAX_ANSWER_TOKENS}).`,
      minimum: 1,
    }),
  ),
  tokenCap: Type.Optional(
    Type.Number({
      description:
        "Expansion retrieval token budget across all delegated lcm_expand calls for this query.",
      minimum: 1,
    }),
  ),
});

type ConversationBreakdown = {
  conversationId: number;
  expandedSummaryCount: number;
  citedIds: string[];
  totalSourceTokens: number;
  truncated: boolean;
  status?: "success" | "failed" | "skipped";
  error?: string;
};

type ExpandQueryReply = {
  answer: string;
  citedIds: string[];
  sourceConversationIds: number[];
  expandedSummaryCount: number;
  totalSourceTokens: number;
  truncated: boolean;
  conversationBreakdown?: ConversationBreakdown[];
  sourceConversationId?: number;
};

type DelegatedExpandQueryReply = {
  answer: string;
  citedIds: string[];
  expandedSummaryCount: number;
  totalSourceTokens: number;
  truncated: boolean;
};

type ParsedExpandQueryReply =
  | {
      ok: true;
      value: DelegatedExpandQueryReply;
    }
  | {
      ok: false;
      error: string;
    };

type SummaryCandidate = {
  summaryId: string;
  conversationId: number;
  requiresMessageExpansion: boolean;
  isExplicit: boolean;
  matchedAt?: Date;
};

type ConversationBucket = {
  conversationId: number;
  summaryIds: string[];
  messageBackedSummaryIds: string[];
  candidateCount: number;
  explicitSummaryCount: number;
  messageBackedCount: number;
  newestMatchAt?: Date;
};

type BucketExecutionResult =
  | {
      conversationId: number;
      status: "success";
      candidateCount: number;
      reply: DelegatedExpandQueryReply;
    }
  | {
      conversationId: number;
      status: "failed" | "skipped";
      candidateCount: number;
      error: string;
    };

type RunDelegatedExpandQueryParams = {
  deps: LcmDependencies;
  callerSessionKey: string;
  requesterAgentId: string;
  bucket: ConversationBucket;
  query?: string;
  prompt: string;
  maxTokens: number;
  tokenCap: number;
  requestId: string;
  childExpansionDepth: number;
  originSessionKey: string;
  delegatedWaitTimeoutMs: number;
  delegatedWaitTimeoutSeconds: number;
};

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

function formatExpansionFailure(error: unknown): string {
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
    "unknown model",
    "model not found",
    "invalid model",
    "not available",
    "not supported",
    "401",
    "403",
  ].some((signal) => normalized.includes(signal));
}

function maxDate(left?: Date, right?: Date): Date | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return left.getTime() >= right.getTime() ? left : right;
}

/**
 * Build the sub-agent task message for delegated expansion and prompt answering.
 */
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
    "2. If additional candidates are needed, use `lcm_grep` scoped to summaries. Prefer `mode: \"full_text\"`, quote exact multi-word phrases, use `sort: \"relevance\"` for older-topic recall, and `sort: \"hybrid\"` when recency should still matter.",
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

function formatInvalidDelegatedReply(reply: string, reason: string): string {
  const compact = reply.replace(/\s+/g, " ").trim();
  const snippet = compact.length <= 240 ? compact : `${compact.slice(0, 240)}...`;
  return `Delegated expansion query returned ${reason}: ${snippet}`;
}

function buildConversationBuckets(candidates: SummaryCandidate[]): ConversationBucket[] {
  const buckets = new Map<
    number,
    {
      conversationId: number;
      summaryIds: string[];
      messageBackedSummaryIds: string[];
      summaryIdSet: Set<string>;
      explicitSummaryIdSet: Set<string>;
      messageBackedSummaryIdSet: Set<string>;
      newestMatchAt?: Date;
    }
  >();

  for (const candidate of candidates) {
    const bucket =
      buckets.get(candidate.conversationId) ??
      {
        conversationId: candidate.conversationId,
        summaryIds: [],
        messageBackedSummaryIds: [],
        summaryIdSet: new Set<string>(),
        explicitSummaryIdSet: new Set<string>(),
        messageBackedSummaryIdSet: new Set<string>(),
        newestMatchAt: undefined,
      };

    if (!bucket.summaryIdSet.has(candidate.summaryId)) {
      bucket.summaryIds.push(candidate.summaryId);
      bucket.summaryIdSet.add(candidate.summaryId);
    }
    if (candidate.isExplicit) {
      bucket.explicitSummaryIdSet.add(candidate.summaryId);
    }
    if (
      candidate.requiresMessageExpansion &&
      !bucket.messageBackedSummaryIdSet.has(candidate.summaryId)
    ) {
      bucket.messageBackedSummaryIds.push(candidate.summaryId);
      bucket.messageBackedSummaryIdSet.add(candidate.summaryId);
    }
    bucket.newestMatchAt = maxDate(bucket.newestMatchAt, candidate.matchedAt);
    buckets.set(candidate.conversationId, bucket);
  }

  return Array.from(buckets.values()).map((bucket) => ({
    conversationId: bucket.conversationId,
    summaryIds: normalizeSummaryIds(bucket.summaryIds),
    messageBackedSummaryIds: normalizeSummaryIds(bucket.messageBackedSummaryIds),
    candidateCount: bucket.summaryIds.length,
    explicitSummaryCount: bucket.explicitSummaryIdSet.size,
    messageBackedCount: bucket.messageBackedSummaryIds.length,
    newestMatchAt: bucket.newestMatchAt,
  }));
}

function compareConversationBuckets(left: ConversationBucket, right: ConversationBucket): number {
  const explicitDelta = right.explicitSummaryCount - left.explicitSummaryCount;
  if (explicitDelta !== 0) {
    return explicitDelta;
  }

  const candidateDelta = right.candidateCount - left.candidateCount;
  if (candidateDelta !== 0) {
    return candidateDelta;
  }

  const recencyDelta =
    (right.newestMatchAt?.getTime() ?? 0) - (left.newestMatchAt?.getTime() ?? 0);
  if (recencyDelta !== 0) {
    return recencyDelta;
  }

  const messageBackedDelta = right.messageBackedCount - left.messageBackedCount;
  if (messageBackedDelta !== 0) {
    return messageBackedDelta;
  }

  return left.conversationId - right.conversationId;
}

function buildExpandQueryReply(params: {
  answer: string;
  citedIds: string[];
  sourceConversationIds: number[];
  expandedSummaryCount: number;
  totalSourceTokens: number;
  truncated: boolean;
  conversationBreakdown?: ConversationBreakdown[];
}): ExpandQueryReply {
  const sourceConversationIds = [...params.sourceConversationIds].sort((left, right) => left - right);

  return {
    answer: params.answer,
    citedIds: normalizeSummaryIds(params.citedIds),
    sourceConversationIds,
    ...(sourceConversationIds.length === 1
      ? { sourceConversationId: sourceConversationIds[0] }
      : {}),
    expandedSummaryCount: params.expandedSummaryCount,
    totalSourceTokens: params.totalSourceTokens,
    truncated: params.truncated,
    ...(params.conversationBreakdown ? { conversationBreakdown: params.conversationBreakdown } : {}),
  };
}

function synthesizeConversationAnswers(params: {
  prompt: string;
  results: BucketExecutionResult[];
}): string {
  const successfulResults = params.results.filter(
    (result): result is Extract<BucketExecutionResult, { status: "success" }> =>
      result.status === "success",
  );
  const failedResults = params.results.filter(
    (result): result is Extract<BucketExecutionResult, { status: "failed" }> =>
      result.status === "failed",
  );
  const skippedResults = params.results.filter(
    (result): result is Extract<BucketExecutionResult, { status: "skipped" }> =>
      result.status === "skipped",
  );

  if (successfulResults.length === 1 && failedResults.length === 0 && skippedResults.length === 0) {
    return successfulResults[0].reply.answer;
  }

  const lines: string[] = [];
  if (successfulResults.length > 1) {
    lines.push(`Merged findings across ${successfulResults.length} conversations:`);
    lines.push("");
  }

  for (const result of successfulResults) {
    if (successfulResults.length > 1) {
      lines.push(`Conversation ${result.conversationId}:`);
    }
    lines.push(result.reply.answer);
    if (successfulResults.length > 1) {
      lines.push("");
    }
  }

  const notes: string[] = [];
  if (failedResults.length > 0) {
    notes.push(
      `failed conversations: ${failedResults
        .map((result) => `${result.conversationId} (${result.error})`)
        .join("; ")}`,
    );
  }
  if (skippedResults.length > 0) {
    notes.push(
      `skipped conversations: ${skippedResults
        .map((result) => `${result.conversationId} (${result.error})`)
        .join("; ")}`,
    );
  }
  if (notes.length > 0) {
    if (lines.length > 0 && lines[lines.length - 1] !== "") {
      lines.push("");
    }
    lines.push(`Partial coverage for "${params.prompt}": ${notes.join("; ")}`);
  }

  return lines.join("\n").trim();
}

/**
 * Parse the child reply; accepts plain JSON or fenced JSON and rejects malformed fallbacks.
 */
function parseDelegatedExpandQueryReply(
  rawReply: string | undefined,
  fallbackExpandedSummaryCount: number,
): ParsedExpandQueryReply {
  const reply = rawReply?.trim();
  if (!reply) {
    return {
      ok: false,
      error: "Delegated expansion query returned an empty reply.",
    };
  }

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
      const truncated = parsed.truncated === true;

      return {
        ok: true,
        value: {
          answer,
          citedIds,
          expandedSummaryCount,
          totalSourceTokens,
          truncated,
        },
      };
    } catch {
      // Try next candidate.
    }
  }

  return {
    ok: false,
    error: formatInvalidDelegatedReply(reply, "non-JSON output"),
  };
}

/**
 * Resolve a single source conversation for delegated expansion.
 */
function resolveSourceConversationId(params: {
  scopedConversationId?: number;
  allConversations: boolean;
  candidates: SummaryCandidate[];
}): number {
  if (typeof params.scopedConversationId === "number") {
    const mismatched = params.candidates
      .filter((candidate) => candidate.conversationId !== params.scopedConversationId)
      .map((candidate) => candidate.summaryId);
    if (mismatched.length > 0) {
      throw new Error(
        `Some summaryIds are outside conversation ${params.scopedConversationId}: ${mismatched.join(", ")}`,
      );
    }
    return params.scopedConversationId;
  }

  const conversationIds = Array.from(
    new Set(params.candidates.map((candidate) => candidate.conversationId)),
  );
  if (conversationIds.length === 1 && typeof conversationIds[0] === "number") {
    return conversationIds[0];
  }

  if (params.allConversations && conversationIds.length > 1) {
    throw new Error(
      "Query matched summaries from multiple conversations. Provide conversationId or narrow the query.",
    );
  }

  throw new Error(
    "Unable to resolve a single conversation scope. Provide conversationId or set a narrower summary scope.",
  );
}

function selectSingleConversationBucket(params: {
  sourceConversationId: number;
  buckets: ConversationBucket[];
}): ConversationBucket {
  const bucket = params.buckets.find(
    (candidateBucket) => candidateBucket.conversationId === params.sourceConversationId,
  );
  if (!bucket || bucket.summaryIds.length === 0) {
    throw new Error("No summaryIds available after applying conversation scope.");
  }
  return bucket;
}

function upsertSummaryCandidate(
  candidates: Map<string, SummaryCandidate>,
  candidate: SummaryCandidate,
): void {
  const existing = candidates.get(candidate.summaryId);
  if (!existing) {
    candidates.set(candidate.summaryId, candidate);
    return;
  }
  candidates.set(candidate.summaryId, {
    ...existing,
    requiresMessageExpansion:
      existing.requiresMessageExpansion || candidate.requiresMessageExpansion,
    isExplicit: existing.isExplicit || candidate.isExplicit,
    matchedAt: maxDate(existing.matchedAt, candidate.matchedAt),
  });
}

/**
 * Resolve summary candidates from explicit IDs and/or query matches.
 */
async function resolveSummaryCandidates(params: {
  lcm: LcmContextEngine;
  explicitSummaryIds: string[];
  query?: string;
  conversationId?: number;
}): Promise<SummaryCandidate[]> {
  const retrieval = params.lcm.getRetrieval();
  const candidates = new Map<string, SummaryCandidate>();

  for (const summaryId of params.explicitSummaryIds) {
    const described = await retrieval.describe(summaryId);
    if (!described || described.type !== "summary" || !described.summary) {
      throw new Error(`Summary not found: ${summaryId}`);
    }
    upsertSummaryCandidate(candidates, {
      summaryId,
      conversationId: described.summary.conversationId,
      requiresMessageExpansion: false,
      isExplicit: true,
      matchedAt: described.summary.latestAt ?? described.summary.createdAt,
    });
  }

  if (params.query) {
    const summaryStore = params.lcm.getSummaryStore();
    const grepResult = await retrieval.grep({
      query: params.query,
      mode: "full_text",
      scope: "summaries",
      conversationId: params.conversationId,
    });
    for (const summary of grepResult.summaries) {
      upsertSummaryCandidate(candidates, {
        summaryId: summary.summaryId,
        conversationId: summary.conversationId,
        requiresMessageExpansion: false,
        isExplicit: false,
        matchedAt: summary.createdAt,
      });
    }

    if (grepResult.summaries.length === 0 && typeof params.conversationId === "number") {
      const maxDepth = await summaryStore.getConversationMaxSummaryDepth(params.conversationId);
      if (typeof maxDepth === "number" && maxDepth <= 1) {
        const messageResult = await retrieval.grep({
          query: params.query,
          mode: "full_text",
          scope: "messages",
          conversationId: params.conversationId,
        });
        const messageIds = messageResult.messages.map((message) => message.messageId);
        const leafLinks = await summaryStore.getLeafSummaryLinksForMessageIds(
          params.conversationId,
          messageIds,
        );
        const summaryIdsByMessageId = new Map<number, string[]>();
        for (const link of leafLinks) {
          const linkedSummaryIds = summaryIdsByMessageId.get(link.messageId) ?? [];
          if (!linkedSummaryIds.includes(link.summaryId)) {
            linkedSummaryIds.push(link.summaryId);
            summaryIdsByMessageId.set(link.messageId, linkedSummaryIds);
          }
        }
        for (const message of messageResult.messages) {
          for (const summaryId of summaryIdsByMessageId.get(message.messageId) ?? []) {
            upsertSummaryCandidate(candidates, {
              summaryId,
              conversationId: params.conversationId,
              requiresMessageExpansion: true,
              isExplicit: false,
              matchedAt: message.createdAt,
            });
          }
        }
      }
    }
  }

  return Array.from(candidates.values());
}

/**
 * Run a single delegated lcm_expand_query bucket against one conversation.
 */
async function runDelegatedExpandQuery(
  params: RunDelegatedExpandQueryParams,
): Promise<DelegatedExpandQueryReply> {
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
  const delegatedOverrideProvider = canonicalExpansionModel ? undefined : expansionProvider;
  const delegatedOverrideModel = canonicalExpansionModel || expansionModel;
  const configuredOverrideLabel =
    delegatedOverrideProvider && delegatedOverrideModel
      ? `${delegatedOverrideProvider}/${delegatedOverrideModel}`
      : delegatedOverrideModel || delegatedOverrideProvider || "configured override";

  const runDelegatedQuery = async (provider?: string, model?: string) => {
    const childSessionKey = `agent:${params.requesterAgentId}:subagent:${crypto.randomUUID()}`;
    const childIdem = crypto.randomUUID();
    let grantCreated = false;

    try {
      createDelegatedExpansionGrant({
        delegatedSessionKey: childSessionKey,
        issuerSessionId: params.callerSessionKey || "main",
        allowedConversationIds: [params.bucket.conversationId],
        tokenCap: params.tokenCap,
        ttlMs: params.delegatedWaitTimeoutMs + 30_000,
      });
      stampDelegatedExpansionContext({
        sessionKey: childSessionKey,
        requestId: params.requestId,
        expansionDepth: params.childExpansionDepth,
        originSessionKey: params.originSessionKey,
        stampedBy: "lcm_expand_query",
      });
      grantCreated = true;

      const response = (await params.deps.callGateway({
        method: "agent",
        params: {
          message: task,
          sessionKey: childSessionKey,
          deliver: false,
          lane: params.deps.agentLaneSubagent,
          idempotencyKey: childIdem,
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
          extraSystemPrompt: params.deps.buildSubagentSystemPrompt({
            depth: 1,
            maxDepth: 8,
            taskSummary: "Run lcm_expand and return prompt-focused JSON answer",
          }),
        },
        timeoutMs: GATEWAY_TIMEOUT_MS,
      })) as { runId?: unknown; error?: unknown };

      const runId = typeof response?.runId === "string" ? response.runId.trim() : "";
      if (!runId) {
        throw new Error(
          formatExpansionFailure(response?.error ?? response)
            || "Delegated expansion did not return a runId.",
        );
      }

      const wait = (await params.deps.callGateway({
        method: "agent.wait",
        params: {
          runId,
          timeoutMs: params.delegatedWaitTimeoutMs,
        },
        timeoutMs: params.delegatedWaitTimeoutMs,
      })) as { status?: string; error?: unknown };
      const status = typeof wait?.status === "string" ? wait.status : "error";
      if (status === "timeout") {
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

      const replyPayload = (await params.deps.callGateway({
        method: "sessions.get",
        params: { key: childSessionKey, limit: 80 },
        timeoutMs: GATEWAY_TIMEOUT_MS,
      })) as { messages?: unknown[] };
      const reply = params.deps.readLatestAssistantReply(
        Array.isArray(replyPayload.messages) ? replyPayload.messages : [],
      );
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

      return parsed.value;
    } finally {
      try {
        await params.deps.callGateway({
          method: "sessions.delete",
          params: { key: childSessionKey, deleteTranscript: true },
          timeoutMs: GATEWAY_TIMEOUT_MS,
        });
      } catch {
        // Cleanup is best-effort.
      }
      if (grantCreated) {
        revokeDelegatedExpansionGrantForSession(childSessionKey, { removeBinding: true });
      }
      clearDelegatedExpansionContext(childSessionKey);
    }
  };

  if (!expansionProvider && !expansionModel) {
    return await runDelegatedQuery();
  }

  try {
    return await runDelegatedQuery(delegatedOverrideProvider, delegatedOverrideModel);
  } catch (error) {
    const failure = formatExpansionFailure(error);
    params.deps.log.warn(
      `[lcm] delegated expansion override failed (${configuredOverrideLabel}) for conversation ${params.bucket.conversationId}: ${failure}`,
    );
    if (!shouldRetryWithoutOverride(failure)) {
      throw new Error(failure);
    }
    params.deps.log.warn(
      `[lcm] retrying delegated expansion without provider/model override after: ${failure}`,
    );
    return await runDelegatedQuery();
  }
}

/**
 * Create the top-level lcm_expand_query tool wrapper for main-agent use.
 */
export function createLcmExpandQueryTool(input: {
  deps: LcmDependencies;
  lcm?: LcmContextEngine;
  getLcm?: () => Promise<LcmContextEngine>;
  /** Session id used for LCM conversation scoping. */
  sessionId?: string;
  /** Requester agent session key used for delegated child session/auth scoping. */
  requesterSessionKey?: string;
  /** Session key for scope fallback when sessionId is unavailable. */
  sessionKey?: string;
}): AnyAgentTool {
  const delegatedWaitTimeoutMs =
    input.deps.config.delegationTimeoutMs || DEFAULT_DELEGATED_WAIT_TIMEOUT_MS;
  const delegatedWaitTimeoutSeconds = Math.ceil(delegatedWaitTimeoutMs / 1000);

  return {
    name: "lcm_expand_query",
    label: "LCM Expand Query",
    description:
      "Answer a focused natural-language question using delegated LCM expansion. " +
      "Find candidate summaries (by IDs or a short FTS5 query that follows the same full-text rules as lcm_grep), expand them in a delegated sub-agent, " +
      "and return a compact prompt-focused answer. Tool output includes cited summary IDs for follow-up.",
    parameters: LcmExpandQuerySchema,
    async execute(_toolCallId, params) {
      const lcm = input.lcm ?? (await input.getLcm?.());
      if (!lcm) {
        throw new Error("LCM engine is unavailable.");
      }
      const p = params as Record<string, unknown>;
      const explicitSummaryIds = normalizeSummaryIds(p.summaryIds as string[] | undefined);
      const query = typeof p.query === "string" ? p.query.trim() : "";
      const prompt = typeof p.prompt === "string" ? p.prompt.trim() : "";
      const requestedMaxTokens =
        typeof p.maxTokens === "number" ? Math.trunc(p.maxTokens) : undefined;
      const maxTokens =
        typeof requestedMaxTokens === "number" && Number.isFinite(requestedMaxTokens)
          ? Math.max(1, requestedMaxTokens)
          : DEFAULT_MAX_ANSWER_TOKENS;
      const requestedTokenCap =
        typeof p.tokenCap === "number" ? Math.trunc(p.tokenCap) : undefined;
      const expansionTokenCap =
        typeof requestedTokenCap === "number" && Number.isFinite(requestedTokenCap)
          ? Math.max(1, requestedTokenCap)
          : Math.max(1, Math.trunc(input.deps.config.maxExpandTokens));

      if (!prompt) {
        return jsonResult({
          error: "prompt is required.",
        });
      }

      if (explicitSummaryIds.length === 0 && !query) {
        return jsonResult({
          error: "Either summaryIds or query must be provided.",
        });
      }

      const callerSessionKey =
        (typeof input.requesterSessionKey === "string"
          ? input.requesterSessionKey
          : input.sessionId
        )?.trim() ?? "";
      const requestId = resolveExpansionRequestId(callerSessionKey);
      const recursionCheck = evaluateExpansionRecursionGuard({
        sessionKey: callerSessionKey,
        requestId,
      });
      recordExpansionDelegationTelemetry({
        deps: input.deps,
        component: "lcm_expand_query",
        event: "start",
        requestId,
        sessionKey: callerSessionKey,
        expansionDepth: recursionCheck.expansionDepth,
        originSessionKey: recursionCheck.originSessionKey,
      });
      if (recursionCheck.blocked) {
        recordExpansionDelegationTelemetry({
          deps: input.deps,
          component: "lcm_expand_query",
          event: "block",
          requestId,
          sessionKey: callerSessionKey,
          expansionDepth: recursionCheck.expansionDepth,
          originSessionKey: recursionCheck.originSessionKey,
          reason: recursionCheck.reason,
        });
        return jsonResult({
          errorCode: recursionCheck.code,
          error: recursionCheck.message,
          requestId: recursionCheck.requestId,
          expansionDepth: recursionCheck.expansionDepth,
          originSessionKey: recursionCheck.originSessionKey,
          reason: recursionCheck.reason,
        });
      }

      const originSessionKey = recursionCheck.originSessionKey || callerSessionKey || "main";

      try {
        const conversationScope = await resolveLcmConversationScope({
          lcm,
          deps: input.deps,
          sessionId: input.sessionId,
          sessionKey: input.sessionKey,
          params: p,
        });
        let scopedConversationId = conversationScope.conversationId;
        if (
          !conversationScope.allConversations &&
          scopedConversationId == null &&
          callerSessionKey
        ) {
          scopedConversationId = await resolveRequesterConversationScopeId({
            deps: input.deps,
            requesterSessionKey: callerSessionKey,
            lcm,
          });
        }

        if (!conversationScope.allConversations && scopedConversationId == null) {
          return jsonResult({
            error:
              "No LCM conversation found for this session. Provide conversationId or set allConversations=true.",
          });
        }

        const candidates = await resolveSummaryCandidates({
          lcm,
          explicitSummaryIds,
          query: query || undefined,
          conversationId: scopedConversationId,
        });

        if (candidates.length === 0) {
          if (typeof scopedConversationId !== "number") {
            return jsonResult({
              error: "No matching summaries found.",
            });
          }
          return jsonResult(
            buildExpandQueryReply({
              answer: "No matching summaries found for this scope.",
              citedIds: [],
              sourceConversationIds: [scopedConversationId],
              expandedSummaryCount: 0,
              totalSourceTokens: 0,
              truncated: false,
            }),
          );
        }

        const conversationBuckets = buildConversationBuckets(candidates);

        const concurrencyCheck = acquireExpansionConcurrencySlot({
          originSessionKey,
          requestId,
        });
        if (concurrencyCheck.blocked) {
          recordExpansionDelegationTelemetry({
            deps: input.deps,
            component: "lcm_expand_query",
            event: "block",
            requestId,
            sessionKey: callerSessionKey,
            expansionDepth: recursionCheck.expansionDepth,
            originSessionKey: concurrencyCheck.originSessionKey,
            reason: concurrencyCheck.reason,
          });
          return jsonResult({
            errorCode: concurrencyCheck.code,
            error: concurrencyCheck.message,
            requestId: concurrencyCheck.requestId,
            expansionDepth: recursionCheck.expansionDepth,
            originSessionKey: concurrencyCheck.originSessionKey,
            reason: concurrencyCheck.reason,
          });
        }

        const requesterAgentId = input.deps.normalizeAgentId(
          input.deps.parseAgentSessionKey(callerSessionKey)?.agentId,
        );
        const childExpansionDepth = resolveNextExpansionDepth(callerSessionKey);

        if (!conversationScope.allConversations) {
          const sourceConversationId = resolveSourceConversationId({
            scopedConversationId,
            allConversations: conversationScope.allConversations,
            candidates,
          });
          const bucket = selectSingleConversationBucket({
            sourceConversationId,
            buckets: conversationBuckets,
          });
          const delegatedReply = await runDelegatedExpandQuery({
            deps: input.deps,
            callerSessionKey,
            requesterAgentId,
            bucket,
            query: query || undefined,
            prompt,
            maxTokens,
            tokenCap: expansionTokenCap,
            requestId,
            childExpansionDepth,
            originSessionKey,
            delegatedWaitTimeoutMs,
            delegatedWaitTimeoutSeconds,
          });

          return jsonResult(
            buildExpandQueryReply({
              answer: delegatedReply.answer,
              citedIds: delegatedReply.citedIds,
              sourceConversationIds: [sourceConversationId],
              expandedSummaryCount: delegatedReply.expandedSummaryCount,
              totalSourceTokens: delegatedReply.totalSourceTokens,
              truncated: delegatedReply.truncated,
            }),
          );
        }

        const rankedBuckets = [...conversationBuckets].sort(compareConversationBuckets);
        const bucketResults: BucketExecutionResult[] = [];
        const bucketsToExpand = rankedBuckets.slice(0, DEFAULT_MAX_CONVERSATION_BUCKETS);
        const skippedBuckets = rankedBuckets.slice(DEFAULT_MAX_CONVERSATION_BUCKETS);
        let remainingTokenCap = expansionTokenCap;
        let firstFailure: string | undefined;

        for (const bucket of bucketsToExpand) {
          if (remainingTokenCap <= 0) {
            bucketResults.push({
              conversationId: bucket.conversationId,
              status: "skipped",
              candidateCount: bucket.candidateCount,
              error: "global token budget exhausted",
            });
            continue;
          }

          try {
            const delegatedReply = await runDelegatedExpandQuery({
              deps: input.deps,
              callerSessionKey,
              requesterAgentId,
              bucket,
              query: query || undefined,
              prompt,
              maxTokens,
              tokenCap: remainingTokenCap,
              requestId,
              childExpansionDepth,
              originSessionKey,
              delegatedWaitTimeoutMs,
              delegatedWaitTimeoutSeconds,
            });
            bucketResults.push({
              conversationId: bucket.conversationId,
              status: "success",
              candidateCount: bucket.candidateCount,
              reply: delegatedReply,
            });
            remainingTokenCap = Math.max(
              0,
              remainingTokenCap - Math.max(0, delegatedReply.totalSourceTokens),
            );
          } catch (error) {
            const failure = formatExpansionFailure(error);
            firstFailure ??= failure;
            bucketResults.push({
              conversationId: bucket.conversationId,
              status: "failed",
              candidateCount: bucket.candidateCount,
              error: failure,
            });
          }
        }

        for (const bucket of skippedBuckets) {
          bucketResults.push({
            conversationId: bucket.conversationId,
            status: "skipped",
            candidateCount: bucket.candidateCount,
            error: `skipped after reaching max conversation bucket limit (${DEFAULT_MAX_CONVERSATION_BUCKETS})`,
          });
        }

        const successfulResults = bucketResults.filter(
          (result): result is Extract<BucketExecutionResult, { status: "success" }> =>
            result.status === "success",
        );
        if (successfulResults.length === 0) {
          throw new Error(firstFailure ?? "Delegated expansion query failed.");
        }

        const conversationBreakdown: ConversationBreakdown[] = bucketResults.map((result) => {
          if (result.status === "success") {
            return {
              conversationId: result.conversationId,
              expandedSummaryCount: result.reply.expandedSummaryCount,
              citedIds: result.reply.citedIds,
              totalSourceTokens: result.reply.totalSourceTokens,
              truncated: result.reply.truncated,
              status: "success",
            };
          }
          return {
            conversationId: result.conversationId,
            expandedSummaryCount: 0,
            citedIds: [],
            totalSourceTokens: 0,
            truncated: true,
            status: result.status,
            error: result.error,
          };
        });

        return jsonResult(
          buildExpandQueryReply({
            answer: synthesizeConversationAnswers({
              prompt,
              results: bucketResults,
            }),
            citedIds: successfulResults.flatMap((result) => result.reply.citedIds),
            sourceConversationIds: successfulResults.map((result) => result.conversationId),
            expandedSummaryCount: successfulResults.reduce(
              (total, result) => total + result.reply.expandedSummaryCount,
              0,
            ),
            totalSourceTokens: successfulResults.reduce(
              (total, result) => total + result.reply.totalSourceTokens,
              0,
            ),
            truncated:
              successfulResults.some((result) => result.reply.truncated)
              || bucketResults.some((result) => result.status !== "success"),
            conversationBreakdown,
          }),
        );
      } catch (error) {
        const failure = formatExpansionFailure(error);
        input.deps.log.error(`[lcm] delegated expansion query failed: ${failure}`);
        return jsonResult({
          error: failure,
        });
      } finally {
        releaseExpansionConcurrencySlot({
          originSessionKey,
          requestId,
        });
      }
    },
  };
}
