import { createHash, randomUUID } from "node:crypto";
import { estimateTokens } from "./estimate-tokens.js";
import {
  planPendingCondensedNodes,
  planPendingLeafNodes,
  resolvePendingFreshTailOrdinal,
  selectPendingPublishFrontier,
  type PendingSummaryPlannerNode,
  type PendingSummaryPlannerSnapshotItem,
} from "./pending-summary-planner.js";
import { PendingSummaryPublisher } from "./pending-summary-publisher.js";
import { PendingSummaryPreparationWorker } from "./pending-summary-worker.js";
import type { ConversationStore, MessageRecord } from "./store/conversation-store.js";
import type {
  PendingCompactionBatchRecord,
  PendingSummaryNodeRecord,
  PendingSummaryStore,
} from "./store/pending-summary-store.js";
import type { ContextItemRecord, SummaryRecord, SummaryStore } from "./store/summary-store.js";
import type { LcmSummarizeFn } from "./summarize.js";

const PENDING_PROMPT_VERSION = "pending-summary-dag:v1";

export type PendingCompactionCoordinatorConfig = {
  freshTailCount: number;
  freshTailMaxTokens?: number;
  leafChunkTokens: number;
  condensedMinFanout: number;
  condensedMinSourceTokens: number;
  condensedChunkTokens: number;
  leaseMs?: number;
};

export type PendingCompactionCoordinatorOptions = {
  conversationStore: ConversationStore;
  summaryStore: SummaryStore;
  pendingSummaryStore: PendingSummaryStore;
  config: PendingCompactionCoordinatorConfig;
  summarize: LcmSummarizeFn;
  model: string;
  leaseOwner: string;
  withPublishLock?: <T>(operation: () => Promise<T>) => Promise<T>;
};

export type PendingCompactionCoordinatorResult =
  | { status: "idle"; reason: string }
  | { status: "planned"; batchId: string; nodeCount: number }
  | { status: "prepared"; batchId: string; nodeId: string }
  | { status: "published"; batchId: string; frontierSummaryIds: string[] }
  | { status: "stale"; batchId: string; reason: string }
  | { status: "failed"; batchId: string; nodeId: string; failureSummary: string };

type ProjectionSnapshot = {
  items: PendingSummaryPlannerSnapshotItem[];
  contextItems: ContextItemRecord[];
  summaryById: Map<string, SummaryRecord>;
  sourceProjectionFingerprint: string;
  freshTailStartOrdinal: number | null;
  compactableStartOrdinal: number | null;
  compactableEndOrdinal: number | null;
};

function digestText(prefix: string, parts: string[]): string {
  const hash = createHash("sha256");
  hash.update(prefix);
  for (const part of parts) {
    hash.update("\0");
    hash.update(part);
  }
  return hash.digest("hex");
}

function shortDigest(prefix: string, parts: string[]): string {
  return digestText(prefix, parts).slice(0, 16);
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return fallback;
}

function normalizeNonNegativeInteger(value: number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return 0;
}

function formatMessageForSummary(message: MessageRecord): string {
  return [`[${message.createdAt.toISOString()}]`, message.content.trim()].join("\n").trim();
}

/**
 * Coordinates hidden pending summary planning, preparation, and atomic publish.
 *
 * The coordinator owns only issue-807 lifecycle orchestration. LLM calls happen
 * through `PendingSummaryPreparationWorker`, after a short claim transaction has
 * completed, and canonical summary tables are changed only by the publisher.
 */
export class PendingCompactionCoordinator {
  private readonly conversationStore: ConversationStore;
  private readonly summaryStore: SummaryStore;
  private readonly pendingSummaryStore: PendingSummaryStore;
  private readonly config: PendingCompactionCoordinatorConfig;
  private readonly summarize: LcmSummarizeFn;
  private readonly model: string;
  private readonly leaseOwner: string;
  private readonly withPublishLock: <T>(operation: () => Promise<T>) => Promise<T>;

  constructor(options: PendingCompactionCoordinatorOptions) {
    this.conversationStore = options.conversationStore;
    this.summaryStore = options.summaryStore;
    this.pendingSummaryStore = options.pendingSummaryStore;
    this.config = options.config;
    this.summarize = options.summarize;
    this.model = options.model;
    this.leaseOwner = options.leaseOwner;
    this.withPublishLock = options.withPublishLock ?? ((operation) => operation());
  }

