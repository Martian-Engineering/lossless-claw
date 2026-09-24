import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLcmDbFeatures } from "../src/db/features.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { PendingCompactionCoordinator } from "../src/pending-summary-coordinator.js";
import { PendingSummaryPublisher } from "../src/pending-summary-publisher.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { PendingSummaryStore } from "../src/store/pending-summary-store.js";
import { SummaryStore } from "../src/store/summary-store.js";

const databases: DatabaseSync[] = [];
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

/** Plan four two-message leaves and a parent, with one protected fresh message. */
async function setup(path = ":memory:") {
  const db = new DatabaseSync(path);
  databases.push(db);
  db.exec("PRAGMA foreign_keys = ON");
  const { fts5Available } = getLcmDbFeatures(db);
  runLcmMigrations(db, { fts5Available });
  const conversationStore = new ConversationStore(db, { fts5Available });
  const pendingSummaryStore = new PendingSummaryStore(db);
  const summaryStore = new SummaryStore(db, { fts5Available });
  const { conversationId } = await conversationStore.createConversation({
    sessionId: "prefix",
  });
  const messages = await conversationStore.createMessagesBulk(
    Array.from({ length: 9 }, (_, index) => ({
      conversationId,
      seq: index + 1,
      role: "user" as const,
      content: `original message ${index + 1}`,
      tokenCount: 4,
    })),
  );
  await summaryStore.appendContextMessages(
    conversationId,
    messages.map((message) => message.messageId),
  );
  const summarize = vi.fn(async (text: string) => `prepared ${text}`);
  const options = {
    conversationStore,
    pendingSummaryStore,
    summaryStore,
    summarize,
    model: "test",
    leaseOwner: "test",
    config: {
      freshTailCount: 1,
      leafChunkTokens: 8,
      condensedMinFanout: 2,
      condensedMinSourceTokens: 1,
      condensedChunkTokens: 100,
    },
  };
  const coordinator = new PendingCompactionCoordinator(options);
  const plan = await coordinator.runOnce({
    conversationId,
    publishPolicy: "prepare-only",
  });
  expect(plan.status).toBe("planned");
  const batch = (await pendingSummaryStore.getActiveBatchForConversation(conversationId))!;
  const nodes = await pendingSummaryStore.getNodesByBatch(batch.batchId);
  const leaves = nodes.filter((node) => node.kind === "leaf");
  expect(leaves).toHaveLength(4);
  /** Complete selected hidden nodes to model preparation finishing out of order. */
  const ready = (index: number) =>
    db
      .prepare(
        "UPDATE pending_summary_nodes SET status = 'ready', content = ?, token_count = 2 WHERE node_id = ?",
      )
      .run(`leaf ${index}`, leaves[index]!.nodeId);
  const publish = () =>
    coordinator.runOnce({
      conversationId,
      publishPolicy: "publish-ready-only",
    });
  return {
    db,
    conversationId,
    messages,
    options,
    coordinator,
    batch,
    leaves,
    ready,
    publish,
    conversationStore,
    pendingSummaryStore,
    summaryStore,
    summarize,
  };
}

