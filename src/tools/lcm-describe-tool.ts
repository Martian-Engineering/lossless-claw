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
  expandChildren: Type.Optional(
    Type.Boolean({
      description:
        "When true (and target is a sum_xxx), include the first-hop child summaries' full content inline (capped at expandChildrenLimit, default 5). For deeper / wider expansion use the sub-agent lcm_expand_query path. Ignored for file_xxx targets.",
    }),
  ),
  expandChildrenLimit: Type.Optional(
    Type.Number({
      description: "Max child summaries to inline when expandChildren=true (default 20, max 50).",
      minimum: 1,
      maximum: 50,
    }),
  ),
  expandMessages: Type.Optional(
    Type.Boolean({
      description:
        "When true (and target is a sum_xxx leaf), include the first-hop source messages' full verbatim content inline (capped at expandMessagesLimit, default 20). Ignored for condensed summaries (no direct messages) and file_xxx targets. Suppressed messages are filtered out.",
    }),
  ),
  expandMessagesLimit: Type.Optional(
    Type.Number({
      description: "Max source messages to inline when expandMessages=true (default 20, max 50).",
      minimum: 1,
      maximum: 50,
    }),
  ),
  expandMessagesOffset: Type.Optional(
    Type.Number({
      description:
        "Skip the first N messages before returning expandMessagesLimit. Use to paginate through long leaves (e.g. 216-message leaves where the default 20 only covers ~10% of source). Default 0.",
      minimum: 0,
    }),
  ),
});

