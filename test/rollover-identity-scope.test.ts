/**
 * Regression tests for the ambiguous-rollover identity-scope wedge: rapid
 * same-day /new resets whose first turn happens to repeat trivial content
 * (e.g. a literal "ping" health check) collide with `messageIdentity`'s
 * pure role+content signature, which carries no session/generation scope.
 * `evaluateAmbiguousRolloverFreshness` treated that single-occurrence
 * trivial content as lineage-discriminating, so the freshness gate reported
 * `identity-overlap-with-persisted-history` even though the rollover was a
 * deliberate, host-confirmed /new. The lane froze (preserve, not rotate)
 * and re-warned on every subsequent turn because nothing memoized the
 * resolution.
 *
 * Two behavior contracts under test:
 *
 * 1. Deliberate-rollover awareness: identity overlap must not block a
 *    provably deliberate /new (Lossless's own softResetPrunedAt marker AND
 *    a `.reset.` archive sibling both present) when the overlapping content
 *    is itself trivial/low-entropy. This is deliberately narrower than
 *    "any identity overlap during a deliberate rollover" — see
 *    `test/soft-reset-new-sibling-rebind.test.ts`'s "does NOT merge a
 *    foreign reused-key transcript even with a sibling" case, which proves
 *    that deliberate-/new evidence alone must NOT excuse overlap on
 *    substantial, specific content (that is the actual foreign-reused-key
 *    defense). Gating the bypass on trivial content keeps that defense
 *    intact while closing the false-positive hole trivial health-check
 *    traffic opens.
 * 2. Once-only resolution: a genuinely ambiguous (non-bypassable) freeze
 *    must warn exactly once per session generation (sessionKey + old
 *    sessionId + new sessionId), not on every subsequent bootstrap/afterTurn
 *    call against the same frozen lane.
 */
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { LcmConfig } from "../src/db/config.js";
import { closeLcmConnection, createLcmDatabaseConnection } from "../src/db/connection.js";
import { LcmContextEngine } from "../src/engine.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import type { LcmDependencies } from "../src/types.js";
import {
  createTestConfig as createSharedTestConfig,
  createTestDeps as createSharedTestDeps,
} from "./helpers.js";

