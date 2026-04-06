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

const LcmExpandQuerySchema = Type.Object({
  summaryIds: Type.Optional(
    Type.Array(Type.String(), {
      description: "Summary IDs to expand (sum_xxx). Required when query is not provided.",
    }),
  ),
  query: Type.Optional(
    Type.String({
      description:
        "Text query used to find summaries via grep before expansion. Required when summaryIds is not provided.",
    }),
  ),
  prompt: Type.String({
    description: "Question to answer using expanded context.",
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

type ExpandQueryReply = {
  answer: string;
  citedIds: string[];
  expandedSummaryCount: number;
  totalSourceTokens: number;
  truncated: boolean;
};

type ParsedExpandQueryReply =
  | {
      ok: true;
      value: ExpandQueryReply;
    }
  | {
      ok: false;
      error: string;
    };

type SummaryCandidate = {
  summaryId: string;
  conversationId: number;
  requiresMessageExpansion: boolean;
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
    "- totalSourceTokens should estimate total tokens consumed from expansion calls.",
    "- truncated should indicate whether source expansion appears truncated.",
  ].join("\n");
}

function formatInvalidDelegatedReply(reply: string, reason: string): string {
  const compact = reply.replace(/\s+/g, " ").trim();
  const snippet = compact.length <= 240 ? compact : `${compact.slice(0, 240)}...`;
  return `Delegated expansion query returned ${reason}: ${snippet}`;
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
            });
          }
        }
      }
    }
  }

  return Array.from(candidates.values());
}

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
      "Answer a focused question using delegated LCM expansion. " +
      "Find candidate summaries (by IDs or query), expand them in a delegated sub-agent, " +
      "and return a compact prompt-focused answer with cited summary IDs.",
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
      const requestedTokenCap = typeof p.tokenCap === "number" ? Math.trunc(p.tokenCap) : undefined;
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
          return jsonResult({
            answer: "No matching summaries found for this scope.",
            citedIds: [],
            sourceConversationId: scopedConversationId,
            expandedSummaryCount: 0,
            totalSourceTokens: 0,
            truncated: false,
          });
        }

        const sourceConversationId = resolveSourceConversationId({
          scopedConversationId,
          allConversations: conversationScope.allConversations,
          candidates,
        });
        const summaryIds = normalizeSummaryIds(
          candidates
            .filter((candidate) => candidate.conversationId === sourceConversationId)
            .map((candidate) => candidate.summaryId),
        );
        const messageBackedSummaryIds = normalizeSummaryIds(
          candidates
            .filter(
              (candidate) =>
                candidate.conversationId === sourceConversationId &&
                candidate.requiresMessageExpansion,
            )
            .map((candidate) => candidate.summaryId),
        );

        if (summaryIds.length === 0) {
          return jsonResult({
            error: "No summaryIds available after applying conversation scope.",
          });
        }

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

        const task = buildDelegatedExpandQueryTask({
          summaryIds,
          messageBackedSummaryIds,
          conversationId: sourceConversationId,
          query: query || undefined,
          prompt,
          maxTokens,
          tokenCap: expansionTokenCap,
          requestId,
          expansionDepth: childExpansionDepth,
          originSessionKey,
        });

        const expansionProvider = input.deps.config.expansionProvider || undefined;
        const expansionModel = input.deps.config.expansionModel || undefined;
        const canonicalExpansionModel = expansionModel?.includes("/") ? expansionModel : undefined;
        const delegatedOverrideProvider = canonicalExpansionModel ? undefined : expansionProvider;
        const delegatedOverrideModel = canonicalExpansionModel || expansionModel;
        const configuredOverrideLabel =
          delegatedOverrideProvider && delegatedOverrideModel
            ? `${delegatedOverrideProvider}/${delegatedOverrideModel}`
            : delegatedOverrideModel || delegatedOverrideProvider || "configured override";

        const runDelegatedQuery = async (provider?: string, model?: string) => {
          const childSessionKey = `agent:${requesterAgentId}:subagent:${crypto.randomUUID()}`;
          const childIdem = crypto.randomUUID();
          let grantCreated = false;

          try {
            createDelegatedExpansionGrant({
              delegatedSessionKey: childSessionKey,
              issuerSessionId: callerSessionKey || "main",
              allowedConversationIds: [sourceConversationId],
              tokenCap: expansionTokenCap,
              ttlMs: delegatedWaitTimeoutMs + 30_000,
            });
            stampDelegatedExpansionContext({
              sessionKey: childSessionKey,
              requestId,
              expansionDepth: childExpansionDepth,
              originSessionKey,
              stampedBy: "lcm_expand_query",
            });
            grantCreated = true;

            const response = (await input.deps.callGateway({
              method: "agent",
              params: {
                message: task,
                sessionKey: childSessionKey,
                deliver: false,
                lane: input.deps.agentLaneSubagent,
                idempotencyKey: childIdem,
                ...(provider ? { provider } : {}),
                ...(model ? { model } : {}),
                extraSystemPrompt: input.deps.buildSubagentSystemPrompt({
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

            const wait = (await input.deps.callGateway({
              method: "agent.wait",
              params: {
                runId,
                timeoutMs: delegatedWaitTimeoutMs,
              },
              timeoutMs: delegatedWaitTimeoutMs,
            })) as { status?: string; error?: unknown };
            const status = typeof wait?.status === "string" ? wait.status : "error";
            if (status === "timeout") {
              recordExpansionDelegationTelemetry({
                deps: input.deps,
                component: "lcm_expand_query",
                event: "timeout",
                requestId,
                sessionKey: callerSessionKey,
                expansionDepth: childExpansionDepth,
                originSessionKey,
                runId,
              });
              throw new Error(
                `lcm_expand_query timed out waiting for delegated expansion (${delegatedWaitTimeoutSeconds}s).`,
              );
            }
            if (status !== "ok") {
              throw new Error(formatExpansionFailure(wait?.error));
            }

            const replyPayload = (await input.deps.callGateway({
              method: "sessions.get",
              params: { key: childSessionKey, limit: 80 },
              timeoutMs: GATEWAY_TIMEOUT_MS,
            })) as { messages?: unknown[] };
            const reply = input.deps.readLatestAssistantReply(
              Array.isArray(replyPayload.messages) ? replyPayload.messages : [],
            );
            const parsed = parseDelegatedExpandQueryReply(reply, summaryIds.length);
            if (!parsed.ok) {
              throw new Error(parsed.error);
            }
            recordExpansionDelegationTelemetry({
              deps: input.deps,
              component: "lcm_expand_query",
              event: "success",
              requestId,
              sessionKey: callerSessionKey,
              expansionDepth: childExpansionDepth,
              originSessionKey,
              runId,
            });

            return jsonResult({
              answer: parsed.value.answer,
              citedIds: parsed.value.citedIds,
              sourceConversationId,
              expandedSummaryCount: parsed.value.expandedSummaryCount,
              totalSourceTokens: parsed.value.totalSourceTokens,
              truncated: parsed.value.truncated,
            });
          } finally {
            try {
              await input.deps.callGateway({
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
          input.deps.log.warn(
            `[lcm] delegated expansion override failed (${configuredOverrideLabel}): ${failure}`,
          );
          if (!shouldRetryWithoutOverride(failure)) {
            throw new Error(failure);
          }
          input.deps.log.warn(
            `[lcm] retrying delegated expansion without provider/model override after: ${failure}`,
          );
          return await runDelegatedQuery();
        }
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
