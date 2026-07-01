import { createHash, randomUUID } from "node:crypto";
import {
  extractMeaningfulMessageText,
  resolveLeafSummaryMessageContent,
  stripInjectedContextBlocks,
} from "./compaction.js";
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
import {
  MAX_PENDING_NODE_RETRIES,
  type PendingCompactionBatchRecord,
  type PendingSummaryNodeRecord,
  type PendingSummaryStore,
} from "./store/pending-summary-store.js";
import type { ContextItemRecord, SummaryRecord, SummaryStore } from "./store/summary-store.js";
import { LcmProviderAuthError, type LcmSummarizeFn } from "./summarize.js";

const PENDING_PROMPT_VERSION = "pending-summary-dag:v1";

export type PendingCompactionCoordinatorConfig = {
  freshTailCount: number;
  freshTailMaxTokens?: number;
  leafChunkTokens: number;
  condensedMinFanout: number;
  condensedMinSourceTokens: number;
  condensedChunkTokens: number;
  leaseMs?: number;
  stripInjectedContextTags?: string[];
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

export type PendingCompactionPublishPolicy = "prepare-only" | "publish-if-ready";

export type PendingCompactionCoordinatorResult =
  | { status: "idle"; reason: string }
  | { status: "planned"; batchId: string; nodeCount: number }
  | { status: "prepared"; batchId: string; nodeId: string }
  | { status: "ready"; batchId: string; reason: "pending summaries ready for publish" }
  | {
      status: "published";
      batchId: string;
      frontierSummaryIds: string[];
      remainingCompactableWork?: boolean;
    }
  | { status: "stale"; batchId: string; reason: string }
  | {
      status: "failed";
      batchId: string;
      nodeId: string;
      failureSummary: string;
      authFailure?: boolean;
    };

type ProjectionSnapshot = {
  items: PendingSummaryPlannerSnapshotItem[];
  contextItems: ContextItemRecord[];
  summaryById: Map<string, SummaryRecord>;
  sourceProjectionFingerprint: string;
  freshTailStartOrdinal: number | null;
  compactableStartOrdinal: number | null;
  compactableEndOrdinal: number | null;
};

type PublishFrontierSelection = {
  frontier: PendingSummaryPlannerNode[];
  pendingFrontier: PendingSummaryPlannerNode[];
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

async function formatMessageForSummary(
  store: Pick<ConversationStore, "getMessageParts">,
  message: MessageRecord,
  stripInjectedContextTags?: string[],
): Promise<string> {
  const resolved = await resolveLeafSummaryMessageContent(store, message);
  const content = extractMeaningfulMessageText(
    stripInjectedContextBlocks(resolved, stripInjectedContextTags),
  ).trim();
  if (!content) {
    return "";
  }
  return [`[${message.createdAt.toISOString()}]`, content].join("\n").trim();
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
    publishPolicy?: PendingCompactionPublishPolicy;
  }): Promise<PendingCompactionCoordinatorResult> {
    const publishPolicy = input.publishPolicy ?? "publish-if-ready";
    const snapshot = await this.buildProjectionSnapshot(input.conversationId);
    if (snapshot.compactableStartOrdinal == null || snapshot.compactableEndOrdinal == null) {
      return { status: "idle", reason: "no compactable context outside fresh tail" };
    }

    let batch = await this.pendingSummaryStore.getActiveBatchForConversation(input.conversationId);
    if (!batch) {
      return this.planBatch({
        conversationId: input.conversationId,
        sessionKey: input.sessionKey,
        snapshot,
      });
    }
    const staleReason = await this.getActiveBatchStaleReason({ batch, snapshot });
    if (staleReason) {
      await this.pendingSummaryStore.markBatchStale({
        batchId: batch.batchId,
        failureSummary: staleReason,
      });
      return { status: "stale", batchId: batch.batchId, reason: staleReason };
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
      isAuthFailure: (error) => error instanceof LcmProviderAuthError,
    });
    const prepared = await worker.prepareOne({ conversationId: input.conversationId });
    if (prepared.status === "prepared") {
      return { status: "prepared", batchId: batch.batchId, nodeId: prepared.nodeId };
    }
    if (prepared.status === "failed") {
      // A transient failure leaves the node claimable again after its backoff
      // window; ready siblings keep their prepared content. Only auth failures
      // (the circuit breaker owns the global stop) and retry exhaustion
      // invalidate the batch.
      const failedNode = await this.pendingSummaryStore.getNode(prepared.nodeId);
      const retriesExhausted = (failedNode?.retryCount ?? 0) >= MAX_PENDING_NODE_RETRIES;
      if (prepared.authFailure || retriesExhausted) {
        await this.pendingSummaryStore.markBatchStale({
          batchId: batch.batchId,
          failureSummary: prepared.failureSummary,
        });
      }
      return {
        status: "failed",
        batchId: batch.batchId,
        nodeId: prepared.nodeId,
        failureSummary: prepared.failureSummary,
        authFailure: prepared.authFailure,
      };
    }

    if (publishPolicy === "prepare-only") {
      const selection = await this.selectPublishFrontier({ batch, snapshot });
      if (selection) {
        const extension = await this.extendReadyBatchIfRangeGrew({
          batch,
          snapshot,
        });
        if (extension) {
          return extension;
        }
        return {
          status: "ready",
          batchId: batch.batchId,
          reason: "pending summaries ready for publish",
        };
      }
      return { status: "idle", reason: "no claimable pending summary nodes" };
    }

    const publishResult = await this.withPublishLock(() =>
      this.publishActiveBatchIfReady(input.conversationId),
    );
    if (publishResult) {
      return publishResult;
    }
    return { status: "idle", reason: "no claimable pending summary nodes" };
  }

  private async extendReadyBatchIfRangeGrew(input: {
    batch: PendingCompactionBatchRecord;
    snapshot: ProjectionSnapshot;
  }): Promise<PendingCompactionCoordinatorResult | null> {
    if (!this.hasRemainingCompactableWork(input)) {
      return null;
    }
    if (
      input.snapshot.compactableStartOrdinal == null ||
      input.snapshot.compactableEndOrdinal == null
    ) {
      return null;
    }

    // Existing ready pending nodes stand in for the already-prepared prefix;
    // extension planning only creates nodes for newly compactable suffix work
    // and any new condensed parents that can reuse that prefix.
    const existingNodes = await this.pendingSummaryStore.getNodesByBatch(input.batch.batchId);
    const reusablePendingNodes = existingNodes
      .filter((node) => node.status === "ready" || node.status === "promoted")
      .map((node) => this.pendingRecordToPlannerNode(node));
    const extensionItems = input.snapshot.items.filter(
      (item) =>
        item.ordinal > input.batch.compactableEndOrdinal &&
        item.ordinal <= input.snapshot.compactableEndOrdinal!,
    );
    // A leaf chunk below leafChunkTokens is not useful summary work. Without
    // this gate, every tiny suffix (e.g. one heartbeat exchange per turn)
    // re-plans the batch and re-runs condensation each cycle, so suffix growth
    // must reach the same minimum that triggers leaf preparation at all.
    const suffixRawTokens = extensionItems.reduce(
      (total, item) =>
        item.itemType === "message" ? total + normalizeNonNegativeInteger(item.tokenCount) : total,
      0,
    );
    if (suffixRawTokens < normalizePositiveInteger(this.config.leafChunkTokens, 1)) {
      return null;
    }
    const nodeIdPrefix = `psn_${shortDigest("pending-summary-extension", [
      input.batch.batchId,
      input.snapshot.sourceProjectionFingerprint,
      randomUUID(),
    ])}`;
    const leafNodes = planPendingLeafNodes({
      items: extensionItems,
      freshTailCount: 0,
      leafChunkTokens: this.config.leafChunkTokens,
      nodeIdPrefix,
    });
    const canonicalNodes = this.buildCanonicalSummaryPlannerNodes(input.snapshot);
    // Nodes already covered by a ready condensed ancestor must not re-enter
    // condensation planning: re-grouping them at their own depth rebuilds a
    // whole-prefix parent (one full re-summarization) for every extension.
    // With covered children removed, new leaves condense among themselves, and
    // deeper parents form over [existing condensed, new parent] pairs only when
    // the fanout/token policy is genuinely met — layered DAG growth.
    const coveringCondensedNodes = reusablePendingNodes.filter(
      (node) => node.kind === "condensed",
    );
    const condensedCandidates = [...canonicalNodes, ...reusablePendingNodes, ...leafNodes].filter(
      (node) =>
        !coveringCondensedNodes.some(
          (cover) =>
            cover.depth > node.depth &&
            cover.ordinalStart <= node.ordinalStart &&
            cover.ordinalEnd >= node.ordinalEnd,
        ),
    );
    const condensedNodes = planPendingCondensedNodes({
      nodes: condensedCandidates,
      condensedMinFanout: this.config.condensedMinFanout,
      condensedMinSourceTokens: this.config.condensedMinSourceTokens,
      condensedChunkTokens: this.config.condensedChunkTokens,
      nodeIdPrefix,
    });
    const existingNodeKeys = new Set(
      existingNodes.map((node) =>
        this.plannerNodeIdentityKey({
          kind: node.kind,
          depth: node.depth,
          ordinalStart: node.ordinalStart,
          ordinalEnd: node.ordinalEnd,
        }),
      ),
    );
    const pendingNodes = [...leafNodes, ...condensedNodes].filter(
      (node) => !existingNodeKeys.has(this.plannerNodeIdentityKey(node)),
    );
    if (pendingNodes.length === 0) {
      return null;
    }

    await this.pendingSummaryStore.withTransaction(async () => {
      const updated = await this.pendingSummaryStore.updateBatchPlanningTarget({
        batchId: input.batch.batchId,
        sourceProjectionFingerprint: input.snapshot.sourceProjectionFingerprint,
        compactableStartOrdinal: input.snapshot.compactableStartOrdinal!,
        compactableEndOrdinal: input.snapshot.compactableEndOrdinal!,
        plannedFreshTailStartOrdinal: input.snapshot.freshTailStartOrdinal,
      });
      if (!updated) {
        throw new Error(`Pending compaction batch ${input.batch.batchId} is not active for extension`);
      }
      for (const node of pendingNodes) {
        await this.insertPendingNode(input.batch.batchId, input.batch.conversationId, node);
      }
    });

    return {
      status: "planned",
      batchId: input.batch.batchId,
      nodeCount: pendingNodes.length,
    };
  }

  private plannerNodeIdentityKey(
    node: Pick<PendingSummaryPlannerNode, "kind" | "depth" | "ordinalStart" | "ordinalEnd">,
  ): string {
    return `${node.kind}:${node.depth}:${node.ordinalStart}:${node.ordinalEnd}`;
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
    await this.pendingSummaryStore.linkNodeToChildren(
      node.nodeId,
      node.childLinks ?? [
        ...node.childNodeIds.map((childNodeId) => ({ childNodeId })),
        ...node.childSummaryIds.map((childSummaryId) => ({ childSummaryId })),
      ],
    );
  }

  private async publishIfReady(input: {
    batch: PendingCompactionBatchRecord;
    snapshot: ProjectionSnapshot;
  }): Promise<PendingCompactionCoordinatorResult | null> {
    const selection = await this.selectPublishFrontier(input);
    if (!selection) {
      return null;
    }
    const { frontier, pendingFrontier } = selection;
    if (pendingFrontier.length === 0) {
      await this.pendingSummaryStore.markBatchPublished({
        batchId: input.batch.batchId,
      });
      return {
        status: "published",
        batchId: input.batch.batchId,
        frontierSummaryIds: frontier.map((node) => node.canonicalSummaryId!),
        ...(this.hasRemainingCompactableWork(input) ? { remainingCompactableWork: true } : {}),
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
      expectedSourceProjectionFingerprint: input.batch.sourceProjectionFingerprint,
    });
    const publishedByNodeId = new Map(
      pendingFrontier.map(
        (node, index) => [node.nodeId, published.frontierSummaryIds[index]!] as const,
      ),
    );
    return {
      status: "published",
      batchId: input.batch.batchId,
      ...(this.hasRemainingCompactableWork(input) ? { remainingCompactableWork: true } : {}),
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

  private hasRemainingCompactableWork(input: {
    batch: PendingCompactionBatchRecord;
    snapshot: ProjectionSnapshot;
  }): boolean {
    return (
      input.snapshot.compactableEndOrdinal != null &&
      input.batch.compactableEndOrdinal < input.snapshot.compactableEndOrdinal
    );
  }

  private async selectPublishFrontier(input: {
    batch: PendingCompactionBatchRecord;
    snapshot: ProjectionSnapshot;
  }): Promise<PublishFrontierSelection | null> {
    const nodes = await this.pendingSummaryStore.getNodesByBatch(input.batch.batchId);
    // A publish frontier may mix already-canonical summaries with ready hidden
    // pending nodes, but it must exactly cover the batch range.
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
    return {
      frontier,
      pendingFrontier: frontier.filter((node) => typeof node.canonicalSummaryId !== "string"),
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
    const staleReason = await this.getActiveBatchStaleReason({ batch, snapshot });
    if (staleReason) {
      await this.pendingSummaryStore.markBatchStale({
        batchId: batch.batchId,
        failureSummary: staleReason,
      });
      return { status: "stale", batchId: batch.batchId, reason: staleReason };
    }
    return this.publishIfReady({ batch, snapshot });
  }

  private async getActiveBatchStaleReason(input: {
    batch: PendingCompactionBatchRecord;
    snapshot: ProjectionSnapshot;
  }): Promise<string | null> {
    const currentStart = input.snapshot.compactableStartOrdinal;
    const currentEnd = input.snapshot.compactableEndOrdinal;
    // Tail growth is valid: the current compactable range may extend beyond
    // the batch. Shrinking or moving the range means this batch no longer
    // targets the same prompt prefix.
    if (
      currentStart == null ||
      currentEnd == null ||
      input.batch.compactableStartOrdinal < currentStart ||
      input.batch.compactableEndOrdinal > currentEnd
    ) {
      return "pending batch range is no longer compactable";
    }

    if (
      input.batch.compactableStartOrdinal === currentStart &&
      input.batch.compactableEndOrdinal === currentEnd &&
      input.batch.sourceProjectionFingerprint !== input.snapshot.sourceProjectionFingerprint
    ) {
      return "source projection fingerprint changed before publish";
    }

    const itemsByOrdinal = new Map(input.snapshot.items.map((item) => [item.ordinal, item]));
    // Publishing rewrites by ordinal range, so gaps inside the planned range
    // indicate another rewrite already changed the source prefix.
    for (
      let ordinal = input.batch.compactableStartOrdinal;
      ordinal <= input.batch.compactableEndOrdinal;
      ordinal += 1
    ) {
      if (!itemsByOrdinal.has(ordinal)) {
        return "pending batch source range changed before publish";
      }
    }

    const nodes = await this.pendingSummaryStore.getNodesByBatch(input.batch.batchId);
    const nodesById = new Map(nodes.map((node) => [node.nodeId, node]));
    const summaryItemsById = new Map(
      input.snapshot.items
        .filter((item) => item.itemType === "summary" && typeof item.summaryId === "string")
        .map((item) => [item.summaryId!, item]),
    );
    // Tail growth is safe only when the original prefix still resolves to the
    // same raw leaf source and canonical summary children.
    for (const node of nodes) {
      if (node.kind === "leaf") {
        const sourceFingerprints = input.snapshot.items
          .filter(
            (item) =>
              item.ordinal >= node.ordinalStart &&
              item.ordinal <= node.ordinalEnd,
          )
          .sort((a, b) => a.ordinal - b.ordinal)
          .map((item) => item.sourceFingerprint);
        const sourceContextHash = digestText("pending-node-context", [
          String(node.ordinalStart),
          String(node.ordinalEnd),
          ...sourceFingerprints,
        ]);
        if (node.sourceContextHash !== sourceContextHash) {
          return "pending batch source changed before publish";
        }
        continue;
      }

      const childrenStillCurrent = await this.pendingNodeChildrenStillCurrent({
        node,
        nodesById,
        summaryItemsById,
      });
      if (!childrenStillCurrent) {
        return "pending batch source changed before publish";
      }
    }

    return null;
  }

  private async pendingNodeChildrenStillCurrent(input: {
    node: PendingSummaryNodeRecord;
    nodesById: Map<string, PendingSummaryNodeRecord>;
    summaryItemsById: Map<string, PendingSummaryPlannerSnapshotItem>;
  }): Promise<boolean> {
    const children = await this.pendingSummaryStore.getNodeChildren(input.node.nodeId);
    for (const child of children) {
      if (child.childNodeId) {
        if (!input.nodesById.has(child.childNodeId)) {
          return false;
        }
        continue;
      }

      if (child.childSummaryId) {
        const summaryItem = input.summaryItemsById.get(child.childSummaryId);
        if (
          !summaryItem ||
          summaryItem.ordinal < input.node.ordinalStart ||
          summaryItem.ordinal > input.node.ordinalEnd
        ) {
          return false;
        }
        continue;
      }

      return false;
    }
    return true;
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
      childLinks: [],
    };
  }

  private async loadSourceText(node: PendingSummaryNodeRecord): Promise<string> {
    if (node.kind === "leaf") {
      const messageLinks = await this.pendingSummaryStore.getNodeMessages(node.nodeId);
      const chunks: string[] = [];
      for (const link of messageLinks) {
        const message = await this.conversationStore.getMessageById(link.messageId);
        if (message) {
          chunks.push(
            await formatMessageForSummary(
              this.conversationStore,
              message,
              this.config.stripInjectedContextTags,
            ),
          );
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
