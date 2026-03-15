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

const LcmDescribeSchema = Type.Object({
  id: Type.String({
    description:
      "The LCM ID to look up. Use sum_xxx for summaries, file_xxx for files, ptr_xxx for collapsed pointers.",
  }),
  query: Type.Optional(
    Type.String({
      description:
        "Search within a pointer's source messages for this pattern (substring match). Only used with ptr_xxx IDs.",
    }),
  ),
  conversationId: Type.Optional(
    Type.Number({
      description:
        "Conversation ID to scope describe lookups to. If omitted, uses the current session conversation.",
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
});

function normalizeRequestedTokenCap(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.trunc(value));
}

function formatIso(value: Date | null | undefined, timezone?: string): string {
  if (!(value instanceof Date)) return "-";
  if (timezone) {
    return formatTimestamp(value, timezone);
  }
  return value.toISOString();
}

export function createLcmDescribeTool(input: {
  deps: LcmDependencies;
  lcm: LcmContextEngine;
  sessionId?: string;
  sessionKey?: string;
}): AnyAgentTool {
  return {
    name: "lcm_describe",
    label: "LCM Describe",
    description:
      "Look up metadata and content for an LCM item by ID. " +
      "Use this to inspect summaries (sum_xxx), stored files (file_xxx), " +
      "or collapsed pointers (ptr_xxx) from compacted conversation history. " +
      "Returns summary content, lineage, token counts, pointer previews, " +
      "and file exploration results. For pointers, use optional query parameter " +
      "to search within collapsed content without expanding.",
    parameters: LcmDescribeSchema,
    async execute(_toolCallId, params) {
      const retrieval = input.lcm.getRetrieval();
      const timezone = input.lcm.timezone;
      const p = params as Record<string, unknown>;
      const id = (p.id as string).trim();
      const conversationScope = await resolveLcmConversationScope({
        lcm: input.lcm,
        deps: input.deps,
        sessionId: input.sessionId,
        sessionKey: input.sessionKey,
        params: p,
      });
      if (!conversationScope.allConversations && conversationScope.conversationId == null) {
        return jsonResult({
          error:
            "No LCM conversation found for this session. Provide conversationId or set allConversations=true.",
        });
      }

      const result = await retrieval.describe(id);

      if (!result) {
        return jsonResult({
          error: `Not found: ${id}`,
          hint: "Check the ID format (sum_xxx for summaries, file_xxx for files, ptr_xxx for pointers).",
        });
      }
      if (conversationScope.conversationId != null) {
        const itemConversationId =
          result.type === "summary"
            ? result.summary?.conversationId
            : result.type === "pointer"
              ? result.pointer?.conversationId
              : result.file?.conversationId;
        if (itemConversationId != null && itemConversationId !== conversationScope.conversationId) {
          return jsonResult({
            error: `Not found in conversation ${conversationScope.conversationId}: ${id}`,
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
            `desc=${s.descendantCount} range=${formatIso(s.earliestAt, timezone)}..${formatIso(s.latestAt, timezone)} ` +
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
              `range=${formatIso(node.earliestAt, timezone)}..${formatIso(node.latestAt, timezone)} ` +
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
            ...result,
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
        lines.push(`**Created:** ${formatIso(f.createdAt, timezone)}`);
        if (f.explorationSummary) {
          lines.push("");
          lines.push("## Exploration Summary");
          lines.push("");
          lines.push(f.explorationSummary);
        } else {
          lines.push("");
          lines.push("*No exploration summary available.*");
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: result,
        };
      }

      if (result.type === "pointer" && result.pointer) {
        const ptr = result.pointer;
        const query = typeof p.query === "string" ? p.query.trim() : "";

        // If query is provided, search within source messages
        if (query) {
          const matches: Array<{
            id: number;
            role: string;
            snippet: string;
            tokens: number;
          }> = [];

          for (const src of ptr.sourceMessages) {
            const idx = src.content.toLowerCase().indexOf(query.toLowerCase());
            if (idx >= 0) {
              const snippetStart = Math.max(0, idx - 40);
              const snippetEnd = Math.min(src.content.length, idx + query.length + 40);
              const snippet =
                (snippetStart > 0 ? "..." : "") +
                src.content.slice(snippetStart, snippetEnd) +
                (snippetEnd < src.content.length ? "..." : "");
              matches.push({
                id: src.messageId,
                role: src.role,
                snippet,
                tokens: src.tokenCount,
              });
            }
          }

          return jsonResult({
            id,
            query,
            matches,
            totalSources: ptr.sourceMessages.length,
            matchCount: matches.length,
          });
        }

        // Full pointer describe
        const totalTokens = ptr.sourceMessages.reduce((sum, m) => sum + m.tokenCount, 0);

        // Build concatenated preview (~500 chars)
        let previewText = "";
        for (const src of ptr.sourceMessages) {
          if (previewText.length >= 500) break;
          previewText += src.content.slice(0, 500 - previewText.length);
        }
        if (previewText.length > 500) {
          previewText = previewText.slice(0, 497) + "...";
        }

        const sources = ptr.sourceMessages.map((src) => ({
          id: src.messageId,
          role: src.role,
          tokens: src.tokenCount,
          preview: src.content.slice(0, 100) + (src.content.length > 100 ? "..." : ""),
        }));

        let parsedData: unknown = undefined;
        if (ptr.data) {
          try {
            parsedData = JSON.parse(ptr.data);
          } catch {
            parsedData = ptr.data;
          }
        }

        // Find related pointers (those sharing tags)
        let relatedPointers: Array<{ id: string; label: string; sharedTags: string[] }> = [];
        if (ptr.tags && ptr.tags.length > 0) {
          const summaryStore = input.lcm.getSummaryStore();
          const related = await summaryStore.getRelatedPointers(id, ptr.conversationId);
          relatedPointers = related.map((rp) => ({
            id: rp.pointerId,
            label: rp.label,
            sharedTags: rp.tags.filter((t) => ptr.tags.includes(t)),
          }));
        }

        return jsonResult({
          id,
          type: "pointer",
          label: ptr.label,
          tags: ptr.tags ?? [],
          status: ptr.status ?? "active",
          data: parsedData ?? null,
          sourceCount: ptr.sourceMessages.length,
          totalTokens,
          tokensSaved: ptr.tokensSaved,
          created: formatIso(ptr.createdAt, timezone),
          preview: previewText,
          sources,
          ...(relatedPointers.length > 0 ? { relatedPointers } : {}),
        });
      }

      return jsonResult(result);
    },
  };
}
