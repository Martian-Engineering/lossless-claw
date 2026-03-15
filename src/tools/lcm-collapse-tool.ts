import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { LcmContextEngine } from "../engine.js";
import { parseRef } from "../assembler.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { resolveLcmConversationScope } from "./lcm-conversation-scope.js";

/**
 * Create a restore point by snapshotting all context_items for the conversation.
 * Called before every mutating operation so lcm_undo can roll back.
 */
async function createRestorePoint(input: {
  lcm: LcmContextEngine;
  conversationId: number;
  operation: string;
  target: string;
  itemsAffected: number;
  tokensAffected: number;
}): Promise<string> {
  const summaryStore = input.lcm.getSummaryStore();
  const contextItems = await summaryStore.getContextItems(input.conversationId);
  const maxOrdinal = contextItems.length > 0
    ? contextItems[contextItems.length - 1].ordinal
    : 0;

  // Snapshot ALL context_items rows (not just the affected range)
  const snapshotRows = summaryStore.getContextItemRowsInRange(
    input.conversationId,
    0,
    maxOrdinal + 1000, // generous upper bound to catch all
  );

  const rpId = `rp_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  await summaryStore.createRestorePoint({
    id: rpId,
    conversationId: input.conversationId,
    operation: input.operation,
    target: input.target,
    itemsAffected: input.itemsAffected,
    tokensAffected: input.tokensAffected,
    snapshotRows,
  });

  return rpId;
}


function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const LcmCollapseSchema = Type.Object({
  target: Type.String({
    description:
      'What to collapse: "last_tool" (most recent tool call + result), ' +
      '"last_tool:ToolName" (most recent call of a specific tool, e.g. "last_tool:Read"), ' +
      '"last_tool:ToolName:all" (ALL calls of that tool from the same turn, e.g. "last_tool:Read:all"), ' +
      '"last_tool:all" (ALL tool call/result pairs from the current turn), ' +
      '"messages:N" (last N messages before the fresh tail), ' +
      '"range:start-end" (ordinal range), ' +
      '"ref:§003" (single context ref), "ref:§003-§005" (ref range), ' +
      '"map" (show current context ref map without collapsing), ' +
      'or a summary ID (e.g. "sum_abc123").',
  }),
  label: Type.Optional(
    Type.String({
      description: "One-line description for the collapsed pointer (e.g. \"webpage HTML from example.com\"). Required for collapse mode.",
    }),
  ),
  reason: Type.Optional(
    Type.String({
      description: "Why this content is being collapsed (e.g. \"accidentally pulled full page\").",
    }),
  ),
  mode: Type.Optional(
    Type.String({
      description: "What to do with the targeted content: \"collapse\" (default, create expandable pointer), \"remove\" (permanently delete from context, no trace), \"replace\" (swap with custom text you provide).",
    }),
  ),
  content: Type.Optional(
    Type.String({
      description: "Replacement text when mode is \"replace\". Required for replace mode.",
    }),
  ),
  data: Type.Optional(
    Type.String({
      description: "Structured data (JSON string) to store with the pointer. Included when expanded. Use for computation results, coefficients, etc.",
    }),
  ),
  tags: Type.Optional(
    Type.Array(Type.String(), {
      description: "Tags for categorization and discovery (e.g. [\"silentsymmetry\", \"path-a\"]). Used to find related pointers.",
    }),
  ),
  status: Type.Optional(
    Type.String({
      description: "Pointer lifecycle status: \"active\" (default, protect from tidy), \"reference\" (keep available), \"stale\" (content may be outdated, tidy aggressively).",
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
      "Collapse, remove, or replace content in active context. " +
      "Default mode creates an expandable pointer (~20 tokens). " +
      "Remove permanently deletes. Replace swaps with your custom text.",
    parameters: LcmCollapseSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const target = (p.target as string).trim();
      let label = typeof p.label === "string" ? p.label.trim() : "";
      const reason = typeof p.reason === "string" ? p.reason.trim() : undefined;
      const mode = typeof p.mode === "string" ? p.mode.trim() : "collapse";
      const content = typeof p.content === "string" ? p.content : undefined;
      const data = typeof p.data === "string" ? p.data : undefined;
      const tags = Array.isArray(p.tags) ? (p.tags as string[]).map(t => String(t).trim()).filter(Boolean) : [];
      const status = typeof p.status === "string" && ["active", "reference", "stale"].includes(p.status) ? p.status as "active" | "reference" | "stale" : "active";

      if (!target) {
        return jsonResult({ error: "target is required." });
      }

      // For last_tool:all, label can be auto-generated; for others it's required in collapse mode
      const isLastToolAll = target === "last_tool:all";
      if (mode === "collapse" && !label && !isLastToolAll) {
        return jsonResult({ error: "label is required for collapse mode." });
      }

      if (mode === "replace" && (!content || content.trim().length === 0)) {
        return jsonResult({ error: "content is required for replace mode." });
      }

      if (!["collapse", "remove", "replace"].includes(mode)) {
        return jsonResult({ error: `Invalid mode "${mode}". Use "collapse", "remove", or "replace".` });
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

      if (target === "map") {
        // Just show the current context ref map without collapsing anything
        const flushResult = await input.lcm.flushPendingMessages();
        if (flushResult.flushed > 0) {
          const refreshedItems = await summaryStore.getContextItems(conversationId);
          contextItems.length = 0;
          contextItems.push(...refreshedItems);
        }

        let contextMap: string | undefined;
        try {
          const assembler = input.lcm.getAssembler();
          contextMap = await assembler.buildRefMap(conversationId);
        } catch {
          // Non-critical
        }

        return jsonResult({
          contextMap: contextMap ?? "",
          message: `Current context ref map (${contextItems.length} items)`,
        });
      } else if (target === "last_tool" || target.startsWith("last_tool:")) {
        // Parse optional tool name filter and :all modifier
        // "last_tool" → no filter, single result
        // "last_tool:Read" → filter by "read", single result
        // "last_tool:Read:all" → filter by "read", collect ALL matching from same turn
        // "last_tool:all" → no filter, collect ALL tool results from current turn
        let toolNameFilter: string | undefined;
        let collectAll = false;
        if (target.includes(":")) {
          const parts = target.slice("last_tool:".length).trim().split(":");
          if (parts[0].toLowerCase() === "all" && parts.length === 1) {
            // "last_tool:all" — collect all tools from the turn, no name filter
            collectAll = true;
          } else {
            toolNameFilter = parts[0].toLowerCase() || undefined;
            collectAll = parts.length > 1 && parts[1].toLowerCase() === "all";
          }
        }
        // Flush pending messages from the current turn so we can find
        // tool results that haven't been ingested by afterTurn() yet.
        const flushResult = await input.lcm.flushPendingMessages();
        if (flushResult.flushed > 0) {
          // Re-fetch context items now that new messages have been ingested
          const refreshedItems = await summaryStore.getContextItems(conversationId);
          contextItems.length = 0;
          contextItems.push(...refreshedItems);
        }

        // Find the most recent tool-related messages (assistant tool_call + tool results)
        // Walk backward from the end of context items.
        // When filtering by tool name, collect ALL consecutive matching tool results
        // (e.g. two Read calls in the same assistant turn → collapse both).
        let toolResultOrdinals: number[] = [];
        let toolCallOrdinal: number | null = null;
        let foundFirstResult = false;
        let lastToolResultOrdinal: number | null = null;
        let firstToolResultOrdinal: number | null = null;
        const collectedToolNames: string[] = [];

        for (let i = contextItems.length - 1; i >= 0; i--) {
          const item = contextItems[i];
          if (item.itemType === "message" && item.messageId != null) {
            const msg = await conversationStore.getMessageById(item.messageId);
            if (msg) {
              if (msg.role === "tool") {
                // If filtering by tool name, check if this tool result matches
                let matchesFilter = true;
                const msgParts = await conversationStore.getMessageParts(item.messageId);
                if (toolNameFilter) {
                  matchesFilter = msgParts.some(
                    (part) => part.toolName && part.toolName.toLowerCase() === toolNameFilter,
                  );
                }

                if (!matchesFilter) {
                  // Non-matching tool result — skip it but keep walking backward.
                  // It's from the same assistant turn (interleaved tool calls).
                  continue;
                }

                // Track tool names for auto-label generation
                for (const part of msgParts) {
                  if (part.toolName && !collectedToolNames.includes(part.toolName)) {
                    collectedToolNames.push(part.toolName);
                  }
                }

                if (!foundFirstResult) {
                  lastToolResultOrdinal = item.ordinal;
                }
                foundFirstResult = true;
                firstToolResultOrdinal = item.ordinal;
                toolResultOrdinals.push(item.ordinal);
                sourceIds.push(String(item.messageId));
                tokensSaved += msg.tokenCount > 0 ? msg.tokenCount : estimateTokens(msg.content);

                // In single mode (no :all), stop after first match —
                // just find the assistant message next
                if (!collectAll) {
                  // Continue walking to find the assistant message, but
                  // don't collect any more tool results
                  for (let j = i - 1; j >= 0; j--) {
                    const prevItem = contextItems[j];
                    if (prevItem.itemType === "message" && prevItem.messageId != null) {
                      const prevMsg = await conversationStore.getMessageById(prevItem.messageId);
                      if (prevMsg && prevMsg.role === "assistant") {
                        toolCallOrdinal = prevItem.ordinal;
                        sourceIds.push(String(prevItem.messageId));
                        tokensSaved += prevMsg.tokenCount > 0 ? prevMsg.tokenCount : estimateTokens(prevMsg.content);
                        break;
                      } else if (prevMsg && prevMsg.role === "user") {
                        break; // Past the turn boundary
                      }
                      // Skip other tool results in between
                    }
                  }
                  break; // Done — found our single match + its assistant
                }
              } else if (msg.role === "assistant") {
                if (foundFirstResult) {
                  // Found the assistant message that initiated the tool call(s)
                  toolCallOrdinal = item.ordinal;
                  sourceIds.push(String(item.messageId));
                  tokensSaved += msg.tokenCount > 0 ? msg.tokenCount : estimateTokens(msg.content);
                  break;
                }
                // Hit an assistant message before any tool result — if filtering,
                // this marks a turn boundary. The tools we want might be further back.
                if (!toolNameFilter) break;
                // With a filter, keep searching past this turn boundary
              } else if (msg.role === "user") {
                if (foundFirstResult) {
                  // Went past the tool pair without finding the assistant call
                  break;
                }
                // Hit a user message — turn boundary. Stop if not filtering.
                if (!toolNameFilter) break;
              }
            }
          }
        }

        if (!foundFirstResult || lastToolResultOrdinal === null) {
          return jsonResult({ error: `No tool call/result${toolNameFilter ? ` for "${toolNameFilter}"` : ""} found in context to collapse.` });
        }

        // Auto-generate label for last_tool:all if none provided
        if (!label && isLastToolAll) {
          const toolList = collectedToolNames.length > 0 ? collectedToolNames.join(", ") : "various";
          label = `All tool results from current turn (${sourceIds.length} items: ${toolList})`;
        }

        startOrdinal = toolCallOrdinal ?? firstToolResultOrdinal!;
        endOrdinal = lastToolResultOrdinal;
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
      } else if (target.startsWith("ref:")) {
        // Ref-based targeting: "ref:§003" or "ref:§003-§005"
        const refPart = target.slice("ref:".length);
        const rangeParts = refPart.split("-");

        if (rangeParts.length === 1) {
          // Single ref
          const ordinal = parseRef(rangeParts[0]);
          if (isNaN(ordinal)) {
            return jsonResult({ error: `Invalid ref "${rangeParts[0]}". Expected format: §XXX (hex).` });
          }
          startOrdinal = ordinal;
          endOrdinal = ordinal;
        } else if (rangeParts.length === 2) {
          // Ref range
          const start = parseRef(rangeParts[0]);
          const end = parseRef(rangeParts[1]);
          if (isNaN(start) || isNaN(end)) {
            return jsonResult({ error: `Invalid ref range. Expected format: ref:§XXX-§YYY (hex).` });
          }
          startOrdinal = start;
          endOrdinal = end;
        } else {
          return jsonResult({ error: `Invalid ref target. Use "ref:§003" or "ref:§003-§005".` });
        }

        sourceType = "ref";

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
      } else {
        return jsonResult({
          error:
            'Invalid target. Use "last_tool", "last_tool:ToolName", "last_tool:all", "messages:N", "range:start-end", "ref:§XXX", "map", or a summary ID.',
        });
      }

      const itemsAffected = sourceIds.length;

      // ── Mode: remove ─────────────────────────────────────────────────────
      if (mode === "remove") {
        await createRestorePoint({
          lcm: input.lcm,
          conversationId,
          operation: "remove",
          target,
          itemsAffected,
          tokensAffected: tokensSaved,
        });

        input.deps.log.info(
          `[lcm:collapse:remove] Removing ${itemsAffected} item(s) (${sourceType}), freeing ~${tokensSaved} tokens`,
        );

        await summaryStore.removeContextItemsInRange(conversationId, startOrdinal, endOrdinal);
        await conversationStore.markConversationManaged(conversationId);

        input.deps.log.info(
          `[lcm:collapse:remove] Done: removed ordinals ${startOrdinal}-${endOrdinal}`,
        );

        let contextMap: string | undefined;
        try {
          const assembler = input.lcm.getAssembler();
          contextMap = await assembler.buildRefMap(conversationId);
        } catch {
          // Non-critical
        }

        return jsonResult({
          removed: true,
          itemsRemoved: itemsAffected,
          tokensSaved,
          message: `Permanently removed ${itemsAffected} items, freeing ~${tokensSaved} tokens.`,
          ...(contextMap ? { contextMap } : {}),
        });

      }

      // ── Mode: replace ────────────────────────────────────────────────────
      if (mode === "replace") {
        await createRestorePoint({
          lcm: input.lcm,
          conversationId,
          operation: "replace",
          target,
          itemsAffected,
          tokensAffected: tokensSaved,
        });

        const replaceContent = content!;
        const newTokens = estimateTokens(replaceContent);
        const seq = (await conversationStore.getMaxSeq(conversationId)) + 1;

        const newMsg = await conversationStore.createMessage({
          conversationId,
          seq,
          role: "user",
          content: replaceContent,
          tokenCount: newTokens,
        });

        input.deps.log.info(
          `[lcm:collapse:replace] Replacing ${itemsAffected} item(s) (${sourceType}) with message ${newMsg.messageId}, saving ~${tokensSaved} tokens, adding ~${newTokens} tokens`,
        );

        await summaryStore.replaceContextRangeWithMessage({
          conversationId,
          startOrdinal,
          endOrdinal,
          messageId: newMsg.messageId,
        });
        await conversationStore.markConversationManaged(conversationId);

        input.deps.log.info(
          `[lcm:collapse:replace] Done: replaced ordinals ${startOrdinal}-${endOrdinal} with message ${newMsg.messageId}`,
        );

        let contextMap: string | undefined;
        try {
          const assembler = input.lcm.getAssembler();
          contextMap = await assembler.buildRefMap(conversationId);
        } catch {
          // Non-critical
        }

        return jsonResult({
          replaced: true,
          tokensSaved,
          newTokens,
          message: `Replaced ${itemsAffected} items with custom content.`,
          ...(contextMap ? { contextMap } : {}),
        });
      }

      // ── Mode: collapse (default) ─────────────────────────────────────────
      await createRestorePoint({
        lcm: input.lcm,
        conversationId,
        operation: "collapse",
        target,
        itemsAffected,
        tokensAffected: tokensSaved,
      });

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
        data,
        tags,
        status,
      });

      // Replace the ordinal range in context_items with the pointer
      await summaryStore.replaceContextRangeWithPointer({
        conversationId,
        startOrdinal,
        endOrdinal,
        pointerId,
      });

      // Mark the conversation as actively managed so the assembler never
      // falls back to live messages (which would re-inject collapsed content).
      await conversationStore.markConversationManaged(conversationId);

      input.deps.log.info(
        `[lcm:collapse] Done: ${pointerId} replaced ordinals ${startOrdinal}-${endOrdinal}`,
      );

      // Build refreshed context ref map
      let contextMap: string | undefined;
      try {
        const assembler = input.lcm.getAssembler();
        contextMap = await assembler.buildRefMap(conversationId);
      } catch {
        // Non-critical — skip map on error
      }

      // Estimate current context budget usage
      let budgetInfo: Record<string, unknown> | undefined;
      try {
        const updatedItems = await summaryStore.getContextItems(conversationId);
        let totalTokens = 0;
        for (const item of updatedItems) {
          if (item.itemType === "pointer") {
            totalTokens += 20; // pointers are ~20 tokens
          } else if (item.messageId != null) {
            const msg = await conversationStore.getMessageById(item.messageId);
            if (msg) totalTokens += msg.tokenCount > 0 ? msg.tokenCount : estimateTokens(msg.content);
          } else if (item.summaryId != null) {
            const summary = await summaryStore.getSummary(item.summaryId);
            if (summary) totalTokens += summary.tokenCount;
          }
        }
        budgetInfo = { estimatedContextTokens: totalTokens };
      } catch {
        // Non-critical
      }

      return jsonResult({
        pointerId,
        tokensSaved,
        label,
        ...(tags.length > 0 ? { tags } : {}),
        ...(status !== "active" ? { status } : {}),
        message: `Collapsed ${sourceIds.length} item(s) saving ~${tokensSaved} tokens. Use lcm_expand_active(pointerId: "${pointerId}") to restore.`,
        ...(contextMap ? { contextMap } : {}),
        ...(budgetInfo ?? {}),
      });
    },
  };
}
