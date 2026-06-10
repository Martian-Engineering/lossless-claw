import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LcmConfig } from "../src/db/config.js";
import { closeLcmConnection, createLcmDatabaseConnection } from "../src/db/connection.js";
import { LcmContextEngine } from "../src/engine.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import {
  getTranscriptEntryId,
  getTranscriptEntryMeta,
  parseBootstrapJsonl,
  readLeafPathMessages,
} from "../src/transcript.js";
import type { LcmDependencies } from "../src/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  tempDirs.length = 0;
});

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createTestConfig(databasePath: string): LcmConfig {
  return {
    enabled: true,
    databasePath,
    largeFilesDir: join(databasePath, "..", "lcm-files"),
    ignoreSessionPatterns: [],
    statelessSessionPatterns: [],
    skipStatelessSessions: true,
    contextThreshold: 0.75,
    freshTailCount: 8,
    promptAwareEviction: false,
    stubLargeToolPayloads: false,
    newSessionRetainDepth: 2,
    leafMinFanout: 8,
    condensedMinFanout: 4,
    condensedMinFanoutHard: 2,
    sweepMaxDepth: 1,
    incrementalMaxDepth: 0,
    maxSweepIterations: 12,
    sweepDeadlineMs: 120_000,
    compactUntilUnderDeadlineMs: 300_000,
    leafChunkTokens: 20_000,
    leafTargetTokens: 600,
    condensedTargetTokens: 900,
    maxExpandTokens: 4000,
    largeFileTokenThreshold: 25_000,
    summaryProvider: "",
    summaryModel: "",
    largeFileSummaryProvider: "",
    largeFileSummaryModel: "",
    timezone: "UTC",
    pruneHeartbeatOk: false,
    transcriptGcEnabled: false,
    enableSummaryThinking: true,
    proactiveThresholdCompactionMode: "deferred",
    autoRotateSessionFiles: {
      enabled: true,
      createBackups: false,
      sizeBytes: 2 * 1024 * 1024,
      startup: "rotate",
      runtime: "rotate",
    },
    independentLogFile: {
      enabled: false,
      maxFileBytes: 100 * 1024 * 1024,
    },
    summaryMaxOverageFactor: 3,
    customInstructions: "",
    expansionProvider: "",
    expansionModel: "",
    delegationTimeoutMs: 120_000,
    summaryTimeoutMs: 60_000,
    circuitBreakerThreshold: 5,
    circuitBreakerCooldownMs: 1_800_000,
    fallbackProviders: [],
    cacheAwareCompaction: {
      enabled: true,
      cacheTTLSeconds: 300,
      maxColdCacheCatchupPasses: 2,
      hotCachePressureFactor: 4,
      hotCacheBudgetHeadroomRatio: 0.2,
      coldCacheObservationThreshold: 3,
      criticalBudgetPressureRatio: 0.90,
    },
    dynamicLeafChunkTokens: {
      enabled: true,
      max: 40_000,
    },
    stripInjectedContextTags: [],
    replayFloodThresholdExternal: 3,
    replayFloodThresholdInternal: 32,
  };
}

