import { Type } from "@sinclair/typebox";
import type { LcmContextEngine } from "../engine.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

const LcmExpandActiveSchema = Type.Object({
  pointerId: Type.String({
    description: "The pointer ID to expand back into full content (e.g. \"ptr_abc123def456\").",
  }),
});

export function createLcmExpandActiveTool(input: {
  deps: LcmDependencies;
  lcm: LcmContextEngine;
  sessionId?: string;
  sessionKey?: string;
}): AnyAgentTool {
  return {
    name: "lcm_expand_active",
    label: "LCM Expand Active",
    description:
      "Expand a previously collapsed pointer back into full content in the context window. " +
      "Pointers are created by lcm_collapse. The original content was never deleted — " +
      "this just restores it to active context.",
    parameters: LcmExpandActiveSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const pointerId = (p.pointerId as string).trim();

      if (!pointerId) {
        return jsonResult({ error: "pointerId is required." });
      }

      const conversationStore = input.lcm.getConversationStore();
      const summaryStore = input.lcm.getSummaryStore();

      // Look up the pointer
      const pointer = await summaryStore.getPointer(pointerId);
      if (!pointer) {
        return jsonResult({ error: `Pointer ${pointerId} not found.` });
      }

      const conversationId = pointer.conversationId;

      // Find the pointer's context item ordinal
      const contextItems = await summaryStore.getContextItems(conversationId);
      const pointerItem = contextItems.find(
        (item) => item.itemType === "pointer" && item.pointerId === pointerId,
      );

      if (!pointerItem) {
        return jsonResult({
          error: `Pointer ${pointerId} exists in storage but is not in active context. It may have already been expanded.`,
        });
      }

      // Reconstruct the original context items from sourceIds
      const restoredItems: Array<{
        itemType: "message" | "summary";
        messageId?: number;
        summaryId?: string;
      }> = [];

      let tokensRestored = 0;

      for (const sourceId of pointer.sourceIds) {
        if (pointer.sourceType === "summary" || sourceId.startsWith("sum_")) {
          const summary = await summaryStore.getSummary(sourceId);
          if (summary) {
            restoredItems.push({ itemType: "summary", summaryId: sourceId });
            tokensRestored += summary.tokenCount;
          }
        } else {
          // Treat as message ID
          const messageId = parseInt(sourceId, 10);
          if (!isNaN(messageId)) {
            const msg = await conversationStore.getMessageById(messageId);
            if (msg) {
              restoredItems.push({ itemType: "message", messageId });
              tokensRestored +=
                msg.tokenCount > 0
                  ? msg.tokenCount
                  : Math.ceil(msg.content.length / 4);
            }
          }
        }
      }

      if (restoredItems.length === 0) {
        return jsonResult({
          error: `Pointer ${pointerId} references items that no longer exist in storage.`,
        });
      }

      input.deps.log.info(
        `[lcm:expand] Expanding ${pointerId}: ${restoredItems.length} item(s), ~${tokensRestored} tokens (source: ${pointer.sourceType}, label: "${pointer.label}")`,
      );

      // Replace the pointer context item with the original items
      await summaryStore.replacePointerWithContextItems({
        conversationId,
        pointerOrdinal: pointerItem.ordinal,
        items: restoredItems,
      });

      // Delete the pointer record
      await summaryStore.deletePointer(pointerId);

      return jsonResult({
        expanded: true,
        tokensRestored,
        itemCount: restoredItems.length,
        message: `Expanded ${restoredItems.length} item(s), restoring ~${tokensRestored} tokens to context.`,
      });
    },
  };
}
