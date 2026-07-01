// Pending summary compaction proof runner exercises the issue-807 lifecycle.
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { getLcmDbFeatures } from "../../src/db/features.js";
import { runLcmMigrations } from "../../src/db/migration.js";
import { PendingCompactionCoordinator } from "../../src/pending-summary-coordinator.js";
import { ConversationStore } from "../../src/store/conversation-store.js";
import { PendingSummaryStore } from "../../src/store/pending-summary-store.js";
import { SummaryStore, type ContextItemRecord } from "../../src/store/summary-store.js";

type ProofCheckpoint = {
  canonicalSummaries: number;
  contextItems: Array<Pick<ContextItemRecord, "itemType" | "messageId" | "ordinal" | "summaryId">>;
  label: string;
  pendingNodes: Array<{
    canonicalSummaryId: string | null;
    depth: number;
    kind: string;
    nodeId: string;
    ordinalEnd: number;
    ordinalStart: number;
    status: string;
  }>;
  summarizeCalls: Array<{ isCondensed: boolean; sourceText: string }>;
};

export type PendingSummaryCompactionProofReport = {
  batchId: string;
  checkpoints: ProofCheckpoint[];
  failures: string[];
  ok: boolean;
  publishedSummaryId: string | null;
};

type Stores = {
  conversationStore: ConversationStore;
  pendingSummaryStore: PendingSummaryStore;
  summaryStore: SummaryStore;
};

function createStores(): Stores {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const { fts5Available } = getLcmDbFeatures(db);
  runLcmMigrations(db, { fts5Available });
  return {
    conversationStore: new ConversationStore(db, { fts5Available }),
    pendingSummaryStore: new PendingSummaryStore(db),
    summaryStore: new SummaryStore(db, { fts5Available }),
  };
}

/** Run an isolated proof that hidden pending summaries publish atomically. */
export async function runPendingSummaryCompactionProof(): Promise<PendingSummaryCompactionProofReport> {
  const stores = createStores();
  const checkpoints: ProofCheckpoint[] = [];
  const failures: string[] = [];
  const summarizeCalls: Array<{ isCondensed: boolean; sourceText: string }> = [];
  let batchId = "";

  const conversation = await stores.conversationStore.createConversation({
    sessionId: "pending-summary-proof-session",
    sessionKey: "agent:main:pending-summary-proof",
  });
  const messages = await stores.conversationStore.createMessagesBulk([
    {
      conversationId: conversation.conversationId,
      seq: 1,
      role: "user",
      content: "alpha raw message to compact",
      tokenCount: 4,
    },
    {
      conversationId: conversation.conversationId,
      seq: 2,
      role: "assistant",
      content: "bravo raw message to compact",
      tokenCount: 4,
    },
    {
      conversationId: conversation.conversationId,
      seq: 3,
      role: "user",
      content: "charlie raw message to compact",
      tokenCount: 4,
    },
    {
      conversationId: conversation.conversationId,
      seq: 4,
      role: "assistant",
      content: "delta raw fresh tail",
      tokenCount: 4,
    },
  ]);
  await stores.summaryStore.appendContextMessages(
    conversation.conversationId,
    messages.map((message) => message.messageId),
  );

  const coordinator = new PendingCompactionCoordinator({
    ...stores,
    model: "proof-model",
    leaseOwner: "proof-worker",
    config: {
      freshTailCount: 1,
      leafChunkTokens: 8,
      condensedMinFanout: 2,
      condensedMinSourceTokens: 1,
      condensedChunkTokens: 100,
    },
    summarize: async (sourceText, _aggressive, options) => {
      const isCondensed = options?.isCondensed === true;
      summarizeCalls.push({ isCondensed, sourceText });
      return isCondensed
        ? `proof condensed summary over:\n${sourceText}`
        : `proof leaf summary over:\n${sourceText}`;
    },
  });

  const record = async (label: string): Promise<void> => {
    const activeBatch = await stores.pendingSummaryStore.getActiveBatchForConversation(
      conversation.conversationId,
    );
    if (activeBatch) {
      batchId = activeBatch.batchId;
    }
    const pendingNodes = batchId
      ? await stores.pendingSummaryStore.getNodesByBatch(batchId)
      : [];
    const canonicalSummaries = await stores.summaryStore.getSummariesByConversation(
      conversation.conversationId,
    );
    checkpoints.push({
      label,
      canonicalSummaries: canonicalSummaries.length,
      contextItems: (await stores.summaryStore.getContextItems(conversation.conversationId)).map(
        (item) => ({
          itemType: item.itemType,
          messageId: item.messageId,
          ordinal: item.ordinal,
          summaryId: item.summaryId,
        }),
      ),
      pendingNodes: pendingNodes.map((node) => ({
        canonicalSummaryId: node.canonicalSummaryId,
        depth: node.depth,
        kind: node.kind,
        nodeId: node.nodeId,
        ordinalEnd: node.ordinalEnd,
        ordinalStart: node.ordinalStart,
        status: node.status,
      })),
      summarizeCalls: [...summarizeCalls],
    });
  };

  await record("seeded-raw-context");
  const planned = await coordinator.runOnce({
    conversationId: conversation.conversationId,
    sessionKey: "agent:main:pending-summary-proof",
  });
  if (planned.status !== "planned") {
    failures.push(`expected planned step, got ${planned.status}`);
  }
  await record("after-plan");

  await coordinator.runOnce({ conversationId: conversation.conversationId });
  await coordinator.runOnce({ conversationId: conversation.conversationId });
  await record("after-leaf-preparation");

  await coordinator.runOnce({ conversationId: conversation.conversationId });
  await record("after-condensed-preparation");

  const ready = await coordinator.runOnce({
    conversationId: conversation.conversationId,
    publishPolicy: "prepare-only",
  });
  if (ready.status !== "ready") {
    failures.push(`expected ready step, got ${ready.status}`);
  }
  await record("after-ready-no-publish");

  const published = await coordinator.runOnce({ conversationId: conversation.conversationId });
  if (published.status !== "published") {
    failures.push(`expected published step, got ${published.status}`);
  }
  await record("after-publish");

  const publishedContext = await stores.summaryStore.getContextItems(conversation.conversationId);
  const publishedSummaryId = publishedContext[0]?.summaryId ?? null;
  const publishedSummary = publishedSummaryId
    ? await stores.summaryStore.getSummary(publishedSummaryId)
    : null;
  const publishedParents = publishedSummaryId
    ? await stores.summaryStore.getSummaryParents(publishedSummaryId)
    : [];

  validateProof({ checkpoints, failures, publishedParents, publishedSummary });
  return {
    batchId,
    checkpoints,
    failures,
    ok: failures.length === 0,
    publishedSummaryId,
  };
}

