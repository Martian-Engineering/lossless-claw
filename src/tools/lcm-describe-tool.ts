import { Type } from "@sinclair/typebox";
import type { LcmContextEngine } from "../engine.js";
import {
  getRuntimeExpansionAuthManager,
  resolveDelegatedExpansionGrantId,
} from "../expansion-auth.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { resolveLcmConversationScope } from "./lcm-conversation-scope.js";
import { formatTimestamp } from "../compaction.js";

function formatDisplayTime(
  value: Date | string | number | null | undefined,
  timezone: string,
): string {
  if (value == null) {
    return "-";
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return formatTimestamp(date, timezone);
}

const LcmDescribeSchema = Type.Object({
  id: Type.String({
    description: "The LCM ID to look up. Use sum_xxx for summaries, file_xxx for files.",
  }),
  conversationId: Type.Optional(
    Type.Number({
      description:
        "Physical conversation ID to scope describe lookups to. If omitted, uses the current session family.",
    }),
  ),
  allConversations: Type.Optional(
    Type.Boolean({
      description:
        "Set true to explicitly allow lookups across all conversations. Ignored when conversationId is provided.",
    }),
  ),
  tokenCap: Type.Optional(
    Type.Number({
      description: "Optional budget cap used for subtree manifest budget-fit annotations.",
      minimum: 1,
    }),
  ),
  expandFile: Type.Optional(
    Type.Boolean({
      description:
        "When true (and target is a file_xxx), inline the file's content from disk. " +
        "Combined with the file's exploration_summary, this is how an agent recovers " +
        "the original output of an elided tool result that was replaced with a " +
        "[LCM Tool Output: file_xxx | tool=… | N bytes] reference. Capped at " +
        "expandFileMaxBytes (default 32768 = ~8K tokens). Returns content + " +
        "contentTruncated boolean. Use lcm_grep to search across the full file when " +
        "it exceeds the cap.",
    }),
  ),
  expandFileMaxBytes: Type.Optional(
    Type.Number({
      description: "Max bytes of inlined file content when expandFile=true. Default 32768. Hard cap 512000.",
      minimum: 1024,
      maximum: 512_000,
    }),
  ),
});

function normalizeRequestedTokenCap(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.trunc(value));
}

function compactDescribeDetails(result: Awaited<ReturnType<LcmContextEngine["getRetrieval"]>["describe"]>) {
  if (!result) {
    return result;
  }
  if (result.type === "summary" && result.summary) {
    const { content: _content, subtree: _subtree, ...summary } = result.summary;
    return {
      id: result.id,
      type: result.type,
      summary,
    };
  }
  if (result.type === "file" && result.file) {
    const { explorationSummary: _explorationSummary, ...file } = result.file;
    return {
      id: result.id,
      type: result.type,
      file: {
        ...file,
        hasExplorationSummary: Boolean(result.file.explorationSummary),
      },
    };
  }
  return { id: result.id, type: result.type };
}

