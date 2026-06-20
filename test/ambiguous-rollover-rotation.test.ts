/**
 * Regression tests for tier-2 ambiguous-rollover resolution (lossless-claw-30b.8).
 *
 * Live incident shape (phaedrus, conversations 1 and 4): the runtime session
 * under a key rolled to a new sessionId while the old conversation's tracked
 * transcript file still existed. The ambiguous-rollover guard froze every
 * bootstrap/assemble/afterTurn — no adoption, no rotation — leaving the lane
 * outside LCM indefinitely while its transcript grew.
 *
 * Policy under test: when the new transcript is PROVABLY FRESH — zero
 * identity overlap with the frozen conversation's recent persisted history
 * and every timestamped entry postdating its last persisted message — the
 * rollover resolves by rebind-in-place. Freshness is content+time
 * evidence, never transcript size, so lanes frozen for days (aged, with
 * accumulated history) still heal. Anything short of proof stays frozen.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { LcmConfig } from "../src/db/config.js";
import { closeLcmConnection, createLcmDatabaseConnection } from "../src/db/connection.js";
import { LcmContextEngine } from "../src/engine.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import type { LcmDependencies } from "../src/types.js";
import { createTestConfig as createSharedTestConfig, createTestDeps as createSharedTestDeps } from "./helpers.js";

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

function createTestConfig(databasePath: string): LcmConfig {
  return createSharedTestConfig(databasePath, { freshTailCount: 4 });
}

function parseAgentSessionKey(sessionKey: string): { agentId: string; suffix: string } | null {
  const trimmed = sessionKey.trim();
  if (!trimmed.startsWith("agent:")) {
    return null;
  }
  const parts = trimmed.split(":");
  if (parts.length < 3) {
    return null;
  }
  return { agentId: parts[1] ?? "main", suffix: parts.slice(2).join(":") };
}

type LogMock = {
  info: Mock<(msg: string) => void>;
  warn: Mock<(msg: string) => void>;
  error: Mock<(msg: string) => void>;
  debug: Mock<(msg: string) => void>;
};

function createTestDeps(config: LcmConfig, log: LogMock): LcmDependencies {
  return createSharedTestDeps(config, {
    readLatestAssistantReply: () => undefined,
    resolveAgentDir: () => tmpdir(),
    log,
  });
}

function createEngine(configOverrides: Partial<LcmConfig> = {}): {
  engine: LcmContextEngine;
  log: LogMock;
  db: ReturnType<typeof createLcmDatabaseConnection>;
} {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-rollover-"));
  tempDirs.push(tempDir);
  const config = {
    ...createTestConfig(join(tempDir, "lcm.db")),
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
  return { engine, log, db };
}

function createTempFile(name: string, contents = ""): string {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-rollover-files-"));
  tempDirs.push(tempDir);
  const file = join(tempDir, name);
  writeFileSync(file, contents);
  return file;
}

function makeMessage(role: string, content: string, timestamp: number): AgentMessage {
  return { role, content, timestamp } as unknown as AgentMessage;
}

const SESSION_KEY = "agent:main:main";
const OLD_SESSION_ID = "old-session-1debb14a";
const NEW_SESSION_ID = "new-session-043c1ec8";

/**
 * Builds the aged frozen-lane shape from the live incident: an active
 * conversation pinned to OLD_SESSION_ID under SESSION_KEY with a week-old
 * persisted history WIDER than the freshness overlap window (so healing
 * cannot depend on lane size), and a bootstrap checkpoint tracking a
 * transcript file that still exists and differs from whatever the new
 * runtime presents.
 */
