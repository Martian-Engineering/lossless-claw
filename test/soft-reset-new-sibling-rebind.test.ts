/**
 * Regression tests for the /new soft-reset carry-forward fix (sibling probe).
 *
 * Documented contract (README "Session reset semantics"; the `/lcm` help line
 * "/new ... does not split storage"): `/new` is a SOFT reset that keeps the
 * conversation and carries the retained summary band forward. The host mints a
 * new session id + file on /new and ARCHIVES the old transcript by renaming it
 * to `${file}.reset.<ts>`. On the next turn the bootstrap rollover detector saw
 * a stale session key whose tracked transcript had vanished and destructively
 * archived the pruned conversation, stranding the retained summaries.
 *
 * Fix under test: when Lossless recorded a /new prune and the tracked transcript
 * is missing with a `.reset.` archive sibling, the destructive guard stands down
 * and the existing ambiguous-rollover path rebinds the same conversation under
 * its freshness gate — preserving the retained summaries and re-anchoring to
 * the NEW session file. A genuine loss with no sibling still archives; a bare
 * suffix without Lossless's /new marker still archives; a foreign reused-key
 * transcript still fails the freshness gate and is never merged.
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
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-sibling-"));
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

function writeRolledTranscript(params: {
  name: string;
  entries: Array<{ role: string; text: string; timestamp: number }>;
}): string {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-sibling-roll-"));
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

function freshEntries(count = 4): Array<{ role: string; text: string; timestamp: number }> {
  const base = Date.now() + 60_000;
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    text: `post-new turn ${index} after the soft reset`,
    timestamp: base + index,
  }));
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

const SESSION_KEY = "agent:one:main";
const OLD_SESSION_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const NEW_SESSION_ID = "bbbbbbbb-0000-0000-0000-000000000002";

function countConversations(db: ReturnType<typeof createLcmDatabaseConnection>): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM conversations`).get() as { count: number };
  return row.count;
}

/**
 * Seed an active conversation under SESSION_KEY pinned to OLD_SESSION_ID with a
 * week-old, lineage-discriminating message history (so the freshness gate has
 * signal) and a depth 0/1/2 summary band in the context window. The tracked
 * transcript file is created on disk inside its own directory so a test can
 * rename it to an archive sibling. Returns the conversation id and tracked path.
 */
async function seedSummaryBearingLane(
  engine: LcmContextEngine,
  db: ReturnType<typeof createLcmDatabaseConnection>,
): Promise<{ conversationId: number; trackedFile: string }> {
  const base = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (let index = 0; index < 12; index += 1) {
    await seedHistoricalMessage(engine, {
      sessionId: OLD_SESSION_ID,
      sessionKey: SESSION_KEY,
      message: makeMessage(
        index % 2 === 0 ? "user" : "assistant",
        `lane turn ${index} about the deployment plan`,
        base + index,
      ),
    });
  }
  const conversation = await engine.getConversationStore().getConversationBySessionKey(SESSION_KEY);
  expect(conversation).not.toBeNull();
  const conversationId = conversation!.conversationId;
  db.prepare("UPDATE messages SET created_at = datetime('now', '-7 days') WHERE conversation_id = ?").run(
    conversationId,
  );

  const summaryStore = engine.getSummaryStore();
  await summaryStore.insertSummary({
    summaryId: "sum_d0",
    conversationId,
    kind: "leaf",
    depth: 0,
    content: "leaf detail",
    tokenCount: 10,
  });
  await summaryStore.insertSummary({
    summaryId: "sum_d1",
    conversationId,
    kind: "condensed",
    depth: 1,
    content: "session arc",
    tokenCount: 10,
  });
  await summaryStore.insertSummary({
    summaryId: "sum_d2",
    conversationId,
    kind: "condensed",
    depth: 2,
    content: "project arc to carry forward",
    tokenCount: 10,
  });
  await summaryStore.appendContextSummary(conversationId, "sum_d0");
  await summaryStore.appendContextSummary(conversationId, "sum_d1");
  await summaryStore.appendContextSummary(conversationId, "sum_d2");

  const fileDir = mkdtempSync(join(tmpdir(), "lossless-claw-sibling-track-"));
  tempDirs.push(fileDir);
  const trackedFile = join(fileDir, "old-session.jsonl");
  writeFileSync(trackedFile, "{}\n");
  await summaryStore.upsertConversationBootstrapState({
    conversationId,
    sessionFilePath: trackedFile,
    lastSeenSize: 3,
    lastSeenMtimeMs: base,
    lastProcessedOffset: 3,
    lastProcessedEntryHash: "0".repeat(64),
  });

  return { conversationId, trackedFile };
}

