import { createHash } from "node:crypto";
import {
  buildPendingProjectionSnapshot,
  buildBatchSourceFingerprint,
  digestText,
} from "./pending-summary-projection.js";
import type { ConversationStore, MessageRecord } from "./store/conversation-store.js";
import type {
  PendingCompactionBatchRecord,
  PendingSummaryNodeRecord,
  PendingSummaryStore,
} from "./store/pending-summary-store.js";
import type { CreateSummaryInput, SummaryRecord, SummaryStore } from "./store/summary-store.js";

export type PendingSummaryPublisherOptions = {
  conversationStore: ConversationStore;
  pendingSummaryStore: PendingSummaryStore;
  summaryStore: SummaryStore;
  canonicalSummaryIdForNode?: (node: PendingSummaryNodeRecord) => string;
};

export type PublishReadyFrontierInput = {
  batchId: string;
  frontierNodeIds: string[];
  expectedSourceProjectionFingerprint?: string;
  publishedAt?: Date;
};

export type PublishReadyFrontierResult = {
  batchId: string;
  canonicalSummaryIds: string[];
  frontierSummaryIds: string[];
  remainingPreparation: boolean;
};

type ChildSummaryLink =
  | { kind: "pending"; childNodeId: string }
  | { kind: "canonical"; summaryId: string };

type SummaryCoverageMetadata = Pick<
  CreateSummaryInput,
  | "earliestAt"
  | "latestAt"
  | "descendantCount"
  | "descendantTokenCount"
  | "sourceMessageTokenCount"
>;

function defaultCanonicalSummaryIdForNode(node: PendingSummaryNodeRecord): string {
  const digest = createHash("sha256")
    .update(`${node.batchId}\0${node.nodeId}\0${node.sourceFingerprint}`)
    .digest("hex")
    .slice(0, 16);
  return `sum_${digest}`;
}

function requireReadyNode(node: PendingSummaryNodeRecord): void {
  if (node.status !== "ready" && node.status !== "promoted") {
    throw new Error(`Pending summary node ${node.nodeId} is not ready for publish`);
  }
  if (node.status === "ready" && (node.content == null || node.tokenCount == null)) {
    throw new Error(`Pending summary node ${node.nodeId} is ready without summary content`);
  }
}

function rangeFromDates(dates: Date[]): Pick<SummaryCoverageMetadata, "earliestAt" | "latestAt"> {
  let earliestAt: Date | undefined;
  let latestAt: Date | undefined;
  for (const date of dates) {
    if (!(date instanceof Date)) {
      continue;
    }
    if (!earliestAt || date < earliestAt) {
      earliestAt = date;
    }
    if (!latestAt || date > latestAt) {
      latestAt = date;
    }
  }
  return {
    ...(earliestAt ? { earliestAt } : {}),
    ...(latestAt ? { latestAt } : {}),
  };
}

/**
 * Publishes a ready pending summary frontier into canonical summary tables.
 *
 * The publisher canonicalizes every pending ancestor needed by the selected
 * frontier, links lineage, swaps the active context ranges to the frontier
 * summaries, and marks pending rows promoted inside one store transaction.
 */
export class PendingSummaryPublisher {
  private readonly conversationStore: ConversationStore;
  private readonly pendingSummaryStore: PendingSummaryStore;
  private readonly summaryStore: SummaryStore;
  private readonly canonicalSummaryIdForNode: (node: PendingSummaryNodeRecord) => string;

  constructor(options: PendingSummaryPublisherOptions) {
    this.conversationStore = options.conversationStore;
    this.pendingSummaryStore = options.pendingSummaryStore;
    this.summaryStore = options.summaryStore;
    this.canonicalSummaryIdForNode =
      options.canonicalSummaryIdForNode ?? defaultCanonicalSummaryIdForNode;
  }

