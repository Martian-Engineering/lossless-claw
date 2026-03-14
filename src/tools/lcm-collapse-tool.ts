import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { LcmContextEngine } from "../engine.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { resolveLcmConversationScope } from "./lcm-conversation-scope.js";


function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const LcmCollapseSchema = Type.Object({
  target: Type.String({
    description:
      'What to collapse: "last_tool" (most recent tool call + result), ' +
      '"messages:N" (last N messages before the fresh tail), ' +
      '"range:start-end" (ordinal range), or a summary ID (e.g. "sum_abc123").',
  }),
  label: Type.String({
    description: "One-line description for the collapsed pointer (e.g. \"webpage HTML from example.com\").",
  }),
  reason: Type.Optional(
    Type.String({
      description: "Why this content is being collapsed (e.g. \"accidentally pulled full page\").",
    }),
  ),
  conversationId: Type.Optional(
    Type.Number({
      description: "Conversation ID. Defaults to the current session conversation.",
    }),
  ),
});

export function createLcmCollapseTool(input: {
  deps: LcmDependencies;
  lcm: LcmContextEngine;
  sessionId?: string;
  sessionKey?: string;
}): AnyAgentTool {
  return {
    name: "lcm_collapse",
    label: "LCM Collapse",
    description:
      "Collapse content from active context into a lightweight pointer (~20 tokens). " +
      "Use this to actively manage your context window: collapse irrelevant tool output, " +
      "verbose content you no longer need, or old discussion that's taking up space. " +
      "The original content stays in storage and can be restored with lcm_expand_active.",
    parameters: LcmCollapseSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const target = (p.target as string).trim();
      const label = (p.label as string).trim();
      const reason = typeof p.reason === "string" ? p.reason.trim() : undefined;

      if (!target || !label) {
        return jsonResult({ error: "Both target and label are required." });
      }

      const conversationStore = input.lcm.getConversationStore();
      const summaryStore = input.lcm.getSummaryStore();

      // Resolve conversation
      const scope = await resolveLcmConversationScope({
        lcm: input.lcm,
        sessionKey: input.sessionKey,
        deps: input.deps,
        params: p,
      });

      if (!scope.conversationId) {
        return jsonResult({ error: "No conversation found for this session." });
      }

      const conversationId = scope.conversationId;
      const contextItems = await summaryStore.getContextItems(conversationId);

      if (contextItems.length === 0) {
        return jsonResult({ error: "No context items found." });
      }

      let startOrdinal: number;
      let endOrdinal: number;
      let sourceType: string;
      let sourceIds: string[] = [];
      let tokensSaved = 0;

      if (target === "last_tool") {
        // Find the most recent tool-related messages (assistant tool_call + tool result)
        // Walk backward from the end of context items
        let toolResultOrdinal: number | null = null;
        let toolCallOrdinal: number | null = null;

        for (let i = contextItems.length - 1; i >= 0; i--) {
          const item = contextItems[i];
          if (item.itemType === "message" && item.messageId != null) {
            const msg = await conversationStore.getMessageById(item.messageId);
            if (msg) {
              if (msg.role === "tool" && toolResultOrdinal === null) {
                toolResultOrdinal = item.ordinal;
                sourceIds.push(String(item.messageId));
                tokensSaved += msg.tokenCount > 0 ? msg.tokenCount : estimateTokens(msg.content);
              } else if (msg.role === "assistant" && toolResultOrdinal !== null) {
                // Check if this assistant message has a tool call
                toolCallOrdinal = item.ordinal;
                sourceIds.push(String(item.messageId));
                tokensSaved += msg.tokenCount > 0 ? msg.tokenCount : estimateTokens(msg.content);
                break;
              } else if (msg.role === "user" && toolResultOrdinal !== null) {
                // Went past the tool pair without finding the assistant call
                break;
              }
            }
          }
        }

        if (toolResultOrdinal === null) {
          return jsonResult({ error: "No tool call/result found in context to collapse." });
        }

        startOrdinal = toolCallOrdinal ?? toolResultOrdinal;
        endOrdinal = toolResultOrdinal;
        sourceType = "tool_output";
      } else if (target.startsWith("messages:")) {
        const count = parseInt(target.slice("messages:".length), 10);
        if (isNaN(count) || count < 1) {
          return jsonResult({ error: "Invalid message count. Use messages:N where N >= 1." });
        }

        // Get message-type items, excluding the fresh tail
        const messageItems = contextItems.filter(
          (item) => item.itemType === "message" && item.messageId != null,
        );

        if (messageItems.length === 0) {
          return jsonResult({ error: "No messages found to collapse." });
        }

        // Take the last N message items (before fresh tail would typically be)
        const toCollapse = messageItems.slice(-count);
        startOrdinal = toCollapse[0].ordinal;
        endOrdinal = toCollapse[toCollapse.length - 1].ordinal;
        sourceType = "messages";

        for (const item of toCollapse) {
          if (item.messageId != null) {
            sourceIds.push(String(item.messageId));
            const msg = await conversationStore.getMessageById(item.messageId);
            if (msg) {
              tokensSaved += msg.tokenCount > 0 ? msg.tokenCount : estimateTokens(msg.content);
            }
          }
        }
      } else if (target.startsWith("range:")) {
        const rangeParts = target.slice("range:".length).split("-").map(Number);
        if (rangeParts.length !== 2 || isNaN(rangeParts[0]) || isNaN(rangeParts[1])) {
          return jsonResult({ error: "Invalid range. Use range:start-end (ordinal numbers)." });
        }

        startOrdinal = rangeParts[0];
        endOrdinal = rangeParts[1];
        sourceType = "raw";

        const rangeItems = contextItems.filter(
          (item) => item.ordinal >= startOrdinal && item.ordinal <= endOrdinal,
        );

        for (const item of rangeItems) {
          if (item.messageId != null) {
            sourceIds.push(String(item.messageId));
            const msg = await conversationStore.getMessageById(item.messageId);
            if (msg) {
              tokensSaved += msg.tokenCount > 0 ? msg.tokenCount : estimateTokens(msg.content);
            }
          } else if (item.summaryId != null) {
            sourceIds.push(item.summaryId);
            const summary = await summaryStore.getSummary(item.summaryId);
            if (summary) {
              tokensSaved += summary.tokenCount;
            }
          }
        }
      } else if (target.startsWith("sum_")) {
        // Collapse a specific summary by ID
        const summaryItem = contextItems.find(
          (item) => item.itemType === "summary" && item.summaryId === target,
        );

        if (!summaryItem) {
          return jsonResult({ error: `Summary ${target} not found in active context.` });
        }

        startOrdinal = summaryItem.ordinal;
        endOrdinal = summaryItem.ordinal;
        sourceType = "summary";
        sourceIds = [target];

        const summary = await summaryStore.getSummary(target);
        if (summary) {
          tokensSaved = summary.tokenCount;
        }
      } else {
        return jsonResult({
          error:
            'Invalid target. Use "last_tool", "messages:N", "range:start-end", or a summary ID.',
        });
      }

      // Create the pointer
      const pointerId = `ptr_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      input.deps.log.info(
        `[lcm:collapse] Collapsing ${sourceIds.length} item(s) (${sourceType}) → ${pointerId}, saving ~${tokensSaved} tokens: "${label}"`,
      );

      await summaryStore.insertPointer({
        pointerId,
        conversationId,
        label,
        reason,
        sourceType,
        sourceIds,
        tokensSaved,
      });

      // Replace the ordinal range in context_items with the pointer
      await summaryStore.replaceContextRangeWithPointer({
        conversationId,
        startOrdinal,
        endOrdinal,
        pointerId,
      });

      input.deps.log.info(
        `[lcm:collapse] Done: ${pointerId} replaced ordinals ${startOrdinal}-${endOrdinal}`,
      );

      return jsonResult({
        pointerId,
        tokensSaved,
        label,
        message: `Collapsed ${sourceIds.length} item(s) saving ~${tokensSaved} tokens. Use lcm_expand_active(pointerId: "${pointerId}") to restore.`,
      });
    },
  };
}