function validateProof(input: {
  checkpoints: ProofCheckpoint[];
  failures: string[];
  publishedParents: unknown[];
  publishedSummary: { content: string; kind: string; depth: number } | null;
}): void {
  const byLabel = new Map(input.checkpoints.map((checkpoint) => [checkpoint.label, checkpoint]));
  for (const label of [
    "seeded-raw-context",
    "after-plan",
    "after-leaf-preparation",
    "after-condensed-preparation",
    "after-ready-no-publish",
  ]) {
    const checkpoint = byLabel.get(label);
    if (!checkpoint) {
      input.failures.push(`missing checkpoint ${label}`);
      continue;
    }
    if (checkpoint.canonicalSummaries !== 0) {
      input.failures.push(`${label} wrote canonical summaries before publish`);
    }
    if (!checkpoint.contextItems.every((item) => item.itemType === "message")) {
      input.failures.push(`${label} changed canonical context before publish`);
    }
  }

  const afterPlan = byLabel.get("after-plan");
  if (afterPlan?.pendingNodes.length !== 3) {
    input.failures.push("after-plan should contain two leaf nodes and one condensed node");
  }
  const afterLeaves = byLabel.get("after-leaf-preparation");
  if (
    afterLeaves?.pendingNodes.filter((node) => node.kind === "leaf" && node.status === "ready")
      .length !== 2
  ) {
    input.failures.push("after-leaf-preparation should have two ready leaves");
  }
  if (
    afterLeaves?.pendingNodes.some(
      (node) => node.kind === "condensed" && node.status !== "planned",
    )
  ) {
    input.failures.push("condensed parent should stay planned until leaves are ready");
  }

  const afterCondensed = byLabel.get("after-condensed-preparation");
  const condensedCall = afterCondensed?.summarizeCalls.find((call) => call.isCondensed);
  if (!condensedCall?.sourceText.includes("proof leaf summary over:")) {
    input.failures.push("condensed summary did not use hidden leaf summaries as source");
  }
  if (
    afterCondensed?.pendingNodes.filter((node) => node.kind === "condensed" && node.status === "ready")
      .length !== 1
  ) {
    input.failures.push("after-condensed-preparation should have one ready condensed parent");
  }

  const afterReady = byLabel.get("after-ready-no-publish");
  if (
    afterReady?.pendingNodes.filter((node) => node.status === "ready").length !== 3
  ) {
    input.failures.push("after-ready-no-publish should leave all pending nodes ready");
  }
  if (afterReady?.canonicalSummaries !== 0) {
    input.failures.push("prepare-only ready step should not publish canonical summaries");
  }
  if (!afterReady?.contextItems.every((item) => item.itemType === "message")) {
    input.failures.push("prepare-only ready step should not swap canonical context");
  }

  const afterPublish = byLabel.get("after-publish");
  if (afterPublish?.canonicalSummaries !== 3) {
    input.failures.push("after-publish should promote two leaves plus one condensed summary");
  }
  if (
    afterPublish?.contextItems.length !== 2 ||
    afterPublish.contextItems[0]?.itemType !== "summary" ||
    afterPublish.contextItems[1]?.itemType !== "message"
  ) {
    input.failures.push("after-publish should swap covered raw prefix and keep fresh tail raw");
  }
  if (!afterPublish?.pendingNodes.every((node) => node.status === "promoted")) {
    input.failures.push("after-publish should mark all pending nodes promoted");
  }
  if (
    !input.publishedSummary ||
    input.publishedSummary.kind !== "condensed" ||
    input.publishedSummary.depth !== 1
  ) {
    input.failures.push("published frontier summary should be the condensed parent");
  }
  if (input.publishedParents.length !== 2) {
    input.failures.push("published condensed summary should link to two leaf parents");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const report = await runPendingSummaryCompactionProof();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) {
    process.exitCode = 1;
  }
}