  /** Publish a ready frontier and return the canonical ids created or reused. */
  async publishReadyFrontier(
    input: PublishReadyFrontierInput,
  ): Promise<PublishReadyFrontierResult> {
    if (input.frontierNodeIds.length === 0) {
      throw new Error("Cannot publish an empty pending summary frontier");
    }

    return this.summaryStore.withTransaction(async () => {
      const batch = await this.pendingSummaryStore.getBatch(input.batchId);
      if (!batch) {
        throw new Error(`Pending compaction batch ${input.batchId} was not found`);
      }
      if (batch.status === "published") {
        return this.readPublishedResult(input);
      }

      if (batch.status !== "planning" && batch.status !== "ready") {
        throw new Error(`Pending compaction batch ${input.batchId} is not active`);
      }

      const frontierNodes: PendingSummaryNodeRecord[] = [];
      for (const nodeId of input.frontierNodeIds) {
        const node = await this.pendingSummaryStore.getNode(nodeId);
        if (!node) {
          throw new Error(`Pending summary frontier node ${nodeId} was not found`);
        }
        if (node.batchId !== input.batchId) {
          throw new Error(`Pending summary frontier node ${nodeId} belongs to another batch`);
        }
        requireReadyNode(node);
        frontierNodes.push(node);
      }

      // A retry of an already committed prefix must not replace its shifted range.
      if (frontierNodes.every((node) => node.status === "promoted")) {
        return this.readPublishedResult(input);
      }
      if (frontierNodes.some((node) => node.status === "promoted")) {
        throw new Error("Cannot mix promoted and ready pending frontier nodes");
      }
      // An obsolete selection is not evidence that the surviving batch is
      // stale: another publication may have advanced its projection.
      if (input.expectedSourceProjectionFingerprint != null &&
          batch.sourceProjectionFingerprint !== input.expectedSourceProjectionFingerprint) {
        throw new Error(`Pending compaction batch ${input.batchId} source fingerprint is stale`);
      }
      await this.validateFrontier(batch, frontierNodes);
      const orderedAncestors = await this.collectPendingAncestors(frontierNodes);
      const canonicalIdsByNodeId = new Map<string, string>();
      for (const node of orderedAncestors) {
        const canonicalSummaryId = node.canonicalSummaryId ?? this.canonicalSummaryIdForNode(node);
        canonicalIdsByNodeId.set(node.nodeId, canonicalSummaryId);
      }

      for (const node of orderedAncestors) {
        const canonicalSummaryId = canonicalIdsByNodeId.get(node.nodeId);
        if (!canonicalSummaryId) {
          throw new Error(`Missing canonical id for pending summary node ${node.nodeId}`);
        }
        await this.insertCanonicalNode(node, canonicalSummaryId, canonicalIdsByNodeId);
        await this.pendingSummaryStore.markNodePromoted({
          nodeId: node.nodeId,
          canonicalSummaryId,
          promotedAt: input.publishedAt,
        });
      }

      const frontierSummaryIds = frontierNodes.map((node) => {
        const canonicalSummaryId = canonicalIdsByNodeId.get(node.nodeId);
        if (!canonicalSummaryId) {
          throw new Error(`Missing canonical id for frontier node ${node.nodeId}`);
        }
        return canonicalSummaryId;
      });
      await this.summaryStore.replaceContextRangesWithSummaries({
        conversationId: batch.conversationId,
        replacements: frontierNodes
          .map((node, index) => ({
            startOrdinal: node.ordinalStart,
            endOrdinal: node.ordinalEnd,
            summaryId: frontierSummaryIds[index]!,
          }))
          .sort((a, b) => a.startOrdinal - b.startOrdinal),
      });
      const remainingPreparation = await this.rebaseBatch(batch, frontierNodes);
      if (!remainingPreparation) {
        await this.pendingSummaryStore.markBatchPublished({
          batchId: input.batchId,
          publishedAt: input.publishedAt,
        });
      }

      return {
        batchId: input.batchId,
        remainingPreparation,
        canonicalSummaryIds: orderedAncestors.map((node) => canonicalIdsByNodeId.get(node.nodeId)!),
        frontierSummaryIds,
      };
    });
  }

