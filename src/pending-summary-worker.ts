import type { PendingSummaryNodeRecord } from "./store/pending-summary-store.js";

export type PendingSummaryPreparationStore = {
  claimNextPlannedNode(input: {
    conversationId: number;
    leaseOwner: string;
    leaseExpiresAt: Date;
    now?: Date;
  }): Promise<PendingSummaryNodeRecord | null>;
  markNodeReady(input: {
    nodeId: string;
    leaseOwner: string;
    leaseExpiresAt: Date;
    content: string;
    tokenCount: number;
    readyAt?: Date;
  }): Promise<boolean>;
  markNodeFailed(input: {
    nodeId: string;
    leaseOwner: string;
    leaseExpiresAt: Date;
    failureSummary: string;
  }): Promise<boolean>;
};

export type PendingSummaryPreparationWorkerOptions = {
  store: PendingSummaryPreparationStore;
  leaseOwner: string;
  leaseMs: number;
  now?: () => Date;
  loadSourceText: (node: PendingSummaryNodeRecord) => Promise<string>;
  summarize: (sourceText: string, node: PendingSummaryNodeRecord) => Promise<string>;
  estimateTokens: (content: string) => number;
};

export type PendingSummaryPreparationResult =
  | { status: "idle" }
  | { status: "prepared"; nodeId: string }
  | { status: "failed"; nodeId: string; failureSummary: string };

function describeError(error: unknown): string {
  if (error instanceof Error && typeof error.message === "string" && error.message.length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.length > 0) {
    return error;
  }
  return "unknown pending summary preparation failure";
}

function normalizeLeaseMs(value: number): number {
  if (Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return 60_000;
}

function normalizeTokenCount(value: number): number {
  if (Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return 0;
}

/**
 * Claims and prepares one hidden pending summary node.
 *
 * This worker intentionally performs the LLM call after `claimNextPlannedNode`
 * returns. The claim and result writes are short store operations; source
 * loading and summarization happen between them.
 */
export class PendingSummaryPreparationWorker {
  private readonly store: PendingSummaryPreparationStore;
  private readonly leaseOwner: string;
  private readonly leaseMs: number;
  private readonly now: () => Date;
  private readonly loadSourceText: (node: PendingSummaryNodeRecord) => Promise<string>;
  private readonly summarize: (
    sourceText: string,
    node: PendingSummaryNodeRecord,
  ) => Promise<string>;
  private readonly estimateTokens: (content: string) => number;

  constructor(options: PendingSummaryPreparationWorkerOptions) {
    this.store = options.store;
    this.leaseOwner = options.leaseOwner;
    this.leaseMs = normalizeLeaseMs(options.leaseMs);
    this.now = options.now ?? (() => new Date());
    this.loadSourceText = options.loadSourceText;
    this.summarize = options.summarize;
    this.estimateTokens = options.estimateTokens;
  }

  /** Prepare one pending summary node for a conversation, if work is claimable. */
  async prepareOne(input: { conversationId: number }): Promise<PendingSummaryPreparationResult> {
    const claimedAt = this.now();
    const node = await this.store.claimNextPlannedNode({
      conversationId: input.conversationId,
      leaseOwner: this.leaseOwner,
      leaseExpiresAt: new Date(claimedAt.getTime() + this.leaseMs),
      now: claimedAt,
    });
    if (!node) {
      return { status: "idle" };
    }
    if (!node.leaseExpiresAt) {
      return { status: "idle" };
    }

    try {
      const sourceText = await this.loadSourceText(node);
      const content = await this.summarize(sourceText, node);
      const saved = await this.store.markNodeReady({
        nodeId: node.nodeId,
        leaseOwner: this.leaseOwner,
        leaseExpiresAt: node.leaseExpiresAt,
        content,
        tokenCount: normalizeTokenCount(this.estimateTokens(content)),
        readyAt: this.now(),
      });
      if (!saved) {
        return { status: "idle" };
      }
      return { status: "prepared", nodeId: node.nodeId };
    } catch (error) {
      const failureSummary = describeError(error);
      const saved = await this.store.markNodeFailed({
        nodeId: node.nodeId,
        leaseOwner: this.leaseOwner,
        leaseExpiresAt: node.leaseExpiresAt,
        failureSummary,
      });
      if (!saved) {
        return { status: "idle" };
      }
      return { status: "failed", nodeId: node.nodeId, failureSummary };
    }
  }
}