  /** Advance a conversation by at most one pending compaction step. */
  async runOnce(input: {
    conversationId: number;
    sessionKey?: string;
  }): Promise<PendingCompactionCoordinatorResult> {
    const snapshot = await this.buildProjectionSnapshot(input.conversationId);
    if (snapshot.compactableStartOrdinal == null || snapshot.compactableEndOrdinal == null) {
      return { status: "idle", reason: "no compactable context outside fresh tail" };
    }

    let batch = await this.pendingSummaryStore.getActiveBatchForConversation(input.conversationId);
    if (batch && batch.sourceProjectionFingerprint !== snapshot.sourceProjectionFingerprint) {
      const staleResult = await this.withPublishLock(() =>
        this.publishActiveBatchIfReady(input.conversationId),
      );
      return staleResult ?? { status: "idle", reason: "no active pending summary batch" };
    }
    if (!batch) {
      return this.planBatch({
        conversationId: input.conversationId,
        sessionKey: input.sessionKey,
        snapshot,
      });
    }

    const worker = new PendingSummaryPreparationWorker({
      store: this.pendingSummaryStore,
      leaseOwner: this.leaseOwner,
      leaseMs: normalizePositiveInteger(this.config.leaseMs, 60_000),
      loadSourceText: (node) => this.loadSourceText(node),
      summarize: (sourceText, node) =>
        this.summarize(sourceText, false, {
          isCondensed: node.kind === "condensed",
          depth: node.kind === "condensed" ? node.depth : undefined,
        }),
      estimateTokens,
    });
    const prepared = await worker.prepareOne({ conversationId: input.conversationId });
    if (prepared.status === "prepared") {
      return { status: "prepared", batchId: batch.batchId, nodeId: prepared.nodeId };
    }
    if (prepared.status === "failed") {
      await this.pendingSummaryStore.markBatchStale({
        batchId: batch.batchId,
        failureSummary: prepared.failureSummary,
      });
      return {
        status: "failed",
        batchId: batch.batchId,
        nodeId: prepared.nodeId,
        failureSummary: prepared.failureSummary,
      };
    }

    const publishResult = await this.withPublishLock(() =>
      this.publishActiveBatchIfReady(input.conversationId),
    );
    if (publishResult) {
      return publishResult;
    }
    return { status: "idle", reason: "no claimable pending summary nodes" };
  }

  private async planBatch(input: {
    conversationId: number;
    sessionKey?: string;
    snapshot: ProjectionSnapshot;
  }): Promise<PendingCompactionCoordinatorResult> {
    const prefixDigest = shortDigest("pending-summary-prefix", [
      String(input.conversationId),
      input.snapshot.sourceProjectionFingerprint,
      this.model,
    ]);
    const attemptDigest = shortDigest("pending-summary-attempt", [randomUUID()]);
    const batchId = `pcb_${prefixDigest}_${attemptDigest}`;
    const nodeIdPrefix = `psn_${prefixDigest}_${attemptDigest}`;
    const canonicalNodes = this.buildCanonicalSummaryPlannerNodes(input.snapshot);
    const leafNodes = planPendingLeafNodes({
      items: input.snapshot.items,
      freshTailCount: this.config.freshTailCount,
      freshTailMaxTokens: this.config.freshTailMaxTokens,
      leafChunkTokens: this.config.leafChunkTokens,
      nodeIdPrefix,
    });
    const condensedNodes = planPendingCondensedNodes({
      nodes: [...canonicalNodes, ...leafNodes],
      condensedMinFanout: this.config.condensedMinFanout,
      condensedMinSourceTokens: this.config.condensedMinSourceTokens,
      condensedChunkTokens: this.config.condensedChunkTokens,
      nodeIdPrefix,
    });
    const pendingNodes = [...leafNodes, ...condensedNodes];
    if (pendingNodes.length === 0) {
      return { status: "idle", reason: "no pending summary nodes planned" };
    }

    await this.pendingSummaryStore.withTransaction(async () => {
      await this.pendingSummaryStore.createBatch({
        batchId,
        conversationId: input.conversationId,
        sessionKey: input.sessionKey ?? null,
        sourceProjectionFingerprint: input.snapshot.sourceProjectionFingerprint,
        compactableStartOrdinal: input.snapshot.compactableStartOrdinal ?? 0,
        compactableEndOrdinal: input.snapshot.compactableEndOrdinal ?? 0,
        plannedFreshTailStartOrdinal: input.snapshot.freshTailStartOrdinal,
        promptVersion: PENDING_PROMPT_VERSION,
        model: this.model,
      });
      for (const node of pendingNodes) {
        await this.insertPendingNode(batchId, input.conversationId, node);
      }
    });

    return { status: "planned", batchId, nodeCount: pendingNodes.length };
  }

