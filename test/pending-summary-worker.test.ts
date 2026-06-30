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
        events.push(`ready:${input.nodeId}:${input.content}:${input.tokenCount}`);
      },
      async markNodeFailed(input) {
        events.push(`failed:${input.nodeId}:${input.failureSummary}`);
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
      "ready:node_worker_a:prepared summary:2",
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
      },
      async markNodeFailed(input) {
        events.push(`failed:${input.nodeId}:${input.failureSummary}`);
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
    expect(events).toEqual(["failed:node_worker_a:provider timeout"]);
  });
});