async function seedFrozenLane(
  engine: LcmContextEngine,
  db: ReturnType<typeof createLcmDatabaseConnection>,
  messageCount = 60,
): Promise<{ conversationId: number; persistedContents: string[]; trackedFile: string }> {
  const persistedContents = Array.from(
    { length: messageCount },
    (_, index) => `frozen lane turn ${index} about deployment details`,
  );
  const base = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [index, content] of persistedContents.entries()) {
    await seedHistoricalMessage(engine, {
      sessionId: OLD_SESSION_ID,
      sessionKey: SESSION_KEY,
      message: makeMessage(index % 2 === 0 ? "user" : "assistant", content, base + index),
    });
  }
  const conversation = await engine
    .getConversationStore()
    .getConversationBySessionKey(SESSION_KEY);
  expect(conversation).not.toBeNull();
  // Age the lane for real: created_at is what the freshness time gate reads.
  db.prepare("UPDATE messages SET created_at = datetime('now', '-7 days') WHERE conversation_id = ?").run(
    conversation!.conversationId,
  );
  const trackedFile = createTempFile("old-rotated-transcript.jsonl", "{}\n");
  await engine.getSummaryStore().upsertConversationBootstrapState({
    conversationId: conversation!.conversationId,
    sessionFilePath: trackedFile,
    lastSeenSize: 3,
    lastSeenMtimeMs: Date.now() - 7 * 24 * 60 * 60 * 1000,
    lastProcessedOffset: 3,
    lastProcessedEntryHash: "0".repeat(64),
  });
  return { conversationId: conversation!.conversationId, persistedContents, trackedFile };
}

/**
 * Write a rolled-session transcript as envelope JSONL directly (the
 * `{type:"message", id, parentId, timestamp, message}` shape OpenClaw
 * writes), chained by parentId so the leaf path covers every entry.
 */
function writeRolledTranscript(params: {
  name: string;
  entries: Array<{ role: string; text?: string; content?: unknown; timestamp?: number }>;
}): string {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-rollover-file-"));
  tempDirs.push(tempDir);
  const file = join(tempDir, `${params.name}.jsonl`);
  let parentId: string | null = null;
  const lines = params.entries.map((entry, index) => {
    const id = `${params.name}-entry-${index}`;
    const line = JSON.stringify({
      type: "message",
      id,
      parentId,
      timestamp: new Date(entry.timestamp ?? Date.now()).toISOString(),
      message: {
        role: entry.role,
        content: entry.content ?? [{ type: "text", text: entry.text ?? "" }],
        ...(entry.timestamp !== undefined ? { timestamp: entry.timestamp } : {}),
      },
    });
    parentId = id;
    return line;
  });
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

/**
 * Write timestamped envelope messages without entry ids. These are legacy-ish
 * but still supported by the transcript parser and freshness checker; lacking
 * ids forces reconciliation through the no-anchor identity path.
 */
function writeIdlessEnvelopeTranscript(params: {
  name: string;
  entries: Array<{ role: string; text: string; timestamp: number }>;
}): string {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-rollover-file-"));
  tempDirs.push(tempDir);
  const file = join(tempDir, `${params.name}.jsonl`);
  const lines = params.entries.map((entry) =>
    JSON.stringify({
      type: "message",
      timestamp: new Date(entry.timestamp).toISOString(),
      message: {
        role: entry.role,
        content: [{ type: "text", text: entry.text }],
        timestamp: entry.timestamp,
      },
    }),
  );
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

function freshEntries(count = 6): Array<{ role: string; text: string; timestamp: number }> {
  const base = Date.now() + 60_000;
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    text: `fresh rolled-session turn ${index}`,
    timestamp: base + index,
  }));
}

/**
 * Seed backdated history through the full ingest pipeline but skip the
 * replay-timestamp flood guard. The guard buckets user rows by insert-second
 * regardless of content, so seeding loops trip it whenever a fast machine
 * lands three user ingests in the same wall-clock second — these tests
 * backdate created_at immediately afterwards anyway.
 */
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