  private async insertPendingNode(
    batchId: string,
    conversationId: number,
    node: PendingSummaryPlannerNode,
  ): Promise<void> {
    await this.pendingSummaryStore.insertNode({
      nodeId: node.nodeId,
      batchId,
      conversationId,
      kind: node.kind,
      depth: node.depth,
      ordinalStart: node.ordinalStart,
      ordinalEnd: node.ordinalEnd,
      sourceFingerprint: digestText("pending-node-source", node.sourceFingerprints),
      sourceContextHash: digestText("pending-node-context", [
        String(node.ordinalStart),
        String(node.ordinalEnd),
        ...node.sourceFingerprints,
      ]),
      promptVersion: PENDING_PROMPT_VERSION,
      model: this.model,
    });
    if (node.kind === "leaf") {
      await this.pendingSummaryStore.linkNodeToMessages(
        node.nodeId,
        node.sourceMessageIds.map((messageId) => ({ messageId })),
      );
      return;
    }
    await this.pendingSummaryStore.linkNodeToChildren(node.nodeId, [
      ...node.childNodeIds.map((childNodeId) => ({ childNodeId })),
      ...node.childSummaryIds.map((childSummaryId) => ({ childSummaryId })),
    ]);
  }

  private async publishIfReady(input: {
    batch: PendingCompactionBatchRecord;
    snapshot: ProjectionSnapshot;
  }): Promise<PendingCompactionCoordinatorResult | null> {
    const nodes = await this.pendingSummaryStore.getNodesByBatch(input.batch.batchId);
    const readyPendingPlannerNodes = nodes
      .filter((node) => node.status === "ready" || node.status === "promoted")
      .map((node) => this.pendingRecordToPlannerNode(node));
    const canonicalPlannerNodes = this.buildCanonicalSummaryPlannerNodes(input.snapshot);
    const frontier = selectPendingPublishFrontier({
      nodes: [...canonicalPlannerNodes, ...readyPendingPlannerNodes],
      startOrdinal: input.batch.compactableStartOrdinal,
      endOrdinal: input.batch.compactableEndOrdinal,
    });
    if (!frontier) {
      return null;
    }
    const pendingFrontier = frontier.filter(
      (node) => typeof node.canonicalSummaryId !== "string",
    );
    if (pendingFrontier.length === 0) {
      await this.pendingSummaryStore.markBatchPublished({
        batchId: input.batch.batchId,
      });
      return {
        status: "published",
        batchId: input.batch.batchId,
        frontierSummaryIds: frontier.map((node) => node.canonicalSummaryId!),
      };
    }

    const publisher = new PendingSummaryPublisher({
      conversationStore: this.conversationStore,
      pendingSummaryStore: this.pendingSummaryStore,
      summaryStore: this.summaryStore,
    });
    const published = await publisher.publishReadyFrontier({
      batchId: input.batch.batchId,
      frontierNodeIds: pendingFrontier.map((node) => node.nodeId),
      expectedSourceProjectionFingerprint: input.snapshot.sourceProjectionFingerprint,
    });
    const publishedByNodeId = new Map(
      pendingFrontier.map(
        (node, index) => [node.nodeId, published.frontierSummaryIds[index]!] as const,
      ),
    );
    return {
      status: "published",
      batchId: input.batch.batchId,
      frontierSummaryIds: frontier.map((node) => {
        if (typeof node.canonicalSummaryId === "string") {
          return node.canonicalSummaryId;
        }
        const summaryId = publishedByNodeId.get(node.nodeId);
        if (!summaryId) {
          throw new Error(`Missing published summary id for pending frontier node ${node.nodeId}`);
        }
        return summaryId;
      }),
    };
  }

  private async publishActiveBatchIfReady(
    conversationId: number,
  ): Promise<PendingCompactionCoordinatorResult | null> {
    const snapshot = await this.buildProjectionSnapshot(conversationId);
    const batch = await this.pendingSummaryStore.getActiveBatchForConversation(conversationId);
    if (!batch) {
      return null;
    }
    if (batch.sourceProjectionFingerprint !== snapshot.sourceProjectionFingerprint) {
      await this.pendingSummaryStore.markBatchStale({
        batchId: batch.batchId,
        failureSummary: "source projection fingerprint changed before publish",
      });
      return {
        status: "stale",
        batchId: batch.batchId,
        reason: "source projection fingerprint changed before publish",
      };
    }
    return this.publishIfReady({ batch, snapshot });
  }

