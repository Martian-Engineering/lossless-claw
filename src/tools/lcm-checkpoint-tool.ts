import crypto from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { LcmContextEngine } from "../engine.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { resolveLcmConversationScope } from "./lcm-conversation-scope.js";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const LcmCheckpointSchema = Type.Object({
  action: Type.String({
    description:
      '"save" to snapshot current context, "list" to show checkpoints, ' +
      '"restore" to restore from a checkpoint, "delete" to remove a checkpoint.',
    enum: ["save", "list", "restore", "delete"],
  }),
  name: Type.Optional(
    Type.String({
      description: "Name for the checkpoint (required for save).",
    }),
  ),
  description: Type.Optional(
    Type.String({
      description: "Optional description of what this checkpoint captures.",
    }),
  ),
  checkpointId: Type.Optional(
    Type.String({
      description: "Checkpoint ID (required for restore and delete).",
    }),
  ),
  restoreScratchpad: Type.Optional(
    Type.Boolean({
      description:
        "Whether to restore scratchpad content from the checkpoint (default: false).",
    }),
  ),
  conversationId: Type.Optional(
    Type.Number({
      description: "Conversation ID. Defaults to the current session conversation.",
    }),
  ),
});

export function createLcmCheckpointTool(input: {
  deps: LcmDependencies;
  lcm: LcmContextEngine;
  sessionId?: string;
  sessionKey?: string;
}): AnyAgentTool {
  return {
    name: "lcm_checkpoint",
    label: "LCM Checkpoint",
    description:
      "Save and restore context state snapshots. Use to bookmark context at key moments " +
      "and restore later. Actions: save (snapshot current context), list (show checkpoints), " +
      "restore (roll back to a checkpoint), delete (remove a checkpoint).",
    parameters: LcmCheckpointSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const action = typeof p.action === "string" ? p.action.trim() : "";

      if (!action || !["save", "list", "restore", "delete"].includes(action)) {
        return jsonResult({
          error: 'Invalid action. Use "save", "list", "restore", or "delete".',
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

      switch (action) {
        case "save": {
          const name = typeof p.name === "string" ? p.name.trim() : "";
          if (!name) {
            return jsonResult({ error: "name is required for save action." });
          }
          const description = typeof p.description === "string" ? p.description.trim() : undefined;

          // Generate checkpoint ID
          const checkpointId = `cp_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

          // Snapshot current context_items
          const contextRows = summaryStore.getContextItemRows(conversationId);
          const contextSnapshot = JSON.stringify(contextRows);

          // Snapshot scratchpad
          const scratchpad = await summaryStore.getScratchpad(conversationId);
          const scratchpadSnapshot = scratchpad?.content ?? null;

          // Estimate token count from context items
          const contextItems = await summaryStore.getContextItems(conversationId);
          let tokenCount = 0;
          for (const item of contextItems) {
            if (item.itemType === "summary" && item.summaryId) {
              const summary = await summaryStore.getSummary(item.summaryId);
              if (summary) tokenCount += summary.tokenCount;
            } else if (item.itemType === "pointer") {
              tokenCount += 20;
            } else if (item.itemType === "scratchpad") {
              if (scratchpad) tokenCount += scratchpad.tokenCount;
            } else if (item.itemType === "message" && item.messageId != null) {
              const msg = await conversationStore.getMessageById(item.messageId);
              if (msg) {
                tokenCount += msg.tokenCount > 0 ? msg.tokenCount : estimateTokens(msg.content);
              }
            }
          }

          const itemCount = contextItems.length;

          await summaryStore.saveCheckpoint({
            checkpointId,
            conversationId,
            name,
            description,
            contextSnapshot,
            scratchpadSnapshot: scratchpadSnapshot ?? undefined,
            tokenCount,
            itemCount,
          });

          input.deps.log.info(
            `[lcm:checkpoint] Saved "${name}" (${checkpointId}): ${itemCount} items, ~${tokenCount} tokens`,
          );

          return jsonResult({
            checkpointId,
            name,
            itemCount,
            estimatedContextTokens: tokenCount,
            message: `Checkpoint "${name}" saved with ${itemCount} context items (~${tokenCount} tokens).`,
          });
        }

        case "list": {
          const checkpoints = await summaryStore.listCheckpoints(conversationId);

          if (checkpoints.length === 0) {
            return jsonResult({
              checkpoints: [],
              message: "No checkpoints saved. Use action: \"save\" to create one.",
            });
          }

          return jsonResult({
            checkpoints: checkpoints.map((cp) => ({
              checkpointId: cp.checkpointId,
              name: cp.name,
              description: cp.description,
              itemCount: cp.itemCount,
              tokenCount: cp.tokenCount,
              createdAt: cp.createdAt.toISOString(),
            })),
            message: `${checkpoints.length} checkpoint(s) available.`,
          });
        }

        case "restore": {
          const checkpointId = typeof p.checkpointId === "string" ? p.checkpointId.trim() : "";
          if (!checkpointId) {
            return jsonResult({ error: "checkpointId is required for restore action." });
          }

          const checkpoint = await summaryStore.getCheckpoint(checkpointId);
          if (!checkpoint) {
            return jsonResult({ error: `Checkpoint "${checkpointId}" not found.` });
          }

          // Create a restore point before restoring
          const rpId = `rp_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
          const currentRows = summaryStore.getContextItemRows(conversationId);
          const currentItems = await summaryStore.getContextItems(conversationId);

          // Estimate current token count
          let currentTokens = 0;
          for (const item of currentItems) {
            if (item.itemType === "summary" && item.summaryId) {
              const summary = await summaryStore.getSummary(item.summaryId);
              if (summary) currentTokens += summary.tokenCount;
            } else if (item.itemType === "pointer") {
              currentTokens += 20;
            } else if (item.itemType === "scratchpad") {
              const sp = await summaryStore.getScratchpad(conversationId);
              if (sp) currentTokens += sp.tokenCount;
            } else if (item.itemType === "message" && item.messageId != null) {
              const msg = await conversationStore.getMessageById(item.messageId);
              if (msg) {
                currentTokens += msg.tokenCount > 0 ? msg.tokenCount : estimateTokens(msg.content);
              }
            }
          }

          await summaryStore.createRestorePoint({
            id: rpId,
            conversationId,
            operation: "checkpoint_restore",
            target: `checkpoint:${checkpointId}`,
            itemsAffected: currentItems.length,
            tokensAffected: currentTokens,
            snapshotRows: currentRows,
          });

          // Restore context items from checkpoint snapshot
          const snapshot = JSON.parse(checkpoint.contextSnapshot) as unknown[];
          summaryStore.restoreContextItemsFromSnapshot(conversationId, snapshot);

          // Optionally restore scratchpad
          const restoreScratchpad = p.restoreScratchpad === true;
          if (restoreScratchpad && checkpoint.scratchpadSnapshot != null) {
            const tokenCount = estimateTokens(checkpoint.scratchpadSnapshot);
            await summaryStore.upsertScratchpad({
              conversationId,
              content: checkpoint.scratchpadSnapshot,
              tokenCount,
            });
          }

          // Mark conversation as managed
          await conversationStore.markConversationManaged(conversationId);

          input.deps.log.info(
            `[lcm:checkpoint] Restored "${checkpoint.name}" (${checkpointId}): ${checkpoint.itemCount} items, ~${checkpoint.tokenCount} tokens`,
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
            restored: true,
            checkpointId,
            name: checkpoint.name,
            itemCount: checkpoint.itemCount,
            estimatedContextTokens: checkpoint.tokenCount,
            restorePointId: rpId,
            scratchpadRestored: restoreScratchpad && checkpoint.scratchpadSnapshot != null,
            message: `Restored checkpoint "${checkpoint.name}" with ${checkpoint.itemCount} items (~${checkpoint.tokenCount} tokens). Restore point ${rpId} created for undo.`,
            ...(contextMap ? { contextMap } : {}),
          });
        }

        case "delete": {
          const checkpointId = typeof p.checkpointId === "string" ? p.checkpointId.trim() : "";
          if (!checkpointId) {
            return jsonResult({ error: "checkpointId is required for delete action." });
          }

          const deleted = await summaryStore.deleteCheckpoint(checkpointId);
          if (!deleted) {
            return jsonResult({ error: `Checkpoint "${checkpointId}" not found.` });
          }

          input.deps.log.info(`[lcm:checkpoint] Deleted checkpoint ${checkpointId}`);

          return jsonResult({
            deleted: true,
            checkpointId,
            message: `Checkpoint "${checkpointId}" deleted.`,
          });
        }

        default:
          return jsonResult({
            error: `Unknown action "${action}". Use save, list, restore, or delete.`,
          });
      }
    },
  };
}
