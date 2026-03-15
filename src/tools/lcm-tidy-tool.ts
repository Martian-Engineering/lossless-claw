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

const LcmTidySchema = Type.Object({
  keepRecentTurns: Type.Optional(
    Type.Number({
      description:
        "How many recent assistant turns to preserve. Everything older gets collapsed. Default 3.",
    }),
  ),
  target: Type.Optional(
    Type.String({
      description:
        'What to collapse: "tool_results" (default, only tool messages) or "all" (all non-fresh messages).',
      enum: ["tool_results", "all"],
    }),
  ),
  exclude: Type.Optional(
    Type.String({
      description:
        "Pattern to exclude from tidy. Items whose content or label matches this substring (case-insensitive) will be preserved.",
    }),
  ),
  maxTokensPerPointer: Type.Optional(
    Type.Number({
      description:
        "Max tokens per collapsed pointer before splitting into multiple pointers. Default: no limit.",
    }),
  ),
  showUnused: Type.Optional(
    Type.Boolean({
      description:
        "When true, include a list of never-accessed pointers in the output. Default false.",
    }),
  ),
  dryRun: Type.Optional(
    Type.Boolean({
      description:
        "Preview what would be collapsed without doing it. Default false.",
    }),
  ),
  conversationId: Type.Optional(
    Type.Number({
      description: "Conversation ID. Defaults to the current session conversation.",
    }),
  ),
});