function createTestDeps(config: LcmConfig): LcmDependencies {
  return {
    config,
    complete: vi.fn(async () => ({
      content: [{ type: "text", text: "summary output" }],
    })),
    callGateway: vi.fn(async () => ({})),
    resolveModel: vi.fn(() => ({ provider: "anthropic", model: "claude-opus-4-5" })),
    parseAgentSessionKey: (key: string) => {
      const trimmed = key.trim();
      if (!trimmed.startsWith("agent:")) return null;
      const parts = trimmed.split(":");
      if (parts.length < 3) return null;
      return { agentId: parts[1] ?? "main", suffix: parts.slice(2).join(":") };
    },
    isSubagentSessionKey: (key: string) => key.includes(":subagent:"),
    normalizeAgentId: (id?: string) => (id?.trim() ? id : "main"),
    buildSubagentSystemPrompt: () => "subagent prompt",
    readLatestAssistantReply: () => undefined,
    resolveAgentDir: () => process.env.HOME ?? tmpdir(),
    resolveSessionIdFromSessionKey: async () => undefined,
    resolveSessionTranscriptFile: async () => undefined,
    agentLaneSubagent: "subagent",
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

function createEngine(): LcmContextEngine {
  const tempDir = createTempDir("lcm-entry-id-");
  const config = createTestConfig(join(tempDir, "lcm.db"));
  const db = createLcmDatabaseConnection(config.databasePath);
  return new LcmContextEngine(createTestDeps(config), db);
}

function createSessionFilePath(name: string): string {
  return join(createTempDir("lcm-entry-id-session-"), `${name}.jsonl`);
}

function appendSessionMessage(manager: SessionManager, message: AgentMessage): string {
  return manager.appendMessage(
    message as unknown as Parameters<SessionManager["appendMessage"]>[0],
  );
}

describe("transcript entry metadata parsing", () => {
  it("attaches envelope id/parentId/timestamp to parsed messages", () => {
    const raw = [
      JSON.stringify({
        type: "message",
        id: "entry-1",
        parentId: null,
        timestamp: "2026-06-10T00:00:00.000Z",
        message: { role: "user", content: "hello" },
      }),
      JSON.stringify({
        type: "message",
        id: "entry-2",
        parentId: "entry-1",
        timestamp: "2026-06-10T00:00:01.000Z",
        message: { role: "assistant", content: "world" },
      }),
    ].join("\n");

    const parsed = parseBootstrapJsonl(raw);
    expect(parsed.messages).toHaveLength(2);
    expect(getTranscriptEntryId(parsed.messages[0]!)).toBe("entry-1");
    expect(getTranscriptEntryMeta(parsed.messages[1]!)).toEqual({
      entryId: "entry-2",
      parentId: "entry-1",
      timestamp: "2026-06-10T00:00:01.000Z",
    });
  });

  it("supports uuid/parentUuid envelope field names", () => {
    const raw = JSON.stringify({
      type: "message",
      uuid: "u-1",
      parentUuid: "u-0",
      message: { role: "user", content: "hi" },
    });
    const parsed = parseBootstrapJsonl(raw);
    expect(parsed.messages).toHaveLength(1);
    expect(getTranscriptEntryMeta(parsed.messages[0]!)).toEqual({
      entryId: "u-1",
      parentId: "u-0",
      timestamp: null,
    });
  });

  it("leaves bare messages and id-less envelopes without entry ids", () => {
    const raw = [
      JSON.stringify({ role: "user", content: "bare" }),
      JSON.stringify({ message: { role: "assistant", content: "enveloped, no id" } }),
    ].join("\n");
    const parsed = parseBootstrapJsonl(raw);
    expect(parsed.messages).toHaveLength(2);
    expect(getTranscriptEntryId(parsed.messages[0]!)).toBeNull();
    expect(getTranscriptEntryId(parsed.messages[1]!)).toBeNull();
  });

  it("keeps metadata invisible to JSON serialization but preserves it across spread", () => {
    const raw = JSON.stringify({
      type: "message",
      id: "entry-7",
      message: { role: "user", content: "hello" },
    });
    const message = parseBootstrapJsonl(raw).messages[0]!;
    expect(JSON.stringify(message)).not.toContain("entry-7");
    const spread = { ...message } as AgentMessage;
    expect(getTranscriptEntryId(spread)).toBe("entry-7");
  });

  it("reads entry ids from SessionManager-written transcripts", async () => {
    const sessionFile = createSessionFilePath("session-manager-ids");
    const manager = SessionManager.open(sessionFile);
    appendSessionMessage(manager, {
      role: "user",
      content: [{ type: "text", text: "question" }],
    } as AgentMessage);
    appendSessionMessage(manager, {
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
    } as AgentMessage);

    const messages = await readLeafPathMessages(sessionFile);
    expect(messages).toHaveLength(2);
    expect(getTranscriptEntryId(messages[0]!)).toBeTruthy();
    expect(getTranscriptEntryId(messages[1]!)).toBeTruthy();
    expect(getTranscriptEntryId(messages[0]!)).not.toBe(getTranscriptEntryId(messages[1]!));
  });
});

describe("messages.transcript_entry_id schema", () => {
  it("creates the column and a partial unique index, enforced on duplicates", () => {
    const tempDir = createTempDir("lcm-entry-id-schema-");
    const config = createTestConfig(join(tempDir, "lcm.db"));
    const db = createLcmDatabaseConnection(config.databasePath);
    const engine = new LcmContextEngine(createTestDeps(config), db);
    // Force migrations.
    void engine;
    (engine as unknown as { ensureMigrated: () => void }).ensureMigrated();

    const columns = db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name?: string }>;
    expect(columns.some((col) => col.name === "transcript_entry_id")).toBe(true);

    db.prepare(
      `INSERT INTO conversations (session_id, created_at, updated_at)
       VALUES ('schema-session', datetime('now'), datetime('now'))`,
    ).run();
    const insert = db.prepare(
      `INSERT INTO messages (conversation_id, seq, role, content, token_count, transcript_entry_id)
       VALUES (1, ?, 'user', ?, 1, ?)`,
    );
    insert.run(1, "first", "dup-entry");
    expect(() => insert.run(2, "second copy of same entry", "dup-entry")).toThrow(/UNIQUE|unique/);
    // NULL entry ids stay exempt from the uniqueness constraint.
    insert.run(3, "legacy row", null);
    insert.run(4, "legacy row", null);
    closeLcmConnection(db);
  });
});

describe("entry-id idempotent ingest", () => {
  it("skips re-ingesting a message whose transcript entry id is already persisted", async () => {
    const engine = createEngine();
    const sessionId = "entry-id-ingest";
    const raw = JSON.stringify({
      type: "message",
      id: "stable-entry",
      message: { role: "user", content: "only once" },
    });

    const first = await engine.ingest({
      sessionId,
      message: parseBootstrapJsonl(raw).messages[0]!,
    });
    expect(first.ingested).toBe(true);

    // Re-parse to get a distinct object with the same entry id (a replayed
    // transcript line), and confirm it cannot duplicate the row.
    const second = await engine.ingest({
      sessionId,
      message: parseBootstrapJsonl(raw).messages[0]!,
    });
    expect(second.ingested).toBe(false);

    const conversation = await engine
      .getConversationStore()
      .getConversationForSession({ sessionId });
    expect(conversation).not.toBeNull();
    const messages = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(messages).toHaveLength(1);
  });

  it("still ingests identical content when it arrives under a new entry id", async () => {
    const engine = createEngine();
    const sessionId = "entry-id-distinct";
    const makeRaw = (id: string) =>
      JSON.stringify({
        type: "message",
        id,
        message: { role: "assistant", content: "" },
      });

    const first = await engine.ingest({
      sessionId,
      message: parseBootstrapJsonl(makeRaw("entry-a")).messages[0]!,
    });
    const second = await engine.ingest({
      sessionId,
      message: parseBootstrapJsonl(makeRaw("entry-b")).messages[0]!,
    });
    expect(first.ingested).toBe(true);
    expect(second.ingested).toBe(true);
  });

  it("stamps transcript_entry_id on rows imported from a transcript bootstrap", async () => {
    const sessionFile = createSessionFilePath("bootstrap-stamps-ids");
    const manager = SessionManager.open(sessionFile);
    for (let index = 0; index < 4; index += 1) {
      appendSessionMessage(manager, {
        role: index % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `turn ${index}` }],
      } as AgentMessage);
    }

    const engine = createEngine();
    const sessionId = "bootstrap-stamps-ids";
    const result = await engine.bootstrap({ sessionId, sessionFile });
    expect(result.importedMessages).toBe(4);

    const conversation = await engine
      .getConversationStore()
      .getConversationForSession({ sessionId });
    const config = (engine as unknown as { config: LcmConfig }).config;
    const db = createLcmDatabaseConnection(config.databasePath);
    try {
      const rows = db
        .prepare(
          `SELECT transcript_entry_id FROM messages WHERE conversation_id = ? ORDER BY seq`,
        )
        .all(conversation!.conversationId) as Array<{ transcript_entry_id: string | null }>;
      expect(rows).toHaveLength(4);
      for (const row of rows) {
        expect(row.transcript_entry_id).toBeTruthy();
      }
      expect(new Set(rows.map((row) => row.transcript_entry_id)).size).toBe(4);
    } finally {
      closeLcmConnection(db);
    }
  });

  it("re-running reconciliation over the same transcript imports nothing", async () => {
    const sessionFile = createSessionFilePath("reconcile-idempotent");
    const manager = SessionManager.open(sessionFile);
    for (let index = 0; index < 6; index += 1) {
      appendSessionMessage(manager, {
        role: index % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `turn ${index}` }],
      } as AgentMessage);
    }

    const engine = createEngine();
    const sessionId = "reconcile-idempotent";
    await engine.bootstrap({ sessionId, sessionFile });

    const conversation = await engine
      .getConversationStore()
      .getConversationForSession({ sessionId });
    const conversationId = conversation!.conversationId;
    const countBefore = await engine.getConversationStore().getMessageCount(conversationId);

    // Drop the bootstrap checkpoint to force the slow-path full re-read on
    // the next afterTurn, simulating checkpoint loss / crash recovery.
    const config = (engine as unknown as { config: LcmConfig }).config;
    const db = createLcmDatabaseConnection(config.databasePath);
    try {
      db.prepare(`DELETE FROM conversation_bootstrap_state WHERE conversation_id = ?`).run(
        conversationId,
      );
    } finally {
      closeLcmConnection(db);
    }

    await engine.afterTurn({
      sessionId,
      sessionFile,
      messages: [],
      prePromptMessageCount: 0,
    });

    const countAfter = await engine.getConversationStore().getMessageCount(conversationId);
    expect(countAfter).toBe(countBefore);
  });
});
