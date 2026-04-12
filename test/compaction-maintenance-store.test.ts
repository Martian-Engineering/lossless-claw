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
});