export function createLcmDescribeTool(input: {
  deps: LcmDependencies;
  lcm?: LcmContextEngine;
  getLcm?: () => Promise<LcmContextEngine>;
  sessionId?: string;
  sessionKey?: string;
}): AnyAgentTool {
  return {
    name: "lcm_describe",
    label: "LCM Describe",
    description:
      "Look up metadata and content for an LCM item by ID. " +
      "Use this to inspect summaries (sum_xxx) or stored files (file_xxx) " +
      "from compacted conversation history. Returns summary content, lineage, " +
      "token counts, and file exploration results. " +
      "ALSO USE THIS when you see a `[LCM Tool Output: file_xxx | tool=… | N bytes]` " +
      "reference in the conversation — that means an older tool result was elided " +
      "for context efficiency. Call lcm_describe(id=file_xxx, expandFile=true) to " +
      "fetch the original output content before answering questions that depend on " +
      "its specifics.",
    parameters: LcmDescribeSchema,
    async execute(_toolCallId, params) {
      const lcm = input.lcm ?? (await input.getLcm?.());
      if (!lcm) {
        throw new Error("LCM engine is unavailable.");
      }
      const retrieval = lcm.getRetrieval();
      const timezone = lcm.timezone;
      const p = params as Record<string, unknown>;
      const id = (p.id as string).trim();
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
      if (
        !conversationScope.allConversations
        && conversationScope.conversationId == null
        && (conversationScope.conversationIds?.length ?? 0) === 0
      ) {
        return jsonResult({
          error:
            "No LCM conversation found for this session. Provide conversationId or set allConversations=true.",
        });
      }

      // v4.2 §B — pass expandFile + largeFilesDir through so file_xxx
      // drilldowns can return on-disk content. Path validation in
      // retrieval.describeFile rejects URIs outside largeFilesDir.
      const expandFile = p.expandFile === true;
      const expandFileMaxBytes =
        typeof p.expandFileMaxBytes === "number" && Number.isFinite(p.expandFileMaxBytes)
          ? p.expandFileMaxBytes
          : undefined;
      const result = await retrieval.describe(id, {
        expandFile,
        expandFileMaxBytes,
        // Optional-chained for test mocks that may not expose configView.
        largeFilesDir: lcm.configView?.largeFilesDir,
      });

      if (!result) {
        return jsonResult({
          error: `Not found: ${id}`,
          hint: "Check the ID format (sum_xxx for summaries, file_xxx for files).",
        });
      }
      if (
        conversationScope.conversationId != null
        || (conversationScope.conversationIds?.length ?? 0) > 0
      ) {
        const itemConversationId =
          result.type === "summary" ? result.summary?.conversationId : result.file?.conversationId;
        const allowedConversationIds = new Set(
          (conversationScope.conversationIds?.length ?? 0) > 0
            ? conversationScope.conversationIds
            : conversationScope.conversationId != null
              ? [conversationScope.conversationId]
              : [],
        );
        if (itemConversationId != null && !allowedConversationIds.has(itemConversationId)) {
          return jsonResult({
            error: conversationScope.delegated
              ? `Not found in delegated conversation scope: ${id}`
              : `Not found in this session scope: ${id}`,
            hint: "Use allConversations=true for cross-conversation lookup.",
          });
        }
      }

      if (result.type === "summary" && result.summary) {
        const s = result.summary;
        const requestedTokenCap = normalizeRequestedTokenCap((params as Record<string, unknown>).tokenCap);
        const sessionKey =
          (typeof input.sessionKey === "string" ? input.sessionKey : input.sessionId)?.trim() ?? "";
        const delegatedGrantId = input.deps.isSubagentSessionKey(sessionKey)
          ? (resolveDelegatedExpansionGrantId(sessionKey) ?? "")
          : "";
        const delegatedRemainingBudget =
          delegatedGrantId !== ""
            ? getRuntimeExpansionAuthManager().getRemainingTokenBudget(delegatedGrantId)
            : null;
        const defaultTokenCap = Math.max(1, Math.trunc(input.deps.config.maxExpandTokens));
        const resolvedTokenCap = (() => {
          const base =
            requestedTokenCap ??
            (typeof delegatedRemainingBudget === "number" ? delegatedRemainingBudget : defaultTokenCap);
          if (typeof delegatedRemainingBudget === "number") {
            return Math.max(0, Math.min(base, delegatedRemainingBudget));
          }
          return Math.max(1, base);
        })();

        const manifestNodes = s.subtree.map((node) => {
          const summariesOnlyCost = Math.max(0, node.tokenCount + node.descendantTokenCount);
          const withMessagesCost = Math.max(0, summariesOnlyCost + node.sourceMessageTokenCount);
          return {
            summaryId: node.summaryId,
            parentSummaryId: node.parentSummaryId,
            depthFromRoot: node.depthFromRoot,
            depth: node.depth,
            kind: node.kind,
            tokenCount: node.tokenCount,
            descendantCount: node.descendantCount,
            descendantTokenCount: node.descendantTokenCount,
            sourceMessageTokenCount: node.sourceMessageTokenCount,
            childCount: node.childCount,
            earliestAt: node.earliestAt,
            latestAt: node.latestAt,
            path: node.path,
            costs: {
              summariesOnly: summariesOnlyCost,
              withMessages: withMessagesCost,
            },
            budgetFit: {
              summariesOnly: summariesOnlyCost <= resolvedTokenCap,
              withMessages: withMessagesCost <= resolvedTokenCap,
            },
          };
        });

        const lines: string[] = [];
        lines.push(`LCM_SUMMARY ${id}`);
        lines.push(
          `meta conv=${s.conversationId} kind=${s.kind} depth=${s.depth} tok=${s.tokenCount} ` +
            `descTok=${s.descendantTokenCount} srcTok=${s.sourceMessageTokenCount} ` +
            `desc=${s.descendantCount} range=${formatDisplayTime(s.earliestAt, timezone)}..${formatDisplayTime(s.latestAt, timezone)} ` +
            `budgetCap=${resolvedTokenCap}`,
        );
        if (s.parentIds.length > 0) {
          lines.push(`parents ${s.parentIds.join(" ")}`);
        }
        if (s.childIds.length > 0) {
          lines.push(`children ${s.childIds.join(" ")}`);
        }
        lines.push("manifest");
        for (const node of manifestNodes) {
          lines.push(
            `d${node.depthFromRoot} ${node.summaryId} k=${node.kind} tok=${node.tokenCount} ` +
              `descTok=${node.descendantTokenCount} srcTok=${node.sourceMessageTokenCount} ` +
              `desc=${node.descendantCount} child=${node.childCount} ` +
              `range=${formatDisplayTime(node.earliestAt, timezone)}..${formatDisplayTime(node.latestAt, timezone)} ` +
              `cost[s=${node.costs.summariesOnly},m=${node.costs.withMessages}] ` +
              `budget[s=${node.budgetFit.summariesOnly ? "in" : "over"},` +
              `m=${node.budgetFit.withMessages ? "in" : "over"}]`,
          );
        }
        lines.push("content");
        lines.push(s.content);

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            ...compactDescribeDetails(result),
            manifest: {
              tokenCap: resolvedTokenCap,
              budgetSource:
                requestedTokenCap != null
                  ? "request"
                  : typeof delegatedRemainingBudget === "number"
                    ? "delegated_grant_remaining"
                    : "config_default",
              nodes: manifestNodes,
            },
          },
        };
      }

      if (result.type === "file" && result.file) {
        const f = result.file;
        const lines: string[] = [];
        lines.push(`## LCM File: ${id}`);
        lines.push("");
        lines.push(`**Conversation:** ${f.conversationId}`);
        lines.push(`**Name:** ${f.fileName ?? "(no name)"}`);
        lines.push(`**Type:** ${f.mimeType ?? "unknown"}`);
        if (f.byteSize != null) {
          lines.push(`**Size:** ${f.byteSize.toLocaleString()} bytes`);
        }
        lines.push(`**Created:** ${formatDisplayTime(f.createdAt, timezone)}`);
        if (f.explorationSummary) {
          lines.push("");
          lines.push("## Exploration Summary");
          lines.push("");
          lines.push(f.explorationSummary);
        } else {
          lines.push("");
          lines.push("*No exploration summary available.*");
        }
        // v4.2 §B — when expandFile=true, retrieval reads on-disk content
        // and inlines it. Show it under a "Content" heading; flag truncation.
        if (typeof f.content === "string") {
          lines.push("");
          lines.push("## Content");
          lines.push("");
          lines.push("```");
          lines.push(f.content);
          lines.push("```");
          if (f.contentTruncated) {
            lines.push("");
            lines.push(
              `*Output truncated to ${f.content.length.toLocaleString()} of ${f.byteSize?.toLocaleString() ?? "?"} bytes. ` +
              `Use lcm_grep against the file id to search the full content.*`,
            );
          }
        } else if (expandFile) {
          lines.push("");
          lines.push("*Content unavailable: file missing on disk or path failed validation.*");
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: compactDescribeDetails(result),
        };
      }

      return jsonResult(result);
    },
  };
}
