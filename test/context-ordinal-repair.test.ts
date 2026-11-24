import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { PendingCompactionCoordinator } from "../src/pending-summary-coordinator.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { PendingSummaryStore } from "../src/store/pending-summary-store.js";
import { SummaryStore } from "../src/store/summary-store.js";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

async function createFixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys = ON");
  runLcmMigrations(db, { fts5Available: false });
  const conversations = new ConversationStore(db, { fts5Available: false });
  const summaries = new SummaryStore(db, { fts5Available: false });
  const pending = new PendingSummaryStore(db);
  const { conversationId } = await conversations.createConversation({
    sessionId: "ordinal-repair",
  });
  for (const [i, depth] of [0, 0, 2, 2, 0, 2, 2].entries()) {
    const summaryId = `summary-${i}`;
    await summaries.insertSummary({
      summaryId,
      conversationId,
      kind: depth === 0 ? "leaf" : "condensed",
      depth,
      content: `summary ${i}`,
      tokenCount: 100,
    });
    const message = await conversations.createMessage({
      conversationId,
      seq: i + 1,
      role: "user",
      content: `historical message ${i}`,
      tokenCount: 100,
    });
    await conversations.createMessageParts(message.messageId, [
      { sessionId: "ordinal-repair", partType: "text", ordinal: 0, textContent: message.content },
    ]);
    await summaries.linkSummaryToMessages(summaryId, [message.messageId]);
    if (depth > 0) await summaries.linkSummaryToParents(summaryId, ["summary-0", "summary-1"]);
    await summaries.appendContextSummary(conversationId, summaryId);
  }
  return { db, conversationId, conversations, summaries, pending };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function appendMessages(f: Fixture) {
  for (let i = 0; i < 70; i++) {
    const message = await f.conversations.createMessage({
      conversationId: f.conversationId,
      seq: i + 8,
      role: i % 2 ? "assistant" : "user",
      content: `new message ${i}`,
      tokenCount: 4000,
    });
    await f.summaries.appendContextMessage(f.conversationId, message.messageId);
  }
}

function coordinator(f: Fixture) {
  return new PendingCompactionCoordinator({
    conversationStore: f.conversations,
    summaryStore: f.summaries,
    pendingSummaryStore: f.pending,
    model: "synthetic",
    leaseOwner: "ordinal-repair-test",
    config: {
      freshTailCount: 64,
      freshTailMaxTokens: 24000,
      leafChunkTokens: 20000,
      condensedMinFanout: 4,
      condensedMinSourceTokens: 20000,
      condensedChunkTokens: 20000,
    },
    summarize: async () => "A short synthetic summary.",
  });
}

function history(db: DatabaseSync) {
  return Object.fromEntries(
    ["messages", "message_parts", "summaries", "summary_messages", "summary_parents"].map(
      (table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()],
    ),
  );
}

async function expectPublication(f: Fixture) {
  const before = history(f.db);
  const runner = coordinator(f);
  for (let i = 0; i < 30; i++) {
    const result = await runner.runOnce({ conversationId: f.conversationId });
    if (result.status === "published") {
      const after = history(f.db);
      for (const [table, rows] of Object.entries(before)) {
        expect(after[table]).toEqual(expect.arrayContaining(rows));
      }
      expect((await f.summaries.getContextItems(f.conversationId)).length).toBeLessThan(74);
      return;
    }
    expect(["planned", "prepared"], JSON.stringify(result)).toContain(result.status);
  }
  throw new Error("Compaction did not publish");
}

function seedLegacyPrune(f: Fixture) {
  // Reproduce the pre-fix prune result without invoking the corrected method.
  f.db
    .prepare("DELETE FROM context_items WHERE conversation_id = ? AND ordinal IN (0, 1, 4)")
    .run(f.conversationId);
  f.db
    .prepare("DELETE FROM lcm_migration_state WHERE step_name = 'repairContextItemOrdinals'")
    .run();
}

async function createPendingBatch(
  f: Fixture,
  batchId: string,
  status: "planning" | "ready" | "publishing" | "published",
) {
  await f.pending.createBatch({
    batchId,
    conversationId: f.conversationId,
    status,
    sourceProjectionFingerprint: "old positions",
    compactableStartOrdinal: 2,
    compactableEndOrdinal: 6,
    promptVersion: "test",
    model: "synthetic",
  });
  await f.pending.insertNode({
    nodeId: `${batchId}-node`,
    batchId,
    conversationId: f.conversationId,
    kind: "condensed",
    depth: 3,
    status: status === "planning" ? "planned" : "ready",
    ordinalStart: 2,
    ordinalEnd: 6,
    sourceFingerprint: "old positions",
    promptVersion: "test",
    model: "synthetic",
    content: "prepared summary",
    tokenCount: 4,
  });
}

function mutableState(db: DatabaseSync) {
  return Object.fromEntries(
    [
      "context_items",
      "pending_compaction_batches",
      "pending_summary_nodes",
      "lcm_migration_state",
    ].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
  );
}

