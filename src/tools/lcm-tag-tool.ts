import { Type } from "@sinclair/typebox";
import type { LcmContextEngine } from "../engine.js";
import type { LcmDependencies } from "../types.js";
import type { PointerStatus } from "../store/summary-store.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { resolveLcmConversationScope } from "./lcm-conversation-scope.js";
import { formatTimestamp } from "../compaction.js";

function formatIso(value: Date | null | undefined, timezone?: string): string {
  if (!(value instanceof Date)) return "-";
  if (timezone) {
    return formatTimestamp(value, timezone);
  }
  return value.toISOString();
}

const LcmTagSchema = Type.Object({
  action: Type.String({
    description:
      'Action to perform: "tag" (add/remove tags on pointers), "status" (set status on pointers), "list" (list pointers with optional filters).',
  }),
  pointers: Type.Optional(
    Type.Array(Type.String(), {
      description: "Pointer IDs to modify (required for tag and status actions).",
    }),
  ),
  add: Type.Optional(
    Type.Array(Type.String(), {
      description: "Tags to add (for tag action).",
    }),
  ),
  remove: Type.Optional(
    Type.Array(Type.String(), {
      description: "Tags to remove (for tag action).",
    }),
  ),
  status: Type.Optional(
    Type.String({
      description:
        'New status to set: "active", "reference", or "stale" (for status action).',
    }),
  ),
  filterTags: Type.Optional(
    Type.Array(Type.String(), {
      description: "Filter results to pointers matching ANY of these tags (for list action).",
    }),
  ),
  filterStatus: Type.Optional(
    Type.String({
      description: "Filter results to pointers with this status (for list action).",
    }),
  ),
  conversationId: Type.Optional(
    Type.Number({
      description: "Conversation ID. Defaults to the current session conversation.",
    }),
  ),
});

export function createLcmTagTool(input: {
  deps: LcmDependencies;
  lcm: LcmContextEngine;
  sessionId?: string;
  sessionKey?: string;
}): AnyAgentTool {
  return {
    name: "lcm_tag",
    label: "LCM Tag",
    description:
      "Batch tag, status, and list operations on collapsed pointers. " +
      "Tag pointers for categorization and discovery. " +
      "Set status (active/reference/stale) for lifecycle management. " +
      "List pointers with optional tag/status filters.",
    parameters: LcmTagSchema,
    async execute(_toolCallId, params) {
      const p = params as Record<string, unknown>;
      const action = typeof p.action === "string" ? p.action.trim() : "";
      const timezone = input.lcm.timezone;

      if (!["tag", "status", "list"].includes(action)) {
        return jsonResult({
          error: `Invalid action "${action}". Use "tag", "status", or "list".`,
        });
      }

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

      // ── Action: list ──────────────────────────────────────────────────
      if (action === "list") {
        let pointers = await summaryStore.getPointersByConversation(conversationId);

        // Apply tag filter
        const filterTags = Array.isArray(p.filterTags)
          ? (p.filterTags as string[]).map((t) => String(t).trim()).filter(Boolean)
          : [];
        if (filterTags.length > 0) {
          pointers = pointers.filter((ptr) =>
            filterTags.some((tag) => ptr.tags.includes(tag)),
          );
        }

        // Apply status filter
        const filterStatus = typeof p.filterStatus === "string" ? p.filterStatus.trim() : "";
        if (filterStatus) {
          pointers = pointers.filter((ptr) => ptr.status === filterStatus);
        }

        const items = pointers.map((ptr) => ({
          id: ptr.pointerId,
          label: ptr.label,
          tags: ptr.tags,
          status: ptr.status,
          tokensSaved: ptr.tokensSaved,
          created: formatIso(ptr.createdAt, timezone),
          accessedAt: formatIso(ptr.accessedAt, timezone),
        }));

        return jsonResult({
          count: items.length,
          pointers: items,
          ...(filterTags.length > 0 ? { filteredByTags: filterTags } : {}),
          ...(filterStatus ? { filteredByStatus: filterStatus } : {}),
        });
      }

      // ── Actions: tag / status ─────────────────────────────────────────
      const pointerIds = Array.isArray(p.pointers)
        ? (p.pointers as string[]).map((id) => String(id).trim()).filter(Boolean)
        : [];

      if (pointerIds.length === 0) {
        return jsonResult({ error: "pointers array is required for tag/status actions." });
      }

      if (action === "tag") {
        const addTags = Array.isArray(p.add)
          ? (p.add as string[]).map((t) => String(t).trim()).filter(Boolean)
          : [];
        const removeTags = Array.isArray(p.remove)
          ? (p.remove as string[]).map((t) => String(t).trim()).filter(Boolean)
          : [];

        if (addTags.length === 0 && removeTags.length === 0) {
          return jsonResult({ error: "At least one of add or remove is required for tag action." });
        }

        const updated: string[] = [];
        const notFound: string[] = [];

        for (const pointerId of pointerIds) {
          const pointer = await summaryStore.getPointer(pointerId);
          if (!pointer) {
            notFound.push(pointerId);
            continue;
          }

          let newTags = [...pointer.tags];

          // Add tags (deduplicate)
          for (const tag of addTags) {
            if (!newTags.includes(tag)) {
              newTags.push(tag);
            }
          }

          // Remove tags
          if (removeTags.length > 0) {
            newTags = newTags.filter((t) => !removeTags.includes(t));
          }

          await summaryStore.updatePointerTags(pointerId, newTags);
          updated.push(pointerId);
        }

        return jsonResult({
          action: "tag",
          updated: updated.length,
          ...(addTags.length > 0 ? { added: addTags } : {}),
          ...(removeTags.length > 0 ? { removed: removeTags } : {}),
          ...(notFound.length > 0 ? { notFound } : {}),
          message: `Updated tags on ${updated.length} pointer(s).`,
        });
      }

      if (action === "status") {
        const newStatus = typeof p.status === "string" ? p.status.trim() : "";
        if (!["active", "reference", "stale"].includes(newStatus)) {
          return jsonResult({
            error: `Invalid status "${newStatus}". Use "active", "reference", or "stale".`,
          });
        }

        const updated: string[] = [];
        const notFound: string[] = [];

        for (const pointerId of pointerIds) {
          const pointer = await summaryStore.getPointer(pointerId);
          if (!pointer) {
            notFound.push(pointerId);
            continue;
          }

          await summaryStore.updatePointerStatus(pointerId, newStatus as PointerStatus);
          updated.push(pointerId);
        }

        return jsonResult({
          action: "status",
          status: newStatus,
          updated: updated.length,
          ...(notFound.length > 0 ? { notFound } : {}),
          message: `Set status to "${newStatus}" on ${updated.length} pointer(s).`,
        });
      }

      return jsonResult({ error: "Unhandled action." });
    },
  };
}
