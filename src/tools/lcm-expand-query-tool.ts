import { Type } from "@sinclair/typebox";
import crypto from "node:crypto";
import type { OpenClawConfig } from "../../config/config.js";
import type { LcmContextEngine } from "../../plugins/lcm/engine.js";
import { ensureContextEnginesInitialized } from "../../context-engine/init.js";
import { resolveContextEngine } from "../../context-engine/registry.js";
import { callGateway } from "../../gateway/call.js";
import { resolveLcmConfig } from "../../plugins/lcm/db/config.js";
import {
  createDelegatedExpansionGrant,
  revokeDelegatedExpansionGrantForSession,
} from "../../plugins/lcm/expansion-auth.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { AGENT_LANE_SUBAGENT } from "../lanes.js";
import { buildSubagentSystemPrompt } from "../subagent-announce.js";
import { readLatestAssistantReply } from "./agent-step.js";
import { jsonResult, type AnyAgentTool } from "./common.js";
import { resolveLcmConversationScope } from "./lcm-conversation-scope.js";
import {
  normalizeSummaryIds,
  resolveRequesterConversationScopeId,
} from "./lcm-expand-tool.delegation.js";

const DELEGATED_WAIT_TIMEOUT_MS = 120_000;
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
});

type ExpandQueryReply = {
  answer: string;
  citedIds: string[];
  expandedSummaryCount: number;
  totalSourceTokens: number;
  truncated: boolean;
};

type SummaryCandidate = {
  summaryId: string;
  conversationId: number;
};

/**
 * Build the sub-agent task message for delegated expansion and prompt answering.
 */
function buildDelegatedExpandQueryTask(params: {
  summaryIds: string[];
  conversationId: number;
  prompt: string;
  maxTokens: number;
}) {
  const payload = {
    summaryIds: params.summaryIds,
    conversationId: params.conversationId,
    includeMessages: false,
  };
  return [
    "Run LCM expansion, then answer the user's prompt from the expanded context.",
    "",
    "Step 1: Call `lcm_expand` using exactly this JSON payload:",
    JSON.stringify(payload, null, 2),
    "",
    "Step 2: Use the `lcm_expand` result as source context and answer this prompt:",
    params.prompt,
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
    `- Keep answer concise and focused (target <= ${params.maxTokens} tokens).`,
    "- citedIds must be unique summary IDs.",
    "- expandedSummaryCount should reflect how many summaries were expanded/used.",
    "- totalSourceTokens should be the estimated source token volume from expansion.",
    "- truncated should indicate whether source expansion appears truncated.",
  ].join("\n");
}

/**
 * Parse the child reply; accepts plain JSON or fenced JSON.
 */
function parseDelegatedExpandQueryReply(
  rawReply: string | undefined,
  fallbackExpandedSummaryCount: number,
): ExpandQueryReply {
  const fallback: ExpandQueryReply = {
    answer: (rawReply ?? "").trim(),
    citedIds: [],
    expandedSummaryCount: fallbackExpandedSummaryCount,
    totalSourceTokens: 0,
    truncated: false,
  };

  const reply = rawReply?.trim();
  if (!reply) {
    return fallback;
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
        answer: answer || fallback.answer,
        citedIds,
        expandedSummaryCount,
        totalSourceTokens,
        truncated,
      };
    } catch {
      // Try next candidate.
    }
  }

  return fallback;
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
    candidates.set(summaryId, {
      summaryId,
      conversationId: described.summary.conversationId,
    });
  }

  if (params.query) {
    const grepResult = await retrieval.grep({
      query: params.query,
      mode: "full_text",
      scope: "summaries",
      conversationId: params.conversationId,
    });
    for (const summary of grepResult.summaries) {
      candidates.set(summary.summaryId, {
        summaryId: summary.summaryId,
        conversationId: summary.conversationId,
      });
    }
  }

  return Array.from(candidates.values());
}

