import { Type } from "@sinclair/typebox";
import type { LcmContextEngine } from "../engine.js";
import type { LcmDependencies } from "../types.js";
import { jsonResult, type AnyAgentTool } from "./common.js";
import { resolveLcmConversationScope } from "./lcm-conversation-scope.js";
import {
  formatExpansionFailure,
  runDelegatedExpandQuery,
  type DelegatedBucketOutcome,
  type DelegatedExpandQueryReply,
  type DelegatedFailureCode,
  type DelegatedFailurePhase,
} from "./lcm-expand-query-delegation.js";
import {
  allocateExpansionTokenCaps,
  createExpansionDeadline,
} from "./lcm-expansion-deadline.js";
import {
  normalizeSummaryIds,
  resolveRequesterConversationScopeId,
} from "./lcm-expand-tool.delegation.js";
import {
  acquireExpansionConcurrencySlot,
  evaluateExpansionRecursionGuard,
  recordExpansionDelegationTelemetry,
  releaseExpansionConcurrencySlot,
  resolveExpansionRequestId,
  resolveNextExpansionDepth,
} from "./lcm-expansion-recursion-guard.js";

const DEFAULT_DELEGATED_WAIT_TIMEOUT_MS = 120_000;
const DYNAMIC_TOOL_TIMEOUT_HEADROOM_MS = 30_000;
const MAX_DYNAMIC_TOOL_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_ANSWER_TOKENS = 2_000;
const DEFAULT_MAX_CONVERSATION_BUCKETS = 3;

function clampPositiveTimeoutMs(value: number): number {
  return Math.max(1, Math.min(MAX_DYNAMIC_TOOL_TIMEOUT_MS, Math.floor(value)));
}

function resolveAdvertisedDynamicToolTimeoutMs(delegatedWaitTimeoutMs: number): number {
  return clampPositiveTimeoutMs(delegatedWaitTimeoutMs + DYNAMIC_TOOL_TIMEOUT_HEADROOM_MS);
}

function createLcmExpandQuerySchema(dynamicToolTimeoutMs: number) {
  return Type.Object({
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
          "Physical conversation ID to scope expansion to. If omitted, uses the current session family.",
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
    timeoutMs: Type.Number({
      description:
        "Total OpenClaw dynamic tool RPC timeout in milliseconds. Use the default value unless the user asks for a shorter recall attempt; this keeps delegated recall open before the host watchdog fires.",
      default: dynamicToolTimeoutMs,
      minimum: 1,
    }),
  });
}

