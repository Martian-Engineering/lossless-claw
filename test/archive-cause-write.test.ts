import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLcmDatabaseConnection } from "../src/db/connection.js";
import { LcmContextEngine } from "../src/engine.js";
import { SessionRolloverDetector } from "../src/session-rollover.js";
import type { ApplySessionReplacementFn } from "../src/session-rollover.js";
import { cleanupEngineTestState, createTestConfig, createTestDeps, tempDirs } from "./helpers.js";

afterEach(cleanupEngineTestState);

function setup() {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-archive-write-"));
  tempDirs.push(tempDir);
  const dbPath = join(tempDir, "lcm.db");
  const config = createTestConfig(dbPath);
  const deps = createTestDeps(config);
  const db = createLcmDatabaseConnection(dbPath);
  const engine = new LcmContextEngine(deps, db);
  (engine as unknown as { ensureMigrated(): void }).ensureMigrated();
  return {
    tempDir,
    dbPath,
    db,
    deps,
    engine,
    conversationStore: engine.getConversationStore(),
    summaryStore: engine.getSummaryStore(),
  };
}

function readArchiveState(
  db: ReturnType<typeof createLcmDatabaseConnection>,
  conversationId: number,
): { active: number; archive_cause: string | null } {
  return db
    .prepare(`SELECT active, archive_cause FROM conversations WHERE conversation_id = ?`)
    .get(conversationId) as { active: number; archive_cause: string | null };
}

describe("archive_cause producers", () => {
  it("tags a deliberate /reset archive as manual-reset", async () => {
    const { engine, db, conversationStore } = setup();
    const sessionKey = "agent:test:main:reset";
    const conversation = await conversationStore.getOrCreateConversation("session-reset-old", {
      sessionKey,
    });
    await conversationStore.createMessage({
      conversationId: conversation.conversationId,
      seq: 0,
      role: "user",
      content: "hello",
      tokenCount: 3,
    });

    await engine.handleBeforeReset({
      reason: "reset",
      sessionId: "session-reset-old",
      sessionKey,
    });

    const row = readArchiveState(db, conversation.conversationId);
    expect(row.active).toBe(0);
    expect(row.archive_cause).toBe("manual-reset");
  });

  it("tags a host delete (session_end reason=deleted) as session-deleted", async () => {
    const { engine, db, conversationStore } = setup();
    const sessionKey = "agent:test:main:deleted";
    const conversation = await conversationStore.getOrCreateConversation("session-del-old", {
      sessionKey,
    });
    await conversationStore.createMessage({
      conversationId: conversation.conversationId,
      seq: 0,
      role: "user",
      content: "hello",
      tokenCount: 3,
    });

    await engine.handleSessionEnd({
      reason: "deleted",
      sessionId: "session-del-old",
      sessionKey,
    });

    const row = readArchiveState(db, conversation.conversationId);
    expect(row.active).toBe(0);
    expect(row.archive_cause).toBe("session-deleted");
  });

  it("tags a session_end reset (a real /reset also fires session_end) as manual-reset", async () => {
    const { engine, db, conversationStore } = setup();
    const sessionKey = "agent:test:main:session-end-reset";
    const conversation = await conversationStore.getOrCreateConversation("session-reset-end-old", {
      sessionKey,
    });
    await conversationStore.createMessage({
      conversationId: conversation.conversationId,
      seq: 0,
      role: "user",
      content: "hello",
      tokenCount: 3,
    });

    await engine.handleSessionEnd({
      reason: "reset",
      sessionId: "session-reset-end-old",
      sessionKey,
    });

    const row = readArchiveState(db, conversation.conversationId);
    expect(row.active).toBe(0);
    expect(row.archive_cause).toBe("manual-reset");
  });

  it("tags any other session_end reason as session-end", async () => {
    const { engine, db, conversationStore } = setup();
    const sessionKey = "agent:test:main:ended";
    const conversation = await conversationStore.getOrCreateConversation("session-end-old", {
      sessionKey,
    });
    await conversationStore.createMessage({
      conversationId: conversation.conversationId,
      seq: 0,
      role: "user",
      content: "hello",
      tokenCount: 3,
    });

    await engine.handleSessionEnd({
      reason: "idle",
      sessionId: "session-end-old",
      sessionKey,
      nextSessionId: "session-end-new",
      nextSessionKey: sessionKey,
    });

    const row = readArchiveState(db, conversation.conversationId);
    expect(row.active).toBe(0);
    expect(row.archive_cause).toBe("session-end");
  });

  it("tags a session-file rollover fallback as rollover-fallback", async () => {
    const { conversationStore, summaryStore, deps, tempDir } = setup();
    const calls: Parameters<ApplySessionReplacementFn>[0][] = [];
    const recordReplacement: ApplySessionReplacementFn = async (params) => {
      calls.push(params);
    };
    const detector = new SessionRolloverDetector(
      conversationStore,
      summaryStore,
      deps,
      recordReplacement,
    );

    const sessionKey = "agent:test:main:rollover";
    const conversation = await conversationStore.getOrCreateConversation("session-rollover-old", {
      sessionKey,
    });
    await summaryStore.upsertConversationBootstrapState({
      conversationId: conversation.conversationId,
      sessionFilePath: join(tempDir, "missing-transcript.jsonl"),
      lastSeenSize: 0,
      lastSeenMtimeMs: 0,
      lastProcessedOffset: 0,
    });

    const rotated = await detector.rotateStaleSessionKeyConversationIfTrackedTranscriptMissing({
      phase: "assemble",
      sessionId: "session-rollover-new",
      sessionKey,
    });

    expect(rotated).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.archiveCause).toBe("rollover-fallback");
  });

  it("tags an isolated cron runtime rollover as cron-rotation", async () => {
    const { conversationStore, summaryStore, deps } = setup();
    const calls: Parameters<ApplySessionReplacementFn>[0][] = [];
    const recordReplacement: ApplySessionReplacementFn = async (params) => {
      calls.push(params);
    };
    const detector = new SessionRolloverDetector(
      conversationStore,
      summaryStore,
      deps,
      recordReplacement,
    );

    const sessionKey = "agent:test:cron:nightly";
    await conversationStore.getOrCreateConversation("cron-old", { sessionKey });

    const rotated = await detector.rotateIsolatedCronConversationIfRuntimeChanged({
      phase: "assemble",
      sessionId: "cron-new",
      sessionKey,
      createReplacement: true,
    });

    expect(rotated).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.archiveCause).toBe("cron-rotation");
  });
});