describe("context ordinal repair", () => {
  it("can publish after session pruning leaves retained summaries", async () => {
    const f = await createFixture();
    const before = history(f.db);
    await f.summaries.pruneForNewSession(f.conversationId, 2);
    expect(history(f.db)).toEqual(before);
    await appendMessages(f);
    await expectPublication(f);
  });

  it("repairs existing sparse contexts before pending compaction", async () => {
    const f = await createFixture();
    seedLegacyPrune(f);
    await appendMessages(f);
    await expect(coordinator(f).runOnce({ conversationId: f.conversationId })).resolves.toEqual({
      status: "idle",
      reason: "no publishable pending summary coverage planned",
    });
    const before = history(f.db);
    runLcmMigrations(f.db, { fts5Available: false });
    expect(history(f.db)).toEqual(before);
    const items = await f.summaries.getContextItems(f.conversationId);
    expect(items.map((item) => item.ordinal)).toEqual(items.map((_, index) => index));
    await expectPublication(f);
  });

  it("invalidates only active plans for repaired contexts, retaining their payloads", async () => {
    const f = await createFixture();
    seedLegacyPrune(f);
    for (const status of ["planning", "ready", "publishing", "published"] as const) {
      await createPendingBatch(f, status, status);
    }
    const dense = await f.conversations.createConversation({ sessionId: "dense" });
    const message = await f.conversations.createMessage({
      conversationId: dense.conversationId,
      seq: 1,
      role: "user",
      content: "unchanged",
      tokenCount: 1,
    });
    await f.summaries.appendContextMessage(dense.conversationId, message.messageId);
    await createPendingBatch({ ...f, conversationId: dense.conversationId }, "dense", "planning");
    const before = mutableState(f.db);
    const originalHistory = history(f.db);
    const originalContext = await f.summaries.getContextItems(f.conversationId);

    runLcmMigrations(f.db, { fts5Available: false });

    expect(history(f.db)).toEqual(originalHistory);
    expect(await f.summaries.getContextItems(f.conversationId)).toEqual(
      originalContext.map((item, ordinal) => ({ ...item, ordinal })),
    );
    expect(mutableState(f.db).pending_summary_nodes).toEqual(before.pending_summary_nodes);
    for (const batchId of ["planning", "ready", "publishing"]) {
      expect(await f.pending.getBatch(batchId)).toMatchObject({ status: "stale" });
    }
    for (const batchId of ["dense", "published"]) {
      const original = before.pending_compaction_batches.find(
        (batch) => batch.batch_id === batchId,
      );
      expect(mutableState(f.db).pending_compaction_batches).toContainEqual(original);
    }
    expect(
      await f.pending.claimNextPlannedNode({
        conversationId: f.conversationId,
        leaseOwner: "test",
        leaseExpiresAt: new Date(Date.now() + 60000),
      }),
    ).toBeNull();
    const repaired = mutableState(f.db);
    runLcmMigrations(f.db, { fts5Available: false });
    expect(mutableState(f.db)).toEqual(repaired);
    await appendMessages(f);
    await expectPublication(f);
  });

  it.each(["migration", "pruning"] as const)(
    "rolls back %s if invalidating old plans fails",
    async (operation) => {
      const f = await createFixture();
      if (operation === "migration") seedLegacyPrune(f);
      await createPendingBatch(f, "old-plan", "ready");
      const before = mutableState(f.db);
      const originalHistory = history(f.db);
      f.db
        .exec(`CREATE TRIGGER fail_invalidation BEFORE UPDATE OF status ON pending_compaction_batches
      BEGIN SELECT RAISE(ABORT, 'invalidation fault'); END`);

      if (operation === "migration") {
        expect(() => runLcmMigrations(f.db, { fts5Available: false })).toThrow(
          "invalidation fault",
        );
      } else {
        await expect(f.summaries.pruneForNewSession(f.conversationId, 2)).rejects.toThrow(
          "invalidation fault",
        );
      }
      expect(mutableState(f.db)).toEqual(before);
      expect(history(f.db)).toEqual(originalHistory);
      f.db.exec("DROP TRIGGER fail_invalidation");
      if (operation === "migration") runLcmMigrations(f.db, { fts5Available: false });
      else
        await f.summaries.withTransaction(() =>
          f.summaries.pruneForNewSession(f.conversationId, 2),
        );
      expect(await f.pending.getBatch("old-plan")).toMatchObject({ status: "stale" });
      await appendMessages(f);
      await expectPublication(f);
    },
  );

  it("leaves context and pending plans unchanged when pruning is disabled", async () => {
    const f = await createFixture();
    await createPendingBatch(f, "old-plan", "ready");
    const before = mutableState(f.db);
    await f.summaries.pruneForNewSession(f.conversationId, -1);
    expect(mutableState(f.db)).toEqual(before);
  });

  it("invalidates old plans when pruning removes the entire context", async () => {
    const f = await createFixture();
    await appendMessages(f);
    await createPendingBatch(f, "old-plan", "ready");
    const before = history(f.db);
    await f.summaries.pruneForNewSession(f.conversationId, Number.POSITIVE_INFINITY);
    expect(await f.summaries.getContextItems(f.conversationId)).toEqual([]);
    expect(await f.pending.getBatch("old-plan")).toMatchObject({ status: "stale" });
    expect(history(f.db)).toEqual(before);
  });
});