type ConversationBreakdown = {
  conversationId: number;
  expandedSummaryCount: number;
  citedIds: string[];
  totalSourceTokens: number;
  truncated: boolean;
  status?: "success" | "failed" | "skipped";
  error?: string;
  summaryIds?: string[];
  phase?: DelegatedFailurePhase;
  elapsedMs?: number;
  errorCode?: DelegatedFailureCode;
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
  | (Extract<DelegatedBucketOutcome, { status: "success" }> & { candidateCount: number })
  | (Extract<DelegatedBucketOutcome, { status: "failed" }> & { candidateCount: number })
  | {
      conversationId: number;
      status: "skipped";
      candidateCount: number;
      summaryIds: string[];
      error: string;
    };

function maxDate(left?: Date, right?: Date): Date | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return left.getTime() >= right.getTime() ? left : right;
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

/** Build the public per-conversation accounting for delegated bucket outcomes. */
function buildConversationBreakdown(results: BucketExecutionResult[]): ConversationBreakdown[] {
  return results.map((result) => {
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
    if (result.status === "failed") {
      return {
        conversationId: result.conversationId,
        expandedSummaryCount: 0,
        citedIds: [],
        totalSourceTokens: 0,
        truncated: true,
        status: "failed",
        summaryIds: result.summaryIds,
        phase: result.phase,
        elapsedMs: result.elapsedMs,
        errorCode: result.code,
        error: result.error,
      };
    }
    return {
      conversationId: result.conversationId,
      expandedSummaryCount: 0,
      citedIds: [],
      totalSourceTokens: 0,
      truncated: true,
      status: "skipped",
      error: result.error,
    };
  });
}

/** Preserve the legacy error text while adding structured failure accounting. */
function buildDelegatedFailureReply(results: BucketExecutionResult[]) {
  const firstFailure = results.find(
    (result): result is Extract<BucketExecutionResult, { status: "failed" }> =>
      result.status === "failed",
  );
  const error = firstFailure?.error ?? "Delegated expansion query failed.";
  return {
    error,
    ...(firstFailure ? { errorCode: firstFailure.code } : {}),
    truncated: true,
    citedIds: [],
    sourceConversationIds: [],
    expandedSummaryCount: 0,
    totalSourceTokens: 0,
    conversationBreakdown: buildConversationBreakdown(results),
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
 * Resolve a single source conversation for delegated expansion.
 */
function resolveSourceConversationId(params: {
  scopedConversationId?: number;
  allowedConversationIds?: number[];
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
  const allowedConversationIds = new Set(params.allowedConversationIds ?? []);
  if (allowedConversationIds.size > 0) {
    const outOfScope = params.candidates
      .filter((candidate) => !allowedConversationIds.has(candidate.conversationId))
      .map((candidate) => candidate.summaryId);
    if (outOfScope.length > 0) {
      throw new Error(
        `Some summaryIds are outside the allowed conversation scope: ${outOfScope.join(", ")}`,
      );
    }
  }
  if (allowedConversationIds.size > 1) {
    const firstAllowed = params.candidates.find((candidate) =>
      allowedConversationIds.has(candidate.conversationId),
    );
    if (firstAllowed) {
      return firstAllowed.conversationId;
    }
  }
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
  conversationIds?: number[];
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
    const fallbackConversationIds = Array.from(
      new Set(
        (params.conversationIds && params.conversationIds.length > 0
          ? params.conversationIds
          : typeof params.conversationId === "number"
            ? [params.conversationId]
            : []
        ).filter((conversationId): conversationId is number => Number.isInteger(conversationId)),
      ),
    );
    const grepResult = await retrieval.grep({
      query: params.query,
      mode: "full_text",
      scope: "summaries",
      conversationId: params.conversationId,
      conversationIds: params.conversationIds,
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

    if (grepResult.summaries.length === 0 && fallbackConversationIds.length > 0) {
      const maxDepths = await Promise.all(
        fallbackConversationIds.map(async (conversationId) => ({
          conversationId,
          maxDepth: await summaryStore.getConversationMaxSummaryDepth(conversationId),
        })),
      );
      const allowMessageFallback = maxDepths.every(
        ({ maxDepth }) => typeof maxDepth === "number" && maxDepth <= 1,
      );
      if (allowMessageFallback) {
        const messageResult = await retrieval.grep({
          query: params.query,
          mode: "full_text",
          scope: "messages",
          conversationId: params.conversationId,
          conversationIds: params.conversationIds,
        });
        const messageIdsByConversationId = new Map<number, number[]>();
        for (const message of messageResult.messages) {
          const messageIds = messageIdsByConversationId.get(message.conversationId) ?? [];
          messageIds.push(message.messageId);
          messageIdsByConversationId.set(message.conversationId, messageIds);
        }
        const leafLinksPerConversation = await Promise.all(
          Array.from(messageIdsByConversationId.entries()).map(async ([conversationId, messageIds]) =>
            summaryStore.getLeafSummaryLinksForMessageIds(conversationId, messageIds),
          ),
        );
        const leafLinks = leafLinksPerConversation.flat();
        const messageConversationById = new Map(
          messageResult.messages.map((message) => [message.messageId, message.conversationId]),
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
            const linkedConversationId = messageConversationById.get(message.messageId);
            if (typeof linkedConversationId !== "number") {
              continue;
            }
            upsertSummaryCandidate(candidates, {
              summaryId,
              conversationId: linkedConversationId,
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
  const configuredDelegatedWaitTimeoutMs =
    input.deps.config.delegationTimeoutMs || DEFAULT_DELEGATED_WAIT_TIMEOUT_MS;
  const advertisedDynamicToolTimeoutMs = resolveAdvertisedDynamicToolTimeoutMs(
    configuredDelegatedWaitTimeoutMs,
  );

  return {
    name: "lcm_expand_query",
    label: "LCM Expand Query",
    description:
      "Answer a focused natural-language question using delegated LCM expansion. " +
      "Find candidate summaries (by IDs or a short FTS5 query that follows the same full-text rules as lcm_grep), expand them in a delegated sub-agent, " +
      "and return a compact prompt-focused answer. Tool output includes cited summary IDs for follow-up.",
    parameters: createLcmExpandQuerySchema(advertisedDynamicToolTimeoutMs),
    async execute(_toolCallId, params) {
      const requestStartedAtMs = performance.now();
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
      const requestedDynamicToolTimeoutMs =
        typeof p.timeoutMs === "number" && Number.isFinite(p.timeoutMs)
          ? clampPositiveTimeoutMs(p.timeoutMs)
          : undefined;
      const deadline = createExpansionDeadline({
        nowMs: requestStartedAtMs,
        dynamicToolTimeoutMs: requestedDynamicToolTimeoutMs ?? advertisedDynamicToolTimeoutMs,
        delegationTimeoutMs: configuredDelegatedWaitTimeoutMs,
        headroomMs: DYNAMIC_TOOL_TIMEOUT_HEADROOM_MS,
      });
      const delegatedWaitTimeoutMs = Math.max(
        1,
        Math.floor(deadline.workDeadlineMs - deadline.startedAtMs),
      );
      const delegatedWaitTimeoutSeconds = Math.ceil(delegatedWaitTimeoutMs / 1000);

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
        if (conversationScope.error) {
          return jsonResult({ error: conversationScope.error });
        }
        const familyScopedConversationId =
          (conversationScope.conversationIds?.length ?? 0) > 1
            ? undefined
            : conversationScope.conversationId;
        let scopedConversationId = familyScopedConversationId;
        if (
          !conversationScope.allConversations &&
          scopedConversationId == null &&
          (conversationScope.conversationIds?.length ?? 0) <= 1 &&
          callerSessionKey
        ) {
          scopedConversationId = await resolveRequesterConversationScopeId({
            deps: input.deps,
            requesterSessionKey: callerSessionKey,
            lcm,
          });
        }

        if (
          !conversationScope.allConversations &&
          scopedConversationId == null &&
          (conversationScope.conversationIds?.length ?? 0) <= 1
        ) {
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
          conversationIds: conversationScope.conversationIds,
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
            allowedConversationIds: conversationScope.conversationIds,
            allConversations: conversationScope.allConversations,
            candidates,
          });
          const bucket = selectSingleConversationBucket({
            sourceConversationId,
            buckets: conversationBuckets,
          });
          const delegatedOutcome = await runDelegatedExpandQuery({
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
            deadline,
            delegatedWaitTimeoutSeconds,
          });
          if (delegatedOutcome.status === "failed") {
            return jsonResult(
              buildDelegatedFailureReply([
                { ...delegatedOutcome, candidateCount: bucket.candidateCount },
              ]),
            );
          }
          const delegatedReply = delegatedOutcome.reply;

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
        const selectedBuckets = rankedBuckets.slice(0, DEFAULT_MAX_CONVERSATION_BUCKETS);
        const tokenAllocations = allocateExpansionTokenCaps({
          bucketCount: selectedBuckets.length,
          tokenCap: expansionTokenCap,
        });
        const runnableBuckets = selectedBuckets.slice(0, tokenAllocations.length);
        const tokenSkippedBuckets = selectedBuckets.slice(tokenAllocations.length);
        const limitSkippedBuckets = rankedBuckets.slice(DEFAULT_MAX_CONVERSATION_BUCKETS);

        const delegatedOutcomes = await Promise.all(
          runnableBuckets.map((bucket, index) =>
            runDelegatedExpandQuery({
              deps: input.deps,
              callerSessionKey,
              requesterAgentId,
              bucket,
              query: query || undefined,
              prompt,
              maxTokens,
              tokenCap: tokenAllocations[index] ?? 1,
              requestId,
              childExpansionDepth,
              originSessionKey,
              deadline,
              delegatedWaitTimeoutSeconds,
            }),
          ),
        );

        const bucketResults: BucketExecutionResult[] = delegatedOutcomes.map(
          (outcome, index) => ({
            ...outcome,
            candidateCount: runnableBuckets[index]?.candidateCount ?? outcome.summaryIds.length,
          }),
        );
        for (const bucket of tokenSkippedBuckets) {
          bucketResults.push({
            conversationId: bucket.conversationId,
            status: "skipped",
            summaryIds: bucket.summaryIds,
            candidateCount: bucket.candidateCount,
            error: "global token budget exhausted",
          });
        }
        for (const bucket of limitSkippedBuckets) {
          bucketResults.push({
            conversationId: bucket.conversationId,
            status: "skipped",
            summaryIds: bucket.summaryIds,
            candidateCount: bucket.candidateCount,
            error: `skipped after reaching max conversation bucket limit (${DEFAULT_MAX_CONVERSATION_BUCKETS})`,
          });
        }

        const successfulResults = bucketResults.filter(
          (result): result is Extract<BucketExecutionResult, { status: "success" }> =>
            result.status === "success",
        );
        if (successfulResults.length === 0) {
          return jsonResult(buildDelegatedFailureReply(bucketResults));
        }

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
            conversationBreakdown: buildConversationBreakdown(bucketResults),
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