function normalizeRequestedTokenCap(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.trunc(value));
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
      "token counts, and file exploration results.",
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
          hint: "Check the ID format (sum_xxx for summaries, file_xxx for files).",
        });
      }
      if (conversationScope.conversationId != null) {
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
            error: `Not found in this session scope: ${id}`,
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
          `meta conv=${s.conversationId} sessionKey=${s.sessionKey || "-"} kind=${s.kind} depth=${s.depth} tok=${s.tokenCount} ` +
            `descTok=${s.descendantTokenCount} srcTok=${s.sourceMessageTokenCount} ` +
            `desc=${s.descendantCount} range=${formatDisplayTime(s.earliestAt, timezone)}..${formatDisplayTime(s.latestAt, timezone)} ` +
            `created=${formatDisplayTime(s.createdAt, timezone)} ` +
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
        // P4 harness fix: emit a HEADER signal line BEFORE content (which
        // can be very long for condensed summaries). The detailed expansion
        // sections still go below content, but the early header guarantees
        // an agent sees the empty-vs-found signal even when content gets
        // truncated by an outer wrapper.
        // Audit 2 finding #5: the early signal must NOT promise candidates
        // when all of them might be suppressed; phrase it as "raw count
        // before suppression filter — see details for survivors".
        const expandChildren = p.expandChildren === true;
        const expandMessages = p.expandMessages === true;
        if (expandChildren) {
          if (s.childIds.length === 0) {
            lines.push("expansion (children): 0 — terminal node, nothing to drill into");
          } else {
            lines.push(
              `expansion (children): ${s.childIds.length} raw candidate(s) before suppression filter; survivors + details below`,
            );
          }
        }
        if (expandMessages) {
          if (s.kind !== "leaf") {
            lines.push("expansion (messages): n/a — target is not a leaf");
          }
        }
        lines.push("content");
        lines.push(s.content);

        // Phase 2.9 — one-hop expansion flags. Lets main agents see source
        // children + messages WITHOUT delegating through lcm_expand_query
        // (which paraphrases via sub-agent LLM call). The lcm_expand sub-
        // agent gate stays intact for deeper traversal; this is the
        // "describe is safe" mental model extension Agent 2 recommended.
        // Hard-capped (default 20, max 50) to prevent runaway context loads.
        const expandedChildren: Array<{
          summaryId: string;
          kind: string;
          tokenCount: number;
          createdAt: string;
          content: string;
        }> = [];
        const expandedMessages: Array<{
          messageId: number;
          role: string;
          tokenCount: number;
          createdAt: string;
          content: string;
        }> = [];

        // P4 FIX (2026-05-06 harness): always emit a status line when
        // expandChildren is requested — silent empty was indistinguishable
        // from "tool ignored my flag" / "node terminal" / "all suppressed".
        let expandChildrenStatus:
          | "no-children"
          | "all-suppressed"
          | "ok"
          | "capped"
          | "skipped-non-summary"
          | undefined;
        if (expandChildren) {
          if (s.childIds.length === 0) {
            expandChildrenStatus = "no-children";
            lines.push("");
            lines.push(
              `expanded children: 0 (this node has no children — it is a terminal in the DAG; nothing to drill into)`,
            );
          } else {
            const requestedLimit =
              typeof p.expandChildrenLimit === "number" && Number.isFinite(p.expandChildrenLimit)
                ? Math.max(1, Math.min(50, Math.trunc(p.expandChildrenLimit)))
                : 20;
            const ids = s.childIds.slice(0, requestedLimit);
            const placeholders = ids.map(() => "?").join(",");
            const db = lcm.getDb();
            const rows = db
              .prepare(
                `SELECT summary_id, kind, content, token_count, created_at
                   FROM summaries
                   WHERE summary_id IN (${placeholders})
                     AND suppressed_at IS NULL
                   ORDER BY created_at ASC`,
              )
              .all(...ids) as Array<{
              summary_id: string;
              kind: string;
              content: string;
              token_count: number;
              created_at: string;
            }>;
            for (const r of rows) {
              expandedChildren.push({
                summaryId: r.summary_id,
                kind: r.kind,
                tokenCount: r.token_count,
                createdAt: r.created_at,
                content: r.content,
              });
            }
            const requestedCount = ids.length;
            const survived = expandedChildren.length;
            const totalChildren = s.childIds.length;
            const wasCapped = totalChildren > requestedLimit;
            if (survived === 0) {
              expandChildrenStatus = "all-suppressed";
              lines.push("");
              lines.push(
                `expanded children: 0/${totalChildren} (all children are suppressed — none returned; the node has children but they have been removed from the agent surface)`,
              );
            } else {
              expandChildrenStatus = wasCapped ? "capped" : "ok";
              lines.push("");
              const suffix =
                survived < requestedCount
                  ? ` (${requestedCount - survived} children suppressed and filtered out)`
                  : "";
              lines.push(
                `expanded children: ${survived}/${totalChildren}${
                  wasCapped ? ` (capped at limit=${requestedLimit}; raise expandChildrenLimit up to 50 for more)` : ""
                }${suffix}`,
              );
              for (const child of expandedChildren) {
                lines.push("");
                lines.push(
                  `### child ${child.summaryId} (${child.kind}, ${child.tokenCount} tokens, ${formatDisplayTime(child.createdAt, timezone)})`,
                );
                lines.push("");
                lines.push(child.content);
              }
            }
          }
        }

        // P4+P5 FIX: always emit status line; default cap raised 5→20 with
        // optional `expandMessagesOffset` for pagination on long leaves.
        let expandMessagesStatus:
          | "not-leaf"
          | "no-messages"
          | "all-suppressed"
          | "ok"
          | "capped"
          | "offset-past-end"
          | undefined;
        if (expandMessages) {
          if (s.kind !== "leaf") {
            expandMessagesStatus = "not-leaf";
            lines.push("");
            lines.push(
              `expanded source messages: 0 (target is a ${s.kind} summary, not a leaf — condensed summaries don't have direct messages; expand its children first to find leaves)`,
            );
          } else {
            const requestedLimit =
              typeof p.expandMessagesLimit === "number" && Number.isFinite(p.expandMessagesLimit)
                ? Math.max(1, Math.min(50, Math.trunc(p.expandMessagesLimit)))
                : 20;
            // Audit 2 finding #4: clamp offset upper-bound so an adversarial
            // / runaway agent can't trigger LIMIT/OFFSET full-table scans.
            // 100k messages is well past any realistic leaf size (max
            // observed: 216) and stops a runaway loop from costing seconds-
            // per-call.
            const OFFSET_HARD_CAP = 100_000;
            const requestedOffset =
              typeof p.expandMessagesOffset === "number" && Number.isFinite(p.expandMessagesOffset)
                ? Math.max(0, Math.min(OFFSET_HARD_CAP, Math.trunc(p.expandMessagesOffset)))
                : 0;
            const db = lcm.getDb();
            // Total source-message count (before offset/limit) to drive the
            // capped-vs-ok status + pagination hint.
            const totalRow = db
              .prepare(
                `SELECT COUNT(*) AS n
                   FROM summary_messages sm
                   JOIN messages m ON m.message_id = sm.message_id
                   WHERE sm.summary_id = ?
                     AND m.suppressed_at IS NULL`,
              )
              .get(id) as { n: number };
            const totalMessages = totalRow?.n ?? 0;

            const rows = db
              .prepare(
                `SELECT m.message_id, m.role, m.content, m.token_count, m.created_at
                   FROM summary_messages sm
                   JOIN messages m ON m.message_id = sm.message_id
                   WHERE sm.summary_id = ?
                     AND m.suppressed_at IS NULL
                   ORDER BY m.created_at ASC
                   LIMIT ? OFFSET ?`,
              )
              .all(id, requestedLimit, requestedOffset) as Array<{
              message_id: number;
              role: string;
              content: string;
              token_count: number;
              created_at: string;
            }>;
            for (const r of rows) {
              expandedMessages.push({
                messageId: r.message_id,
                role: r.role,
                tokenCount: r.token_count,
                createdAt: r.created_at,
                content: r.content,
              });
            }
            if (totalMessages === 0) {
              expandMessagesStatus = "no-messages";
              lines.push("");
              lines.push(
                `expanded source messages: 0 (this leaf has no associated messages — likely a synthetic / migrated leaf without source-message lineage)`,
              );
            } else if (expandedMessages.length === 0) {
              // Either offset went past the end or all in-range messages
              // were suppressed. Audit 2 finding #6 fix: distinct status
              // for offset-past-end so callers don't read "ok" + 0 results
              // and conclude the leaf is empty.
              expandMessagesStatus =
                requestedOffset >= totalMessages
                  ? "offset-past-end"
                  : "all-suppressed";
              lines.push("");
              if (requestedOffset >= totalMessages) {
                lines.push(
                  `expanded source messages: 0/${totalMessages} (offset=${requestedOffset} is past the end; reduce offset to see content)`,
                );
              } else {
                lines.push(
                  `expanded source messages: 0/${totalMessages} (all messages in this offset window were suppressed and filtered out)`,
                );
              }
            } else {
              const remaining =
                totalMessages - (requestedOffset + expandedMessages.length);
              expandMessagesStatus = remaining > 0 ? "capped" : "ok";
              lines.push("");
              const range = `[${requestedOffset + 1}..${requestedOffset + expandedMessages.length}]`;
              const paginationHint =
                remaining > 0
                  ? ` — ${remaining} more after this window; paginate with expandMessagesOffset=${requestedOffset + expandedMessages.length}`
                  : "";
              lines.push(
                `expanded source messages: ${expandedMessages.length}/${totalMessages} ${range}${paginationHint}`,
              );
              for (const msg of expandedMessages) {
                lines.push("");
                lines.push(
                  `### msg#${msg.messageId} (${msg.role}, ${msg.tokenCount} tokens, ${formatDisplayTime(msg.createdAt, timezone)})`,
                );
                lines.push("");
                lines.push(msg.content);
              }
            }
          }
        }

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
            expansion: {
              children: expandedChildren,
              childrenStatus: expandChildrenStatus,
              messages: expandedMessages,
              messagesStatus: expandMessagesStatus,
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

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: result,
        };
      }

      return jsonResult(result);
    },
  };
}