export function createLcmExpandQueryTool(options?: {
  config?: OpenClawConfig;
  /** Session id used for LCM conversation scoping. */
  sessionId?: string;
  /** Requester agent session key used for delegated child session/auth scoping. */
  requesterSessionKey?: string;
}): AnyAgentTool {
  return {
    name: "lcm_expand_query",
    label: "LCM Expand Query",
    description:
      "Answer a focused question using delegated LCM expansion. " +
      "Find candidate summaries (by IDs or query), expand them in a delegated sub-agent, " +
      "and return a compact prompt-focused answer with cited summary IDs.",
    parameters: LcmExpandQuerySchema,
    async execute(_toolCallId, params) {
      ensureContextEnginesInitialized();
      const engine = await resolveContextEngine(options?.config);

      if (engine.info.id !== "lcm") {
        return jsonResult({
          error: "lcm_expand_query requires the LCM context engine to be active.",
        });
      }

      const lcm = engine as LcmContextEngine;
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

      const requesterSessionKey =
        (typeof options?.requesterSessionKey === "string"
          ? options.requesterSessionKey
          : options?.sessionId
        )?.trim() ?? "";
      const conversationScope = await resolveLcmConversationScope({
        lcm,
        sessionId: options?.sessionId,
        params: p,
      });
      let scopedConversationId = conversationScope.conversationId;
      if (
        !conversationScope.allConversations &&
        scopedConversationId == null &&
        requesterSessionKey
      ) {
        scopedConversationId = await resolveRequesterConversationScopeId({
          config: options?.config,
          requesterSessionKey,
          lcm,
        });
      }

      if (!conversationScope.allConversations && scopedConversationId == null) {
        return jsonResult({
          error:
            "No LCM conversation found for this session. Provide conversationId or set allConversations=true.",
        });
      }

      let childSessionKey = "";
      let grantCreated = false;

      try {
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

        if (summaryIds.length === 0) {
          return jsonResult({
            error: "No summaryIds available after applying conversation scope.",
          });
        }

        const requesterAgentId = normalizeAgentId(
          parseAgentSessionKey(requesterSessionKey)?.agentId,
        );
        childSessionKey = `agent:${requesterAgentId}:subagent:${crypto.randomUUID()}`;

        createDelegatedExpansionGrant({
          delegatedSessionKey: childSessionKey,
          issuerSessionId: requesterSessionKey || "main",
          allowedConversationIds: [sourceConversationId],
          tokenCap: resolveLcmConfig().maxExpandTokens,
          ttlMs: DELEGATED_WAIT_TIMEOUT_MS + 30_000,
        });
        grantCreated = true;

        const task = buildDelegatedExpandQueryTask({
          summaryIds,
          conversationId: sourceConversationId,
          prompt,
          maxTokens,
        });

        const childIdem = crypto.randomUUID();
        const response = await callGateway<{ runId?: string }>({
          method: "agent",
          params: {
            message: task,
            sessionKey: childSessionKey,
            deliver: false,
            lane: AGENT_LANE_SUBAGENT,
            idempotencyKey: childIdem,
            extraSystemPrompt: buildSubagentSystemPrompt({
              requesterSessionKey,
              childSessionKey,
              label: "LCM expand query",
              task: "Run lcm_expand and return prompt-focused JSON answer",
            }),
          },
          timeoutMs: GATEWAY_TIMEOUT_MS,
        });

        const runId = typeof response?.runId === "string" ? response.runId.trim() : "";
        if (!runId) {
          return jsonResult({
            error: "Delegated expansion did not return a runId.",
          });
        }

        const wait = await callGateway<{ status?: string; error?: string }>({
          method: "agent.wait",
          params: {
            runId,
            timeoutMs: DELEGATED_WAIT_TIMEOUT_MS,
          },
          timeoutMs: DELEGATED_WAIT_TIMEOUT_MS,
        });
        const status = typeof wait?.status === "string" ? wait.status : "error";
        if (status === "timeout") {
          return jsonResult({
            error: "lcm_expand_query timed out waiting for delegated expansion (120s).",
          });
        }
        if (status !== "ok") {
          return jsonResult({
            error:
              typeof wait?.error === "string" && wait.error.trim()
                ? wait.error
                : "Delegated expansion query failed.",
          });
        }

        const reply = await readLatestAssistantReply({
          sessionKey: childSessionKey,
          limit: 80,
        });
        const parsed = parseDelegatedExpandQueryReply(reply, summaryIds.length);

        return jsonResult({
          answer: parsed.answer,
          citedIds: parsed.citedIds,
          sourceConversationId,
          expandedSummaryCount: parsed.expandedSummaryCount,
          totalSourceTokens: parsed.totalSourceTokens,
          truncated: parsed.truncated,
        });
      } catch (error) {
        return jsonResult({
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (childSessionKey) {
          try {
            await callGateway({
              method: "sessions.delete",
              params: { key: childSessionKey, deleteTranscript: true },
              timeoutMs: GATEWAY_TIMEOUT_MS,
            });
          } catch {
            // Cleanup is best-effort.
          }
        }
        if (grantCreated && childSessionKey) {
          revokeDelegatedExpansionGrantForSession(childSessionKey, { removeBinding: true });
        }
      }
    },
  };
}
