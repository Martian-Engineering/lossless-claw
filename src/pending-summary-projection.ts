import { createHash } from "node:crypto";
import {
  resolvePendingFreshTailOrdinal,
  type PendingSummaryPlannerSnapshotItem,
} from "./pending-summary-planner.js";
import type { ConversationStore } from "./store/conversation-store.js";
import type { ContextItemRecord, SummaryRecord, SummaryStore } from "./store/summary-store.js";

export type ProjectionSnapshot = {
  items: PendingSummaryPlannerSnapshotItem[];
  contextItems: ContextItemRecord[];
  summaryById: Map<string, SummaryRecord>;
  sourceProjectionFingerprint: string;
  freshTailStartOrdinal: number | null;
  compactableStartOrdinal: number | null;
  compactableEndOrdinal: number | null;
};

/** Hash ordered source identity components with unambiguous separators. */
export function digestText(prefix: string, parts: string[]): string {
  const hash = createHash("sha256");
  hash.update(prefix);
  for (const part of parts) {
    hash.update("\0");
    hash.update(part);
  }
  return hash.digest("hex");
}

/** Normalize stored token counts for projection planning. */
function normalizeNonNegativeInteger(value: number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return 0;
}

/** Read the canonical projection and its protected compactable range. */
export async function buildPendingProjectionSnapshot(
  conversationId: number,
  conversationStore: ConversationStore,
  summaryStore: SummaryStore,
  config: { freshTailCount: number; freshTailMaxTokens?: number },
): Promise<ProjectionSnapshot> {
  const contextItems = await summaryStore.getContextItems(conversationId);
  const summaryById = new Map<string, SummaryRecord>();
  const items: PendingSummaryPlannerSnapshotItem[] = [];

  // Fingerprints bind position and immutable identity to the current content.
  for (const item of contextItems) {
    if (item.itemType === "message" && item.messageId != null) {
      const message = await conversationStore.getMessageById(item.messageId);
      if (!message) {
        continue;
      }
      items.push({
        ordinal: item.ordinal,
        itemType: "message",
        messageId: message.messageId,
        role: message.role,
        tokenCount: normalizeNonNegativeInteger(message.tokenCount),
        sourceFingerprint: digestText("pending-message-item", [
          String(item.ordinal),
          String(message.messageId),
          String(message.seq),
          message.role,
          String(message.tokenCount),
          message.createdAt.toISOString(),
          digestText("message-content", [message.content]),
        ]),
      });
      continue;
    }

    if (item.itemType === "summary" && item.summaryId) {
      const summary = await summaryStore.getSummary(item.summaryId);
      if (!summary) {
        continue;
      }
      summaryById.set(summary.summaryId, summary);
      items.push({
        ordinal: item.ordinal,
        itemType: "summary",
        summaryId: summary.summaryId,
        depth: summary.depth,
        tokenCount: normalizeNonNegativeInteger(summary.tokenCount),
        sourceFingerprint: digestText("pending-summary-item", [
          String(item.ordinal),
          summary.summaryId,
          String(summary.depth),
          String(summary.tokenCount),
          summary.createdAt.toISOString(),
          digestText("summary-content", [summary.content]),
        ]),
      });
    }
  }

  // The protected tail bounds every range that may become canonical summaries.
  const freshTailOrdinal = resolvePendingFreshTailOrdinal({
    items,
    freshTailCount: config.freshTailCount,
    freshTailMaxTokens: config.freshTailMaxTokens,
  });
  const compactableItems = items.filter((item) => item.ordinal < freshTailOrdinal);
  const compactableStartOrdinal =
    compactableItems.length > 0 ? Math.min(...compactableItems.map((item) => item.ordinal)) : null;
  const compactableEndOrdinal =
    compactableItems.length > 0 ? Math.max(...compactableItems.map((item) => item.ordinal)) : null;
  const sourceProjectionFingerprint = digestText("pending-projection", [
    String(conversationId),
    String(freshTailOrdinal),
    ...compactableItems.map((item) => `${item.ordinal}:${item.sourceFingerprint}`),
  ]);

  return {
    items,
    contextItems,
    summaryById,
    sourceProjectionFingerprint,
    freshTailStartOrdinal: Number.isFinite(freshTailOrdinal) ? freshTailOrdinal : null,
    compactableStartOrdinal,
    compactableEndOrdinal,
  };
}

/** Fingerprint exactly the canonical range owned by a pending batch. */
export function buildBatchSourceFingerprint(input: {
  conversationId: number;
  snapshot: ProjectionSnapshot;
  startOrdinal: number;
  endOrdinal: number;
}): string {
  const compactableItems = input.snapshot.items
    .filter((item) => item.ordinal >= input.startOrdinal && item.ordinal <= input.endOrdinal)
    .sort((a, b) => a.ordinal - b.ordinal);
  return digestText("pending-projection-range", [
    String(input.conversationId),
    String(input.startOrdinal),
    String(input.endOrdinal),
    ...compactableItems.map((item) => `${item.ordinal}:${item.sourceFingerprint}`),
  ]);
}