/**
 * Simulate the host's archive rename: `trackedFile` -> `${trackedFile}.<kind>.<ts>`.
 * This mirrors the exact shape OpenClaw core produces in `archiveFileOnDisk`
 * (`src/gateway/session-transcript-files.fs.ts`: `${filePath}.${reason}.<ts>`,
 * `reason` a `SessionArchiveReason` of "bak" | "reset" | "deleted"). The `<ts>`
 * is a representative host timestamp, not a value copied from a live session.
 */
function archiveTrackedFile(trackedFile: string, kind: "reset" | "deleted"): void {
  renameSync(trackedFile, `${trackedFile}.${kind}.2026-06-29T120000-000Z`);
}

describe("/new soft-reset carry-forward via archive-sibling probe", () => {
  it("rebinds (not archives) when the tracked transcript was archived to a .reset. sibling", async () => {
    const { engine, log, db } = createEngine({ newSessionRetainDepth: 2 });
    const lane = await seedSummaryBearingLane(engine, db);

    // /new prunes the conversation in place: only the depth>=2 summary survives.
    await engine.handleBeforeReset({
      reason: "new",
      sessionId: OLD_SESSION_ID,
      sessionKey: SESSION_KEY,
    });
    const afterPrune = await engine.getSummaryStore().getContextItems(lane.conversationId);
    expect(afterPrune.map((item) => item.summaryId)).toEqual(["sum_d2"]);

    // The host archived the old transcript and minted a fresh session file.
    archiveTrackedFile(lane.trackedFile, "reset");
    const newSessionFile = writeRolledTranscript({ name: NEW_SESSION_ID, entries: freshEntries() });

    const result = await engine.bootstrap({
      sessionId: NEW_SESSION_ID,
      sessionKey: SESSION_KEY,
      sessionFile: newSessionFile,
    });

    // Destructive guard stood down; the ambiguous path rebound the lane.
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("tracked transcript archived after /new (reset sibling present)"),
    );
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("resolved by fresh-transcript rebind"),
    );
    expect(log.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("detected reset/rollover without prior lifecycle split"),
    );

    // Same conversation id, now bound to the new session; no replacement row.
    const rebound = await engine.getConversationStore().getConversationBySessionKey(SESSION_KEY);
    expect(rebound?.conversationId).toBe(lane.conversationId);
    expect(rebound?.sessionId).toBe(NEW_SESSION_ID);
    expect(rebound?.active).toBe(true);
    expect(countConversations(db)).toBe(1);

    // The retained depth-2 summary carried forward; the new transcript imported;
    // the checkpoint re-anchored to the NEW file (never the .reset. sibling).
    const carried = await engine.getSummaryStore().getContextItems(lane.conversationId);
    expect(carried.map((item) => item.summaryId)).toContain("sum_d2");
    expect(result.importedMessages).toBeGreaterThan(0);
    const messages = await engine.getConversationStore().getMessages(lane.conversationId);
    expect(messages.some((m) => m.content.includes("post-new turn"))).toBe(true);
    const bootstrapState = await engine
      .getSummaryStore()
      .getConversationBootstrapState(lane.conversationId);
    expect(bootstrapState?.sessionFilePath).toBe(newSessionFile);
    expect(bootstrapState?.softResetPrunedAt).toBeNull();
  });

  it("still archives and creates a replacement when the transcript is genuinely lost (no sibling)", async () => {
    const { engine, log, db } = createEngine({ newSessionRetainDepth: 2 });
    const lane = await seedSummaryBearingLane(engine, db);

    // Genuine silent loss: the tracked file vanished with NO archive sibling.
    rmSync(lane.trackedFile, { force: true });
    const newSessionFile = writeRolledTranscript({ name: NEW_SESSION_ID, entries: freshEntries() });

    await engine.bootstrap({
      sessionId: NEW_SESSION_ID,
      sessionKey: SESSION_KEY,
      sessionFile: newSessionFile,
    });

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("detected reset/rollover without prior lifecycle split"),
    );
    expect(log.info).not.toHaveBeenCalledWith(
      expect.stringContaining("tracked transcript archived after /new (reset sibling present)"),
    );

    const original = await engine.getConversationStore().getConversation(lane.conversationId);
    expect(original?.active).toBe(false);
    const active = await engine.getConversationStore().getConversationBySessionKey(SESSION_KEY);
    expect(active?.conversationId).not.toBe(lane.conversationId);
    expect(active?.sessionId).toBe(NEW_SESSION_ID);
  });

  it("does NOT merge a foreign reused-key transcript even with a sibling (freshness gate holds)", async () => {
    const { engine, log, db } = createEngine({ newSessionRetainDepth: 2 });
    const lane = await seedSummaryBearingLane(engine, db);
    await engine.handleBeforeReset({
      reason: "new",
      sessionId: OLD_SESSION_ID,
      sessionKey: SESSION_KEY,
    });
    archiveTrackedFile(lane.trackedFile, "reset");

    // The "new" transcript overlaps the lane's own persisted history, so it is
    // NOT provably fresh: a foreign session reusing the key, not a real /new.
    const foreignFile = writeRolledTranscript({
      name: `${NEW_SESSION_ID}-foreign`,
      entries: [
        { role: "user", text: "post-new turn 0 after the soft reset", timestamp: Date.now() + 60_000 },
        // Same content as a recent persisted message -> identity overlap.
        { role: "user", text: "lane turn 10 about the deployment plan", timestamp: Date.now() + 60_001 },
      ],
    });

    const result = await engine.bootstrap({
      sessionId: NEW_SESSION_ID,
      sessionKey: SESSION_KEY,
      sessionFile: foreignFile,
    });

    // Guard stood down (sibling), but the freshness gate refused the merge.
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("tracked transcript archived after /new (reset sibling present)"),
    );
    expect(result.bootstrapped).toBe(false);
    expect(result.reason).toBe("ambiguous session-key runtime rollover");
    expect(log.info).not.toHaveBeenCalledWith(
      expect.stringContaining("resolved by fresh-transcript rebind"),
    );
    // A foreign reused-key transcript is a genuine conflict (identity overlap),
    // so the preserve stays at WARN even though a sibling is present.
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("ambiguous session-key runtime rollover; preserving"),
    );
    expect(log.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("detected reset/rollover without prior lifecycle split"),
    );

    // The lane is preserved (frozen), still pinned to the old session: safe.
    const conversation = await engine.getConversationStore().getConversationBySessionKey(SESSION_KEY);
    expect(conversation?.conversationId).toBe(lane.conversationId);
    expect(conversation?.sessionId).toBe(OLD_SESSION_ID);
  });

  it("does not treat a .deleted. archive sibling as /new continuity proof", async () => {
    const { engine, log, db } = createEngine({ newSessionRetainDepth: 2 });
    const lane = await seedSummaryBearingLane(engine, db);

    await engine.handleBeforeReset({
      reason: "new",
      sessionId: OLD_SESSION_ID,
      sessionKey: SESSION_KEY,
    });
    archiveTrackedFile(lane.trackedFile, "deleted");
    const newSessionFile = writeRolledTranscript({ name: NEW_SESSION_ID, entries: freshEntries() });

    await engine.bootstrap({
      sessionId: NEW_SESSION_ID,
      sessionKey: SESSION_KEY,
      sessionFile: newSessionFile,
    });

    expect(log.info).not.toHaveBeenCalledWith(
      expect.stringContaining("tracked transcript archived after /new (reset sibling present)"),
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("detected reset/rollover without prior lifecycle split"),
    );
    expect(log.info).not.toHaveBeenCalledWith(
      expect.stringContaining("resolved by fresh-transcript rebind"),
    );
    const original = await engine.getConversationStore().getConversation(lane.conversationId);
    expect(original?.active).toBe(false);
    const active = await engine.getConversationStore().getConversationBySessionKey(SESSION_KEY);
    expect(active?.conversationId).not.toBe(lane.conversationId);
    expect(active?.sessionId).toBe(NEW_SESSION_ID);
  });

  it("does not treat a bare .reset. sibling as continuity proof without the /new marker", async () => {
    const { engine, log, db } = createEngine({ newSessionRetainDepth: 2 });
    const lane = await seedSummaryBearingLane(engine, db);

    archiveTrackedFile(lane.trackedFile, "reset");
    const newSessionFile = writeRolledTranscript({ name: NEW_SESSION_ID, entries: freshEntries() });

    await engine.bootstrap({
      sessionId: NEW_SESSION_ID,
      sessionKey: SESSION_KEY,
      sessionFile: newSessionFile,
    });

    expect(log.info).not.toHaveBeenCalledWith(
      expect.stringContaining("tracked transcript archived after /new (reset sibling present)"),
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("detected reset/rollover without prior lifecycle split"),
    );
    const original = await engine.getConversationStore().getConversation(lane.conversationId);
    expect(original?.active).toBe(false);
    const active = await engine.getConversationStore().getConversationBySessionKey(SESSION_KEY);
    expect(active?.conversationId).not.toBe(lane.conversationId);
    expect(active?.sessionId).toBe(NEW_SESSION_ID);
  });

  it("a legit single /new is silent: bootstrap preserves at debug while unjudgeable, afterTurn rebinds once the turn lands", async () => {
    // Drives the REAL afterTurn path (no hand-set signals): the new session file
    // is EMPTY at bootstrap (no usable timestamps -> transient preserve at debug)
    // and CONTENT-bearing by afterTurn (the completed turn lands -> judgeable ->
    // rebind). This is the live conv-56 /new shape; net result is 0 warns.
    const { engine, log, db } = createEngine({ newSessionRetainDepth: 2 });
    const lane = await seedSummaryBearingLane(engine, db);
    await engine.handleBeforeReset({ reason: "new", sessionId: OLD_SESSION_ID, sessionKey: SESSION_KEY });
    archiveTrackedFile(lane.trackedFile, "reset");

    const newDir = mkdtempSync(join(tmpdir(), "lossless-claw-sibling-grow-"));
    tempDirs.push(newDir);
    const newFile = join(newDir, `${NEW_SESSION_ID}.jsonl`);

    // turn-START: file exists but has no usable content yet.
    writeFileSync(newFile, "");
    await engine.bootstrap({ sessionId: NEW_SESSION_ID, sessionKey: SESSION_KEY, sessionFile: newFile });

    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("bootstrap: ambiguous session-key runtime rollover; preserving"),
    );
    expect(log.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("ambiguous session-key runtime rollover; preserving"),
    );

    // turn-END: the real fresh, postdating, non-overlapping turn lands in the file.
    const future = Date.now() + 60_000;
    let parentId: string | null = null;
    const grown = [
      { role: "user", text: "brand new post-/new question about something else", ts: future },
      { role: "assistant", text: "fresh answer after the soft reset", ts: future + 1 },
    ]
      .map((e, i) => {
        const id = `grow-${i}`;
        const line = JSON.stringify({
          type: "message",
          id,
          parentId,
          timestamp: new Date(e.ts).toISOString(),
          message: { role: e.role, content: [{ type: "text", text: e.text }], timestamp: e.ts },
        });
        parentId = id;
        return line;
      })
      .join("\n");
    writeFileSync(newFile, `${grown}\n`);
    await engine.afterTurn({
      sessionId: NEW_SESSION_ID,
      sessionKey: SESSION_KEY,
      sessionFile: newFile,
      messages: [makeMessage("user", "brand new post-/new question about something else", future)],
      prePromptMessageCount: 0,
      tokenBudget: 10_000,
    });

    // afterTurn now has judgeable evidence -> rebinds in place (no "preserving").
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("afterTurn: ambiguous rollover resolved by fresh-transcript rebind"),
    );
    expect(log.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("ambiguous session-key runtime rollover; preserving"),
    );
    const rebound = await engine.getConversationStore().getConversationBySessionKey(SESSION_KEY);
    expect(rebound?.conversationId).toBe(lane.conversationId);
    expect(rebound?.sessionId).toBe(NEW_SESSION_ID);
  });
});