  /** Verify active identity, ordering, canonical gaps, and the planned tail boundary. */
  private async validateFrontier(
    batch: PendingCompactionBatchRecord,
    frontier: PendingSummaryNodeRecord[],
  ): Promise<void> {
    const items = await this.summaryStore.getContextItems(batch.conversationId);
    const identities = new Map(items.map((item) => [item.ordinal,
      item.itemType === "message" ? `message:${item.messageId}` : `summary:${item.summaryId}`]));
    let cursor = batch.compactableStartOrdinal;
    for (const node of [...frontier].sort((a, b) => a.ordinalStart - b.ordinalStart)) {
      if (node.ordinalStart < cursor || node.ordinalEnd < node.ordinalStart ||
          node.ordinalEnd > batch.compactableEndOrdinal ||
          node.ordinalEnd >= (batch.plannedFreshTailStartOrdinal ?? Infinity)) {
        throw new Error("Pending frontier crosses its source range or fresh tail");
      }
      // Canonical summaries may bridge ready pending nodes. Raw or missing
      // items are an uncovered gap and cannot be skipped during publication.
      for (; cursor < node.ordinalStart; cursor += 1) {
        if (!identities.get(cursor)?.startsWith("summary:")) {
          throw new Error("Pending frontier crosses uncovered source coverage");
        }
      }
      const expected = await this.activeSourceIdentities(node);
      const actual: string[] = [];
      for (; cursor <= node.ordinalEnd; cursor += 1) actual.push(identities.get(cursor) ?? "missing");
      if (expected.length !== actual.length || expected.some((id, index) => id !== actual[index])) {
        throw new Error("Pending frontier source identity or ordering changed before publish");
      }
    }
  }

  /** Resolve a prepared node to the canonical items that still represent its sources. */
  private async activeSourceIdentities(node: PendingSummaryNodeRecord): Promise<string[]> {
    if (node.canonicalSummaryId) return [`summary:${node.canonicalSummaryId}`];
    if (node.kind === "leaf") {
      return (await this.pendingSummaryStore.getNodeMessages(node.nodeId))
        .map((link) => `message:${link.messageId}`);
    }
    const identities: string[] = [];
    for (const child of await this.readChildSummaryLinks(node.nodeId)) {
      if (child.kind === "canonical") {
        identities.push(`summary:${child.summaryId}`);
      } else {
        const childNode = await this.pendingSummaryStore.getNode(child.childNodeId);
        if (!childNode) throw new Error(`Missing pending child ${child.childNodeId}`);
        identities.push(...await this.activeSourceIdentities(childNode));
      }
    }
    return identities;
  }

