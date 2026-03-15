import { Type } from "@sinclair/typebox";
import type { LcmContextEngine } from "../engine.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { resolveLcmConversationScope } from "./lcm-conversation-scope.js";

const LcmUndoSchema = Type.Object({
  action: Type.String({
    description:
      '"list" to show available restore points, or "undo" to roll back the most recent operation.',
  }),
  pointId: Type.Optional(
    Type.String({
      description:
        "Specific restore point ID to undo (e.g. \"rp_abc123\"). If omitted, undoes the most recent.",
    }),
  ),
  conversationId: Type.Optional(
    Type.Number({
      description: "Conversation ID. Defaults to the current session conversation.",
    }),
  ),
});

export function createLcmUndoTool(input: {
  deps: LcmDependencies;
  lcm: LcmContextEngine;
  sessionId?: string;
  sessionKey?: string;
}): AnyAgentTool {
  return {
    name: "lcm_undo",
    label: "LCM Undo",
    description:
      "List or roll back LCM context operations (collapse, remove, replace). " +
      "Restore points are automatically created before every mutating operation. " +
      "Use action \"list\" to see available restore points, or \"undo\" to roll back.",
    parameters: LcmUndoSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const action = typeof p.action === "string" ? p.action.trim() : "";

      if (!action || !["list", "undo"].includes(action)) {
        return jsonResult({
          error: 'Invalid action. Use "list" or "undo".',
        });
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

      if (action === "list") {
        const points = await summaryStore.getRestorePoints(conversationId);

        if (points.length === 0) {
          return jsonResult({
            restorePoints: [],
            message: "No restore points available. Points are created automatically before collapse/remove/replace operations and expire after 1 hour.",
          });
        }

        return jsonResult({
          restorePoints: points.map((rp) => ({
            id: rp.id,
            operation: rp.operation,
            target: rp.target,
            itemsAffected: rp.itemsAffected,
            tokensAffected: rp.tokensAffected,
            createdAt: rp.createdAt.toISOString(),
          })),
          message: `${points.length} restore point(s) available. Use lcm_undo(action: "undo") to roll back the most recent, or specify a pointId.`,
        });
      }

      // action === "undo"
      const pointId = typeof p.pointId === "string" ? p.pointId.trim() : undefined;

      let restorePoint;
      if (pointId) {
        restorePoint = await summaryStore.getRestorePoint(pointId);
        if (!restorePoint) {
          return jsonResult({ error: `Restore point "${pointId}" not found or expired.` });
        }
      } else {
        // Get most recent
        const points = await summaryStore.getRestorePoints(conversationId);
        if (points.length === 0) {
          return jsonResult({ error: "No restore points available to undo." });
        }
        restorePoint = points[0]; // Already sorted DESC by created_at
      }

      input.deps.log.info(
        `[lcm:undo] Restoring ${restorePoint.id}: operation="${restorePoint.operation}" target="${restorePoint.target}" items=${restorePoint.itemsAffected}`,
      );

      // Restore all context items from the snapshot
      summaryStore.restoreContextItemsFromSnapshotById(restorePoint.id);

      // Delete the used restore point
      await summaryStore.deleteRestorePoint(restorePoint.id);

      // Mark conversation as managed
      await conversationStore.markConversationManaged(conversationId);

      input.deps.log.info(
        `[lcm:undo] Done: restored ${restorePoint.itemsAffected} items from ${restorePoint.id}`,
      );

      // Build refreshed context ref map
      let contextMap: string | undefined;
      try {
        const assembler = input.lcm.getAssembler();
        contextMap = await assembler.buildRefMap(conversationId);
      } catch {
        // Non-critical
      }

      return jsonResult({
        undone: true,
        restoredPoint: restorePoint.id,
        operation: restorePoint.operation,
        target: restorePoint.target,
        itemsRestored: restorePoint.itemsAffected,
        tokensRestored: restorePoint.tokensAffected,
        message: `Undid "${restorePoint.operation}" on ${restorePoint.target}, restoring ${restorePoint.itemsAffected} items (~${restorePoint.tokensAffected} tokens).`,
        ...(contextMap ? { contextMap } : {}),
      });
    },
  };
}