  private async buildProjectionSnapshot(conversationId: number): Promise<ProjectionSnapshot> {
    const contextItems = await this.summaryStore.getContextItems(conversationId);
    const summaryById = new Map<string, SummaryRecord>();
    const items: PendingSummaryPlannerSnapshotItem[] = [];

    for (const item of contextItems) {
      if (item.itemType === "message" && item.messageId != null) {
        const message = await this.conversationStore.getMessageById(item.messageId);
        if (!message) {
          continue;
        }
        items.push({
          ordinal: item.ordinal,
          itemType: "message",
          messageId: message.messageId,
          tokenCount: normalizeNonNegativeInteger(message.tokenCount),
          sourceFingerprint: digestText("pending-message-item", [
            String(item.ordinal),
            String(message.messageId),
            String(message.seq),
            String(message.tokenCount),
            message.createdAt.toISOString(),
            digestText("message-content", [message.content]),
          ]),
        });
        continue;
      }

      if (item.itemType === "summary" && item.summaryId) {
        const summary = await this.summaryStore.getSummary(item.summaryId);
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

    const freshTailOrdinal = resolvePendingFreshTailOrdinal({
      items,
      freshTailCount: this.config.freshTailCount,
      freshTailMaxTokens: this.config.freshTailMaxTokens,
    });
    const compactableItems = items.filter((item) => item.ordinal < freshTailOrdinal);
    const compactableStartOrdinal =
      compactableItems.length > 0
        ? Math.min(...compactableItems.map((item) => item.ordinal))
        : null;
    const compactableEndOrdinal =
      compactableItems.length > 0
        ? Math.max(...compactableItems.map((item) => item.ordinal))
        : null;
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

  private buildCanonicalSummaryPlannerNodes(
    snapshot: ProjectionSnapshot,
  ): PendingSummaryPlannerNode[] {
    return snapshot.items
      .filter(
        (item) =>
          item.itemType === "summary" &&
          typeof item.summaryId === "string" &&
          item.ordinal < (snapshot.freshTailStartOrdinal ?? Infinity),
      )
      .map((item) => {
        const summary = snapshot.summaryById.get(item.summaryId!);
        return {
          nodeId: `canonical-${item.summaryId}`,
          canonicalSummaryId: item.summaryId,
          kind: summary?.kind ?? "leaf",
          depth: summary?.depth ?? item.depth ?? 0,
          ordinalStart: item.ordinal,
          ordinalEnd: item.ordinal,
          tokenCount: normalizeNonNegativeInteger(summary?.tokenCount ?? item.tokenCount),
          sourceFingerprints: [item.sourceFingerprint],
          sourceMessageIds: [],
          childNodeIds: [],
          childSummaryIds: [],
        };
      });
  }

  private pendingRecordToPlannerNode(node: PendingSummaryNodeRecord): PendingSummaryPlannerNode {
    return {
      nodeId: node.nodeId,
      canonicalSummaryId: node.canonicalSummaryId,
      kind: node.kind,
      depth: node.depth,
      ordinalStart: node.ordinalStart,
      ordinalEnd: node.ordinalEnd,
      tokenCount: normalizeNonNegativeInteger(node.tokenCount ?? 0),
      sourceFingerprints: [node.sourceFingerprint],
      sourceMessageIds: [],
      childNodeIds: [],
      childSummaryIds: [],
    };
  }

  private async loadSourceText(node: PendingSummaryNodeRecord): Promise<string> {
    if (node.kind === "leaf") {
      const messageLinks = await this.pendingSummaryStore.getNodeMessages(node.nodeId);
      const chunks: string[] = [];
      for (const link of messageLinks) {
        const message = await this.conversationStore.getMessageById(link.messageId);
        if (message) {
          chunks.push(formatMessageForSummary(message));
        }
      }
      return chunks.filter(Boolean).join("\n\n");
    }

    const children = await this.pendingSummaryStore.getNodeChildren(node.nodeId);
    const chunks: string[] = [];
    for (const child of children) {
      if (child.childNodeId) {
        const pendingChild = await this.pendingSummaryStore.getNode(child.childNodeId);
        if (!pendingChild?.content) {
          throw new Error(`Pending child summary ${child.childNodeId} is not ready`);
        }
        chunks.push(pendingChild.content);
        continue;
      }
      if (child.childSummaryId) {
        const canonicalChild = await this.summaryStore.getSummary(child.childSummaryId);
        if (!canonicalChild) {
          throw new Error(`Canonical child summary ${child.childSummaryId} was not found`);
        }
        chunks.push(canonicalChild.content);
      }
    }
    return chunks.filter(Boolean).join("\n\n");
  }
}
