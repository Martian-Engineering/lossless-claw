import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { LcmContextEngine } from "../../plugins/lcm/engine.js";
import type { AnyAgentTool } from "./common.js";
import { ensureContextEnginesInitialized } from "../../context-engine/init.js";
import { resolveContextEngine } from "../../context-engine/registry.js";
import {
  getRuntimeExpansionAuthManager,
  resolveDelegatedExpansionGrantId,
  wrapWithAuth,
} from "../../plugins/lcm/expansion-auth.js";
import { decideLcmExpansionRouting } from "../../plugins/lcm/expansion-policy.js";
import {
  ExpansionOrchestrator,
  distillForSubagent,
  type ExpansionResult,
} from "../../plugins/lcm/expansion.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import { jsonResult } from "./common.js";
import { resolveLcmConversationScope } from "./lcm-conversation-scope.js";
import {
  normalizeSummaryIds,
  runDelegatedExpansionLoop,
  type DelegatedExpansionLoopResult,
} from "./lcm-expand-tool.delegation.js";

const LcmExpandSchema = Type.Object({
  summaryIds: Type.Optional(
    Type.Array(Type.String(), {
      description: "Summary IDs to expand (sum_xxx format). Required if query is not provided.",
    }),
  ),
  query: Type.Optional(
    Type.String({
      description:
        "Text query to grep for matching summaries before expanding. " +
        "If provided, summaryIds is ignored and the top grep results are expanded.",
    }),
  ),
  maxDepth: Type.Optional(
    Type.Number({
      description: "Max traversal depth per summary (default: 3).",
      minimum: 1,
    }),
  ),
  tokenCap: Type.Optional(
    Type.Number({
      description: "Max tokens across the entire expansion result.",
      minimum: 1,
    }),
  ),
  includeMessages: Type.Optional(
    Type.Boolean({
      description: "Whether to include raw source messages at leaf level (default: false).",
    }),
  ),
  conversationId: Type.Optional(
    Type.Number({
      description:
        "Conversation ID to scope the expansion to. If omitted, uses the current session's conversation.",
    }),
  ),
  allConversations: Type.Optional(
    Type.Boolean({
      description:
        "Set true to explicitly allow cross-conversation expansion. Ignored when conversationId is provided.",
    }),
  ),
});

function makeEmptyExpansionResult(): ExpansionResult {
  return {
    expansions: [],
    citedIds: [],
    totalTokens: 0,
    truncated: false,
  };
}

type LcmDelegatedRunReference = {
  pass: number;
  status: "ok" | "timeout" | "error";
  runId: string;
  childSessionKey: string;
};

/**
 * Extract delegated run references for deterministic orchestration diagnostics.
 */
function toDelegatedRunReferences(
  delegated?: DelegatedExpansionLoopResult,
): LcmDelegatedRunReference[] | undefined {
  if (!delegated) {
    return undefined;
  }
  const refs = delegated.passes.map((pass) => ({
    pass: pass.pass,
    status: pass.status,
    runId: pass.runId,
    childSessionKey: pass.childSessionKey,
  }));
  return refs.length > 0 ? refs : undefined;
}

/**
 * Build stable debug metadata for route-vs-delegate orchestration decisions.
 */
function buildOrchestrationObservability(input: {
  policy: ReturnType<typeof decideLcmExpansionRouting>;
  executionPath: "direct" | "delegated" | "direct_fallback";
  delegated?: DelegatedExpansionLoopResult;
}) {
  return {
    decisionPath: {
      policyAction: input.policy.action,
      executionPath: input.executionPath,
    },
    policyReasons: input.policy.reasons,
    delegatedRunRefs: toDelegatedRunReferences(input.delegated),
  };
}

/**
 * Build the runtime LCM expansion tool with route-vs-delegate orchestration.
 */