  /** Persist the post-publication projection while retaining all pending DAG links. */
  private async rebaseBatch(
    batch: PendingCompactionBatchRecord,
    frontier: PendingSummaryNodeRecord[],
  ): Promise<boolean> {
    const replacements = [...frontier].sort((a, b) => a.ordinalStart - b.ordinalStart);
    // Every source ordinal maps either to its replacement or to the same item
    // shifted left by preceding replacements. Parents spanning a prefix keep
    // their promoted children and can later condense the canonical summaries.
    const rebaseOrdinal = (ordinal: number): number => {
      let removed = 0;
      for (const node of replacements) {
        if (ordinal < node.ordinalStart) break;
        if (ordinal <= node.ordinalEnd) return node.ordinalStart - removed;
        removed += node.ordinalEnd - node.ordinalStart;
      }
      return ordinal - removed;
    };
    const snapshot = await buildPendingProjectionSnapshot(
      batch.conversationId, this.conversationStore, this.summaryStore, { freshTailCount: 0 },
    );
    const nodes = await this.pendingSummaryStore.getNodesByBatch(batch.batchId);
    for (const node of nodes) {
      // Promoted ranges describe immutable lineage and never re-enter selection.
      if (node.status === "promoted") continue;
      const ordinalStart = rebaseOrdinal(node.ordinalStart);
      const ordinalEnd = rebaseOrdinal(node.ordinalEnd);
      // Leaf validation includes ordinals. Refresh only that projection hash;
      // the immutable source fingerprint still identifies the prepared result.
      const sourceContextHash = node.kind === "leaf"
        ? digestText("pending-node-context", [
            String(ordinalStart), String(ordinalEnd),
            ...snapshot.items.filter((item) => item.ordinal >= ordinalStart && item.ordinal <= ordinalEnd)
              .map((item) => item.sourceFingerprint),
          ])
        : node.sourceContextHash;
      await this.pendingSummaryStore.updateNodeContext({
        nodeId: node.nodeId, ordinalStart, ordinalEnd, sourceContextHash,
      });
    }
    const startOrdinal = rebaseOrdinal(batch.compactableStartOrdinal);
    const endOrdinal = rebaseOrdinal(batch.compactableEndOrdinal);
    await this.pendingSummaryStore.updateBatchPlanningTarget({
      batchId: batch.batchId,
      compactableStartOrdinal: startOrdinal,
      compactableEndOrdinal: endOrdinal,
      plannedFreshTailStartOrdinal: batch.plannedFreshTailStartOrdinal == null
        ? null : rebaseOrdinal(batch.plannedFreshTailStartOrdinal),
      sourceProjectionFingerprint: buildBatchSourceFingerprint({
        conversationId: batch.conversationId, snapshot, startOrdinal, endOrdinal,
      }),
    });
    return nodes.some((node) => node.status !== "promoted");
  }

  private async readPublishedResult(
    input: PublishReadyFrontierInput,
  ): Promise<PublishReadyFrontierResult> {
    const frontierNodes: PendingSummaryNodeRecord[] = [];
    for (const nodeId of input.frontierNodeIds) {
      const node = await this.pendingSummaryStore.getNode(nodeId);
      if (!node?.canonicalSummaryId || node.batchId !== input.batchId) {
        throw new Error(`Published frontier node ${nodeId} has no canonical summary id`);
      }
      frontierNodes.push(node);
    }
    const orderedAncestors = await this.collectPendingAncestors(frontierNodes);
    return {
      batchId: input.batchId,
      remainingPreparation: (await this.pendingSummaryStore.getBatch(input.batchId))?.status !== "published",
      canonicalSummaryIds: orderedAncestors
        .map((node) => node.canonicalSummaryId)
        .filter((summaryId): summaryId is string => typeof summaryId === "string"),
      frontierSummaryIds: frontierNodes.map((node) => node.canonicalSummaryId!),
    };
  }

  private async collectPendingAncestors(
    frontierNodes: PendingSummaryNodeRecord[],
  ): Promise<PendingSummaryNodeRecord[]> {
    const visited = new Set<string>();
    const ordered: PendingSummaryNodeRecord[] = [];

    const visit = async (node: PendingSummaryNodeRecord): Promise<void> => {
      if (visited.has(node.nodeId)) {
        return;
      }
      visited.add(node.nodeId);
      requireReadyNode(node);
      const children = await this.readChildSummaryLinks(node.nodeId);
      for (const childNodeId of children
        .filter((child) => child.kind === "pending")
        .map((child) => child.childNodeId)) {
        const childNode = await this.pendingSummaryStore.getNode(childNodeId);
        if (!childNode) {
          throw new Error(`Pending child summary node ${childNodeId} was not found`);
        }
        await visit(childNode);
      }
      ordered.push(node);
    };

    for (const node of frontierNodes) {
      await visit(node);
    }
    return ordered;
  }

