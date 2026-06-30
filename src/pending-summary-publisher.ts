import { createHash } from "node:crypto";
import type { ConversationStore, MessageRecord } from "./store/conversation-store.js";
import type {
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
};

type ChildSummaryIds = {
  pendingChildNodeIds: string[];
  canonicalChildSummaryIds: string[];
};

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

    const batchBeforeTransaction = await this.pendingSummaryStore.getBatch(input.batchId);
    if (!batchBeforeTransaction) {
      throw new Error(`Pending compaction batch ${input.batchId} was not found`);
    }
    if (batchBeforeTransaction.status === "published") {
      return this.readPublishedResult(input);
    }
    if (
      input.expectedSourceProjectionFingerprint != null &&
      batchBeforeTransaction.sourceProjectionFingerprint !== input.expectedSourceProjectionFingerprint
    ) {
      await this.pendingSummaryStore.markBatchStale({
        batchId: input.batchId,
        failureSummary: "source projection fingerprint changed before publish",
      });
      throw new Error(`Pending compaction batch ${input.batchId} source fingerprint is stale`);
    }

    return this.summaryStore.withTransaction(async () => {
      const batch = await this.pendingSummaryStore.getBatch(input.batchId);
      if (!batch) {
        throw new Error(`Pending compaction batch ${input.batchId} was not found`);
      }
      if (batch.status === "published") {
        return this.readPublishedResult(input);
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
      await this.pendingSummaryStore.markBatchPublished({
        batchId: input.batchId,
        publishedAt: input.publishedAt,
      });

      return {
        batchId: input.batchId,
        canonicalSummaryIds: orderedAncestors.map((node) => canonicalIdsByNodeId.get(node.nodeId)!),
        frontierSummaryIds,
      };
    });
  }

  private async readPublishedResult(
    input: PublishReadyFrontierInput,
  ): Promise<PublishReadyFrontierResult> {
    const frontierNodes: PendingSummaryNodeRecord[] = [];
    for (const nodeId of input.frontierNodeIds) {
      const node = await this.pendingSummaryStore.getNode(nodeId);
      if (!node?.canonicalSummaryId) {
        throw new Error(`Published frontier node ${nodeId} has no canonical summary id`);
      }
      frontierNodes.push(node);
    }
    const orderedAncestors = await this.collectPendingAncestors(frontierNodes);
    return {
      batchId: input.batchId,
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
      const children = await this.readChildSummaryIds(node.nodeId);
      for (const childNodeId of children.pendingChildNodeIds) {
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

    const childIds = await this.readChildSummaryIds(node.nodeId);
    const parentSummaryIds = [
      ...childIds.pendingChildNodeIds.map((childNodeId) => {
        const canonicalChildId = canonicalIdsByNodeId.get(childNodeId);
        if (!canonicalChildId) {
          throw new Error(`Missing canonical id for pending child node ${childNodeId}`);
        }
        return canonicalChildId;
      }),
      ...childIds.canonicalChildSummaryIds,
    ];
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

  private async readChildSummaryIds(nodeId: string): Promise<ChildSummaryIds> {
    const children = await this.pendingSummaryStore.getNodeChildren(nodeId);
    return {
      pendingChildNodeIds: children
        .map((child) => child.childNodeId)
        .filter((childNodeId): childNodeId is string => typeof childNodeId === "string"),
      canonicalChildSummaryIds: children
        .map((child) => child.childSummaryId)
        .filter((childSummaryId): childSummaryId is string => typeof childSummaryId === "string"),
    };
  }
}
