import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeLcmConnection, createLcmDatabaseConnection } from "../src/db/connection.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { runLcmMigrations } from "../src/db/migration.js";
import type { ArchiveCause } from "../src/store/conversation-store.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import {
  applyRolloverSplitRepair,
  scanRolloverSplits,
} from "../src/plugin/lcm-doctor-rollover-splits.js";

type Fixture = {
  tempDir: string;
  dbPath: string;
  db: ReturnType<typeof createLcmDatabaseConnection>;
  conversationStore: ConversationStore;
  summaryStore: SummaryStore;
};

const tempDirs = new Set<string>();
const dbPaths = new Set<string>();

afterEach(() => {
  for (const dbPath of dbPaths) {
    closeLcmConnection(dbPath);
  }
  dbPaths.clear();
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

function createFixture(): Fixture {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-archive-cause-"));
  const dbPath = join(tempDir, "lcm.db");
  const db = createLcmDatabaseConnection(dbPath);
  const { fts5Available } = getLcmDbFeatures(db);
  runLcmMigrations(db, { fts5Available });
  const conversationStore = new ConversationStore(db, { fts5Available });
  const summaryStore = new SummaryStore(db, { fts5Available });
  tempDirs.add(tempDir);
  dbPaths.add(dbPath);
  return { tempDir, dbPath, db, conversationStore, summaryStore };
}

async function seedConversationWithMessage(
  fixture: Fixture,
  params: { sessionId: string; sessionKey: string; label: string },
): Promise<number> {
  const conversation = await fixture.conversationStore.createConversation({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
  });
  const message = await fixture.conversationStore.createMessage({
    conversationId: conversation.conversationId,
    seq: 0,
    role: "user",
    content: `${params.label} message`,
    tokenCount: 5,
  });
  await fixture.summaryStore.appendContextMessage(conversation.conversationId, message.messageId);
  return conversation.conversationId;
}

function setConversationTimes(
  fixture: Fixture,
  conversationId: number,
  createdAt: string,
  archivedAt?: string,
): void {
  fixture.db
    .prepare(
      `UPDATE conversations
       SET created_at = ?,
           archived_at = COALESCE(?, archived_at),
           updated_at = ?
       WHERE conversation_id = ?`,
    )
    .run(createdAt, archivedAt ?? null, archivedAt ?? createdAt, conversationId);
}

function setArchiveCause(fixture: Fixture, conversationId: number, cause: string | null): void {
  fixture.db
    .prepare(`UPDATE conversations SET archive_cause = ? WHERE conversation_id = ?`)
    .run(cause, conversationId);
}

function messageCount(fixture: Fixture, conversationId: number): number {
  return (
    fixture.db
      .prepare(`SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?`)
      .get(conversationId) as { count: number }
  ).count;
}

function activeFlag(fixture: Fixture, conversationId: number): number {
  return (
    fixture.db
      .prepare(`SELECT active FROM conversations WHERE conversation_id = ?`)
      .get(conversationId) as { active: number }
  ).active;
}

async function archiveWithCause(
  fixture: Fixture,
  conversationId: number,
  cause: ArchiveCause,
  createdAt: string,
  archivedAt: string,
): Promise<void> {
  await fixture.conversationStore.archiveConversation(conversationId, cause);
  setConversationTimes(fixture, conversationId, createdAt, archivedAt);
}

describe("doctor rollover-split repair respects archive_cause", () => {
  it("never restores a deliberate /reset (manual-reset) archive", async () => {
    const fixture = createFixture();
    const sessionKey = "agent:test:main:reset-skip";

    const resetId = await seedConversationWithMessage(fixture, {
      sessionId: "session-reset-old",
      sessionKey,
      label: "reset_old",
    });
    await archiveWithCause(fixture, resetId, "manual-reset", "2026-06-17 01:00:00", "2026-06-17 01:05:00");

    const activeId = await seedConversationWithMessage(fixture, {
      sessionId: "session-reset-new",
      sessionKey,
      label: "active",
    });
    setConversationTimes(fixture, activeId, "2026-06-17 01:10:00");

    const scan = scanRolloverSplits(fixture.db);
    expect(scan.safe.map((group) => group.sessionKey)).not.toContain(sessionKey);
    expect(scan.needsReview.map((group) => group.sessionKey)).not.toContain(sessionKey);

    const result = await applyRolloverSplitRepair({ db: fixture.db, databasePath: fixture.dbPath });
    expect(result.kind).toBe("applied");

    // The deliberately wiped conversation keeps its own messages; the active
    // successor never inherits them.
    expect(messageCount(fixture, resetId)).toBe(1);
    expect(activeFlag(fixture, resetId)).toBe(0);
    expect(messageCount(fixture, activeId)).toBe(1);
  });

  it("still repairs a genuine rollover-fallback archive", async () => {
    const fixture = createFixture();
    const sessionKey = "agent:test:main:rollover-merge";

    const strandedId = await seedConversationWithMessage(fixture, {
      sessionId: "session-rollover-old",
      sessionKey,
      label: "stranded",
    });
    await archiveWithCause(
      fixture,
      strandedId,
      "rollover-fallback",
      "2026-06-17 02:00:00",
      "2026-06-17 02:05:00",
    );

    const activeId = await seedConversationWithMessage(fixture, {
      sessionId: "session-rollover-new",
      sessionKey,
      label: "active",
    });
    setConversationTimes(fixture, activeId, "2026-06-17 02:10:00");

    const scan = scanRolloverSplits(fixture.db);
    const safe = scan.safe.find((group) => group.sessionKey === sessionKey);
    expect(safe).toBeDefined();
    expect(safe?.sourceConversationIds).toEqual([strandedId]);
    expect(safe?.targetConversationId).toBe(activeId);

    const result = await applyRolloverSplitRepair({ db: fixture.db, databasePath: fixture.dbPath });
    expect(result.kind).toBe("applied");

    expect(messageCount(fixture, strandedId)).toBe(0);
    expect(messageCount(fixture, activeId)).toBe(2);
  });

  it("treats a legacy NULL archive_cause as merge-eligible", async () => {
    const fixture = createFixture();
    const sessionKey = "agent:test:main:legacy-null";

    const strandedId = await seedConversationWithMessage(fixture, {
      sessionId: "session-legacy-old",
      sessionKey,
      label: "legacy",
    });
    await archiveWithCause(
      fixture,
      strandedId,
      "rollover-fallback",
      "2026-06-17 03:00:00",
      "2026-06-17 03:05:00",
    );
    // Simulate a row archived before the column existed: provenance unknown.
    setArchiveCause(fixture, strandedId, null);

    const activeId = await seedConversationWithMessage(fixture, {
      sessionId: "session-legacy-new",
      sessionKey,
      label: "active",
    });
    setConversationTimes(fixture, activeId, "2026-06-17 03:10:00");

    const scan = scanRolloverSplits(fixture.db);
    const safe = scan.safe.find((group) => group.sessionKey === sessionKey);
    expect(safe).toBeDefined();
    expect(safe?.sourceConversationIds).toEqual([strandedId]);

    const result = await applyRolloverSplitRepair({ db: fixture.db, databasePath: fixture.dbPath });
    expect(result.kind).toBe("applied");

    expect(messageCount(fixture, strandedId)).toBe(0);
    expect(messageCount(fixture, activeId)).toBe(2);
  });

  it("merges only the rollover row in a mixed group, leaving the reset row intact", async () => {
    const fixture = createFixture();
    const sessionKey = "agent:test:main:mixed-group";

    const resetId = await seedConversationWithMessage(fixture, {
      sessionId: "session-mixed-reset",
      sessionKey,
      label: "reset",
    });
    await archiveWithCause(fixture, resetId, "manual-reset", "2026-06-17 04:00:00", "2026-06-17 04:05:00");

    const rolloverId = await seedConversationWithMessage(fixture, {
      sessionId: "session-mixed-rollover",
      sessionKey,
      label: "rollover",
    });
    await archiveWithCause(
      fixture,
      rolloverId,
      "rollover-fallback",
      "2026-06-17 04:06:00",
      "2026-06-17 04:10:00",
    );

    const activeId = await seedConversationWithMessage(fixture, {
      sessionId: "session-mixed-new",
      sessionKey,
      label: "active",
    });
    setConversationTimes(fixture, activeId, "2026-06-17 04:11:00");

    const scan = scanRolloverSplits(fixture.db);
    const safe = scan.safe.find((group) => group.sessionKey === sessionKey);
    expect(safe).toBeDefined();
    expect(safe?.sourceConversationIds).toEqual([rolloverId]);
    expect(safe?.targetConversationId).toBe(activeId);

    const result = await applyRolloverSplitRepair({ db: fixture.db, databasePath: fixture.dbPath });
    expect(result.kind).toBe("applied");

    // Reset row untouched; only the rollover row is merged into the active row.
    expect(messageCount(fixture, resetId)).toBe(1);
    expect(activeFlag(fixture, resetId)).toBe(0);
    expect(messageCount(fixture, rolloverId)).toBe(0);
    expect(messageCount(fixture, activeId)).toBe(2);
  });
});
