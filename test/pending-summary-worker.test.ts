import { describe, expect, it } from "vitest";
import {
  PendingSummaryPreparationWorker,
  type PendingSummaryPreparationStore,
} from "../src/pending-summary-worker.js";
import type { PendingSummaryNodeRecord } from "../src/store/pending-summary-store.js";

function createNode(): PendingSummaryNodeRecord {
  return {
    nodeId: "node_worker_a",
    batchId: "batch_worker_a",
    conversationId: 42,
    kind: "leaf",
    depth: 0,
    status: "running",
    ordinalStart: 0,
    ordinalEnd: 1,
    sourceFingerprint: "source:worker",
    sourceContextHash: null,
    content: null,
    tokenCount: null,
    promptVersion: "leaf:v1",
    model: "test-model",
    canonicalSummaryId: null,
    leaseOwner: "worker-a",
    leaseExpiresAt: new Date("2026-06-30T12:05:00.000Z"),
    failureSummary: null,
    retryCount: 0,
    nextAttemptAfter: null,
    createdAt: new Date("2026-06-30T12:00:00.000Z"),
    updatedAt: new Date("2026-06-30T12:00:00.000Z"),
    readyAt: null,
    promotedAt: null,
  };
}

describe("PendingSummaryPreparationWorker", () => {
  it("runs summarization after the claim transaction has completed", async () => {
    let transactionActive = false;
    const events: string[] = [];
    const store: PendingSummaryPreparationStore = {
      async claimNextPlannedNode() {
        transactionActive = true;
        events.push("claim:start");
        transactionActive = false;
        events.push("claim:end");
        return createNode();
      },
      async markNodeReady(input) {
        events.push(
          `ready:${input.nodeId}:${input.leaseOwner}:${input.content}:${input.tokenCount}`,
        );
        return true;
      },
      async markNodeFailed(input) {
        events.push(`failed:${input.nodeId}:${input.leaseOwner}:${input.failureSummary}`);
        return true;
      },
      async releaseNodeClaim(input) {
        events.push(`released:${input.nodeId}`);
        return true;
      },
    };
    const worker = new PendingSummaryPreparationWorker({
      store,
      leaseOwner: "worker-a",
      leaseMs: 60_000,
      now: () => new Date("2026-06-30T12:00:00.000Z"),
      loadSourceText: async (node) => {
        events.push(`load:${node.nodeId}`);
        return "source text";
      },
      summarize: async (sourceText, node) => {
        expect(transactionActive).toBe(false);
        events.push(`summarize:${node.nodeId}:${sourceText}`);
        return "prepared summary";
      },
      estimateTokens: (content) => content.split(/\s+/).length,
    });

    await expect(worker.prepareOne({ conversationId: 42 })).resolves.toEqual({
      status: "prepared",
      nodeId: "node_worker_a",
    });
    expect(events).toEqual([
      "claim:start",
      "claim:end",
      "load:node_worker_a",
      "summarize:node_worker_a:source text",
      "ready:node_worker_a:worker-a:prepared summary:2",
    ]);
  });

  it("marks a claimed node failed when summarization throws", async () => {
    const events: string[] = [];
    const store: PendingSummaryPreparationStore = {
      async claimNextPlannedNode() {
        return createNode();
      },
      async markNodeReady(input) {
        events.push(`ready:${input.nodeId}`);
        return true;
      },
      async markNodeFailed(input) {
        events.push(`failed:${input.nodeId}:${input.leaseOwner}:${input.failureSummary}`);
        return true;
      },
      async releaseNodeClaim(input) {
        events.push(`released:${input.nodeId}`);
        return true;
      },
    };
    const worker = new PendingSummaryPreparationWorker({
      store,
      leaseOwner: "worker-a",
      leaseMs: 60_000,
      now: () => new Date("2026-06-30T12:00:00.000Z"),
      loadSourceText: async () => "source text",
      summarize: async () => {
        throw new Error("provider timeout");
      },
      estimateTokens: () => 0,
    });

    await expect(worker.prepareOne({ conversationId: 42 })).resolves.toEqual({
      status: "failed",
      nodeId: "node_worker_a",
      failureSummary: "provider timeout",
    });
    expect(events).toEqual(["failed:node_worker_a:worker-a:provider timeout"]);
  });

  it("marks a claimed node failed when source text is empty", async () => {
    const events: string[] = [];
    const store: PendingSummaryPreparationStore = {
      async claimNextPlannedNode() {
        return createNode();
      },
      async markNodeReady(input) {
        events.push(`ready:${input.nodeId}`);
        return true;
      },
      async markNodeFailed(input) {
        events.push(`failed:${input.nodeId}:${input.leaseOwner}:${input.failureSummary}`);
        return true;
      },
      async releaseNodeClaim(input) {
        events.push(`released:${input.nodeId}`);
        return true;
      },
    };
    const worker = new PendingSummaryPreparationWorker({
      store,
      leaseOwner: "worker-a",
      leaseMs: 60_000,
      now: () => new Date("2026-06-30T12:00:00.000Z"),
      loadSourceText: async () => "   ",
      summarize: async () => {
        throw new Error("should not be called");
      },
      estimateTokens: () => 0,
    });

    await expect(worker.prepareOne({ conversationId: 42 })).resolves.toEqual({
      status: "failed",
      nodeId: "node_worker_a",
      failureSummary: "empty pending summary source",
    });
    expect(events).toEqual(["failed:node_worker_a:worker-a:empty pending summary source"]);
  });

  it("marks a claimed node failed when prepared content is empty", async () => {
    const events: string[] = [];
    const store: PendingSummaryPreparationStore = {
      async claimNextPlannedNode() {
        return createNode();
      },
      async markNodeReady(input) {
        events.push(`ready:${input.nodeId}`);
        return true;
      },
      async markNodeFailed(input) {
        events.push(`failed:${input.nodeId}:${input.leaseOwner}:${input.failureSummary}`);
        return true;
      },
      async releaseNodeClaim(input) {
        events.push(`released:${input.nodeId}`);
        return true;
      },
    };
    const worker = new PendingSummaryPreparationWorker({
      store,
      leaseOwner: "worker-a",
      leaseMs: 60_000,
      now: () => new Date("2026-06-30T12:00:00.000Z"),
      loadSourceText: async () => "source text",
      summarize: async () => "   ",
      estimateTokens: () => 0,
    });

    await expect(worker.prepareOne({ conversationId: 42 })).resolves.toEqual({
      status: "failed",
      nodeId: "node_worker_a",
      failureSummary: "empty pending summary content",
    });
    expect(events).toEqual(["failed:node_worker_a:worker-a:empty pending summary content"]);
  });

  it("releases the claim without failure bookkeeping on spend-guard refusal", async () => {
    const events: string[] = [];
    const store: PendingSummaryPreparationStore = {
      async claimNextPlannedNode() {
        return createNode();
      },
      async markNodeReady(input) {
        events.push(`ready:${input.nodeId}`);
        return true;
      },
      async markNodeFailed(input) {
        events.push(`failed:${input.nodeId}:${input.leaseOwner}:${input.failureSummary}`);
        return true;
      },
      async releaseNodeClaim(input) {
        events.push(`released:${input.nodeId}`);
        return true;
      },
    };
    class SpendLimitError extends Error {}
    const worker = new PendingSummaryPreparationWorker({
      store,
      leaseOwner: "worker-a",
      leaseMs: 60_000,
      now: () => new Date("2026-06-30T12:00:00.000Z"),
      loadSourceText: async () => "source text",
      summarize: async () => {
        throw new SpendLimitError("spend guard refused");
      },
      estimateTokens: () => 0,
      isSpendLimitFailure: (error) => error instanceof SpendLimitError,
    });

    await expect(worker.prepareOne({ conversationId: 42 })).resolves.toEqual({
      status: "spend-limited",
      nodeId: "node_worker_a",
    });
    expect(events).toEqual(["released:node_worker_a"]);
  });

  it("treats a lost lease during ready save as obsolete work", async () => {
    const events: string[] = [];
    const store: PendingSummaryPreparationStore = {
      async claimNextPlannedNode() {
        return createNode();
      },
      async markNodeReady(input) {
        events.push(`ready:${input.nodeId}:${input.leaseOwner}`);
        return false;
      },
      async markNodeFailed(input) {
        events.push(`failed:${input.nodeId}:${input.leaseOwner}`);
        return true;
      },
      async releaseNodeClaim(input) {
        events.push(`released:${input.nodeId}`);
        return true;
      },
    };
    const worker = new PendingSummaryPreparationWorker({
      store,
      leaseOwner: "worker-a",
      leaseMs: 60_000,
      now: () => new Date("2026-06-30T12:00:00.000Z"),
      loadSourceText: async () => "source text",
      summarize: async () => "prepared summary",
      estimateTokens: () => 2,
    });

    await expect(worker.prepareOne({ conversationId: 42 })).resolves.toEqual({
      status: "idle",
    });
    expect(events).toEqual(["ready:node_worker_a:worker-a"]);
  });
});