describe("ambiguous rollover tier-2 fresh-transcript rotation", () => {
  it("bootstrap heals an aged frozen lane: rebinds it and imports the rolled transcript", async () => {
    const { engine, log, db } = createEngine();
    const lane = await seedFrozenLane(engine, db);

    const newSessionFile = writeRolledTranscript({
      name: NEW_SESSION_ID,
      entries: freshEntries(),
    });
    const result = await engine.bootstrap({
      sessionId: NEW_SESSION_ID,
      sessionKey: SESSION_KEY,
      sessionFile: newSessionFile,
    });

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("resolved by fresh-transcript rebind"),
    );
    expect(result.bootstrapped).toBe(true);
    expect(result.importedMessages).toBeGreaterThan(0);

    // Existing conversation id is rebound to the new session, fully preserving history.
    const preserved = await engine.getConversationStore().getMessages(lane.conversationId);
    expect(preserved.slice(0, lane.persistedContents.length).map((m) => m.content)).toEqual(
      lane.persistedContents,
    );

    // The key now binds the new session on the same conversation id, with the transcript imported.
    const rebound = await engine
      .getConversationStore()
      .getConversationBySessionKey(SESSION_KEY);
    expect(rebound?.sessionId).toBe(NEW_SESSION_ID);
    expect(rebound?.conversationId).toBe(lane.conversationId);
    const imported = await engine.getConversationStore().getMessages(lane.conversationId);
    expect(imported.some((m) => m.content.includes("fresh rolled-session turn"))).toBe(true);
  });

  it("imports a fresh id-less rollover transcript even when it exceeds the no-anchor cap", async () => {
    const { engine, log, db } = createEngine();
    const lane = await seedFrozenLane(engine, db);
    const entries = freshEntries(60);
    const newSessionFile = writeIdlessEnvelopeTranscript({
      name: `${NEW_SESSION_ID}-idless-over-cap`,
      entries,
    });

    const result = await engine.bootstrap({
      sessionId: NEW_SESSION_ID,
      sessionKey: SESSION_KEY,
      sessionFile: newSessionFile,
    });

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("resolved by fresh-transcript rebind"),
    );
    expect(result.bootstrapped).toBe(true);
    expect(result.importedMessages).toBe(entries.length);
    expect(log.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("no anchor import cap exceeded"),
    );

    const rebound = await engine
      .getConversationStore()
      .getConversationBySessionKey(SESSION_KEY);
    expect(rebound?.conversationId).toBe(lane.conversationId);
    expect(rebound?.sessionId).toBe(NEW_SESSION_ID);
    const persisted = await engine.getConversationStore().getMessages(lane.conversationId);
    expect(persisted.slice(0, lane.persistedContents.length).map((m) => m.content)).toEqual(
      lane.persistedContents,
    );
    expect(persisted.slice(-entries.length).map((m) => m.content)).toEqual(
      entries.map((entry) => entry.text),
    );
  });

  it("keeps repeated id-less prefix messages in a proven-fresh rollover transcript", async () => {
    const { engine, log, db } = createEngine();
    const lane = await seedFrozenLane(engine, db);
    const repeatedTemplate = "Daily status template line";
    const oldBase = Date.now() - 6 * 24 * 60 * 60 * 1000;
    for (let index = 0; index < 3; index += 1) {
      await seedHistoricalMessage(engine, {
        sessionId: OLD_SESSION_ID,
        sessionKey: SESSION_KEY,
        message: makeMessage("user", repeatedTemplate, oldBase + index),
      });
    }
    db.prepare(
      "UPDATE messages SET created_at = datetime('now', '-6 days') WHERE conversation_id = ?",
    ).run(lane.conversationId);
    const freshBase = Date.now() + 60_000;
    const entries = [
      { role: "user", text: repeatedTemplate, timestamp: freshBase },
      { role: "user", text: repeatedTemplate, timestamp: freshBase + 1 },
      { role: "user", text: repeatedTemplate, timestamp: freshBase + 2 },
      { role: "assistant", text: "fresh answer after repeated prefix", timestamp: freshBase + 3 },
    ];
    const newSessionFile = writeIdlessEnvelopeTranscript({
      name: `${NEW_SESSION_ID}-idless-repeated-prefix`,
      entries,
    });

    const result = await engine.bootstrap({
      sessionId: NEW_SESSION_ID,
      sessionKey: SESSION_KEY,
      sessionFile: newSessionFile,
    });

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("resolved by fresh-transcript rebind"),
    );
    expect(result.bootstrapped).toBe(true);
    expect(result.importedMessages).toBe(entries.length);
    expect(log.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("duplicate transcript replay guard dropped"),
    );
    const persisted = await engine.getConversationStore().getMessages(lane.conversationId);
    expect(persisted.slice(-entries.length).map((m) => m.content)).toEqual(
      entries.map((entry) => entry.text),
    );
  });

  it("inserts fresh entry-id rollover messages instead of adopting old repeated rows", async () => {
    const { engine, log, db } = createEngine();
    const lane = await seedFrozenLane(engine, db);
    const repeatedTemplate = "Daily status template line";
    const oldBase = Date.now() - 6 * 24 * 60 * 60 * 1000;
    for (let index = 0; index < 3; index += 1) {
      await seedHistoricalMessage(engine, {
        sessionId: OLD_SESSION_ID,
        sessionKey: SESSION_KEY,
        message: makeMessage("user", repeatedTemplate, oldBase + index),
      });
    }
    db.prepare(
      "UPDATE messages SET created_at = datetime('now', '-6 days') WHERE conversation_id = ?",
    ).run(lane.conversationId);
    const freshBase = Date.now() + 60_000;
    const entries = [
      { role: "user", text: repeatedTemplate, timestamp: freshBase },
      { role: "user", text: repeatedTemplate, timestamp: freshBase + 1 },
      { role: "user", text: repeatedTemplate, timestamp: freshBase + 2 },
      { role: "assistant", text: "fresh entry-id answer after repeated prefix", timestamp: freshBase + 3 },
    ];
    const newSessionFile = writeRolledTranscript({
      name: `${NEW_SESSION_ID}-entry-id-repeated-prefix`,
      entries,
    });

    const result = await engine.bootstrap({
      sessionId: NEW_SESSION_ID,
      sessionKey: SESSION_KEY,
      sessionFile: newSessionFile,
    });

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("resolved by fresh-transcript rebind"),
    );
    expect(result.bootstrapped).toBe(true);
    expect(result.importedMessages).toBe(entries.length);
    const persisted = await engine.getConversationStore().getMessages(lane.conversationId);
    expect(persisted.slice(-entries.length).map((m) => m.content)).toEqual(
      entries.map((entry) => entry.text),
    );
  });

  it("afterTurn rebinds the lane and imports the fresh transcript immediately", async () => {
    const { engine, log, db } = createEngine();
    const lane = await seedFrozenLane(engine, db);

    const entries = freshEntries(4);
    const newSessionFile = writeRolledTranscript({ name: NEW_SESSION_ID, entries });
    const liveMessages = entries.map(
      (entry) =>
        ({
          role: entry.role,
          content: [{ type: "text", text: entry.text }],
          timestamp: entry.timestamp,
        }) as unknown as AgentMessage,
    );

    await engine.afterTurn({
      sessionId: NEW_SESSION_ID,
      sessionKey: SESSION_KEY,
      sessionFile: newSessionFile,
      messages: liveMessages,
      prePromptMessageCount: 0,
      tokenBudget: 10_000,
    });

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("resolved by fresh-transcript rebind"),
    );
    const reboundAfterFirst = await engine
      .getConversationStore()
      .getConversationBySessionKey(SESSION_KEY);
    expect(reboundAfterFirst?.sessionId).toBe(NEW_SESSION_ID);

    const persistedAfterTurn = await engine
      .getConversationStore()
      .getMessages(reboundAfterFirst!.conversationId);
    expect(persistedAfterTurn.some((m) => m.content.includes("fresh rolled-session turn"))).toBe(
      true,
    );

    // Production sequence: the host calls bootstrap before each run; after the
    // immediate afterTurn import, bootstrap sees the checkpoint is already current.
    const boot = await engine.bootstrap({
      sessionId: NEW_SESSION_ID,
      sessionKey: SESSION_KEY,
      sessionFile: newSessionFile,
    });
    expect(boot.importedMessages).toBe(0);
    expect(boot.reason).toBe("already bootstrapped");
    const persisted = await engine
      .getConversationStore()
      .getMessages(reboundAfterFirst!.conversationId);
    expect(persisted.some((m) => m.content.includes("fresh rolled-session turn"))).toBe(true);

    const preserved = await engine.getConversationStore().getMessages(lane.conversationId);
    expect(preserved.slice(0, lane.persistedContents.length).map((m) => m.content)).toEqual(
      lane.persistedContents,
    );
  });

  it("stays frozen when the rolled transcript overlaps the lane's persisted history", async () => {
    const { engine, log, db } = createEngine();
    const lane = await seedFrozenLane(engine, db);

    const newSessionFile = writeRolledTranscript({
      name: NEW_SESSION_ID,
      entries: [
        ...freshEntries(3),
        // Same content as a recent persisted message: lineage is plausible,
        // so the rollover is NOT provably fresh.
        { role: "user", text: lane.persistedContents[56]!, timestamp: Date.now() + 90_000 },
      ],
    });

    const result = await engine.bootstrap({
      sessionId: NEW_SESSION_ID,
      sessionKey: SESSION_KEY,
      sessionFile: newSessionFile,
    });

    expect(result.bootstrapped).toBe(false);
    expect(result.reason).toBe("ambiguous session-key runtime rollover");
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("freshness=identity-overlap-with-persisted-history"),
    );
    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionKey(SESSION_KEY);
    expect(conversation?.conversationId).toBe(lane.conversationId);
    expect(conversation?.sessionId).toBe(OLD_SESSION_ID);
  });

  it("stays frozen when transcript timestamps predate the lane or are missing", async () => {
    const { engine, log, db } = createEngine();
    const lane = await seedFrozenLane(engine, db);

    // Message timestamps a month old: predate the week-old persisted lane.
    const stale = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const staleFile = writeRolledTranscript({
      name: `${NEW_SESSION_ID}-stale`,
      entries: [{ role: "user", text: "suspiciously old entry", timestamp: stale }],
    });
    const staleResult = await engine.bootstrap({
      sessionId: NEW_SESSION_ID,
      sessionKey: SESSION_KEY,
      sessionFile: staleFile,
    });
    expect(staleResult.bootstrapped).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("freshness=candidate-entries-predate-last-persisted"),
    );

    // Bare-line transcript: no envelope, no message timestamp → fail closed.
    const bareFile = createTempFile(
      "bare-lines.jsonl",
      `${JSON.stringify({ role: "user", content: [{ type: "text", text: "no timestamps at all" }] })}\n`,
    );
    const bareResult = await engine.bootstrap({
      sessionId: NEW_SESSION_ID,
      sessionKey: SESSION_KEY,
      sessionFile: bareFile,
    });
    expect(bareResult.bootstrapped).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("freshness=candidate-missing-timestamp"),
    );

    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionKey(SESSION_KEY);
    expect(conversation?.conversationId).toBe(lane.conversationId);
  });

  it("stays frozen when the rolled transcript contains only delivery/config traffic", async () => {
    const { engine, log, db } = createEngine();
    const lane = await seedFrozenLane(engine, db);

    const newSessionFile = writeRolledTranscript({
      name: `${NEW_SESSION_ID}-delivery-only`,
      entries: [
        {
          role: "system",
          text: "delivery-mirror: delivered pending runtime notification",
          timestamp: Date.now() + 60_000,
        },
        {
          role: "system",
          text: "config audit: refreshed runtime delivery settings",
          timestamp: Date.now() + 60_001,
        },
      ],
    });

    const result = await engine.bootstrap({
      sessionId: NEW_SESSION_ID,
      sessionKey: SESSION_KEY,
      sessionFile: newSessionFile,
    });

    expect(result.bootstrapped).toBe(false);
    expect(result.reason).toBe("ambiguous session-key runtime rollover");
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("freshness=delivery-only-synthetic-transcript"),
    );
    expect(log.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("resolved by fresh-transcript rebind"),
    );
    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionKey(SESSION_KEY);
    expect(conversation?.conversationId).toBe(lane.conversationId);
    expect(conversation?.sessionId).toBe(OLD_SESSION_ID);
  });

  it("stays frozen when the rolled transcript has no comparable message content", async () => {
    const { engine, log, db } = createEngine();
    const lane = await seedFrozenLane(engine, db);

    const newSessionFile = writeRolledTranscript({
      name: `${NEW_SESSION_ID}-empty-content`,
      entries: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu-empty", name: "noop", input: {} }],
          timestamp: Date.now() + 60_000,
        },
        {
          role: "assistant",
          content: [{ type: "reasoning", text: "private chain" }],
          timestamp: Date.now() + 60_001,
        },
      ],
    });

    const result = await engine.bootstrap({
      sessionId: NEW_SESSION_ID,
      sessionKey: SESSION_KEY,
      sessionFile: newSessionFile,
    });

    expect(result.bootstrapped).toBe(false);
    expect(result.reason).toBe("ambiguous session-key runtime rollover");
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("freshness=no-comparable-candidate-content"),
    );
    expect(log.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("resolved by fresh-transcript rebind"),
    );
    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionKey(SESSION_KEY);
    expect(conversation?.conversationId).toBe(lane.conversationId);
    expect(conversation?.sessionId).toBe(OLD_SESSION_ID);
  });

  it("assemble never rotates or writes live tool-output files before rollover safety checks", async () => {
    const { engine, log, db } = createEngine({
      largeFileTokenThreshold: 20,
      stubLargeToolPayloads: true,
    });
    const lane = await seedFrozenLane(engine, db);

    const oversizedToolOutput = "tool output. ".repeat(200);
    const result = await engine.assemble({
      sessionId: NEW_SESSION_ID,
      sessionKey: SESSION_KEY,
      messages: [
        {
          role: "user",
          content: "brand new prompt that would look fresh",
          timestamp: Date.now() + 60_000,
        } as unknown as AgentMessage,
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call_1", name: "exec", input: {} }],
          timestamp: Date.now() + 60_001,
        } as unknown as AgentMessage,
        {
          role: "toolResult",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              output: oversizedToolOutput,
            },
          ],
          timestamp: Date.now() + 60_002,
        } as unknown as AgentMessage,
      ],
      tokenBudget: 10_000,
    });

    expect(result.messages.length).toBeGreaterThan(0);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("ambiguous session-key runtime rollover; preserving"),
    );
    expect(log.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("resolved by fresh-transcript rebind"),
    );
    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionKey(SESSION_KEY);
    expect(conversation?.conversationId).toBe(lane.conversationId);
    expect(conversation?.sessionId).toBe(OLD_SESSION_ID);
    await expect(
      engine.getSummaryStore().getLargeFilesByConversation(lane.conversationId),
    ).resolves.toEqual([]);
  });

  it("rebinds even an empty lifecycle row instead of creating a replacement", async () => {
    const { engine, log } = createEngine({ bootstrapMaxTokens: 1 });
    // Empty conversation pinned to the old session: rebind it in-place so
    // even lifecycle edge cases preserve the conversation id.
    const conversation = await engine
      .getConversationStore()
      .getOrCreateConversation(OLD_SESSION_ID, { sessionKey: SESSION_KEY });
    const trackedFile = createTempFile("old-empty-tracked.jsonl", "{}\n");
    await engine.getSummaryStore().upsertConversationBootstrapState({
      conversationId: conversation.conversationId,
      sessionFilePath: trackedFile,
      lastSeenSize: 3,
      lastSeenMtimeMs: Date.now() - 1000,
      lastProcessedOffset: 3,
      lastProcessedEntryHash: "0".repeat(64),
    });

    const entries = freshEntries(2);
    const newSessionFile = writeRolledTranscript({ name: `${NEW_SESSION_ID}-noop`, entries });
    await engine.afterTurn({
      sessionId: NEW_SESSION_ID,
      sessionKey: SESSION_KEY,
      sessionFile: newSessionFile,
      messages: entries.map(
        (entry) =>
          ({
            role: entry.role,
            content: [{ type: "text", text: entry.text }],
            timestamp: entry.timestamp,
          }) as unknown as AgentMessage,
      ),
      prePromptMessageCount: 0,
      tokenBudget: 10_000,
    });

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("resolved by fresh-transcript rebind"),
    );
    const rebound = await engine
      .getConversationStore()
      .getConversationBySessionKey(SESSION_KEY);
    expect(rebound?.conversationId).toBe(conversation.conversationId);
    expect(rebound?.sessionId).toBe(NEW_SESSION_ID);
    const imported = await engine
      .getConversationStore()
      .getMessages(conversation.conversationId);
    expect(imported.map((m) => m.content)).toEqual(entries.map((entry) => entry.text));
  });
  it("heals a heartbeat-idle lane on time evidence alone (live conv-1 shape)", async () => {
    const { engine, log, db } = createEngine();
    // The lane's entire recent history is synthetic heartbeat traffic —
    // the live incident shape: no lineage-discriminating content at all.
    const heartbeatContents: Array<{ role: string; content: string }> = [];
    for (let index = 0; index < 60; index += 1) {
      heartbeatContents.push(
        index % 2 === 0
          ? { role: "user", content: "[OpenClaw heartbeat poll]" }
          : { role: "assistant", content: "HEARTBEAT_OK" },
      );
    }
    const base = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const [index, entry] of heartbeatContents.entries()) {
      await seedHistoricalMessage(engine, {
        sessionId: OLD_SESSION_ID,
        sessionKey: SESSION_KEY,
        message: makeMessage(entry.role, entry.content, base + index),
      });
    }
    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionKey(SESSION_KEY);
    expect(conversation).not.toBeNull();
    db.prepare(
      "UPDATE messages SET created_at = datetime('now', '-7 days') WHERE conversation_id = ?",
    ).run(conversation!.conversationId);
    const trackedFile = createTempFile("old-heartbeat-tracked.jsonl", "{}\n");
    await engine.getSummaryStore().upsertConversationBootstrapState({
      conversationId: conversation!.conversationId,
      sessionFilePath: trackedFile,
      lastSeenSize: 3,
      lastSeenMtimeMs: Date.now() - 7 * 24 * 60 * 60 * 1000,
      lastProcessedOffset: 3,
      lastProcessedEntryHash: "0".repeat(64),
    });

    // The rolled transcript also carries heartbeat polls (every session
    // does) plus genuinely new content.
    const rolledBase = Date.now() + 60_000;
    const newSessionFile = writeRolledTranscript({
      name: `${NEW_SESSION_ID}-heartbeat-idle`,
      entries: [
        { role: "user", text: "[OpenClaw heartbeat poll]", timestamp: rolledBase },
        { role: "assistant", text: "HEARTBEAT_OK", timestamp: rolledBase + 1 },
        { role: "user", text: "real new work after the roll", timestamp: rolledBase + 2 },
      ],
    });
    const result = await engine.bootstrap({
      sessionId: NEW_SESSION_ID,
      sessionKey: SESSION_KEY,
      sessionFile: newSessionFile,
    });

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("resolved by fresh-transcript rebind"),
    );
    expect(result.bootstrapped).toBe(true);
    const rebound = await engine
      .getConversationStore()
      .getConversationBySessionKey(SESSION_KEY);
    expect(rebound?.sessionId).toBe(NEW_SESSION_ID);
    // The heartbeat history remains intact on the same conversation id.
    const preserved = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(preserved.slice(0, 60).map((m) => m.content)).toEqual(
      heartbeatContents.map((entry) => entry.content),
    );
  });

  it("heartbeat polls and recurring template content never block the heal", async () => {
    const { engine, log, db } = createEngine();
    const lane = await seedFrozenLane(engine, db);
    // Add recurring template noise on top of the unique history: heartbeat
    // polls and a thrice-repeated boilerplate line.
    const base = Date.now() - 6 * 24 * 60 * 60 * 1000;
    const noise = [
      { role: "user", content: "[OpenClaw heartbeat poll]" },
      { role: "assistant", content: "HEARTBEAT_OK" },
      { role: "user", content: "Daily status template line" },
      { role: "user", content: "[OpenClaw heartbeat poll]" },
      { role: "user", content: "Daily status template line" },
      { role: "user", content: "Daily status template line" },
    ];
    for (const [index, entry] of noise.entries()) {
      await seedHistoricalMessage(engine, {
        sessionId: OLD_SESSION_ID,
        sessionKey: SESSION_KEY,
        message: makeMessage(entry.role, entry.content, base + index),
      });
    }
    db.prepare(
      "UPDATE messages SET created_at = datetime('now', '-6 days') WHERE conversation_id = ?",
    ).run(lane.conversationId);

    // The rolled transcript shares ONLY the template noise — heartbeats and
    // the recurring boilerplate — plus fresh content. No unique overlap.
    const rolledBase = Date.now() + 60_000;
    const newSessionFile = writeRolledTranscript({
      name: `${NEW_SESSION_ID}-template-noise`,
      entries: [
        { role: "user", text: "[OpenClaw heartbeat poll]", timestamp: rolledBase },
        { role: "user", text: "Daily status template line", timestamp: rolledBase + 1 },
        { role: "user", text: "fresh post-roll question", timestamp: rolledBase + 2 },
      ],
    });
    const result = await engine.bootstrap({
      sessionId: NEW_SESSION_ID,
      sessionKey: SESSION_KEY,
      sessionFile: newSessionFile,
    });

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("resolved by fresh-transcript rebind"),
    );
    expect(result.bootstrapped).toBe(true);
    const rebound = await engine
      .getConversationStore()
      .getConversationBySessionKey(SESSION_KEY);
    expect(rebound?.sessionId).toBe(NEW_SESSION_ID);
    expect(rebound?.conversationId).toBe(lane.conversationId);
  });
});