describe("partial pending summary publication", () => {
  it("retains prepared suffix work and resumes parents through promoted canonical children", async () => {
    const f = await setup();
    f.ready(0);
    f.ready(1);
    f.ready(3);
    const original = await f.summaryStore.getContextItems(f.conversationId);
    expect(original).toHaveLength(9);
    const first = await f.publish();
    expect(first).toMatchObject({
      status: "published",
      remainingCompactableWork: true,
    });
    expect(f.summarize).not.toHaveBeenCalled();
    const active = await f.summaryStore.getContextItems(f.conversationId);
    expect(active.map((item) => item.itemType)).toEqual([
      "summary",
      "summary",
      ...Array(5).fill("message"),
    ]);
    expect(active.slice(2).map((item) => item.messageId)).toEqual(
      f.messages.slice(4).map((m) => m.messageId),
    );
    expect(await f.conversationStore.getMessageCount(f.conversationId)).toBe(9);
    expect(await f.pendingSummaryStore.getNode(f.leaves[3]!.nodeId)).toMatchObject({
      status: "ready",
      content: "leaf 3",
      ordinalStart: 4,
      ordinalEnd: 5,
    });
    expect(await f.pendingSummaryStore.getNode(f.leaves[0]!.nodeId)).toMatchObject({
      status: "promoted",
      content: null,
    });
    expect(await f.publish()).toMatchObject({
      status: "idle",
      reason: "no ready pending summary frontier",
    });
    expect(await f.summaryStore.getContextItems(f.conversationId)).toEqual(active);

    // A fresh coordinator/store has no in-memory publication state to depend on.
    const restarted = new PendingCompactionCoordinator({
      ...f.options,
      pendingSummaryStore: new PendingSummaryStore(f.db),
    });
    expect(
      await restarted.runOnce({
        conversationId: f.conversationId,
        publishPolicy: "prepare-only",
      }),
    ).toMatchObject({ status: "prepared", nodeId: f.leaves[2]!.nodeId });
    expect(await f.publish()).toMatchObject({
      status: "published",
      remainingCompactableWork: true,
    });
    expect((await f.summaryStore.getContextItems(f.conversationId)).slice(0, 2)).toEqual(
      active.slice(0, 2),
    );
    expect(
      await restarted.runOnce({
        conversationId: f.conversationId,
        publishPolicy: "prepare-only",
      }),
    ).toMatchObject({ status: "prepared" });
    expect(f.summarize).toHaveBeenCalledTimes(2);
    expect(f.summarize.mock.calls[1]![0]).toContain("leaf 0");
    expect(f.summarize.mock.calls[1]![0]).toContain("leaf 3");
    expect(await f.publish()).toMatchObject({ status: "published" });
    expect(await f.pendingSummaryStore.getActiveBatchForConversation(f.conversationId)).toBeNull();
    const final = await f.summaryStore.getContextItems(f.conversationId);
    expect(final.map((item) => item.itemType)).toEqual(["summary", "message"]);
    expect(final[1]!.messageId).toBe(f.messages[8]!.messageId);
    expect(await f.summaryStore.getSummaryParents(final[0]!.summaryId!)).toHaveLength(4);
    expect(await f.conversationStore.getMessageCount(f.conversationId)).toBe(9);
  });

  it("replays a committed prefix idempotently even with its original fingerprint", async () => {
    const f = await setup();
    f.ready(0);
    const publisher = new PendingSummaryPublisher(f.options);
    const input = {
      batchId: f.batch.batchId,
      frontierNodeIds: [f.leaves[0]!.nodeId],
      expectedSourceProjectionFingerprint: f.batch.sourceProjectionFingerprint,
    };
    const first = await publisher.publishReadyFrontier(input);
    const active = await f.summaryStore.getContextItems(f.conversationId);
    expect(await publisher.publishReadyFrontier(input)).toEqual(first);
    expect(await f.summaryStore.getContextItems(f.conversationId)).toEqual(active);
    expect(
      await f.pendingSummaryStore.getActiveBatchForConversation(f.conversationId),
    ).not.toBeNull();
  });

  it("rolls back canonical rows, promotion, and context if progress persistence fails", async () => {
    const f = await setup();
    f.ready(0);
    const original = await f.summaryStore.getContextItems(f.conversationId);
    const failure = vi
      .spyOn(f.pendingSummaryStore, "updateBatchPlanningTarget")
      .mockRejectedValueOnce(new Error("crash before commit"));
    await expect(f.publish()).rejects.toThrow("crash before commit");
    expect(await f.summaryStore.getContextItems(f.conversationId)).toEqual(original);
    expect(f.db.prepare("SELECT count(*) AS n FROM summaries").get()).toMatchObject({ n: 0 });
    expect(await f.pendingSummaryStore.getNode(f.leaves[0]!.nodeId)).toMatchObject({
      status: "ready",
    });
    failure.mockRestore();
    expect(await f.publish()).toMatchObject({
      status: "published",
      remainingCompactableWork: true,
    });
  });

  it.each(["suffix", "published", "gap", "fresh tail"])(
    "rejects genuine %s changes after partial publication",
    async (change) => {
      const f = await setup();
      f.ready(0);
      await f.publish();
      f.ready(1);
      if (change === "suffix")
        f.db
          .prepare("UPDATE messages SET content = 'changed' WHERE message_id = ?")
          .run(f.messages[2]!.messageId);
      if (change === "published") f.db.prepare("UPDATE summaries SET content = 'changed'").run();
      if (change === "gap")
        f.db
          .prepare("DELETE FROM context_items WHERE conversation_id = ? AND ordinal = 2")
          .run(f.conversationId);
      if (change === "fresh tail") f.options.config.freshTailCount = 8;
      const before = await f.summaryStore.getContextItems(f.conversationId);
      expect(await f.publish()).toMatchObject({ status: "stale" });
      expect(await f.summaryStore.getContextItems(f.conversationId)).toEqual(before);
    },
  );

  it("revalidates after acquiring the publication lock", async () => {
    const f = await setup();
    f.ready(0);
    const coordinator = new PendingCompactionCoordinator({
      ...f.options,
      withPublishLock: async (operation) => {
        f.db
          .prepare("UPDATE messages SET content = 'concurrent mutation' WHERE message_id = ?")
          .run(f.messages[0]!.messageId);
        return operation();
      },
    });
    const before = await f.summaryStore.getContextItems(f.conversationId);
    expect(
      await coordinator.runOnce({
        conversationId: f.conversationId,
        publishPolicy: "publish-ready-only",
      }),
    ).toMatchObject({ status: "stale" });
    expect(await f.summaryStore.getContextItems(f.conversationId)).toEqual(before);
  });

  it("serializes competing publication attempts into one canonical swap", async () => {
    const f = await setup();
    f.ready(0);
    const results = await Promise.all([f.publish(), f.publish()]);
    expect(results.map((result) => result.status).sort()).toEqual(["idle", "published"]);
    expect(await f.summaryStore.getSummariesByConversation(f.conversationId)).toHaveLength(1);
    expect(await f.conversationStore.getMessageCount(f.conversationId)).toBe(9);
  });

  it("adds active coordinates to an existing batch without changing planning keys or sources", async () => {
    const f = await setup();
    f.ready(0);
    f.db.exec("ALTER TABLE pending_summary_nodes DROP COLUMN active_ordinal_start");
    f.db.exec("ALTER TABLE pending_summary_nodes DROP COLUMN active_ordinal_end");
    const original = await f.pendingSummaryStore.getNodeMessages(f.leaves[0]!.nodeId);
    runLcmMigrations(f.db, getLcmDbFeatures(f.db));
    runLcmMigrations(f.db, getLcmDbFeatures(f.db));
    expect(await f.publish()).toMatchObject({
      status: "published",
      remainingCompactableWork: true,
    });
    expect(
      f.db
        .prepare(
          "SELECT ordinal_start, ordinal_end, active_ordinal_start, active_ordinal_end FROM pending_summary_nodes WHERE node_id = ?",
        )
        .get(f.leaves[1]!.nodeId),
    ).toEqual({ ordinal_start: 2, ordinal_end: 3, active_ordinal_start: 1, active_ordinal_end: 2 });
    expect(await f.pendingSummaryStore.getNodeMessages(f.leaves[0]!.nodeId)).toEqual(original);
  });

  it("resumes a committed prefix after closing and reopening its database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lcm-prefix-restart-"));
    directories.push(directory);
    const path = join(directory, "lcm.db");
    const f = await setup(path);
    f.ready(0);
    await f.publish();
    const before = await f.summaryStore.getContextItems(f.conversationId);
    f.db.close();
    databases.splice(databases.indexOf(f.db), 1);
    const db = new DatabaseSync(path);
    databases.push(db);
    db.exec("PRAGMA foreign_keys = ON");
    const features = getLcmDbFeatures(db);
    runLcmMigrations(db, features);
    const conversationStore = new ConversationStore(db, features);
    const summaryStore = new SummaryStore(db, features);
    const pendingSummaryStore = new PendingSummaryStore(db);
    const restarted = new PendingCompactionCoordinator({
      ...f.options,
      conversationStore,
      summaryStore,
      pendingSummaryStore,
    });
    expect(await summaryStore.getContextItems(f.conversationId)).toEqual(before);
    expect(
      await restarted.runOnce({ conversationId: f.conversationId, publishPolicy: "prepare-only" }),
    ).toMatchObject({ status: "prepared", nodeId: f.leaves[1]!.nodeId });
    expect(
      await restarted.runOnce({
        conversationId: f.conversationId,
        publishPolicy: "publish-ready-only",
      }),
    ).toMatchObject({ status: "published", remainingCompactableWork: true });
    expect(await conversationStore.getMessageCount(f.conversationId)).toBe(9);
    expect(await summaryStore.getSummariesByConversation(f.conversationId)).toHaveLength(2);
  });

  it("rejects an obsolete publication selection without invalidating surviving work", async () => {
    const f = await setup();
    f.ready(0);
    await f.publish();
    f.ready(1);
    const publisher = new PendingSummaryPublisher(f.options);
    await expect(
      publisher.publishReadyFrontier({
        batchId: f.batch.batchId,
        frontierNodeIds: [f.leaves[1]!.nodeId],
        expectedSourceProjectionFingerprint: f.batch.sourceProjectionFingerprint,
      }),
    ).rejects.toThrow("stale");
    expect(await f.pendingSummaryStore.getBatch(f.batch.batchId)).toMatchObject({
      status: "planning",
    });
    expect(await f.publish()).toMatchObject({ status: "published" });
  });

  it("leaves active context unchanged without a ready prefix", async () => {
    const f = await setup();
    f.ready(1);
    const before = await f.summaryStore.getContextItems(f.conversationId);
    expect(await f.publish()).toMatchObject({
      status: "idle",
      reason: "no ready pending summary frontier",
    });
    expect(await f.summaryStore.getContextItems(f.conversationId)).toEqual(before);
    expect(f.summarize).not.toHaveBeenCalled();
  });
});