const tempDirs: string[] = [];
const dbs: ReturnType<typeof createLcmDatabaseConnection>[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of dbs.splice(0)) {
    try {
      closeLcmConnection(db);
    } catch {
      // best-effort cleanup
    }
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

type LogMock = {
  info: Mock<(msg: string) => void>;
  warn: Mock<(msg: string) => void>;
  error: Mock<(msg: string) => void>;
  debug: Mock<(msg: string) => void>;
};

function createTestDeps(config: LcmConfig, log: LogMock): LcmDependencies {
  return createSharedTestDeps(config, { resolveAgentDir: () => tmpdir(), log });
}

function createEngine(configOverrides: Partial<LcmConfig> = {}): {
  engine: LcmContextEngine;
  log: LogMock;
  db: ReturnType<typeof createLcmDatabaseConnection>;
} {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-idscope-"));
  tempDirs.push(tempDir);
  const config = {
    ...createSharedTestConfig(join(tempDir, "lcm.db")),
    ...configOverrides,
  };
  const db = createLcmDatabaseConnection(config.databasePath);
  dbs.push(db);
  const log: LogMock = {
    info: vi.fn<(msg: string) => void>(),
    warn: vi.fn<(msg: string) => void>(),
    error: vi.fn<(msg: string) => void>(),
    debug: vi.fn<(msg: string) => void>(),
  };
  const engine = new LcmContextEngine(createTestDeps(config, log), db);
  (engine as unknown as { ensureMigrated(): void }).ensureMigrated();
  return { engine, log, db };
}

function makeMessage(role: string, content: string, timestamp: number): AgentMessage {
  return { role, content, timestamp } as unknown as AgentMessage;
}

async function seedHistoricalMessage(
  engine: LcmContextEngine,
  params: { sessionId: string; sessionKey?: string; message: AgentMessage },
): Promise<void> {
  await (
    engine as unknown as {
      ingestSingle: (p: {
        sessionId: string;
        sessionKey?: string;
        message: AgentMessage;
        skipReplayTimestampFloodGuard?: boolean;
      }) => Promise<unknown>;
    }
  ).ingestSingle({ ...params, skipReplayTimestampFloodGuard: true });
}

function writeRolledTranscript(params: {
  name: string;
  entries: Array<{ role: string; text: string; timestamp: number }>;
}): string {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-idscope-roll-"));
  tempDirs.push(tempDir);
  const file = join(tempDir, `${params.name}.jsonl`);
  let parentId: string | null = null;
  const lines = params.entries.map((entry, index) => {
    const id = `${params.name}-entry-${index}`;
    const line = JSON.stringify({
      type: "message",
      id,
      parentId,
      timestamp: new Date(entry.timestamp).toISOString(),
      message: {
        role: entry.role,
        content: [{ type: "text", text: entry.text }],
        timestamp: entry.timestamp,
      },
    });
    parentId = id;
    return line;
  });
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

function archiveTrackedFile(trackedFile: string, kind: "reset" | "deleted"): void {
  renameSync(trackedFile, `${trackedFile}.${kind}.2026-07-11T120000-000Z`);
}

const SESSION_KEY = "agent:two:main";
const OLD_SESSION_ID = "cccccccc-0000-0000-0000-000000000003";
const NEW_SESSION_ID = "dddddddd-0000-0000-0000-000000000004";

/**
 * Seed an active conversation under SESSION_KEY pinned to OLD_SESSION_ID with
 * a week-old, lineage-discriminating history whose final message is a
 * trivial "ping" (or the given `tailContent`) — the exact shape rapid
 * same-day /new health-check traffic produces. The tracked transcript file
 * lives in its own directory so a test can rename it to an archive sibling.
 */
async function seedPingTailLane(
  engine: LcmContextEngine,
  db: ReturnType<typeof createLcmDatabaseConnection>,
  tailContent = "ping",
): Promise<{ conversationId: number; trackedFile: string }> {
  const base = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (let index = 0; index < 9; index += 1) {
    await seedHistoricalMessage(engine, {
      sessionId: OLD_SESSION_ID,
      sessionKey: SESSION_KEY,
      message: makeMessage(
        index % 2 === 0 ? "user" : "assistant",
        `lane turn ${index} about the release checklist`,
        base + index,
      ),
    });
  }
  await seedHistoricalMessage(engine, {
    sessionId: OLD_SESSION_ID,
    sessionKey: SESSION_KEY,
    message: makeMessage("user", tailContent, base + 9),
  });
  const conversation = await engine.getConversationStore().getConversationBySessionKey(SESSION_KEY);
  expect(conversation).not.toBeNull();
  const conversationId = conversation!.conversationId;
  db.prepare(
    "UPDATE messages SET created_at = datetime('now', '-7 days') WHERE conversation_id = ?",
  ).run(conversationId);

  const fileDir = mkdtempSync(join(tmpdir(), "lossless-claw-idscope-track-"));
  tempDirs.push(fileDir);
  const trackedFile = join(fileDir, "old-session.jsonl");
  writeFileSync(trackedFile, "{}\n");
  await engine.getSummaryStore().upsertConversationBootstrapState({
    conversationId,
    sessionFilePath: trackedFile,
    lastSeenSize: 3,
    lastSeenMtimeMs: base,
    lastProcessedOffset: 3,
    lastProcessedEntryHash: "0".repeat(64),
  });

  return { conversationId, trackedFile };
}

describe("ambiguous-rollover identity scope (deliberate-rollover awareness)", () => {
  it("rotates cleanly with no warn when a trivial 'ping' repeat coincides with a deliberate /new", async () => {
    const { engine, log, db } = createEngine({ newSessionRetainDepth: 2 });
    const lane = await seedPingTailLane(engine, db);
    await engine.handleBeforeReset({
      reason: "new",
      sessionId: OLD_SESSION_ID,
      sessionKey: SESSION_KEY,
    });
    archiveTrackedFile(lane.trackedFile, "reset");

    // The new session's own opening turn repeats the trivial "ping" content
    // that also appears once in the frozen lane's recent window.
    const newSessionFile = writeRolledTranscript({
      name: NEW_SESSION_ID,
      entries: [{ role: "user", text: "ping", timestamp: Date.now() + 60_000 }],
    });

    const result = await engine.bootstrap({
      sessionId: NEW_SESSION_ID,
      sessionKey: SESSION_KEY,
      sessionFile: newSessionFile,
    });

    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("resolved by fresh-transcript rebind"),
    );
    expect(result.bootstrapped).toBe(true);

    const rebound = await engine.getConversationStore().getConversationBySessionKey(SESSION_KEY);
    expect(rebound?.sessionId).toBe(NEW_SESSION_ID);
  });

  it("still preserves and warns on a trivial 'ping' repeat with NO deliberate-rollover evidence (fail-closed)", async () => {
    const { engine, log, db } = createEngine({ newSessionRetainDepth: 2 });
    const lane = await seedPingTailLane(engine, db);

    // No handleBeforeReset, no archive sibling: this is the "genuinely
    // ambiguous, no evidence of deliberate /new" case. The tracked file is
    // simply left in place (no rename), matching an ordinary ambiguous
    // session-key collision rather than a soft-reset.
    const newSessionFile = writeRolledTranscript({
      name: `${NEW_SESSION_ID}-no-evidence`,
      entries: [{ role: "user", text: "ping", timestamp: Date.now() + 60_000 }],
    });

    const result = await engine.bootstrap({
      sessionId: NEW_SESSION_ID,
      sessionKey: SESSION_KEY,
      sessionFile: newSessionFile,
    });

    expect(result.bootstrapped).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("freshness=identity-overlap-with-persisted-history"),
    );
    const conversation = await engine.getConversationStore().getConversationBySessionKey(SESSION_KEY);
    expect(conversation?.conversationId).toBe(lane.conversationId);
    expect(conversation?.sessionId).toBe(OLD_SESSION_ID);
  });

  // Pins TRIVIAL_ROLLOVER_OVERLAP_CONTENT_MAX_LENGTH (session-rollover.ts) at
  // exactly 8: a future bump of that constant must fail one of these two
  // tests, making the change a deliberate review point instead of incidental.
  it("bypasses at the trivial-content boundary: an 8-char overlap rebinds with a deliberate /new", async () => {
    const tailContent = "12345678";
    expect(tailContent).toHaveLength(8);
    const { engine, log, db } = createEngine({ newSessionRetainDepth: 2 });
    const lane = await seedPingTailLane(engine, db, tailContent);
    await engine.handleBeforeReset({
      reason: "new",
      sessionId: OLD_SESSION_ID,
      sessionKey: SESSION_KEY,
    });
    archiveTrackedFile(lane.trackedFile, "reset");

    const newSessionFile = writeRolledTranscript({
      name: NEW_SESSION_ID,
      entries: [{ role: "user", text: tailContent, timestamp: Date.now() + 60_000 }],
    });

    const result = await engine.bootstrap({
      sessionId: NEW_SESSION_ID,
      sessionKey: SESSION_KEY,
      sessionFile: newSessionFile,
    });

    expect(log.warn).not.toHaveBeenCalled();
    expect(result.bootstrapped).toBe(true);
    const rebound = await engine.getConversationStore().getConversationBySessionKey(SESSION_KEY);
    expect(rebound?.sessionId).toBe(NEW_SESSION_ID);
  });

  it("fails closed one character over the trivial-content boundary: a 9-char overlap still preserves and warns", async () => {
    const tailContent = "123456789";
    expect(tailContent).toHaveLength(9);
    const { engine, log, db } = createEngine({ newSessionRetainDepth: 2 });
    const lane = await seedPingTailLane(engine, db, tailContent);
    await engine.handleBeforeReset({
      reason: "new",
      sessionId: OLD_SESSION_ID,
      sessionKey: SESSION_KEY,
    });
    archiveTrackedFile(lane.trackedFile, "reset");

    const newSessionFile = writeRolledTranscript({
      name: NEW_SESSION_ID,
      entries: [{ role: "user", text: tailContent, timestamp: Date.now() + 60_000 }],
    });

    const result = await engine.bootstrap({
      sessionId: NEW_SESSION_ID,
      sessionKey: SESSION_KEY,
      sessionFile: newSessionFile,
    });

    expect(result.bootstrapped).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("freshness=identity-overlap-with-persisted-history"),
    );
    const conversation = await engine.getConversationStore().getConversationBySessionKey(SESSION_KEY);
    expect(conversation?.sessionId).toBe(OLD_SESSION_ID);
  });
});