export function createLcmTidyTool(input: {
  deps: LcmDependencies;
  lcm: LcmContextEngine;
  sessionId?: string;
  sessionKey?: string;
}): AnyAgentTool {
  return {
    name: "lcm_tidy",
    label: "LCM Tidy",
    description:
      "One-command context hygiene. Collapses stale tool results (or all old messages) in bulk, " +
      "preserving only the most recent assistant turns. Creates expandable pointers for collapsed content.",
    parameters: LcmTidySchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const keepRecentTurns = typeof p.keepRecentTurns === "number" ? p.keepRecentTurns : 3;
      const target = typeof p.target === "string" ? p.target.trim() : "tool_results";
      const exclude = typeof p.exclude === "string" ? p.exclude.trim().toLowerCase() : undefined;
      const maxTokensPerPointer = typeof p.maxTokensPerPointer === "number" && p.maxTokensPerPointer > 0 ? p.maxTokensPerPointer : undefined;
      const showUnused = p.showUnused === true;
      const dryRun = p.dryRun === true;

      if (!["tool_results", "all"].includes(target)) {
        return jsonResult({ error: `Invalid target "${target}". Use "tool_results" or "all".` });
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

      // Step 1: Flush pending messages
      await input.lcm.flushPendingMessages();

      // Step 2: Get context items
      const contextItems = await summaryStore.getContextItems(conversationId);

      if (contextItems.length === 0) {
        return jsonResult({ collapsed: 0, tokensSaved: 0, pointersCreated: [], dryRun, message: "No context items found." });
      }

      // Step 3: Find the fresh tail boundary
      // Walk backward to find the Nth most recent assistant message
      let assistantCount = 0;
      let boundaryIndex = contextItems.length; // default: everything is candidate

      for (let i = contextItems.length - 1; i >= 0; i--) {
        const item = contextItems[i];
        if (item.itemType === "message" && item.messageId != null) {
          const msg = await conversationStore.getMessageById(item.messageId);
          if (msg && msg.role === "assistant") {
            assistantCount++;
            if (assistantCount >= keepRecentTurns) {
              boundaryIndex = i;
              break;
            }
          }
        }
      }

      // Candidates are everything before the boundary
      const candidates = contextItems.slice(0, boundaryIndex);

      if (candidates.length === 0) {
        return jsonResult({ collapsed: 0, tokensSaved: 0, pointersCreated: [], dryRun, message: "Nothing old enough to collapse." });
      }

      // Step 4: Filter based on target
      const collapsible: Array<{ index: number; ordinal: number; messageId: number; tokens: number }> = [];

      for (let i = 0; i < candidates.length; i++) {
        const item = candidates[i];
        // Skip non-message items (summaries, pointers, scratchpad are already compact)
        if (item.itemType !== "message" || item.messageId == null) continue;

        const msg = await conversationStore.getMessageById(item.messageId);
        if (!msg) continue;

        if (target === "tool_results") {
          if (msg.role !== "tool") continue;
        }
        // For "all", include all message items

        // Exclusion filter: skip items matching the exclude pattern
        if (exclude && msg.content.toLowerCase().includes(exclude)) {
          continue;
        }

        const tokens = msg.tokenCount > 0 ? msg.tokenCount : estimateTokens(msg.content);
        collapsible.push({ index: i, ordinal: item.ordinal, messageId: item.messageId, tokens });
      }

      if (collapsible.length === 0) {
        return jsonResult({ collapsed: 0, tokensSaved: 0, pointersCreated: [], dryRun, message: "No collapsible items found." });
      }

      // Step 5: Group collapsible items into ranges
      // Allow gaps of up to 3 non-collapsible items between collapsible items
      // This prevents 50+ individual pointers when tool results are interleaved with assistant msgs
      const MAX_ORDINAL_GAP = 4;
      const groups: Array<typeof collapsible> = [];
      let currentGroup: typeof collapsible = [collapsible[0]];

      for (let i = 1; i < collapsible.length; i++) {
        const prev = collapsible[i - 1];
        const curr = collapsible[i];
        // Group if ordinals are close enough (allowing small gaps for interleaved messages)
        if (curr.ordinal - prev.ordinal <= MAX_ORDINAL_GAP) {
          currentGroup.push(curr);
        } else {
          groups.push(currentGroup);
          currentGroup = [curr];
        }
      }
      groups.push(currentGroup);

      let totalCollapsed = 0;
      let totalTokensSaved = 0;
      const pointersCreated: string[] = [];

      if (dryRun) {
        // Just calculate what would happen — account for ALL items in the ordinal range
        for (const group of groups) {
          const startOrd = group[0].ordinal;
          const endOrd = group[group.length - 1].ordinal;
          // Count all context items in the ordinal range (including non-collapsible ones caught in the span)
          const rangeItems = contextItems.filter(
            (ci) => ci.ordinal >= startOrd && ci.ordinal <= endOrd && ci.itemType === "message",
          );
          let rangeTokens = 0;
          for (const ri of rangeItems) {
            if (ri.messageId != null) {
              const m = await conversationStore.getMessageById(ri.messageId);
              if (m) rangeTokens += m.tokenCount > 0 ? m.tokenCount : estimateTokens(m.content);
            }
          }
          totalCollapsed += rangeItems.length;
          totalTokensSaved += rangeTokens;
          pointersCreated.push(`(dry run) ${rangeItems.length} items, ~${rangeTokens} tokens`);
        }

        return jsonResult({
          collapsed: totalCollapsed,
          tokensSaved: totalTokensSaved,
          pointersCreated,
          dryRun: true,
          message: `Dry run: would collapse ${totalCollapsed} items into ${groups.length} pointer(s), saving ~${totalTokensSaved} tokens.`,
        });
      }

      // Step 6: Create pointers for each group (process in reverse order to preserve ordinals)
      // If maxTokensPerPointer is set, split groups into subgroups that fit within the limit.
      for (let gi = groups.length - 1; gi >= 0; gi--) {
        const group = groups[gi];
        const startOrdinal = group[0].ordinal;
        const endOrdinal = group[group.length - 1].ordinal;
        // Count ALL items in range for accurate token savings
        const rangeItems = contextItems.filter(
          (ci) => ci.ordinal >= startOrdinal && ci.ordinal <= endOrdinal && ci.itemType === "message",
        );

        // Gather per-item token info for potential splitting
        const itemInfos: Array<{ messageId: number; ordinal: number; tokens: number }> = [];
        for (const ri of rangeItems) {
          if (ri.messageId != null) {
            const m = await conversationStore.getMessageById(ri.messageId);
            if (m) {
              const tokens = m.tokenCount > 0 ? m.tokenCount : estimateTokens(m.content);
              itemInfos.push({ messageId: ri.messageId, ordinal: ri.ordinal, tokens });
            }
          }
        }

        // Split into subgroups if maxTokensPerPointer is set
        const subgroups: Array<typeof itemInfos> = [];
        if (maxTokensPerPointer && itemInfos.length > 0) {
          let current: typeof itemInfos = [];
          let currentTokens = 0;
          for (const info of itemInfos) {
            if (current.length > 0 && currentTokens + info.tokens > maxTokensPerPointer) {
              subgroups.push(current);
              current = [];
              currentTokens = 0;
            }
            current.push(info);
            currentTokens += info.tokens;
          }
          if (current.length > 0) subgroups.push(current);
        } else {
          subgroups.push(itemInfos);
        }

        // Process subgroups in reverse order to preserve ordinals
        for (let si = subgroups.length - 1; si >= 0; si--) {
          const sub = subgroups[si];
          if (sub.length === 0) continue;
          const subStart = sub[0].ordinal;
          const subEnd = sub[sub.length - 1].ordinal;
          const tokens = sub.reduce((sum, i) => sum + i.tokens, 0);
          const sourceIds = sub.map((i) => String(i.messageId));

          const pointerId = `ptr_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
          const label = `${target === "tool_results" ? "Tool results" : "Messages"} (${sourceIds.length} items, ~${tokens} tokens)`;

          input.deps.log.info(
            `[lcm:tidy] Collapsing ${sub.length} item(s) → ${pointerId}, saving ~${tokens} tokens`,
          );

          await summaryStore.insertPointer({
            pointerId,
            conversationId,
            label,
            sourceType: target === "tool_results" ? "tool_output" : "messages",
            sourceIds,
            tokensSaved: tokens,
            status: "reference",
          });

          await summaryStore.replaceContextRangeWithPointer({
            conversationId,
            startOrdinal: subStart,
            endOrdinal: subEnd,
            pointerId,
          });

          totalTokensSaved += tokens;
          pointersCreated.push(pointerId);
        }

        totalCollapsed += group.length;
      }

      // Step 7: Mark conversation as managed
      await conversationStore.markConversationManaged(conversationId);

      const result: Record<string, unknown> = {
        collapsed: totalCollapsed,
        tokensSaved: totalTokensSaved,
        pointersCreated: pointersCreated.reverse(), // restore chronological order
        dryRun: false,
        message: `Collapsed ${totalCollapsed} items into ${pointersCreated.length} pointer(s), saving ~${totalTokensSaved} tokens.`,
      };

      // Show unused pointers if requested
      if (showUnused) {
        const unusedPointers = await summaryStore.getUnusedPointers(conversationId, 0);
        if (unusedPointers.length > 0) {
          result.unusedPointers = unusedPointers.map((ptr) =>
            `${ptr.pointerId} (${ptr.label}, ${ptr.tokensSaved} tokens)`
          );
        }
      }

      return jsonResult(result);
    },
  };
}
