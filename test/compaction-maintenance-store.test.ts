import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLcmDatabaseConnection, closeLcmConnection } from "../src/db/connection.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { CompactionMaintenanceStore } from "../src/store/compaction-maintenance-store.js";

const tempDirs: string[] = [];
const dbs: ReturnType<typeof createLcmDatabaseConnection>[] = [];

function createTestDb() {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-maintenance-store-"));
  tempDirs.push(tempDir);
  const dbPath = join(tempDir, "lcm.db");
  const db = createLcmDatabaseConnection(dbPath);
  dbs.push(db);
  const { fts5Available } = getLcmDbFeatures(db);
  runLcmMigrations(db, { fts5Available });
  return db;
}

afterEach(() => {
  for (const db of dbs.splice(0)) {
    closeLcmConnection(db);
  }
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("CompactionMaintenanceStore", () => {
  it("allows pending and running flags to transition back to false", async () => {
    const db = createTestDb();
    const { fts5Available } = getLcmDbFeatures(db);
    const conversationStore = new ConversationStore(db, { fts5Available });
    const conversation = await conversationStore.createConversation({
      sessionId: "maintenance-store-session",
      sessionKey: "agent:main:maintenance-store:1",
    });
    const store = new CompactionMaintenanceStore(db);

    await store.requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
    });

    await store.markProactiveCompactionRunning({
      conversationId: conversation.conversationId,
    });

    await store.markProactiveCompactionFinished({
      conversationId: conversation.conversationId,
      failureSummary: null,
      keepPending: false,
    });

    const record = await store.getConversationCompactionMaintenance(conversation.conversationId);
    expect(record).not.toBeNull();
    expect(record?.pending).toBe(false);
    expect(record?.running).toBe(false);
  });

  it("persists projected token diagnostics for deferred threshold debt", async () => {
    const db = createTestDb();
    const { fts5Available } = getLcmDbFeatures(db);
    const conversationStore = new ConversationStore(db, { fts5Available });
    const conversation = await conversationStore.createConversation({
      sessionId: "maintenance-store-projected-session",
      sessionKey: "agent:main:maintenance-store:2",
    });
    const store = new CompactionMaintenanceStore(db);

    await store.requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 600,
      currentTokenCount: 300,
      projectedTokenCount: 620,
      rawTokensOutsideTail: 320,
      contextThreshold: 0.15,
      contextThresholdSource: "override",
    });

    const record = await store.getConversationCompactionMaintenance(conversation.conversationId);
    expect(record).toMatchObject({
      pending: true,
      reason: "threshold",
      tokenBudget: 600,
      currentTokenCount: 300,
      projectedTokenCount: 620,
      rawTokensOutsideTail: 320,
      contextThreshold: 0.15,
      contextThresholdSource: "override",
    });

    await store.requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "leaf-trigger",
      tokenBudget: 700,
      currentTokenCount: 400,
    });

    const refreshed = await store.getConversationCompactionMaintenance(conversation.conversationId);
    expect(refreshed).toMatchObject({
      pending: true,
      reason: "leaf-trigger",
      tokenBudget: 700,
      currentTokenCount: 400,
      contextThreshold: null,
      contextThresholdSource: null,
    });
  });

  it("records retry backoff after failures and clears it after success", async () => {
    const db = createTestDb();
    const { fts5Available } = getLcmDbFeatures(db);
    const conversationStore = new ConversationStore(db, { fts5Available });
    const conversation = await conversationStore.createConversation({
      sessionId: "maintenance-store-retry-session",
      sessionKey: "agent:main:maintenance-store:3",
    });
    const store = new CompactionMaintenanceStore(db);
    const firstFinishedAt = new Date("2026-05-31T12:00:00.000Z");
    const secondFinishedAt = new Date("2026-05-31T12:05:00.000Z");

    await store.requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
    });
    await store.markProactiveCompactionRunning({
      conversationId: conversation.conversationId,
    });
    await store.markProactiveCompactionFinished({
      conversationId: conversation.conversationId,
      failureSummary: "provider timeout",
      finishedAt: firstFinishedAt,
    });

    const failed = await store.getConversationCompactionMaintenance(conversation.conversationId);
    expect(failed?.pending).toBe(true);
    expect(failed?.running).toBe(false);
    expect(failed?.retryAttempts).toBe(1);
    expect(failed?.nextAttemptAfter?.toISOString()).toBe("2026-05-31T12:05:00.000Z");

    await store.markProactiveCompactionRunning({
      conversationId: conversation.conversationId,
    });
    await store.markProactiveCompactionFinished({
      conversationId: conversation.conversationId,
      failureSummary: "provider timeout",
      finishedAt: secondFinishedAt,
    });

    const failedAgain = await store.getConversationCompactionMaintenance(conversation.conversationId);
    expect(failedAgain?.retryAttempts).toBe(2);
    expect(failedAgain?.nextAttemptAfter?.toISOString()).toBe("2026-05-31T12:15:00.000Z");

    for (let attempt = 3; attempt <= 8; attempt += 1) {
      await store.markProactiveCompactionRunning({
        conversationId: conversation.conversationId,
      });
      await store.markProactiveCompactionFinished({
        conversationId: conversation.conversationId,
        failureSummary: "provider timeout",
        finishedAt: new Date(`2026-05-31T12:${String(10 + attempt).padStart(2, "0")}:00.000Z`),
      });
    }

    const capped = await store.getConversationCompactionMaintenance(conversation.conversationId);
    expect(capped?.retryAttempts).toBe(8);
    expect(capped?.nextAttemptAfter?.getTime()).toBe(
      new Date("2026-05-31T12:18:00.000Z").getTime() + 30 * 60 * 1000,
    );

    await store.markProactiveCompactionRunning({
      conversationId: conversation.conversationId,
    });
    await store.markProactiveCompactionFinished({
      conversationId: conversation.conversationId,
      failureSummary: null,
      keepPending: false,
    });

    const recovered = await store.getConversationCompactionMaintenance(conversation.conversationId);
    expect(recovered?.pending).toBe(false);
    expect(recovered?.running).toBe(false);
    expect(recovered?.retryAttempts).toBe(0);
    expect(recovered?.nextAttemptAfter).toBeNull();
  });

  it("does not add deferred retry backoff for provider auth failures", async () => {
    const db = createTestDb();
    const { fts5Available } = getLcmDbFeatures(db);
    const conversationStore = new ConversationStore(db, { fts5Available });
    const conversation = await conversationStore.createConversation({
      sessionId: "maintenance-store-auth-session",
      sessionKey: "agent:main:maintenance-store:4",
    });
    const store = new CompactionMaintenanceStore(db);

    await store.requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
    });
    await store.markProactiveCompactionRunning({
      conversationId: conversation.conversationId,
    });
    await store.markProactiveCompactionFinished({
      conversationId: conversation.conversationId,
      failureSummary: "provider auth failure",
    });

    const record = await store.getConversationCompactionMaintenance(conversation.conversationId);
    expect(record?.pending).toBe(true);
    expect(record?.running).toBe(false);
    expect(record?.retryAttempts).toBe(0);
    expect(record?.nextAttemptAfter).toBeNull();
  });
});