describe("ambiguous-rollover once-only WARN resolution", () => {
  it("warns exactly once across repeated bootstrap calls against the same frozen generation", async () => {
    const { engine, log, db } = createEngine();
    const base = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const persistedContents = Array.from(
      { length: 60 },
      (_, index) => `frozen lane turn ${index} about the deployment plan`,
    );
    for (const [index, content] of persistedContents.entries()) {
      await seedHistoricalMessage(engine, {
        sessionId: OLD_SESSION_ID,
        sessionKey: SESSION_KEY,
        message: makeMessage(index % 2 === 0 ? "user" : "assistant", content, base + index),
      });
    }
    const conversation = await engine.getConversationStore().getConversationBySessionKey(SESSION_KEY);
    expect(conversation).not.toBeNull();
    db.prepare(
      "UPDATE messages SET created_at = datetime('now', '-7 days') WHERE conversation_id = ?",
    ).run(conversation!.conversationId);
    const fileDir = mkdtempSync(join(tmpdir(), "lossless-claw-idscope-once-"));
    tempDirs.push(fileDir);
    const trackedFile = join(fileDir, "old-session.jsonl");
    writeFileSync(trackedFile, "{}\n");
    await engine.getSummaryStore().upsertConversationBootstrapState({
      conversationId: conversation!.conversationId,
      sessionFilePath: trackedFile,
      lastSeenSize: 3,
      lastSeenMtimeMs: base,
      lastProcessedOffset: 3,
      lastProcessedEntryHash: "0".repeat(64),
    });

    // Genuinely ambiguous: the new transcript repeats specific, non-trivial
    // persisted content, and there is no deliberate-/new evidence — this
    // must stay frozen (preserve) on every call, but WARN only the first time.
    const newSessionFile = writeRolledTranscript({
      name: NEW_SESSION_ID,
      entries: [
        { role: "user", text: "fresh post-roll question", timestamp: Date.now() + 60_000 },
        { role: "user", text: persistedContents[56]!, timestamp: Date.now() + 60_001 },
      ],
    });

    for (let turn = 0; turn < 3; turn += 1) {
      const result = await engine.bootstrap({
        sessionId: NEW_SESSION_ID,
        sessionKey: SESSION_KEY,
        sessionFile: newSessionFile,
      });
      expect(result.bootstrapped).toBe(false);
    }

    const notProvablyFreshWarns = log.warn.mock.calls.filter(([message]) =>
      String(message).includes("ambiguous rollover not provably fresh"),
    );
    const preservingWarns = log.warn.mock.calls.filter(([message]) =>
      String(message).includes("ambiguous session-key runtime rollover; preserving"),
    );
    expect(notProvablyFreshWarns).toHaveLength(1);
    expect(preservingWarns).toHaveLength(1);

    // The lane is still frozen (never healed) after all three turns.
    const stillFrozen = await engine.getConversationStore().getConversationBySessionKey(SESSION_KEY);
    expect(stillFrozen?.sessionId).toBe(OLD_SESSION_ID);
  });

  it("shares the once-only memo across bootstrap and afterTurn for the same generation", async () => {
    const { engine, log, db } = createEngine();
    const base = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const persistedContents = Array.from(
      { length: 60 },
      (_, index) => `frozen lane turn ${index} about the migration runbook`,
    );
    for (const [index, content] of persistedContents.entries()) {
      await seedHistoricalMessage(engine, {
        sessionId: OLD_SESSION_ID,
        sessionKey: SESSION_KEY,
        message: makeMessage(index % 2 === 0 ? "user" : "assistant", content, base + index),
      });
    }
    const conversation = await engine.getConversationStore().getConversationBySessionKey(SESSION_KEY);
    db.prepare(
      "UPDATE messages SET created_at = datetime('now', '-7 days') WHERE conversation_id = ?",
    ).run(conversation!.conversationId);
    const fileDir = mkdtempSync(join(tmpdir(), "lossless-claw-idscope-once-shared-"));
    tempDirs.push(fileDir);
    const trackedFile = join(fileDir, "old-session.jsonl");
    writeFileSync(trackedFile, "{}\n");
    await engine.getSummaryStore().upsertConversationBootstrapState({
      conversationId: conversation!.conversationId,
      sessionFilePath: trackedFile,
      lastSeenSize: 3,
      lastSeenMtimeMs: base,
      lastProcessedOffset: 3,
      lastProcessedEntryHash: "0".repeat(64),
    });

    const newSessionFile = writeRolledTranscript({
      name: NEW_SESSION_ID,
      entries: [
        { role: "user", text: "fresh post-roll question", timestamp: Date.now() + 60_000 },
        { role: "user", text: persistedContents[40]!, timestamp: Date.now() + 60_001 },
      ],
    });

    await engine.bootstrap({
      sessionId: NEW_SESSION_ID,
      sessionKey: SESSION_KEY,
      sessionFile: newSessionFile,
    });
    await engine.afterTurn({
      sessionId: NEW_SESSION_ID,
      sessionKey: SESSION_KEY,
      sessionFile: newSessionFile,
      messages: [makeMessage("user", "fresh post-roll question", Date.now() + 60_000)],
      prePromptMessageCount: 0,
      tokenBudget: 10_000,
    });

    const notProvablyFreshWarns = log.warn.mock.calls.filter(([message]) =>
      String(message).includes("ambiguous rollover not provably fresh"),
    );
    const preservingWarns = log.warn.mock.calls.filter(([message]) =>
      String(message).includes("ambiguous session-key runtime rollover; preserving"),
    );
    expect(notProvablyFreshWarns).toHaveLength(1);
    expect(preservingWarns).toHaveLength(1);
  });
});