  private async insertCanonicalNode(
    node: PendingSummaryNodeRecord,
    canonicalSummaryId: string,
    canonicalIdsByNodeId: Map<string, string>,
  ): Promise<void> {
    const existing = await this.summaryStore.getSummary(canonicalSummaryId);
    if (node.kind === "leaf") {
      const messageIds = (await this.pendingSummaryStore.getNodeMessages(node.nodeId)).map(
        (message) => message.messageId,
      );
      if (!existing) {
        await this.summaryStore.insertSummary({
          summaryId: canonicalSummaryId,
          conversationId: node.conversationId,
          kind: node.kind,
          depth: node.depth,
          content: node.content ?? "",
          tokenCount: node.tokenCount ?? 0,
          model: node.model,
          ...(await this.buildLeafCoverageMetadata(messageIds)),
        });
      }
      await this.summaryStore.linkSummaryToMessages(canonicalSummaryId, messageIds);
      return;
    }

    const childLinks = await this.readChildSummaryLinks(node.nodeId);
    const parentSummaryIds = childLinks.map((child) => {
      if (child.kind === "pending") {
        const canonicalChildId = canonicalIdsByNodeId.get(child.childNodeId);
        if (!canonicalChildId) {
          throw new Error(`Missing canonical id for pending child node ${child.childNodeId}`);
        }
        return canonicalChildId;
      }
      return child.summaryId;
    });
    if (!existing) {
      await this.summaryStore.insertSummary({
        summaryId: canonicalSummaryId,
        conversationId: node.conversationId,
        kind: node.kind,
        depth: node.depth,
        content: node.content ?? "",
        tokenCount: node.tokenCount ?? 0,
        model: node.model,
        ...(await this.buildCondensedCoverageMetadata(parentSummaryIds)),
      });
    }
    await this.summaryStore.linkSummaryToParents(canonicalSummaryId, parentSummaryIds);
  }

  private async buildLeafCoverageMetadata(
    messageIds: number[],
  ): Promise<SummaryCoverageMetadata> {
    const messages: MessageRecord[] = [];
    for (const messageId of messageIds) {
      const message = await this.conversationStore.getMessageById(messageId);
      if (message) {
        messages.push(message);
      }
    }
    return {
      ...rangeFromDates(messages.map((message) => message.createdAt)),
      descendantCount: 0,
      descendantTokenCount: 0,
      sourceMessageTokenCount: messages.reduce(
        (total, message) => total + Math.max(0, Math.floor(message.tokenCount)),
        0,
      ),
    };
  }

  private async buildCondensedCoverageMetadata(
    parentSummaryIds: string[],
  ): Promise<SummaryCoverageMetadata> {
    const parents: SummaryRecord[] = [];
    for (const summaryId of parentSummaryIds) {
      const summary = await this.summaryStore.getSummary(summaryId);
      if (summary) {
        parents.push(summary);
      }
    }
    return {
      ...rangeFromDates(
        parents.flatMap((summary) => [
          summary.earliestAt ?? summary.createdAt,
          summary.latestAt ?? summary.createdAt,
        ]),
      ),
      descendantCount: parents.reduce(
        (total, summary) => total + Math.max(0, summary.descendantCount) + 1,
        0,
      ),
      descendantTokenCount: parents.reduce(
        (total, summary) =>
          total + Math.max(0, summary.tokenCount) + Math.max(0, summary.descendantTokenCount),
        0,
      ),
      sourceMessageTokenCount: parents.reduce(
        (total, summary) => total + Math.max(0, summary.sourceMessageTokenCount),
        0,
      ),
    };
  }

  private async readChildSummaryLinks(nodeId: string): Promise<ChildSummaryLink[]> {
    const children = await this.pendingSummaryStore.getNodeChildren(nodeId);
    const links: ChildSummaryLink[] = [];
    for (const child of children) {
      if (typeof child.childNodeId === "string") {
        links.push({ kind: "pending", childNodeId: child.childNodeId });
        continue;
      }
      if (typeof child.childSummaryId === "string") {
        links.push({ kind: "canonical", summaryId: child.childSummaryId });
      }
    }
    return links;
  }
}
