import { Type } from "@sinclair/typebox";
import type { LcmContextEngine } from "../engine.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { resolveLcmConversationScope } from "./lcm-conversation-scope.js";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const LcmBudgetSchema = Type.Object({
  conversationId: Type.Optional(
    Type.Number({
      description: "Conversation ID. Defaults to the current session conversation.",
    }),
  ),
});

export function createLcmBudgetTool(input: {
  deps: LcmDependencies;
  lcm: LcmContextEngine;
  sessionId?: string;
  sessionKey?: string;
}): AnyAgentTool {
  return {
    name: "lcm_budget",
    label: "LCM Budget",
    description:
      "Show context composition breakdown: where tokens are spent across " +
      "system prompts, summaries, conversation messages, pointers, scratchpad, " +
      "and tool calls. Shows cuttable vs fixed amounts.",
    parameters: LcmBudgetSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;

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
        return jsonResult({
          total: 0,
          limit: 0,
          breakdown: {},
          cuttable: 0,
          fixed: 0,
          message: "No context items found.",
        });
      }

      // Categorize each item by type and sum tokens
      const breakdown: Record<string, number> = {
        system: 0,
        summaries: 0,
        conversation: 0,
        pointers: 0,
        scratchpad: 0,
        tool_calls: 0,
        tool_results: 0,
      };

      // Track fresh tail count from config
      const freshTailCount = input.deps.config.freshTailCount ?? 8;

      for (const item of contextItems) {
        if (item.itemType === "summary") {
          if (item.summaryId) {
            const summary = await summaryStore.getSummary(item.summaryId);
            if (summary) {
              breakdown.summaries += summary.tokenCount;
            }
          }
        } else if (item.itemType === "pointer") {
          // Pointers are tiny (~20 tokens each)
          breakdown.pointers += 20;
        } else if (item.itemType === "scratchpad") {
          const scratchpad = await summaryStore.getScratchpad(conversationId);
          if (scratchpad) {
            breakdown.scratchpad += scratchpad.tokenCount;
          }
        } else if (item.itemType === "message" && item.messageId != null) {
          const msg = await conversationStore.getMessageById(item.messageId);
          if (msg) {
            const tokens = msg.tokenCount > 0 ? msg.tokenCount : estimateTokens(msg.content);

            if (msg.role === "system") {
              breakdown.system += tokens;
            } else if (msg.role === "tool") {
              breakdown.tool_results += tokens;
            } else if (msg.role === "assistant") {
              // Check if it's a tool call by looking for tool_use pattern
              const hasToolCall = msg.content.includes('"type":"tool_use"') ||
                msg.content.includes('"tool_use"');
              if (hasToolCall) {
                breakdown.tool_calls += tokens;
              } else {
                breakdown.conversation += tokens;
              }
            } else {
              // user messages
              breakdown.conversation += tokens;
            }
          }
        }
      }

      const total = Object.values(breakdown).reduce((sum, v) => sum + v, 0);

      // "Fixed" = system prompt (always re-injected by framework)
      // "Cuttable" = everything except system and the minimum fresh tail
      const fixed = breakdown.system;
      const cuttable = total - fixed;

      // Get context limit from config
      const contextThreshold = input.deps.config.contextThreshold ?? 0.75;
      const limit = input.deps.config.contextWindow ?? 200000;

      const usagePercent = Math.round((total / limit) * 100);

      // Format human-readable breakdown
      const parts: string[] = [];
      for (const [key, value] of Object.entries(breakdown)) {
        if (value > 0) {
          parts.push(`${key}: ${(value / 1000).toFixed(1)}k`);
        }
      }

      const message =
        `${(total / 1000).toFixed(1)}k tokens in context — ` +
        `${(cuttable / 1000).toFixed(1)}k cuttable, ${(fixed / 1000).toFixed(1)}k fixed (system). ` +
        `Breakdown: ${parts.join(", ")}`;

      return jsonResult({
        total,
        limit,
        usagePercent,
        breakdown,
        cuttable,
        fixed,
        freshTailCount,
        contextItemCount: contextItems.length,
        message,
      });
    },
  };
}