export function createLcmExpandTool(options?: {
  config?: OpenClawConfig;
  /** Runtime session key (used for delegated expansion auth scoping). */
  sessionId?: string;
}): AnyAgentTool {
  return {
    name: "lcm_expand",
    label: "LCM Expand",
    description:
      "Expand compacted conversation summaries from LCM (Lossless Context Management). " +
      "Traverses the summary DAG to retrieve children and source messages. " +
      "Use this to drill into previously-compacted context when you need detail " +
      "that was summarised away. Provide either summaryIds (direct expansion) or " +
      "query (grep-first, then expand top matches). Returns a compact text payload " +
      "with cited IDs for follow-up.",
    parameters: LcmExpandSchema,
    async execute(_toolCallId, params) {
      ensureContextEnginesInitialized();
      const engine = await resolveContextEngine(options?.config);

      if (engine.info.id !== "lcm") {
        return jsonResult({
          error: "lcm_expand requires the LCM context engine to be active.",
        });
      }

      const lcm = engine as LcmContextEngine;
      const retrieval = lcm.getRetrieval();
      const orchestrator = new ExpansionOrchestrator(retrieval);
      const runtimeAuthManager = getRuntimeExpansionAuthManager();

      const p = params as Record<string, unknown>;
      const summaryIds = p.summaryIds as string[] | undefined;
      const query = typeof p.query === "string" ? p.query.trim() : undefined;
      const maxDepth = typeof p.maxDepth === "number" ? Math.trunc(p.maxDepth) : undefined;
      const requestedTokenCap = typeof p.tokenCap === "number" ? Math.trunc(p.tokenCap) : undefined;
      const tokenCap =
        typeof requestedTokenCap === "number" && Number.isFinite(requestedTokenCap)
          ? Math.max(1, requestedTokenCap)
          : undefined;
      const includeMessages = typeof p.includeMessages === "boolean" ? p.includeMessages : false;
      const sessionKey = typeof options?.sessionId === "string" ? options.sessionId.trim() : "";
      if (!isSubagentSessionKey(sessionKey)) {
        return jsonResult({
          error:
            "lcm_expand is only available in sub-agent sessions. Use lcm_expand_query to ask a focused question against expanded summaries, or lcm_describe/lcm_grep for lighter lookups.",
        });
      }
      const isDelegatedSession = isSubagentSessionKey(sessionKey);
      const delegatedGrantId = isDelegatedSession
        ? (resolveDelegatedExpansionGrantId(sessionKey) ?? undefined)
        : undefined;
      const delegatedGrant =
        delegatedGrantId !== undefined ? runtimeAuthManager.getGrant(delegatedGrantId) : null;
      const authorizedOrchestrator =
        delegatedGrantId !== undefined ? wrapWithAuth(orchestrator, runtimeAuthManager) : null;

      if (isDelegatedSession && !delegatedGrantId) {
        return jsonResult({
          error:
            "Delegated expansion requires a valid grant. This sub-agent session has no propagated expansion grant.",
        });
      }

      const conversationScope = await resolveLcmConversationScope({
        lcm,
        sessionId: options?.sessionId,
        params: p,
      });

      const runExpand = async (input: {
        summaryIds: string[];
        conversationId: number;
        maxDepth?: number;
        tokenCap?: number;
        includeMessages?: boolean;
      }) => {
        if (!authorizedOrchestrator || !delegatedGrantId) {
          return orchestrator.expand(input);
        }
        return authorizedOrchestrator.expand(delegatedGrantId, input);
      };

      const resolvedConversationId =
        conversationScope.conversationId ??
        (delegatedGrant?.allowedConversationIds.length === 1
          ? delegatedGrant.allowedConversationIds[0]
          : undefined);

      if (query) {
        try {
          if (resolvedConversationId == null) {
            const result = await orchestrator.describeAndExpand({
              query,
              mode: "full_text",
              conversationId: undefined,
              maxDepth,
              tokenCap,
            });
            const text = distillForSubagent(result);
            const policy = decideLcmExpansionRouting({
              intent: "query_probe",
              query,
              requestedMaxDepth: maxDepth,
              candidateSummaryCount: result.expansions.length,
              tokenCap: tokenCap ?? Number.MAX_SAFE_INTEGER,
              includeMessages: false,
            });
            return {
              content: [{ type: "text", text }],
              details: {
                expansionCount: result.expansions.length,
                citedIds: result.citedIds,
                totalTokens: result.totalTokens,
                truncated: result.truncated,
                policy,
                executionPath: "direct",
                observability: buildOrchestrationObservability({
                  policy,
                  executionPath: "direct",
                }),
              },
            };
          }
          const grepResult = await retrieval.grep({
            query,
            mode: "full_text",
            scope: "summaries",
            conversationId: resolvedConversationId,
          });
          const matchedSummaryIds = grepResult.summaries.map((entry) => entry.summaryId);
          const policy = decideLcmExpansionRouting({
            intent: "query_probe",
            query,
            requestedMaxDepth: maxDepth,
            candidateSummaryCount: matchedSummaryIds.length,
            tokenCap: tokenCap ?? Number.MAX_SAFE_INTEGER,
            includeMessages: false,
          });
          const canDelegate =
            matchedSummaryIds.length > 0 &&
            policy.action === "delegate_traversal" &&
            !isDelegatedSession &&
            !!sessionKey;
          const delegated =
            canDelegate && resolvedConversationId != null
              ? await runDelegatedExpansionLoop({
                  requesterSessionKey: sessionKey,
                  conversationId: resolvedConversationId,
                  summaryIds: matchedSummaryIds,
                  maxDepth,
                  tokenCap,
                  includeMessages: false,
                  query,
                })
              : undefined;
          if (delegated && delegated.status === "ok") {
            return {
              content: [{ type: "text", text: delegated.text }],
              details: {
                expansionCount: delegated.citedIds.length,
                citedIds: delegated.citedIds,
                totalTokens: delegated.totalTokens,
                truncated: delegated.truncated,
                policy,
                executionPath: "delegated",
                delegated,
                observability: buildOrchestrationObservability({
                  policy,
                  executionPath: "delegated",
                  delegated,
                }),
              },
            };
          }

          const executionPath = delegated ? "direct_fallback" : "direct";
          const result =
            matchedSummaryIds.length === 0
              ? makeEmptyExpansionResult()
              : await runExpand({
                  summaryIds: matchedSummaryIds,
                  maxDepth,
                  tokenCap,
                  includeMessages: false,
                  conversationId: resolvedConversationId,
                });
          const text = distillForSubagent(result);
          return {
            content: [{ type: "text", text }],
            details: {
              expansionCount: result.expansions.length,
              citedIds: result.citedIds,
              totalTokens: result.totalTokens,
              truncated: result.truncated,
              policy,
              executionPath,
              delegated:
                delegated && delegated.status !== "ok"
                  ? {
                      status: delegated.status,
                      error: delegated.error,
                      passes: delegated.passes,
                    }
                  : undefined,
              observability: buildOrchestrationObservability({
                policy,
                executionPath,
                delegated,
              }),
            },
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResult({ error: message });
        }
      }

      if (summaryIds && summaryIds.length > 0) {
        try {
          if (conversationScope.conversationId != null) {
            const outOfScope: string[] = [];
            for (const summaryId of summaryIds) {
              const described = await retrieval.describe(summaryId);
              if (
                described?.type === "summary" &&
                described.summary?.conversationId !== conversationScope.conversationId
              ) {
                outOfScope.push(summaryId);
              }
            }
            if (outOfScope.length > 0) {
              return jsonResult({
                error:
                  `Some summaryIds are outside conversation ${conversationScope.conversationId}: ` +
                  outOfScope.join(", "),
                hint: "Use allConversations=true for cross-conversation expansion.",
              });
            }
          }

          const policy = decideLcmExpansionRouting({
            intent: "explicit_expand",
            requestedMaxDepth: maxDepth,
            candidateSummaryCount: summaryIds.length,
            tokenCap: tokenCap ?? Number.MAX_SAFE_INTEGER,
            includeMessages,
          });
          const normalizedSummaryIds = normalizeSummaryIds(summaryIds);
          const canDelegate =
            normalizedSummaryIds.length > 0 &&
            policy.action === "delegate_traversal" &&
            !isDelegatedSession &&
            !!sessionKey &&
            resolvedConversationId != null;
          const delegated = canDelegate
            ? await runDelegatedExpansionLoop({
                requesterSessionKey: sessionKey,
                conversationId: resolvedConversationId,
                summaryIds: normalizedSummaryIds,
                maxDepth,
                tokenCap,
                includeMessages,
              })
            : undefined;
          if (delegated && delegated.status === "ok") {
            return {
              content: [{ type: "text", text: delegated.text }],
              details: {
                expansionCount: delegated.citedIds.length,
                citedIds: delegated.citedIds,
                totalTokens: delegated.totalTokens,
                truncated: delegated.truncated,
                policy,
                executionPath: "delegated",
                delegated,
                observability: buildOrchestrationObservability({
                  policy,
                  executionPath: "delegated",
                  delegated,
                }),
              },
            };
          }
          const executionPath = delegated ? "direct_fallback" : "direct";
          const result = await runExpand({
            summaryIds: normalizedSummaryIds,
            maxDepth,
            tokenCap,
            includeMessages,
            conversationId: resolvedConversationId ?? 0,
          });
          const text = distillForSubagent(result);
          return {
            content: [{ type: "text", text }],
            details: {
              expansionCount: result.expansions.length,
              citedIds: result.citedIds,
              totalTokens: result.totalTokens,
              truncated: result.truncated,
              policy,
              executionPath,
              delegated:
                delegated && delegated.status !== "ok"
                  ? {
                      status: delegated.status,
                      error: delegated.error,
                      passes: delegated.passes,
                    }
                  : undefined,
              observability: buildOrchestrationObservability({
                policy,
                executionPath,
                delegated,
              }),
            },
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResult({ error: message });
        }
      }

      return jsonResult({
        error: "Either summaryIds or query must be provided.",
      });
    },
  };
}
