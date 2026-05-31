import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextAssembler } from "../src/assembler.js";
import type { LcmConfig } from "../src/db/config.js";
import { closeLcmConnection, createLcmDatabaseConnection } from "../src/db/connection.js";
import { LcmContextEngine } from "../src/engine.js";
import { estimateTokens } from "../src/estimate-tokens.js";
import {
  createDelegatedExpansionGrant,
  getRuntimeExpansionAuthManager,
  resetDelegatedExpansionGrantsForTests,
  resolveDelegatedExpansionGrantId,
} from "../src/expansion-auth.js";
import { RetrievalEngine } from "../src/retrieval.js";
import type { LcmDependencies } from "../src/types.js";

const tempDirs: string[] = [];

function createTestConfig(databasePath: string): LcmConfig {
  const tempDir = join(databasePath, "..", "lcm-files");
  return {
    enabled: true,
    databasePath,
    largeFilesDir: tempDir,
    ignoreSessionPatterns: [],
    statelessSessionPatterns: [],
    skipStatelessSessions: true,
    contextThreshold: 0.75,
    freshTailCount: 8,
    newSessionRetainDepth: 2,
    leafMinFanout: 8,
    condensedMinFanout: 4,
    condensedMinFanoutHard: 2,
    incrementalMaxDepth: 0,
    leafChunkTokens: 20_000,
    leafTargetTokens: 600,
    condensedTargetTokens: 900,
    maxExpandTokens: 4000,
    largeFileTokenThreshold: 25_000,
    summaryProvider: "",
    summaryModel: "",
    largeFileSummaryProvider: "",
    largeFileSummaryModel: "",
    expansionProvider: "",
    expansionModel: "",
    delegationTimeoutMs: 120_000,
    summaryTimeoutMs: 60_000,
    timezone: "UTC",
    pruneHeartbeatOk: false,
    transcriptGcEnabled: false,
    proactiveThresholdCompactionMode: "deferred",
    autoRotateSessionFiles: {
      enabled: true,
      createBackups: false,
      sizeBytes: 2 * 1024 * 1024,
      startup: "rotate",
      runtime: "rotate",
    },
    summaryMaxOverageFactor: 3,
    customInstructions: "",
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
  };
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
  return {
    agentId: parts[1] ?? "main",
    suffix: parts.slice(2).join(":"),
  };
}

function createTestDeps(
  config: LcmConfig,
  overrides?: Partial<LcmDependencies>,
): LcmDependencies {
  return {
    config,
    complete: vi.fn(async () => ({
      content: [{ type: "text", text: "summary output" }],
    })),
    callGateway: vi.fn(async () => ({})),
    resolveModel: vi.fn(() => ({ provider: "anthropic", model: "claude-opus-4-5" })),
    parseAgentSessionKey,
    isSubagentSessionKey: (sessionKey: string) => sessionKey.includes(":subagent:"),
    normalizeAgentId: (id?: string) => (id?.trim() ? id : "main"),
    buildSubagentSystemPrompt: () => "subagent prompt",
    readLatestAssistantReply: (messages: unknown[]) => {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i] as { role?: unknown; content?: unknown };
        if (message.role !== "assistant") {
          continue;
        }
        if (typeof message.content === "string") {
          return message.content;
        }
      }
      return undefined;
    },
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
    ...overrides,
  };
}

function createEngine(): LcmContextEngine {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
  tempDirs.push(tempDir);
  const config = createTestConfig(join(tempDir, "lcm.db"));
  const db = createLcmDatabaseConnection(config.databasePath);
  return new LcmContextEngine(createTestDeps(config), db);
}

function createEngineWithDepsOverrides(overrides: Partial<LcmDependencies>): LcmContextEngine {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
  tempDirs.push(tempDir);
  const config = createTestConfig(join(tempDir, "lcm.db"));
  const db = createLcmDatabaseConnection(config.databasePath);
  return new LcmContextEngine(
    {
      ...createTestDeps(config),
      ...overrides,
    },
    db,
  );
}

function createEngineAtDatabasePath(databasePath: string): LcmContextEngine {
  const config = createTestConfig(databasePath);
  const db = createLcmDatabaseConnection(config.databasePath);
  return new LcmContextEngine(createTestDeps(config), db);
}

function createSessionFilePath(name: string): string {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-session-"));
  tempDirs.push(tempDir);
  return join(tempDir, `${name}.jsonl`);
}

function writeLeafTranscript(
  sessionFile: string,
  entries: Array<{ role: AgentMessage["role"]; content: string }>,
): void {
  writeFileSync(
    sessionFile,
    entries
      .map((entry) =>
        JSON.stringify({
          message: {
            role: entry.role,
            content: [{ type: "text", text: entry.content }],
          },
        }),
      )
      .join("\n") + "\n",
    "utf8",
  );
}

function writeLeafTranscriptMessages(sessionFile: string, messages: AgentMessage[]): void {
  writeFileSync(
    sessionFile,
    messages.map((message) => JSON.stringify({ message })).join("\n") + "\n",
    "utf8",
  );
}

function createEngineWithConfig(overrides: Partial<LcmConfig>): LcmContextEngine {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
  tempDirs.push(tempDir);
  const config = {
    ...createTestConfig(join(tempDir, "lcm.db")),
    ...overrides,
  };
  const db = createLcmDatabaseConnection(config.databasePath);
  return new LcmContextEngine(createTestDeps(config), db);
}

function createEngineWithDeps(
  configOverrides: Partial<LcmConfig>,
  depOverrides?: Partial<LcmDependencies>,
): LcmContextEngine {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
  tempDirs.push(tempDir);
  const config = {
    ...createTestConfig(join(tempDir, "lcm.db")),
    ...configOverrides,
  };
  const db = createLcmDatabaseConnection(config.databasePath);
  return new LcmContextEngine(createTestDeps(config, depOverrides), db);
}

async function withTempHome<T>(run: (homeDir: string) => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  const tempHome = mkdtempSync(join(tmpdir(), "lossless-claw-home-"));
  tempDirs.push(tempHome);
  process.env.HOME = tempHome;

  try {
    return await run(tempHome);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
}

function makeMessage(params: { role?: string; content: unknown }): AgentMessage {
  return {
    role: (params.role ?? "assistant") as AgentMessage["role"],
    content: params.content,
    timestamp: Date.now(),
  } as AgentMessage;
}

async function seedBacklogContext(
  engine: LcmContextEngine,
  sessionId: string,
  tokenCounts: number[],
): Promise<void> {
  const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
    sessionKey: undefined,
  });
  const messages = await engine.getConversationStore().createMessagesBulk(
    tokenCounts.map((tokenCount, index) => ({
      conversationId: conversation.conversationId,
      seq: index,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `backlog turn ${index}`,
      tokenCount,
      skipReplayTimestampFloodGuard: true,
    })),
  );
  await engine
    .getSummaryStore()
    .appendContextMessages(conversation.conversationId, messages.map((message) => message.messageId));
}

function readSessionMessages(sessionFile: string): AgentMessage[] {
  return SessionManager.open(sessionFile)
    .getBranch()
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message as AgentMessage);
}

function createBulkySession(sessionFile: string, messageCount: number): AgentMessage[] {
  const sm = SessionManager.open(sessionFile);
  const messages: AgentMessage[] = [];
  for (let index = 0; index < messageCount; index += 1) {
    const message = makeMessage({
      role: index % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `auto rotate payload ${index} ${"x".repeat(160)}` }],
    });
    sm.appendMessage(message);
    messages.push(message);
  }
  return messages;
}

async function flushImmediate(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function corruptSessionFilePreservingObservedStats(sessionFile: string): void {
  const originalStats = statSync(sessionFile);
  writeFileSync(sessionFile, "x".repeat(originalStats.size));
  const restoredMtime = new Date(originalStats.mtimeMs);
  utimesSync(sessionFile, restoredMtime, restoredMtime);
}

function estimateAssembledPayloadTokens(messages: AgentMessage[]): number {
  let total = 0;
  for (const message of messages) {
    if ("content" in message) {
      if (typeof message.content === "string") {
        total += Math.ceil(message.content.length / 4);
        continue;
      }
      const serialized = JSON.stringify(message.content);
      total += Math.ceil((typeof serialized === "string" ? serialized : "").length / 4);
    }
  }
  return total;
}

async function ingestAndReadStoredContent(params: {
  engine: LcmContextEngine;
  sessionId: string;
  message: AgentMessage;
}): Promise<string> {
  await params.engine.ingest({
    sessionId: params.sessionId,
    message: params.message,
  });

  const conversation = await params.engine
    .getConversationStore()
    .getConversationBySessionId(params.sessionId);
  expect(conversation).not.toBeNull();

  const messages = await params.engine
    .getConversationStore()
    .getMessages(conversation!.conversationId);
  expect(messages).toHaveLength(1);

  return messages[0].content;
}

afterEach(() => {
  vi.restoreAllMocks();
  closeLcmConnection();
  resetDelegatedExpansionGrantsForTests();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("LcmContextEngine metadata", () => {
  it("reports the registered lossless-claw engine id", () => {
    const engine = createEngine();
    expect(engine.info.id).toBe("lossless-claw");
  });

  it("advertises ownsCompaction capability", () => {
    const engine = createEngine();
    expect(engine.info.ownsCompaction).toBe(true);
  });

  it("requires the full native host lifecycle for agent runs", () => {
    const engine = createEngine();
    expect(engine.info.hostRequirements?.["agent-run"]).toEqual({
      requiredCapabilities: [
        "bootstrap",
        "assemble-before-prompt",
        "after-turn",
        "maintain",
        "compact",
        "runtime-llm-complete",
      ],
      unsupportedMessage: expect.stringContaining("native Codex or Pi embedded runtime"),
    });
  });

  it("configures file-backed sqlite connections with WAL and busy_timeout", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-db-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "pragmas.db");
    const db = createLcmDatabaseConnection(dbPath);

    const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string };
    const busy = db.prepare("PRAGMA busy_timeout").get() as { timeout?: number };

    expect(journal.journal_mode).toBe("wal");
    expect(busy.timeout).toBe(30000);
  });
});

describe("LcmContextEngine ignored sessions", () => {
  const ignoredSessionId = "runtime-ignored-session";
  const ignoredSessionKey = "agent:main:cron:nightly:run:run-123";
  const includedSessionId = "runtime-included-session";
  const includedSessionKey = "agent:main:main";

  it("skips bootstrap for ignored sessions while bootstrapping included sessions", async () => {
    const sessionFile = createSessionFilePath("ignored-bootstrap");
    const sm = SessionManager.open(sessionFile);
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "bootstrap me" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "bootstrap reply" }],
    } as AgentMessage);

    const engine = createEngineWithConfig({
      ignoreSessionPatterns: ["agent:*:cron:**"],
    });

    const ignored = await engine.bootstrap({
      sessionId: ignoredSessionId,
      sessionKey: ignoredSessionKey,
      sessionFile,
    });
    const included = await engine.bootstrap({
      sessionId: includedSessionId,
      sessionKey: includedSessionKey,
      sessionFile,
    });

    expect(ignored).toEqual({
      bootstrapped: false,
      importedMessages: 0,
      reason: "session excluded by pattern",
    });
    expect(included.bootstrapped).toBe(true);
    expect(included.importedMessages).toBe(2);
    expect(
      await engine.getConversationStore().getConversationBySessionId(ignoredSessionId),
    ).toBeNull();
    expect(
      await engine.getConversationStore().getConversationBySessionId(includedSessionId),
    ).not.toBeNull();
  });

  it("skips ingest for ignored sessions while storing included sessions", async () => {
    const engine = createEngineWithConfig({
      ignoreSessionPatterns: ["agent:*:cron:**"],
    });

    const ignored = await engine.ingest({
      sessionId: ignoredSessionId,
      sessionKey: ignoredSessionKey,
      message: makeMessage({ role: "user", content: "drop me" }),
    });
    const included = await engine.ingest({
      sessionId: includedSessionId,
      sessionKey: includedSessionKey,
      message: makeMessage({ role: "user", content: "keep me" }),
    });

    expect(ignored).toEqual({ ingested: false });
    expect(included).toEqual({ ingested: true });
    expect(
      await engine.getConversationStore().getConversationBySessionId(ignoredSessionId),
    ).toBeNull();
    expect(
      await engine.getConversationStore().getConversationBySessionId(includedSessionId),
    ).not.toBeNull();
  });

  it("skips ingestBatch for ignored sessions while storing included sessions", async () => {
    const engine = createEngineWithConfig({
      ignoreSessionPatterns: ["agent:*:cron:**"],
    });

    const ignored = await engine.ingestBatch({
      sessionId: ignoredSessionId,
      sessionKey: ignoredSessionKey,
      messages: [
        makeMessage({ role: "user", content: "drop batch user" }),
        makeMessage({ role: "assistant", content: "drop batch assistant" }),
      ],
    });
    const included = await engine.ingestBatch({
      sessionId: includedSessionId,
      sessionKey: includedSessionKey,
      messages: [
        makeMessage({ role: "user", content: "keep batch user" }),
        makeMessage({ role: "assistant", content: "keep batch assistant" }),
      ],
    });

    expect(ignored).toEqual({ ingestedCount: 0 });
    expect(included).toEqual({ ingestedCount: 2 });
    expect(
      await engine.getConversationStore().getConversationBySessionId(ignoredSessionId),
    ).toBeNull();

    const includedConversation = await engine
      .getConversationStore()
      .getConversationBySessionId(includedSessionId);
    expect(includedConversation).not.toBeNull();
    expect(
      await engine.getConversationStore().getMessageCount(includedConversation!.conversationId),
    ).toBe(2);
  });

  it("skips afterTurn for ignored sessions while persisting included sessions", async () => {
    const engine = createEngineWithConfig({
      ignoreSessionPatterns: ["agent:*:cron:**"],
    });

    await engine.afterTurn({
      sessionId: ignoredSessionId,
      sessionKey: ignoredSessionKey,
      sessionFile: createSessionFilePath("ignored-after-turn"),
      messages: [makeMessage({ role: "assistant", content: "ignored turn" })],
      prePromptMessageCount: 0,
    });
    await engine.afterTurn({
      sessionId: includedSessionId,
      sessionKey: includedSessionKey,
      sessionFile: createSessionFilePath("included-after-turn"),
      messages: [makeMessage({ role: "assistant", content: "included turn" })],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    expect(
      await engine.getConversationStore().getConversationBySessionId(ignoredSessionId),
    ).toBeNull();

    const includedConversation = await engine
      .getConversationStore()
      .getConversationBySessionId(includedSessionId);
    expect(includedConversation).not.toBeNull();

    const stored = await engine.getConversationStore().getMessages(
      includedConversation!.conversationId,
    );
    expect(stored.map((message) => message.content)).toEqual(["included turn"]);
  });

  it("passes through assemble for ignored sessions while assembling included sessions from LCM", async () => {
    const engine = createEngineWithConfig({
      ignoreSessionPatterns: ["agent:*:cron:**"],
    });

    await engine.ingest({
      sessionId: includedSessionId,
      sessionKey: includedSessionKey,
      message: makeMessage({ role: "user", content: "persisted context" }),
    });

    const liveMessages = [makeMessage({ role: "user", content: "live ignored turn" })];
    const ignored = await engine.assemble({
      sessionId: ignoredSessionId,
      sessionKey: ignoredSessionKey,
      messages: liveMessages,
      tokenBudget: 500,
    });
    const included = await engine.assemble({
      sessionId: includedSessionId,
      sessionKey: includedSessionKey,
      messages: [],
      tokenBudget: 500,
    });

    expect(ignored).toEqual({
      messages: liveMessages,
      estimatedTokens: 0,
    });
    expect(included.messages).toHaveLength(1);
    expect(included.messages[0]?.content).toBe("persisted context");
  });

  it("skips compact for ignored sessions while compact still evaluates included sessions", async () => {
    const engine = createEngineWithConfig({
      ignoreSessionPatterns: ["agent:*:cron:**"],
    });

    const ignored = await engine.compact({
      sessionId: ignoredSessionId,
      sessionKey: ignoredSessionKey,
      sessionFile: createSessionFilePath("ignored-compact"),
      tokenBudget: 1000,
    });

    await engine.ingest({
      sessionId: includedSessionId,
      sessionKey: includedSessionKey,
      message: makeMessage({ role: "user", content: "compact me maybe" }),
    });
    const included = await engine.compact({
      sessionId: includedSessionId,
      sessionKey: includedSessionKey,
      sessionFile: createSessionFilePath("included-compact"),
      tokenBudget: 1000,
    });

    expect(ignored).toEqual({
      ok: true,
      compacted: false,
      reason: "session excluded",
    });
    expect(included.ok).toBe(true);
    expect(included.reason).not.toBe("session excluded");
  });

  it("skips prepareSubagentSpawn for ignored sessions while creating grants for included sessions", async () => {
    const childSessionKey = "agent:main:subagent:worker-123";
    const includedParentSessionKey = "agent:main:main";
    const runtimeSessionId = "runtime-parent-session";
    const engine = createEngineWithDeps(
      { ignoreSessionPatterns: ["agent:*:cron:**"] },
      {
        resolveSessionIdFromSessionKey: vi.fn(async (sessionKey: string) =>
          sessionKey === includedParentSessionKey ? runtimeSessionId : undefined,
        ),
      },
    );

    await engine.ingest({
      sessionId: runtimeSessionId,
      message: makeMessage({ role: "user", content: "parent context" }),
    });

    const ignored = await engine.prepareSubagentSpawn({
      parentSessionKey: ignoredSessionId,
      childSessionKey,
    });
    const included = await engine.prepareSubagentSpawn({
      parentSessionKey: includedParentSessionKey,
      childSessionKey,
    });

    expect(ignored).toBeUndefined();
    expect(included).toBeDefined();
    expect(resolveDelegatedExpansionGrantId(childSessionKey)).not.toBeNull();

    included?.rollback();
    expect(resolveDelegatedExpansionGrantId(childSessionKey)).toBeNull();
  });

  it("skips onSubagentEnded for ignored sessions while cleaning up included child grants", async () => {
    const ignoredChildSessionKey = "agent:main:cron:child";
    const includedChildSessionKey = "agent:main:subagent:child";
    createDelegatedExpansionGrant({
      delegatedSessionKey: ignoredChildSessionKey,
      issuerSessionId: "issuer-1",
      allowedConversationIds: [1],
    });
    createDelegatedExpansionGrant({
      delegatedSessionKey: includedChildSessionKey,
      issuerSessionId: "issuer-2",
      allowedConversationIds: [2],
    });

    const engine = createEngineWithConfig({
      ignoreSessionPatterns: ["agent:*:cron:**"],
    });

    await engine.onSubagentEnded({
      childSessionKey: ignoredChildSessionKey,
      reason: "deleted",
    });
    await engine.onSubagentEnded({
      childSessionKey: includedChildSessionKey,
      reason: "deleted",
    });

    expect(resolveDelegatedExpansionGrantId(ignoredChildSessionKey)).not.toBeNull();
    expect(resolveDelegatedExpansionGrantId(includedChildSessionKey)).toBeNull();
    expect(
      getRuntimeExpansionAuthManager().getGrant(
        resolveDelegatedExpansionGrantId(ignoredChildSessionKey)!,
      ),
    ).not.toBeNull();
  });
});

describe("LcmContextEngine stateless sessions", () => {
  const statelessSessionKey = "agent:main:subagent:worker-preview";
  const statefulSessionKey = "agent:main:main";
  const runtimeSessionId = "runtime-stateless-session";
  const statefulRuntimeSessionId = "runtime-stateful-session";

  it("matches stateless patterns on sessionKey and can be disabled globally", () => {
    const enabledEngine = createEngineWithConfig({
      statelessSessionPatterns: ["agent:*:subagent:worker-*"],
    });
    const disabledEngine = createEngineWithConfig({
      statelessSessionPatterns: ["agent:*:subagent:worker-*"],
      skipStatelessSessions: false,
    });

    expect(enabledEngine.isStatelessSession(statelessSessionKey)).toBe(true);
    expect(enabledEngine.isStatelessSession(statefulSessionKey)).toBe(false);
    expect(disabledEngine.isStatelessSession(statelessSessionKey)).toBe(false);
  });

  it("skips bootstrap persistence for stateless session keys", async () => {
    const sessionFile = createSessionFilePath("stateless-bootstrap");
    const sm = SessionManager.open(sessionFile);
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "bootstrap me" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "bootstrap reply" }],
    } as AgentMessage);

    const engine = createEngineWithConfig({
      statelessSessionPatterns: ["agent:*:subagent:worker-*"],
    });

    const stateless = await engine.bootstrap({
      sessionId: runtimeSessionId,
      sessionKey: statelessSessionKey,
      sessionFile,
    });

    const stateful = await engine.bootstrap({
      sessionId: statefulRuntimeSessionId,
      sessionKey: statefulSessionKey,
      sessionFile,
    });

    expect(stateless).toEqual({
      bootstrapped: false,
      importedMessages: 0,
      reason: "stateless session",
    });
    expect(
      await engine.getConversationStore().getConversationBySessionId(runtimeSessionId),
    ).toBeNull();
    expect(stateful.bootstrapped).toBe(true);
    expect(stateful.importedMessages).toBe(2);
  });

  it("skips ingest and ingestBatch writes for stateless session keys", async () => {
    const engine = createEngineWithConfig({
      statelessSessionPatterns: ["agent:*:subagent:worker-*"],
    });

    const ingested = await engine.ingest({
      sessionId: runtimeSessionId,
      sessionKey: statelessSessionKey,
      message: makeMessage({ role: "user", content: "drop me" }),
    });
    const batched = await engine.ingestBatch({
      sessionId: runtimeSessionId,
      sessionKey: statelessSessionKey,
      messages: [
        makeMessage({ role: "user", content: "drop batch user" }),
        makeMessage({ role: "assistant", content: "drop batch assistant" }),
      ],
    });
    const included = await engine.ingest({
      sessionId: runtimeSessionId,
      sessionKey: statefulSessionKey,
      message: makeMessage({ role: "user", content: "keep me" }),
    });

    expect(ingested).toEqual({ ingested: false });
    expect(batched).toEqual({ ingestedCount: 0 });
    expect(included).toEqual({ ingested: true });

    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(runtimeSessionId);
    expect(conversation).not.toBeNull();
    expect(
      await engine.getConversationStore().getMessageCount(conversation!.conversationId),
    ).toBe(1);
  });

  it("skips ingest for assistant messages with error/aborted stop reasons and empty content", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const sessionKey = "agent:poppy:main";

    // Ingest a normal user message first
    const userResult = await engine.ingest({
      sessionId,
      sessionKey,
      message: makeMessage({ role: "user", content: "ping" }),
    });
    expect(userResult).toEqual({ ingested: true });

    // Ingest an error assistant message with empty content array
    const errorResult = await engine.ingest({
      sessionId,
      sessionKey,
      message: {
        role: "assistant" as AgentMessage["role"],
        content: [],
        stopReason: "error",
        timestamp: Date.now(),
      } as AgentMessage,
    });
    expect(errorResult).toEqual({ ingested: false });

    // Ingest an error assistant message with empty string content
    const errorResult2 = await engine.ingest({
      sessionId,
      sessionKey,
      message: {
        role: "assistant" as AgentMessage["role"],
        content: "",
        stopReason: "error",
        timestamp: Date.now(),
      } as AgentMessage,
    });
    expect(errorResult2).toEqual({ ingested: false });

    // Ingest an error assistant message using snake_case stop_reason
    const errorResult3 = await engine.ingest({
      sessionId,
      sessionKey,
      message: {
        role: "assistant" as AgentMessage["role"],
        content: [],
        stop_reason: "error",
        timestamp: Date.now(),
      } as AgentMessage,
    });
    expect(errorResult3).toEqual({ ingested: false });

    // Ingest an aborted assistant message with no content
    const abortedResult = await engine.ingest({
      sessionId,
      sessionKey,
      message: {
        role: "assistant" as AgentMessage["role"],
        content: [],
        stopReason: "aborted",
        timestamp: Date.now(),
      } as AgentMessage,
    });
    expect(abortedResult).toEqual({ ingested: false });

    // A normal assistant message should still be ingested
    const normalResult = await engine.ingest({
      sessionId,
      sessionKey,
      message: makeMessage({ role: "assistant", content: "pong" }),
    });
    expect(normalResult).toEqual({ ingested: true });

    // An error assistant with actual content should still be ingested
    const errorWithContentResult = await engine.ingest({
      sessionId,
      sessionKey,
      message: {
        role: "assistant" as AgentMessage["role"],
        content: [{ type: "text", text: "Partial response before error" }],
        stopReason: "error",
        timestamp: Date.now(),
      } as AgentMessage,
    });
    expect(errorWithContentResult).toEqual({ ingested: true });

    // Verify only the 3 valid messages were stored despite rejected empty error turns.
    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    expect(
      await engine.getConversationStore().getMessageCount(conversation!.conversationId),
    ).toBe(3);
  });

  it("allows assemble reads for stateless session keys", async () => {
    const engine = createEngineWithConfig({
      statelessSessionPatterns: ["agent:*:subagent:worker-*"],
    });

    await engine.ingest({
      sessionId: runtimeSessionId,
      sessionKey: statefulSessionKey,
      message: makeMessage({ role: "user", content: "persisted context" }),
    });

    const assembled = await engine.assemble({
      sessionId: runtimeSessionId,
      sessionKey: statelessSessionKey,
      messages: [],
      tokenBudget: 500,
    });

    expect(assembled.messages).toHaveLength(1);
    expect(assembled.messages[0]?.content).toBe("persisted context");
  });

  it("skips afterTurn and compact writes for stateless session keys", async () => {
    const engine = createEngineWithConfig({
      statelessSessionPatterns: ["agent:*:subagent:worker-*"],
    });

    await engine.afterTurn({
      sessionId: runtimeSessionId,
      sessionKey: statelessSessionKey,
      sessionFile: createSessionFilePath("stateless-after-turn"),
      messages: [makeMessage({ role: "assistant", content: "ignored turn" })],
      prePromptMessageCount: 0,
      tokenBudget: 1000,
    });

    await engine.ingest({
      sessionId: runtimeSessionId,
      sessionKey: statefulSessionKey,
      message: makeMessage({ role: "user", content: "persisted context" }),
    });

    const compactResult = await engine.compact({
      sessionId: runtimeSessionId,
      sessionKey: statelessSessionKey,
      sessionFile: createSessionFilePath("stateless-compact"),
      tokenBudget: 1000,
    });

    expect(compactResult).toEqual({
      ok: true,
      compacted: false,
      reason: "stateless session",
    });

    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(runtimeSessionId);
    expect(conversation).not.toBeNull();
    expect(
      await engine.getConversationStore().getMessageCount(conversation!.conversationId),
    ).toBe(1);
  });

  it("skips delegated grant writes for stateless session keys", async () => {
    const childSessionKey = "agent:main:subagent:child-456";
    const engine = createEngineWithDeps(
      { statelessSessionPatterns: ["agent:*:subagent:worker-*"] },
      {
        resolveSessionIdFromSessionKey: vi.fn(async (sessionKey: string) =>
          sessionKey === statefulSessionKey ? runtimeSessionId : undefined,
        ),
      },
    );

    await engine.ingest({
      sessionId: runtimeSessionId,
      sessionKey: statefulSessionKey,
      message: makeMessage({ role: "user", content: "parent context" }),
    });

    const skipped = await engine.prepareSubagentSpawn({
      parentSessionKey: statelessSessionKey,
      childSessionKey,
    });
    const included = await engine.prepareSubagentSpawn({
      parentSessionKey: statefulSessionKey,
      childSessionKey,
    });

    expect(skipped).toBeUndefined();
    expect(resolveDelegatedExpansionGrantId(childSessionKey)).not.toBeNull();

    included?.rollback();
    expect(resolveDelegatedExpansionGrantId(childSessionKey)).toBeNull();
  });

  it("skips subagent cleanup for stateless child session keys", async () => {
    const childSessionKey = statelessSessionKey;
    createDelegatedExpansionGrant({
      delegatedSessionKey: childSessionKey,
      issuerSessionId: "issuer-1",
      allowedConversationIds: [1],
    });

    const engine = createEngineWithConfig({
      statelessSessionPatterns: ["agent:*:subagent:worker-*"],
    });

    await engine.onSubagentEnded({
      childSessionKey,
      reason: "deleted",
    });

    expect(resolveDelegatedExpansionGrantId(childSessionKey)).not.toBeNull();
  });
});

describe("ConversationStore session reuse", () => {
  it("reuses conversation across session resets when sessionKey matches", async () => {
    const engine = createEngine();
    (engine as unknown as { ensureMigrated(): void }).ensureMigrated();
    const store = engine.getConversationStore();

    const conv1 = await store.getOrCreateConversation("uuid-1", { sessionKey: "agent:main:main" });
    const conv2 = await store.getOrCreateConversation("uuid-2", { sessionKey: "agent:main:main" });

    expect(conv2.conversationId).toBe(conv1.conversationId);

    const refreshed = await store.getConversation(conv1.conversationId);
    expect(refreshed?.sessionId).toBe("uuid-2");
  });
});

describe("LcmContextEngine before_reset lifecycle", () => {
  it("prunes fresh-tail messages and low-depth summaries on /new", async () => {
    const engine = createEngineWithConfig({ newSessionRetainDepth: 2 });
    (engine as unknown as { ensureMigrated(): void }).ensureMigrated();
    const conversationStore = engine.getConversationStore();
    const summaryStore = engine.getSummaryStore();

    const conversation = await conversationStore.getOrCreateConversation("uuid-1", {
      sessionKey: "agent:main:main",
    });

    const firstMessage = await conversationStore.createMessage({
      conversationId: conversation.conversationId,
      seq: 1,
      role: "user",
      content: "first",
      tokenCount: 5,
    });
    const secondMessage = await conversationStore.createMessage({
      conversationId: conversation.conversationId,
      seq: 2,
      role: "assistant",
      content: "second",
      tokenCount: 5,
    });
    await summaryStore.appendContextMessages(conversation.conversationId, [
      firstMessage.messageId,
      secondMessage.messageId,
    ]);

    await summaryStore.insertSummary({
      summaryId: "sum_d0",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "leaf",
      tokenCount: 10,
    });
    await summaryStore.insertSummary({
      summaryId: "sum_d1",
      conversationId: conversation.conversationId,
      kind: "condensed",
      depth: 1,
      content: "session arc",
      tokenCount: 10,
    });
    await summaryStore.insertSummary({
      summaryId: "sum_d2",
      conversationId: conversation.conversationId,
      kind: "condensed",
      depth: 2,
      content: "project arc",
      tokenCount: 10,
    });
    await summaryStore.appendContextSummary(conversation.conversationId, "sum_d0");
    await summaryStore.appendContextSummary(conversation.conversationId, "sum_d1");
    await summaryStore.appendContextSummary(conversation.conversationId, "sum_d2");

    await engine.handleBeforeReset({
      reason: "new",
      sessionId: "uuid-2",
      sessionKey: "agent:main:main",
    });

    const remainingItems = await summaryStore.getContextItems(conversation.conversationId);
    expect(remainingItems).toHaveLength(1);
    expect(remainingItems[0]?.summaryId).toBe("sum_d2");
  });

  it("keeps all context items on /new when retain depth is -1", async () => {
    const engine = createEngineWithConfig({ newSessionRetainDepth: -1 });
    (engine as unknown as { ensureMigrated(): void }).ensureMigrated();
    const conversationStore = engine.getConversationStore();
    const summaryStore = engine.getSummaryStore();

    const conversation = await conversationStore.getOrCreateConversation("uuid-1", {
      sessionKey: "agent:main:main",
    });
    const message = await conversationStore.createMessage({
      conversationId: conversation.conversationId,
      seq: 1,
      role: "user",
      content: "first",
      tokenCount: 5,
    });
    await summaryStore.appendContextMessage(conversation.conversationId, message.messageId);
    await summaryStore.insertSummary({
      summaryId: "sum_keep",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "keep me",
      tokenCount: 10,
    });
    await summaryStore.appendContextSummary(conversation.conversationId, "sum_keep");

    await engine.handleBeforeReset({
      reason: "new",
      sessionId: "uuid-2",
      sessionKey: "agent:main:main",
    });

    const remainingItems = await summaryStore.getContextItems(conversation.conversationId);
    expect(remainingItems).toHaveLength(2);
    expect(remainingItems[0]?.messageId).toBe(message.messageId);
    expect(remainingItems[1]?.summaryId).toBe("sum_keep");
  });

  it("drops fresh-tail messages but keeps all summaries on /new when retain depth is 0", async () => {
    const engine = createEngineWithConfig({ newSessionRetainDepth: 0 });
    (engine as unknown as { ensureMigrated(): void }).ensureMigrated();
    const conversationStore = engine.getConversationStore();
    const summaryStore = engine.getSummaryStore();

    const conversation = await conversationStore.getOrCreateConversation("uuid-1", {
      sessionKey: "agent:main:main",
    });
    const message = await conversationStore.createMessage({
      conversationId: conversation.conversationId,
      seq: 1,
      role: "user",
      content: "first",
      tokenCount: 5,
    });
    await summaryStore.appendContextMessage(conversation.conversationId, message.messageId);
    await summaryStore.insertSummary({
      summaryId: "sum_keep",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "keep me",
      tokenCount: 10,
    });
    await summaryStore.appendContextSummary(conversation.conversationId, "sum_keep");

    await engine.handleBeforeReset({
      reason: "new",
      sessionId: "uuid-2",
      sessionKey: "agent:main:main",
    });

    const remainingItems = await summaryStore.getContextItems(conversation.conversationId);
    expect(remainingItems).toHaveLength(1);
    expect(remainingItems[0]?.summaryId).toBe("sum_keep");
  });

  it("archives the prior active conversation and creates a fresh active row on /reset", async () => {
    const engine = createEngine();
    (engine as unknown as { ensureMigrated(): void }).ensureMigrated();
    const store = engine.getConversationStore();

    const original = await store.getOrCreateConversation("uuid-1", {
      sessionKey: "agent:main:main",
    });
    await store.createMessage({
      conversationId: original.conversationId,
      seq: 1,
      role: "user",
      content: "seed",
      tokenCount: 5,
    });

    await engine.handleBeforeReset({
      reason: "reset",
      sessionId: "uuid-1",
      sessionKey: "agent:main:main",
    });

    const active = await store.getConversationBySessionKey("agent:main:main");
    const archived = await store.getConversation(original.conversationId);

    expect(active).not.toBeNull();
    expect(active?.conversationId).not.toBe(original.conversationId);
    expect(active?.active).toBe(true);
    expect(archived?.active).toBe(false);
    expect(archived?.archivedAt).not.toBeNull();
  });

  it("creates a fresh active conversation on /reset when none exists yet", async () => {
    const engine = createEngine();
    (engine as unknown as { ensureMigrated(): void }).ensureMigrated();
    const store = engine.getConversationStore();

    await engine.handleBeforeReset({
      reason: "reset",
      sessionId: "uuid-1",
      sessionKey: "agent:main:main",
    });

    const active = await store.getConversationBySessionKey("agent:main:main");
    expect(active).not.toBeNull();
    expect(active?.active).toBe(true);
    expect(active?.sessionId).toBe("uuid-1");
  });

  it("treats repeated /reset on an already fresh conversation as a no-op", async () => {
    const engine = createEngine();
    (engine as unknown as { ensureMigrated(): void }).ensureMigrated();
    const store = engine.getConversationStore();

    const original = await store.getOrCreateConversation("uuid-1", {
      sessionKey: "agent:main:main",
    });
    await store.createMessage({
      conversationId: original.conversationId,
      seq: 1,
      role: "user",
      content: "seed",
      tokenCount: 5,
    });

    await engine.handleBeforeReset({
      reason: "reset",
      sessionId: "uuid-1",
      sessionKey: "agent:main:main",
    });
    const firstFresh = await store.getConversationBySessionKey("agent:main:main");

    await engine.handleBeforeReset({
      reason: "reset",
      sessionId: "uuid-1",
      sessionKey: "agent:main:main",
    });
    const secondFresh = await store.getConversationBySessionKey("agent:main:main");

    expect(firstFresh?.conversationId).not.toBe(original.conversationId);
    expect(secondFresh?.conversationId).toBe(firstFresh?.conversationId);
  });
});

describe("LcmContextEngine session_end lifecycle", () => {
  it("ignores session_end new so /new stays a prune-in-place flow", async () => {
    const engine = createEngine();
    (engine as unknown as { ensureMigrated(): void }).ensureMigrated();
    const store = engine.getConversationStore();

    const original = await store.getOrCreateConversation("uuid-1", {
      sessionKey: "agent:main:main",
    });
    await store.createMessage({
      conversationId: original.conversationId,
      seq: 1,
      role: "user",
      content: "seed",
      tokenCount: 5,
    });

    await engine.handleSessionEnd({
      reason: "new",
      sessionId: "uuid-1",
      sessionKey: "agent:main:main",
      nextSessionId: "uuid-2",
    });

    const active = await store.getConversationBySessionKey("agent:main:main");
    expect(active?.conversationId).toBe(original.conversationId);
    expect(active?.active).toBe(true);
  });

  for (const reason of ["restart", "shutdown"] as const) {
    it(`ignores session_end ${reason} so gateway lifecycle does not orphan conversation history`, async () => {
      const engine = createEngine();
      (engine as unknown as { ensureMigrated(): void }).ensureMigrated();
      const store = engine.getConversationStore();

      const original = await store.getOrCreateConversation("uuid-1", {
        sessionKey: "agent:main:main",
      });
      await store.createMessage({
        conversationId: original.conversationId,
        seq: 1,
        role: "user",
        content: "seed",
        tokenCount: 5,
      });

      await engine.handleSessionEnd({
        reason,
        sessionId: "uuid-1",
        sessionKey: "agent:main:main",
        nextSessionId: "uuid-2",
      });

      const active = await store.getConversationBySessionKey("agent:main:main");
      const originalAfterLifecycle = await store.getConversation(original.conversationId);

      expect(active?.conversationId).toBe(original.conversationId);
      expect(active?.active).toBe(true);
      expect(originalAfterLifecycle?.active).toBe(true);
      expect(originalAfterLifecycle?.archivedAt).toBeNull();
    });
  }

  it("archives the prior active conversation and creates a fresh active row on idle rollover", async () => {
    const engine = createEngine();
    (engine as unknown as { ensureMigrated(): void }).ensureMigrated();
    const store = engine.getConversationStore();

    const original = await store.getOrCreateConversation("uuid-1", {
      sessionKey: "agent:main:main",
    });
    await store.createMessage({
      conversationId: original.conversationId,
      seq: 1,
      role: "user",
      content: "seed",
      tokenCount: 5,
    });

    await engine.handleSessionEnd({
      reason: "idle",
      sessionId: "uuid-1",
      sessionKey: "agent:main:main",
      nextSessionId: "uuid-2",
    });

    const active = await store.getConversationBySessionKey("agent:main:main");
    const archived = await store.getConversation(original.conversationId);

    expect(active).not.toBeNull();
    expect(active?.conversationId).not.toBe(original.conversationId);
    expect(active?.sessionId).toBe("uuid-2");
    expect(active?.active).toBe(true);
    expect(archived?.active).toBe(false);
    expect(archived?.archivedAt).not.toBeNull();
  });

  it("archives the active conversation without replacement on deleted session_end", async () => {
    const engine = createEngine();
    (engine as unknown as { ensureMigrated(): void }).ensureMigrated();
    const store = engine.getConversationStore();

    const original = await store.getOrCreateConversation("uuid-1", {
      sessionKey: "agent:main:main",
    });
    await store.createMessage({
      conversationId: original.conversationId,
      seq: 1,
      role: "user",
      content: "seed",
      tokenCount: 5,
    });

    await engine.handleSessionEnd({
      reason: "deleted",
      sessionId: "uuid-1",
      sessionKey: "agent:main:main",
    });

    const active = await store.getConversationBySessionKey("agent:main:main");
    const archived = await store.getConversation(original.conversationId);

    expect(active).toBeNull();
    expect(archived?.active).toBe(false);
    expect(archived?.archivedAt).not.toBeNull();
  });

  it("treats session_end reset after before_reset as a no-op on the fresh replacement row", async () => {
    const engine = createEngine();
    (engine as unknown as { ensureMigrated(): void }).ensureMigrated();
    const store = engine.getConversationStore();

    const original = await store.getOrCreateConversation("uuid-1", {
      sessionKey: "agent:main:main",
    });
    await store.createMessage({
      conversationId: original.conversationId,
      seq: 1,
      role: "user",
      content: "seed",
      tokenCount: 5,
    });

    await engine.handleBeforeReset({
      reason: "reset",
      sessionId: "uuid-1",
      sessionKey: "agent:main:main",
    });
    const firstFresh = await store.getConversationBySessionKey("agent:main:main");

    await engine.handleSessionEnd({
      reason: "reset",
      sessionId: "uuid-1",
      sessionKey: "agent:main:main",
      nextSessionId: "uuid-2",
    });
    const secondFresh = await store.getConversationBySessionKey("agent:main:main");

    expect(firstFresh?.conversationId).not.toBe(original.conversationId);
    expect(secondFresh?.conversationId).toBe(firstFresh?.conversationId);
  });
});

describe("LcmContextEngine delegated session continuity", () => {
  it("prepares subagent spawn from an existing conversation found by sessionKey", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
    tempDirs.push(tempDir);
    const config = createTestConfig(join(tempDir, "lcm.db"));
    const db = createLcmDatabaseConnection(config.databasePath);
    const deps = createTestDeps(config);
    deps.resolveSessionIdFromSessionKey = vi.fn(async () => "uuid-after-reset");
    const engine = new LcmContextEngine(deps, db);

    (engine as unknown as { ensureMigrated(): void }).ensureMigrated();
    await engine
      .getConversationStore()
      .getOrCreateConversation("uuid-before-reset", { sessionKey: "agent:main:main" });

    const prepared = await engine.prepareSubagentSpawn({
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:child",
    });

    expect(prepared).toBeDefined();
  });
});

// ── Ingest content extraction ───────────────────────────────────────────────

describe("LcmContextEngine.ingest content extraction", () => {
  it("stores string content as-is", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const content = await ingestAndReadStoredContent({
      engine,
      sessionId,
      message: makeMessage({ role: "user", content: "hello world" }),
    });

    expect(content).toBe("hello world");
  });

  it("flattens text content block arrays to plain text", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const content = await ingestAndReadStoredContent({
      engine,
      sessionId,
      message: makeMessage({
        content: [{ type: "text", text: "hello" }],
      }),
    });

    expect(content).toBe("hello");
  });

  it("extracts only text blocks from mixed content arrays", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const content = await ingestAndReadStoredContent({
      engine,
      sessionId,
      message: makeMessage({
        content: [
          { type: "text", text: "line one" },
          { type: "thinking", thinking: "internal chain of thought" },
          { type: "tool_use", name: "bash" },
          { type: "text", text: "line two" },
        ],
      }),
    });

    expect(content).toBe("line one\nline two");
  });

  it("stores empty string for empty content arrays", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const content = await ingestAndReadStoredContent({
      engine,
      sessionId,
      message: makeMessage({ content: [] }),
    });

    expect(content).toBe("");
  });

  it("falls back to JSON.stringify for non-array, non-string content", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const content = await ingestAndReadStoredContent({
      engine,
      sessionId,
      message: makeMessage({ content: { status: "ok", count: 2 } }),
    });

    expect(content).toBe('{"status":"ok","count":2}');
  });

  it("roundtrip stores plain text, not JSON content blocks", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    await engine.ingest({
      sessionId,
      message: makeMessage({
        content: [{ type: "text", text: "HEARTBEAT_OK" }],
      }),
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const storedMessages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(storedMessages).toHaveLength(1);
    expect(storedMessages[0].content).toBe("HEARTBEAT_OK");
    expect(storedMessages[0].content).not.toContain('{"type":"text"');
  });

  it("intercepts oversized <file> blocks and persists large file metadata", async () => {
    await withTempHome(async () => {
      const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
      const sessionId = randomUUID();
      const fileText = `${"line about architecture\n".repeat(160)}closing notes`;
      const messageContent = `<file name="lcm-paper.md" mime="text/markdown">${fileText}</file>`;

      await engine.ingest({
        sessionId,
        message: makeMessage({ role: "user", content: messageContent }),
      });

      const conversation = await engine
        .getConversationStore()
        .getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();

      const messages = await engine
        .getConversationStore()
        .getMessages(conversation!.conversationId);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toContain("[LCM File: file_");
      expect(messages[0].content).toContain("Exploration Summary:");
      expect(messages[0].content).not.toContain("<file name=");

      const fileIdMatch = messages[0].content.match(/file_[a-f0-9]{16}/);
      expect(fileIdMatch).not.toBeNull();
      const fileId = fileIdMatch![0];

      const storedFile = await engine.getSummaryStore().getLargeFile(fileId);
      expect(storedFile).not.toBeNull();
      expect(storedFile!.fileName).toBe("lcm-paper.md");
      expect(storedFile!.mimeType).toBe("text/markdown");
      expect(storedFile!.storageUri).toContain(
        `lcm-files/${conversation!.conversationId}/`,
      );
      expect(readFileSync(storedFile!.storageUri, "utf8")).toBe(fileText);

      const parts = await engine.getConversationStore().getMessageParts(messages[0].messageId);
      expect(parts).toHaveLength(1);
      expect(parts[0].textContent).toContain("[LCM File: file_");
      expect(parts[0].textContent).not.toContain("<file name=");
    });
  });

  it("keeps <file> blocks inline when below the large-file threshold", async () => {
    await withTempHome(async () => {
      const engine = createEngineWithConfig({ largeFileTokenThreshold: 100_000 });
      const sessionId = randomUUID();
      const messageContent = '<file name="small.json" mime="application/json">{"ok":true}</file>';

      await engine.ingest({
        sessionId,
        message: makeMessage({ role: "user", content: messageContent }),
      });

      const conversation = await engine
        .getConversationStore()
        .getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();

      const messages = await engine
        .getConversationStore()
        .getMessages(conversation!.conversationId);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe(messageContent);

      const largeFiles = await engine
        .getSummaryStore()
        .getLargeFilesByConversation(conversation!.conversationId);
      expect(largeFiles).toHaveLength(0);
    });
  });

  it("externalizes oversized plain user text as a raw payload", async () => {
    await withTempHome(async () => {
      const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
      const sessionId = randomUUID();
      const rawText = `${"plain raw message line\n".repeat(160)}done`;

      await engine.ingest({
        sessionId,
        message: makeMessage({ role: "user", content: rawText }),
      });

      const conversation = await engine
        .getConversationStore()
        .getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();

      const messages = await engine
        .getConversationStore()
        .getMessages(conversation!.conversationId);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toContain("[LCM Raw Payload: file_");
      expect(messages[0].content).toContain("role=user");
      expect(messages[0].content).toContain("reason=large_raw_message");
      expect(messages[0].content).not.toContain(rawText.slice(0, 64));

      const fileIdMatch = messages[0].content.match(/file_[a-f0-9]{16}/);
      expect(fileIdMatch).not.toBeNull();
      const fileId = fileIdMatch![0];
      const storedFile = await engine.getSummaryStore().getLargeFile(fileId);
      expect(storedFile).not.toBeNull();
      expect(storedFile!.fileName).toBe("raw-user-payload.txt");
      expect(storedFile!.mimeType).toBe("text/plain");
      expect(readFileSync(storedFile!.storageUri, "utf8")).toBe(rawText);

      const parts = await engine.getConversationStore().getMessageParts(messages[0].messageId);
      expect(parts).toHaveLength(1);
      expect(parts[0].textContent).toBe(messages[0].content);
      const metadata = JSON.parse(parts[0].metadata ?? "{}") as Record<string, unknown>;
      expect(metadata).toMatchObject({
        originalRole: "user",
        rawPayloadExternalized: true,
        externalizedFileId: fileId,
        originalByteSize: Buffer.byteLength(rawText, "utf8"),
        externalizationReason: "large_raw_message",
      });
    });
  });

  it("keeps plain user text inline when below the raw-payload threshold", async () => {
    await withTempHome(async () => {
      const engine = createEngineWithConfig({ largeFileTokenThreshold: 100_000 });
      const sessionId = randomUUID();
      const rawText = "short raw message";

      await engine.ingest({
        sessionId,
        message: makeMessage({ role: "user", content: rawText }),
      });

      const conversation = await engine
        .getConversationStore()
        .getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();

      const messages = await engine
        .getConversationStore()
        .getMessages(conversation!.conversationId);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe(rawText);

      const largeFiles = await engine
        .getSummaryStore()
        .getLargeFilesByConversation(conversation!.conversationId);
      expect(largeFiles).toHaveLength(0);
    });
  });

  it("externalizes oversized non-file non-tool raw payloads", async () => {
    await withTempHome(async () => {
      const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
      const sessionId = randomUUID();
      const rawBlob = "RAW_VENDOR_PAYLOAD ".repeat(220);
      const rawPayload = [{ type: "vendor_payload", blob: rawBlob, status: "ok" }];

      await engine.ingest({
        sessionId,
        message: makeMessage({ role: "assistant", content: rawPayload }),
      });

      const conversation = await engine
        .getConversationStore()
        .getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();

      const messages = await engine
        .getConversationStore()
        .getMessages(conversation!.conversationId);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toContain("[LCM Raw Payload: file_");
      expect(messages[0].content).toContain("role=assistant");
      expect(messages[0].content).not.toContain(rawBlob.slice(0, 64));

      const fileIdMatch = messages[0].content.match(/file_[a-f0-9]{16}/);
      expect(fileIdMatch).not.toBeNull();
      const storedFile = await engine.getSummaryStore().getLargeFile(fileIdMatch![0]);
      expect(storedFile).not.toBeNull();
      expect(storedFile!.fileName).toBe("raw-assistant-payload.json");
      expect(storedFile!.mimeType).toBe("application/json");
      expect(readFileSync(storedFile!.storageUri, "utf8")).toBe(JSON.stringify(rawPayload));

      const assembler = new ContextAssembler(engine.getConversationStore(), engine.getSummaryStore());
      const assembled = await assembler.assemble({
        conversationId: conversation!.conversationId,
        tokenBudget: 10_000,
      });
      const assembledMessage = assembled.messages[0] as {
        role: string;
        content?: Array<{ type?: unknown; text?: unknown }>;
      };
      expect(assembledMessage.role).toBe("assistant");
      expect(assembledMessage.content?.[0]?.type).toBe("text");
      expect(String(assembledMessage.content?.[0]?.text)).toContain("[LCM Raw Payload:");
    });
  });

  it("does not externalize assistant tool or reasoning blocks generically", async () => {
    await withTempHome(async () => {
      const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
      const sessionId = randomUUID();
      const largeReasoning = "protected reasoning ".repeat(220);
      const largeInput = "protected tool input ".repeat(220);

      await engine.ingest({
        sessionId,
        message: {
          role: "assistant",
          content: [
            { type: "reasoning", summary: [{ text: largeReasoning }] },
            {
              type: "toolCall",
              id: "call_protected",
              name: "exec",
              input: { cmd: largeInput },
            },
          ],
        } as AgentMessage,
      });

      const conversation = await engine
        .getConversationStore()
        .getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();

      const messages = await engine
        .getConversationStore()
        .getMessages(conversation!.conversationId);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).not.toContain("[LCM Raw Payload:");
      expect(messages[0].content).not.toContain("protected reasoning");

      const largeFiles = await engine
        .getSummaryStore()
        .getLargeFilesByConversation(conversation!.conversationId);
      expect(largeFiles).toHaveLength(0);

      const parts = await engine.getConversationStore().getMessageParts(messages[0].messageId);
      expect(parts.map((part) => part.partType)).toEqual(["reasoning", "tool"]);
      expect(parts[1].toolCallId).toBe("call_protected");
      expect(parts[1].toolName).toBe("exec");
    });
  });

  it("stores externalized inline images under largeFilesDir", async () => {
    const largeFilesDir = mkdtempSync(join(tmpdir(), "lossless-claw-large-files-"));
    tempDirs.push(largeFilesDir);
    // Realistic threshold so the post-image-rewrite content (which is below
    // it) doesn't also trigger raw-payload externalization — this test only
    // verifies the image-externalizer path.
    const engine = createEngineWithConfig({
      largeFileTokenThreshold: 1000,
      largeFilesDir,
    });
    const sessionId = randomUUID();
    const base64Image = `iVBOR${"A".repeat(600)}`;

    await engine.ingest({
      sessionId,
      message: makeMessage({
        role: "user",
        content: `[media attached: screenshot.png]\n${base64Image}\n`,
      }),
    });

    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const messages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain("[User image: screenshot.png");
    expect(messages[0].content).not.toContain(base64Image.slice(0, 32));

    const fileIdMatch = messages[0].content.match(/file_[a-f0-9]{16}/);
    expect(fileIdMatch).not.toBeNull();
    const storedFile = await engine.getSummaryStore().getLargeFile(fileIdMatch![0]);
    expect(storedFile).not.toBeNull();
    expect(storedFile!.mimeType).toBe("image/png");
    expect(storedFile!.storageUri).toContain(
      `${largeFilesDir}/${conversation!.conversationId}/`,
    );
  });

  it("externalizes native user image blocks before raw payload fallback", async () => {
    const largeFilesDir = mkdtempSync(join(tmpdir(), "lossless-claw-large-files-"));
    tempDirs.push(largeFilesDir);
    // Realistic threshold — the post-image-rewrite content is below it, so
    // only the native-image-block path runs (raw-payload would otherwise
    // also fire under the artificially-low 20-token threshold this test
    // used to set, which is the scenario the new mixed-content test in
    // this file deliberately exercises with a longer body).
    const engine = createEngineWithConfig({
      largeFileTokenThreshold: 1000,
      largeFilesDir,
    });
    const sessionId = randomUUID();
    const base64Image = `/9j/${"A".repeat(600)}`;
    const userText =
      "[media attached: /Users/example/inbound/screenshot.jpg (image/jpeg)]\nplease inspect";

    await engine.ingest({
      sessionId,
      message: makeMessage({
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image", data: base64Image, mimeType: "image/jpeg" },
        ],
      }),
    });

    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const messages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain("please inspect");
    expect(messages[0].content).toContain("[User image: screenshot.jpg");
    expect(messages[0].content).not.toContain("[LCM Raw Payload:");
    expect(messages[0].content).not.toContain(base64Image.slice(0, 32));

    const largeFiles = await engine
      .getSummaryStore()
      .getLargeFilesByConversation(conversation!.conversationId);
    expect(largeFiles).toHaveLength(1);
    expect(largeFiles[0].fileName).toBe("screenshot.jpg");
    expect(largeFiles[0].mimeType).toBe("image/jpeg");
    expect(readFileSync(largeFiles[0].storageUri)).toEqual(Buffer.from(base64Image, "base64"));

    const parts = await engine.getConversationStore().getMessageParts(messages[0].messageId);
    expect(parts.map((part) => part.partType)).toEqual(["text", "text"]);
    expect(JSON.stringify(parts)).not.toContain(base64Image.slice(0, 32));

    const assembler = new ContextAssembler(engine.getConversationStore(), engine.getSummaryStore());
    const assembled = await assembler.assemble({
      conversationId: conversation!.conversationId,
      tokenBudget: 10_000,
    });
    const assembledUser = assembled.messages[0] as {
      role: string;
      content?: Array<{ type?: unknown; text?: unknown }>;
    };
    expect(assembledUser.role).toBe("user");
    expect(assembledUser.content?.[0]?.text).toContain("please inspect");
    expect(assembledUser.content?.[1]?.text).toContain("[User image: screenshot.jpg");
    expect(JSON.stringify(assembled.messages)).not.toContain(base64Image.slice(0, 32));
  });

  it("externalizes native assistant image blocks before raw payload fallback", async () => {
    const largeFilesDir = mkdtempSync(join(tmpdir(), "lossless-claw-large-files-"));
    tempDirs.push(largeFilesDir);
    // Realistic threshold — see the user-image variant above for rationale.
    const engine = createEngineWithConfig({
      largeFileTokenThreshold: 1000,
      largeFilesDir,
    });
    const sessionId = randomUUID();
    const base64Image = `iVBORw0KGgo${"A".repeat(600)}`;

    await engine.ingest({
      sessionId,
      message: makeMessage({
        role: "assistant",
        content: [
          { type: "text", text: "Here is the rendered chart:" },
          { type: "image", data: base64Image, mimeType: "image/png" },
        ],
      }),
    });

    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const messages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain("Here is the rendered chart");
    expect(messages[0].content).toContain("[Assistant image:");
    expect(messages[0].content).not.toContain("raw-assistant-payload");
    expect(messages[0].content).not.toContain("[LCM Raw Payload:");
    expect(messages[0].content).not.toContain(base64Image.slice(0, 32));

    const largeFiles = await engine
      .getSummaryStore()
      .getLargeFilesByConversation(conversation!.conversationId);
    expect(largeFiles).toHaveLength(1);
    expect(largeFiles[0].mimeType).toBe("image/png");
    expect(largeFiles[0].fileName).toBe("assistant-image.png");
  });

  it("externalizes native tool-result image blocks instead of persisting them inline", async () => {
    const largeFilesDir = mkdtempSync(join(tmpdir(), "lossless-claw-large-files-"));
    tempDirs.push(largeFilesDir);
    const engine = createEngineWithConfig({
      largeFileTokenThreshold: 20,
      largeFilesDir,
    });
    const sessionId = randomUUID();
    const base64Image = `iVBORw0KGgo${"B".repeat(600)}`;

    // First the assistant tool call so the conversation has a corresponding tool message.
    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_screenshot",
            name: "take_screenshot",
            input: {},
          },
        ],
      } as AgentMessage,
    });

    await engine.ingest({
      sessionId,
      message: {
        role: "toolResult",
        toolCallId: "call_screenshot",
        toolName: "take_screenshot",
        content: [
          { type: "image", data: base64Image, mimeType: "image/png" },
        ],
      } as AgentMessage,
    });

    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const messages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(messages).toHaveLength(2);
    const toolMessage = messages[1];
    expect(toolMessage.role).toBe("tool");
    // The important behavior: toolResult native image is replaced by an
    // externalized reference and the base64 payload never reaches the DB
    // row inline. Tool messages skip raw-payload externalization entirely
    // (see `interceptLargeRawPayload` early-return), so we don't assert on
    // a `raw-tool-payload.json` shape.
    expect(toolMessage.content).toContain("[Tool image:");
    expect(toolMessage.content).not.toContain(base64Image.slice(0, 32));

    const largeFiles = await engine
      .getSummaryStore()
      .getLargeFilesByConversation(conversation!.conversationId);
    expect(largeFiles).toHaveLength(1);
    expect(largeFiles[0].mimeType).toBe("image/png");
    expect(largeFiles[0].fileName).toBe("tool-image.png");
  });

  it("externalizes native system image blocks instead of falling through to raw-system-payload", async () => {
    const largeFilesDir = mkdtempSync(join(tmpdir(), "lossless-claw-large-files-"));
    tempDirs.push(largeFilesDir);
    const engine = createEngineWithConfig({
      largeFileTokenThreshold: 1000,
      largeFilesDir,
    });
    const sessionId = randomUUID();
    const base64Image = `iVBORw0KGgo${"S".repeat(600)}`;

    await engine.ingest({
      sessionId,
      message: {
        role: "system",
        content: [
          { type: "text", text: "Workspace bootstrap." },
          { type: "image", data: base64Image, mimeType: "image/png" },
        ],
      } as AgentMessage,
    });

    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const messages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain("Workspace bootstrap");
    expect(messages[0].content).toContain("[System image:");
    expect(messages[0].content).not.toContain("raw-system-payload");
    expect(messages[0].content).not.toContain(base64Image.slice(0, 32));

    const largeFiles = await engine
      .getSummaryStore()
      .getLargeFilesByConversation(conversation!.conversationId);
    expect(largeFiles).toHaveLength(1);
    expect(largeFiles[0].fileName).toBe("system-image.png");
  });

  it("still externalizes large mixed-content messages that embed an image reference alongside oversized text", async () => {
    // Regression for the substring-skip bug in `interceptLargeRawPayload`:
    // a previous skip on `isExternalizedReferenceContent(stored.content)`
    // tripped on any content containing `LCM file: file_...`, so a message
    // with an image reference plus a large amount of other text was never
    // externalized as a raw payload. The skip is now gated on the explicit
    // `rawPayloadExternalized: true` flag set by the raw-payload pass itself.
    const largeFilesDir = mkdtempSync(join(tmpdir(), "lossless-claw-large-files-"));
    tempDirs.push(largeFilesDir);
    const engine = createEngineWithConfig({
      largeFileTokenThreshold: 20,
      largeFilesDir,
    });
    const sessionId = randomUUID();
    const base64Image = `iVBORw0KGgo${"M".repeat(600)}`;
    // 4_000-word body so the assistant message blows past the threshold
    // even after the image is externalized to a short reference.
    const longBody = "lorem ipsum ".repeat(2_000);

    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "Render the chart please." }),
    });
    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Here's the rendered chart:" },
          { type: "image", data: base64Image, mimeType: "image/png" },
          { type: "text", text: longBody },
        ],
      } as AgentMessage,
    });

    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const largeFiles = await engine
      .getSummaryStore()
      .getLargeFilesByConversation(conversation!.conversationId);
    // Two large_files rows: one for the image and one for the
    // raw-payload externalization that the substring-skip used to suppress.
    expect(largeFiles.length).toBeGreaterThanOrEqual(2);
    const mimeTypes = largeFiles.map((row) => row.mimeType);
    expect(mimeTypes).toContain("image/png");
    expect(mimeTypes.some((m) => m === "application/json" || m === "text/plain")).toBe(true);
  });

  it("infers extensions for heic, avif, and bmp native image blocks", async () => {
    const largeFilesDir = mkdtempSync(join(tmpdir(), "lossless-claw-large-files-"));
    tempDirs.push(largeFilesDir);
    const engine = createEngineWithConfig({
      largeFileTokenThreshold: 1000,
      largeFilesDir,
    });

    const cases: Array<{ mimeType: string; extension: string }> = [
      { mimeType: "image/heic", extension: "heic" },
      { mimeType: "image/avif", extension: "avif" },
      { mimeType: "image/bmp", extension: "bmp" },
    ];

    for (const variant of cases) {
      const sessionId = randomUUID();
      // Use a base64 payload that will NOT match any magic-byte prefix so we
      // exercise the declared mimeType -> extension fallback.
      const base64Image = `ZZZZ${"C".repeat(600)}`;

      await engine.ingest({
        sessionId,
        message: makeMessage({
          role: "user",
          content: [
            { type: "text", text: "look at this" },
            { type: "image", data: base64Image, mimeType: variant.mimeType },
          ],
        }),
      });

      const conversation = await engine
        .getConversationStore()
        .getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();

      const largeFiles = await engine
        .getSummaryStore()
        .getLargeFilesByConversation(conversation!.conversationId);
      expect(largeFiles).toHaveLength(1);
      expect(largeFiles[0].mimeType).toBe(variant.mimeType);
      expect(largeFiles[0].storageUri.endsWith(`.${variant.extension}`)).toBe(true);
      expect(largeFiles[0].fileName.endsWith(`.${variant.extension}`)).toBe(true);
    }
  });

  it("externalizes oversized tool-result payloads into large_files", async () => {
    await withTempHome(async () => {
      const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
      const sessionId = randomUUID();
      const toolOutput = `${"tool output line\n".repeat(160)}done`;

      await engine.ingest({
        sessionId,
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_externalized",
              name: "exec",
              input: { cmd: "pwd" },
            },
          ],
        } as AgentMessage,
      });

      await engine.ingest({
        sessionId,
        message: {
          role: "toolResult",
          toolCallId: "call_externalized",
          toolName: "exec",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_externalized",
              name: "exec",
              content: [{ type: "text", text: toolOutput }],
            },
          ],
        } as AgentMessage,
      });

      const conversation = await engine
        .getConversationStore()
        .getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();

      const storedMessages = await engine
        .getConversationStore()
        .getMessages(conversation!.conversationId);
      expect(storedMessages).toHaveLength(2);
      expect(storedMessages[1].content).toContain("[LCM Tool Output: file_");
      expect(storedMessages[1].content).toContain("tool=exec");
      expect(storedMessages[1].content).not.toContain(toolOutput.slice(0, 64));

      const fileIdMatch = storedMessages[1].content.match(/file_[a-f0-9]{16}/);
      expect(fileIdMatch).not.toBeNull();
      const fileId = fileIdMatch![0];

      const storedFile = await engine.getSummaryStore().getLargeFile(fileId);
      expect(storedFile).not.toBeNull();
      expect(storedFile!.fileName).toBe("exec.txt");
      expect(storedFile!.mimeType).toBe("text/plain");
      expect(readFileSync(storedFile!.storageUri, "utf8")).toBe(toolOutput);

      const parts = await engine.getConversationStore().getMessageParts(storedMessages[1].messageId);
      expect(parts).toHaveLength(1);
      expect(parts[0].partType).toBe("tool");
      const metadata = JSON.parse(parts[0].metadata ?? "{}") as Record<string, unknown>;
      expect(metadata).toMatchObject({
        externalizedFileId: fileId,
        originalByteSize: Buffer.byteLength(toolOutput, "utf8"),
        toolOutputExternalized: true,
        externalizationReason: "large_tool_result",
      });

      const assembler = new ContextAssembler(engine.getConversationStore(), engine.getSummaryStore());
      const assembled = await assembler.assemble({
        conversationId: conversation!.conversationId,
        tokenBudget: 10_000,
      });
      expect(assembled.messages).toHaveLength(2);
      const assembledToolResult = assembled.messages[1] as {
        role: string;
        content?: Array<{ output?: unknown }>;
      };
      expect(assembledToolResult.role).toBe("toolResult");
      expect(typeof assembledToolResult.content?.[0]?.output).toBe("string");
      expect(String(assembledToolResult.content?.[0]?.output)).toContain(fileId);

      const retrieval = new RetrievalEngine(
        engine.getConversationStore(),
        engine.getSummaryStore(),
      );
      const described = await retrieval.describe(fileId);
      expect(described?.type).toBe("file");
      expect(described?.file?.storageUri).toBe(storedFile!.storageUri);

      const searchable = await engine.getConversationStore().searchMessages({
        conversationId: conversation!.conversationId,
        query: "exec",
        mode: "full_text",
      });
      expect(searchable).toHaveLength(1);

      const noisy = await engine.getConversationStore().searchMessages({
        conversationId: conversation!.conversationId,
        query: "lcm_describe",
        mode: "full_text",
      });
      expect(noisy).toHaveLength(0);
    });
  });

  it("externalizes oversized plain-text tool-result blocks from live exec-style messages", async () => {
    await withTempHome(async () => {
      const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
      const sessionId = randomUUID();
      const toolOutput = `${"minified js chunk\n".repeat(160)}done`;

      await engine.ingest({
        sessionId,
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_live_exec",
              name: "exec",
              input: { cmd: "head -c 200000 viewer-runtime.js" },
            },
          ],
        } as AgentMessage,
      });

      await engine.ingest({
        sessionId,
        message: {
          role: "toolResult",
          toolCallId: "call_live_exec",
          toolName: "exec",
          isError: false,
          content: [
            {
              type: "text",
              text: toolOutput,
            },
          ],
        } as AgentMessage,
      });

      const conversation = await engine
        .getConversationStore()
        .getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();

      const storedMessages = await engine
        .getConversationStore()
        .getMessages(conversation!.conversationId);
      expect(storedMessages).toHaveLength(2);
      expect(storedMessages[1].content).toContain("[LCM Tool Output: file_");
      expect(storedMessages[1].content).toContain("tool=exec");
      expect(storedMessages[1].content).not.toContain(toolOutput.slice(0, 64));

      const fileIdMatch = storedMessages[1].content.match(/file_[a-f0-9]{16}/);
      expect(fileIdMatch).not.toBeNull();
      const fileId = fileIdMatch![0];

      const storedFile = await engine.getSummaryStore().getLargeFile(fileId);
      expect(storedFile).not.toBeNull();
      expect(storedFile!.fileName).toBe("exec.txt");
      expect(readFileSync(storedFile!.storageUri, "utf8")).toBe(toolOutput);

      const parts = await engine.getConversationStore().getMessageParts(storedMessages[1].messageId);
      expect(parts).toHaveLength(1);
      expect(parts[0].partType).toBe("tool");
      expect(parts[0].toolCallId).toBe("call_live_exec");
      expect(parts[0].toolName).toBe("exec");
      const metadata = JSON.parse(parts[0].metadata ?? "{}") as Record<string, unknown>;
      expect(metadata).toMatchObject({
        originalRole: "toolResult",
        rawType: "tool_result",
        externalizedFileId: fileId,
        originalByteSize: Buffer.byteLength(toolOutput, "utf8"),
        toolOutputExternalized: true,
        externalizationReason: "large_tool_result",
      });

      const assembler = new ContextAssembler(engine.getConversationStore(), engine.getSummaryStore());
      const assembled = await assembler.assemble({
        conversationId: conversation!.conversationId,
        tokenBudget: 10_000,
      });
      expect(assembled.messages).toHaveLength(2);
      const assembledToolResult = assembled.messages[1] as {
        role: string;
        toolCallId?: string;
        toolName?: string;
        content?: Array<{ type?: unknown; text?: unknown; output?: unknown }>;
      };
      expect(assembledToolResult.role).toBe("toolResult");
      expect(assembledToolResult.toolCallId).toBe("call_live_exec");
      expect(assembledToolResult.toolName).toBe("exec");
      const block = assembledToolResult.content?.[0];
      expect(block?.type).toBe("text");
      expect(typeof block?.text).toBe("string");
      expect(String(block?.text)).toContain(fileId);
      expect(block).not.toHaveProperty("output");
    });
  });

  it("externalizes structured tool-result image payloads before text externalization", async () => {
    const largeFilesDir = mkdtempSync(join(tmpdir(), "lossless-claw-large-files-"));
    tempDirs.push(largeFilesDir);
    const engine = createEngineWithConfig({
      largeFileTokenThreshold: 20,
      largeFilesDir,
    });
    const sessionId = randomUUID();
    const base64Image = `iVBOR${"A".repeat(600)}`;

    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_structured_image",
            name: "capture",
            input: { cmd: "screenshot" },
          },
        ],
      } as AgentMessage,
    });

    await engine.ingest({
      sessionId,
      message: {
        role: "toolResult",
        toolCallId: "call_structured_image",
        toolName: "capture",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_structured_image",
            name: "capture",
            content: [{ type: "text", text: base64Image }],
          },
        ],
      } as AgentMessage,
    });

    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const storedMessages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(storedMessages).toHaveLength(2);
    expect(storedMessages[1].content).toBe("");

    const parts = await engine.getConversationStore().getMessageParts(storedMessages[1].messageId);
    expect(parts).toHaveLength(1);
    expect(parts[0].partType).toBe("tool");
    expect(parts[0].toolOutput).toBeNull();
    const metadata = JSON.parse(parts[0].metadata ?? "{}") as Record<string, unknown>;
    const raw = metadata.raw as {
      type: string;
      content: Array<{ type: string; text: string }>;
    };
    const imageReference = raw.content[0]?.text ?? "";
    expect(imageReference).toContain("[Tool image: tool-image.png");
    expect(imageReference).not.toContain(base64Image.slice(0, 32));

    const fileIdMatch = imageReference.match(/file_[a-f0-9]{16}/);
    expect(fileIdMatch).not.toBeNull();
    const storedFile = await engine.getSummaryStore().getLargeFile(fileIdMatch![0]);
    expect(storedFile).not.toBeNull();
    expect(storedFile!.mimeType).toBe("image/png");
    expect(storedFile!.fileName).toBe("tool-image.png");

    expect(metadata.raw).toMatchObject({
      type: "tool_result",
      content: [{ type: "text", text: expect.stringContaining("[Tool image: tool-image.png") }],
    });

    const assembler = new ContextAssembler(engine.getConversationStore(), engine.getSummaryStore());
    const assembled = await assembler.assemble({
      conversationId: conversation!.conversationId,
      tokenBudget: 10_000,
    });
    const assembledToolResult = assembled.messages[1] as {
      role: string;
      content?: Array<{ content?: Array<{ text?: string }> }>;
    };
    expect(assembledToolResult.role).toBe("toolResult");
    expect(assembledToolResult.content?.[0]?.content?.[0]?.text).toContain("[Tool image: tool-image.png");
  });

  it("externalizes string-content tool-result images without converting them to text files", async () => {
    const largeFilesDir = mkdtempSync(join(tmpdir(), "lossless-claw-large-files-"));
    tempDirs.push(largeFilesDir);
    const engine = createEngineWithConfig({
      largeFileTokenThreshold: 20,
      largeFilesDir,
    });
    const sessionId = randomUUID();
    const base64Image = `iVBOR${"A".repeat(600)}`;

    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_text_image",
            name: "capture",
            input: { cmd: "screenshot" },
          },
        ],
      } as AgentMessage,
    });

    await engine.ingest({
      sessionId,
      message: {
        role: "toolResult",
        toolCallId: "call_text_image",
        toolName: "capture",
        isError: false,
        content: base64Image,
      } as AgentMessage,
    });

    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const storedMessages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(storedMessages).toHaveLength(2);
    expect(storedMessages[1].content).toContain("[Tool image: tool-image.png");
    expect(storedMessages[1].content).not.toContain("[LCM Tool Output:");

    const fileIdMatch = storedMessages[1].content.match(/file_[a-f0-9]{16}/);
    expect(fileIdMatch).not.toBeNull();
    const storedFile = await engine.getSummaryStore().getLargeFile(fileIdMatch![0]);
    expect(storedFile).not.toBeNull();
    expect(storedFile!.mimeType).toBe("image/png");
    expect(storedFile!.fileName).toBe("tool-image.png");
    expect(storedFile!.storageUri.endsWith(".png")).toBe(true);

    const parts = await engine.getConversationStore().getMessageParts(storedMessages[1].messageId);
    expect(parts).toHaveLength(1);
    expect(parts[0].partType).toBe("text");
    expect(JSON.parse(parts[0].metadata ?? "{}")).toMatchObject({
      toolCallId: "call_text_image",
      toolName: "capture",
      isError: false,
    });
  });

  it("lists summarized externalized tool results as transcript GC candidates", async () => {
    await withTempHome(async () => {
      const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
      const sessionId = randomUUID();
      const toolOutput = `${"tool output line\n".repeat(160)}done`;

      await engine.ingest({
        sessionId,
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_gc_candidate",
              name: "exec",
              input: { cmd: "pwd" },
            },
          ],
        } as AgentMessage,
      });

      await engine.ingest({
        sessionId,
        message: {
          role: "toolResult",
          toolCallId: "call_gc_candidate",
          toolName: "exec",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_gc_candidate",
              name: "exec",
              content: [{ type: "text", text: toolOutput }],
            },
          ],
        } as AgentMessage,
      });

      const conversation = await engine
        .getConversationStore()
        .getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();

      const storedMessages = await engine
        .getConversationStore()
        .getMessages(conversation!.conversationId);
      const toolMessage = storedMessages[1];
      expect(toolMessage?.role).toBe("tool");

      const summaryId = `sum_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      await engine.getSummaryStore().insertSummary({
        summaryId,
        conversationId: conversation!.conversationId,
        kind: "leaf",
        content: "summarized tool output",
        tokenCount: 16,
      });
      await engine.getSummaryStore().linkSummaryToMessages(summaryId, [toolMessage.messageId]);
      await engine.getSummaryStore().replaceContextRangeWithSummary({
        conversationId: conversation!.conversationId,
        startOrdinal: 1,
        endOrdinal: 1,
        summaryId,
      });

      const candidates = await engine
        .getSummaryStore()
        .listTranscriptGcCandidates(conversation!.conversationId);

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        messageId: toolMessage.messageId,
        conversationId: conversation!.conversationId,
        toolCallId: "call_gc_candidate",
        toolName: "exec",
      });
      expect(candidates[0]?.externalizedFileId).toMatch(/^file_[a-f0-9]{16}$/);
      expect(candidates[0]?.originalByteSize).toBe(Buffer.byteLength(toolOutput, "utf8"));
    });
  });

  it("maintain() defers transcript GC until host-approved background maintenance", async () => {
    await withTempHome(async () => {
      const engine = createEngineWithConfig({
        largeFileTokenThreshold: 20,
        transcriptGcEnabled: true,
      });
      const sessionId = randomUUID();
      const sessionFile = createSessionFilePath("transcript-gc-maintain");
      const toolOutput = `${"tool output line\n".repeat(160)}done`;

      const sm = SessionManager.open(sessionFile);
      sm.appendMessage({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_gc_rewrite",
            name: "exec",
            arguments: { cmd: "pwd" },
          },
        ],
      } as AgentMessage);
      const toolResultEntryId = sm.appendMessage({
        role: "toolResult",
        toolCallId: "call_gc_rewrite",
        toolName: "exec",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_gc_rewrite",
            name: "exec",
            content: [{ type: "text", text: toolOutput }],
          },
        ],
      } as AgentMessage);
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      } as AgentMessage);

      await engine.ingest({
        sessionId,
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_gc_rewrite",
              name: "exec",
              input: { cmd: "pwd" },
            },
          ],
        } as AgentMessage,
      });

      await engine.ingest({
        sessionId,
        message: {
          role: "toolResult",
          toolCallId: "call_gc_rewrite",
          toolName: "exec",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_gc_rewrite",
              name: "exec",
              content: [{ type: "text", text: toolOutput }],
            },
          ],
        } as AgentMessage,
      });

      await engine.ingest({
        sessionId,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        } as AgentMessage,
      });

      const conversation = await engine
        .getConversationStore()
        .getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();

      const storedMessages = await engine
        .getConversationStore()
        .getMessages(conversation!.conversationId);
      const toolMessage = storedMessages[1];
      expect(toolMessage?.content).toContain("[LCM Tool Output: file_");

      const summaryId = `sum_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      await engine.getSummaryStore().insertSummary({
        summaryId,
        conversationId: conversation!.conversationId,
        kind: "leaf",
        content: "summarized tool output",
        tokenCount: 16,
      });
      await engine.getSummaryStore().linkSummaryToMessages(summaryId, [toolMessage.messageId]);
      await engine.getSummaryStore().replaceContextRangeWithSummary({
        conversationId: conversation!.conversationId,
        startOrdinal: 1,
        endOrdinal: 1,
        summaryId,
      });

      const rewriteTranscriptEntries = vi.fn(async (request: { replacements: unknown[] }) => ({
        changed: true,
        bytesFreed: 123,
        rewrittenEntries: request.replacements.length,
      }));

      const deferred = await engine.maintain({
        sessionId,
        sessionFile,
        runtimeContext: {
          rewriteTranscriptEntries,
        },
      });

      expect(deferred).toEqual({
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
        reason: "transcript GC deferred until host-approved background maintenance",
      });
      expect(rewriteTranscriptEntries).not.toHaveBeenCalled();

      const result = await engine.maintain({
        sessionId,
        sessionFile,
        runtimeContext: {
          allowDeferredCompactionExecution: true,
          rewriteTranscriptEntries,
        },
      });

      expect(result).toEqual({
        changed: true,
        bytesFreed: 123,
        rewrittenEntries: 1,
      });
      expect(rewriteTranscriptEntries).toHaveBeenCalledTimes(1);
      expect(rewriteTranscriptEntries).toHaveBeenCalledWith({
        replacements: [
          {
            entryId: toolResultEntryId,
            message: expect.objectContaining({
              role: "toolResult",
              toolCallId: "call_gc_rewrite",
              toolName: "exec",
            }),
          },
        ],
      });

      const replacement = (
        rewriteTranscriptEntries.mock.calls[0]?.[0] as {
          replacements?: Array<{ message?: { content?: unknown } }>;
        }
      )?.replacements?.[0]?.message;
      expect(replacement?.content).toEqual([
        expect.objectContaining({
          type: "tool_result",
          tool_use_id: "call_gc_rewrite",
          name: "exec",
          output: expect.stringContaining("[LCM Tool Output: file_"),
        }),
      ]);

      const bootstrapState = await engine
        .getSummaryStore()
        .getConversationBootstrapState(conversation!.conversationId);
      const sessionFileStats = statSync(sessionFile);
      expect(bootstrapState).not.toBeNull();
      expect(bootstrapState?.lastSeenSize).toBe(sessionFileStats.size);
      expect(bootstrapState?.lastSeenMtimeMs).toBe(Math.trunc(sessionFileStats.mtimeMs));
      expect(bootstrapState?.lastProcessedOffset).toBe(sessionFileStats.size);
      expect(bootstrapState?.lastProcessedEntryHash).toMatch(/^[a-f0-9]{64}$/);

      const reconcileSpy = vi.spyOn(engine as any, "reconcileSessionTail");
      const bootstrap = await engine.bootstrap({ sessionId, sessionFile });
      expect(bootstrap).toEqual({
        bootstrapped: false,
        importedMessages: 0,
        reason: "conversation already up to date",
      });
      expect(reconcileSpy).not.toHaveBeenCalled();
    });
  });

  it("maintain() skips transcript GC when transcriptGcEnabled is false", async () => {
    await withTempHome(async () => {
      const engine = createEngineWithConfig({
        transcriptGcEnabled: false,
      });
      const sessionId = randomUUID();
      const sessionFile = createSessionFilePath("transcript-gc-disabled");
      const rewriteTranscriptEntries = vi.fn();

      const ingested = await engine.ingest({
        sessionId,
        message: makeMessage({ role: "user", content: "keep LCM active" }),
      });

      expect(ingested).toEqual({ ingested: true });

      const result = await engine.maintain({
        sessionId,
        sessionFile,
        runtimeContext: {
          rewriteTranscriptEntries,
        },
      });

      expect(result).toEqual({
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
        reason: "transcript GC disabled",
      });
      expect(rewriteTranscriptEntries).not.toHaveBeenCalled();
      expect(await engine.getConversationStore().getConversationBySessionId(sessionId)).not.toBeNull();
    });
  });

  it("serializes recycled session writes by stable sessionKey", async () => {
    const engine = createEngine();
    const sessionKey = "agent:main:main";

    await engine.ingest({
      sessionId: "runtime-seed",
      sessionKey,
      message: makeMessage({ role: "assistant", content: "seed" }),
    });

    const store = engine.getConversationStore();
    const originalCreateMessage = store.createMessage.bind(store);
    let releaseFirstCreate: () => void = () => {};
    let unblockFirstCreate!: () => void;
    const firstCreateBlocked = new Promise<void>((resolve) => {
      unblockFirstCreate = resolve;
    });
    let heldFirstCreate = false;

    const createMessageSpy = vi
      .spyOn(store, "createMessage")
      .mockImplementation(async (input) => {
        if (!heldFirstCreate) {
          heldFirstCreate = true;
          unblockFirstCreate();
          await new Promise<void>((resolve) => {
            releaseFirstCreate = resolve;
          });
        }
        return originalCreateMessage(input);
      });

    const firstIngest = engine.ingest({
      sessionId: "runtime-a",
      sessionKey,
      message: makeMessage({ role: "assistant", content: "first recycled reply" }),
    });
    await firstCreateBlocked;

    const secondIngest = engine.ingest({
      sessionId: "runtime-b",
      sessionKey,
      message: makeMessage({ role: "assistant", content: "second recycled reply" }),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(createMessageSpy).toHaveBeenCalledTimes(1);

    releaseFirstCreate();

    await expect(Promise.all([firstIngest, secondIngest])).resolves.toEqual([
      { ingested: true },
      { ingested: true },
    ]);

    const conversation = await store.getConversationBySessionKey(sessionKey);
    expect(conversation).not.toBeNull();
    expect(conversation!.sessionId).toBe("runtime-b");

    const stored = await store.getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "seed",
      "first recycled reply",
      "second recycled reply",
    ]);
  });
});

describe("LcmContextEngine connection lifecycle", () => {
  it("keeps shared sqlite handle open while another engine instance is active", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-shared-db-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "lcm.db");

    const engineA = createEngineAtDatabasePath(dbPath);
    const engineB = createEngineAtDatabasePath(dbPath);
    const sessionId = randomUUID();

    await engineA.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "first" }),
    });

    await engineA.dispose();

    await expect(
      engineB.ingest({
        sessionId,
        message: makeMessage({ role: "assistant", content: "second" }),
      }),
    ).resolves.toEqual({ ingested: true });
  });
});

// ── Bootstrap ───────────────────────────────────────────────────────────────

describe("LcmContextEngine.bootstrap", () => {
  it("imports only active leaf-path messages from SessionManager context", async () => {
    const sessionFile = createSessionFilePath("branched");
    const sm = SessionManager.open(sessionFile);

    const rootUserId = sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "root user" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "abandoned assistant" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "abandoned user" }],
    } as AgentMessage);

    // Re-branch from the first user entry so prior turns are abandoned.
    sm.branch(rootUserId);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "active assistant" }],
    } as AgentMessage);

    const engine = createEngine();
    const sessionId = "bootstrap-leaf-path";
    const result = await engine.bootstrap({ sessionId, sessionFile });

    expect(result.bootstrapped).toBe(true);
    expect(result.importedMessages).toBe(4);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    expect(conversation!.bootstrappedAt).not.toBeNull();

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored).toHaveLength(4);
    expect(stored.map((m) => m.content)).toEqual([
      "root user",
      "abandoned assistant",
      "abandoned user",
      "active assistant",
    ]);

    const contextItems = await engine
      .getSummaryStore()
      .getContextItems(conversation!.conversationId);
    expect(contextItems).toHaveLength(4);
    expect(contextItems.every((item) => item.itemType === "message")).toBe(true);

    const bootstrapState = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    const sessionFileStats = statSync(sessionFile);
    expect(bootstrapState).not.toBeNull();
    expect(bootstrapState?.sessionFilePath).toBe(sessionFile);
    expect(bootstrapState?.lastSeenSize).toBe(sessionFileStats.size);
    expect(bootstrapState?.lastSeenMtimeMs).toBe(Math.trunc(sessionFileStats.mtimeMs));
    expect(bootstrapState?.lastProcessedOffset).toBe(sessionFileStats.size);
    expect(bootstrapState?.lastProcessedEntryHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is idempotent and does not duplicate already bootstrapped sessions", async () => {
    const sessionFile = createSessionFilePath("idempotent");
    const sm = SessionManager.open(sessionFile);
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "first" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "second" }],
    } as AgentMessage);

    const engine = createEngine();
    const sessionId = "bootstrap-idempotent";

    const first = await engine.bootstrap({ sessionId, sessionFile });
    const second = await engine.bootstrap({ sessionId, sessionFile });

    expect(first.bootstrapped).toBe(true);
    expect(first.importedMessages).toBe(2);
    expect(second.bootstrapped).toBe(false);
    expect(second.importedMessages).toBe(0);
    expect(second.reason).toBe("already bootstrapped");

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    expect(await engine.getConversationStore().getMessageCount(conversation!.conversationId)).toBe(
      2,
    );
  });

  it("does not rewrite prior assistant transcript rows when bootstrap re-instantiates a conversation", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "lcm.db");
    const sessionFile = createSessionFilePath("bootstrap-reinstantiation-replay");
    const sm = SessionManager.open(sessionFile);
    const sessionId = "bootstrap-reinstantiation-replay";

    for (let turn = 1; turn <= 5; turn += 1) {
      sm.appendMessage({
        role: "user",
        content: [{ type: "text", text: `question ${turn}` }],
      } as AgentMessage);
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: `answer ${turn}` }],
      } as AgentMessage);
    }

    const engineA = createEngineAtDatabasePath(dbPath);
    const first = await engineA.bootstrap({ sessionId, sessionFile });
    expect(first).toEqual({ bootstrapped: true, importedMessages: 10 });

    const conversation = await engineA.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const before = await engineA.getConversationStore().getMessages(conversation!.conversationId);
    await engineA.dispose();

    for (const answer of ["answer 3", "answer 4", "answer 5"]) {
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: answer }],
      } as AgentMessage);
    }

    const engineB = createEngineAtDatabasePath(dbPath);
    const second = await engineB.bootstrap({ sessionId, sessionFile });
    expect(second.bootstrapped).toBe(false);
    expect(second.importedMessages).toBe(0);

    const after = await engineB.getConversationStore().getMessages(conversation!.conversationId);
    expect(after.map((message) => `${message.role}\0${message.content}`)).toEqual(
      before.map((message) => `${message.role}\0${message.content}`),
    );

    const seen = new Set<string>();
    const duplicateContentRows = after.filter((message) => {
      const identity = `${message.role}\0${message.content}`;
      if (seen.has(identity)) {
        return true;
      }
      seen.add(identity);
      return false;
    });
    expect(duplicateContentRows).toHaveLength(0);
  });

  it("keeps fresh tool-only rows after dropping a replayed assistant prefix", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "lcm.db");
    const sessionFile = createSessionFilePath("bootstrap-reinstantiation-tool-tail");
    const sm = SessionManager.open(sessionFile);
    const sessionId = "bootstrap-reinstantiation-tool-tail";

    for (let turn = 1; turn <= 5; turn += 1) {
      sm.appendMessage({
        role: "user",
        content: [{ type: "text", text: `question ${turn}` }],
      } as AgentMessage);
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: `answer ${turn}` }],
      } as AgentMessage);
    }

    const engineA = createEngineAtDatabasePath(dbPath);
    const first = await engineA.bootstrap({ sessionId, sessionFile });
    expect(first).toEqual({ bootstrapped: true, importedMessages: 10 });

    const conversation = await engineA.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const before = await engineA.getConversationStore().getMessages(conversation!.conversationId);
    await engineA.dispose();

    for (const answer of ["answer 3", "answer 4", "answer 5"]) {
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: answer }],
      } as AgentMessage);
    }
    sm.appendMessage({
      role: "toolResult",
      toolCallId: "call_new",
      content: [{ type: "tool_result", tool_use_id: "call_new", output: { ok: true } }],
    } as AgentMessage);

    const engineB = createEngineAtDatabasePath(dbPath);
    const second = await engineB.bootstrap({ sessionId, sessionFile });
    expect(second.bootstrapped).toBe(true);
    expect(second.importedMessages).toBe(1);
    expect(second.reason).toBe("reconciled missing session messages");

    const after = await engineB.getConversationStore().getMessages(conversation!.conversationId);
    expect(after).toHaveLength(before.length + 1);

    const imported = after[after.length - 1]!;
    expect(imported.role).toBe("tool");
    expect(imported.content).toBe("");

    const parts = await engineB.getConversationStore().getMessageParts(imported.messageId);
    expect(parts.some((part) => part.toolCallId === "call_new")).toBe(true);
  });

  it("keeps legitimate repeated assistant text when the ordering does not match a prior replay", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "lcm.db");
    const sessionFile = createSessionFilePath("bootstrap-repeated-assistant-order");
    const sm = SessionManager.open(sessionFile);
    const sessionId = "bootstrap-repeated-assistant-order";

    for (const [question, answer] of [
      ["question 1", "alpha"],
      ["question 2", "beta"],
      ["question 3", "gamma"],
    ] as const) {
      sm.appendMessage({
        role: "user",
        content: [{ type: "text", text: question }],
      } as AgentMessage);
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: answer }],
      } as AgentMessage);
    }

    const engineA = createEngineAtDatabasePath(dbPath);
    const first = await engineA.bootstrap({ sessionId, sessionFile });
    expect(first).toEqual({ bootstrapped: true, importedMessages: 6 });
    await engineA.dispose();

    const rawDb = createLcmDatabaseConnection(dbPath);
    try {
      rawDb.prepare(`UPDATE messages SET created_at = '2000-01-01 00:00:00'`).run();
    } finally {
      closeLcmConnection(rawDb);
    }

    for (const answer of ["alpha", "gamma", "beta"]) {
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: answer }],
      } as AgentMessage);
    }

    const engineB = createEngineAtDatabasePath(dbPath);
    const second = await engineB.bootstrap({ sessionId, sessionFile });
    expect(second.bootstrapped).toBe(true);
    expect(second.importedMessages).toBe(3);
    expect(second.reason).toBe("reconciled missing session messages");

    const conversation = await engineB.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const after = await engineB.getConversationStore().getMessages(conversation!.conversationId);
    expect(after.slice(-3).map((message) => message.content)).toEqual(["alpha", "gamma", "beta"]);
  });

  it("keeps the replay flood guard active for user-leading append-only replay batches", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "lcm.db");
    const sessionFile = createSessionFilePath("bootstrap-user-leading-replay");
    const sm = SessionManager.open(sessionFile);
    const sessionId = "bootstrap-user-leading-replay";

    for (const [question, answer] of [
      ["question 1", "alpha"],
      ["question 2", "beta"],
      ["question 3", "gamma"],
    ] as const) {
      sm.appendMessage({
        role: "user",
        content: [{ type: "text", text: question }],
      } as AgentMessage);
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: answer }],
      } as AgentMessage);
    }

    const engineA = createEngineAtDatabasePath(dbPath);
    const first = await engineA.bootstrap({ sessionId, sessionFile });
    expect(first).toEqual({ bootstrapped: true, importedMessages: 6 });

    const conversation = await engineA.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const before = await engineA.getConversationStore().getMessages(conversation!.conversationId);
    await engineA.dispose();

    const rawDb = createLcmDatabaseConnection(dbPath);
    try {
      rawDb.prepare(`UPDATE messages SET created_at = '2000-01-01 00:00:00'`).run();
    } finally {
      closeLcmConnection(rawDb);
    }

    for (const question of ["question 1", "question 2", "question 3"]) {
      sm.appendMessage({
        role: "user",
        content: [{ type: "text", text: question }],
      } as AgentMessage);
    }

    const engineB = createEngineAtDatabasePath(dbPath);
    await expect(engineB.bootstrap({ sessionId, sessionFile })).rejects.toThrow(
      "[lcm] refused replay-like message batch",
    );

    const after = await engineB.getConversationStore().getMessages(conversation!.conversationId);
    expect(after).toHaveLength(before.length);
  });

  it("skips reopening the transcript when checkpoint stats match", async () => {
    const sessionFile = createSessionFilePath("unchanged-fast-path");
    const sm = SessionManager.open(sessionFile);
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "first" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "second" }],
    } as AgentMessage);

    const engine = createEngine();
    const sessionId = "bootstrap-unchanged-fast-path";

    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first.bootstrapped).toBe(true);
    expect(first.importedMessages).toBe(2);

    corruptSessionFilePreservingObservedStats(sessionFile);

    const second = await engine.bootstrap({ sessionId, sessionFile });
    expect(second.bootstrapped).toBe(false);
    expect(second.importedMessages).toBe(0);
    expect(second.reason).toBe("already bootstrapped");
  });

  it("preserves ordinary bootstrap behavior when no checkpoint exists", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "lcm.db");
    const sessionFile = createSessionFilePath("missing-checkpoint");
    const sm = SessionManager.open(sessionFile);
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "first" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "second" }],
    } as AgentMessage);

    const engine = createEngineAtDatabasePath(dbPath);
    const sessionId = "bootstrap-missing-checkpoint";

    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first.bootstrapped).toBe(true);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const rawDb = createLcmDatabaseConnection(dbPath);
    try {
      rawDb
        .prepare(`DELETE FROM conversation_bootstrap_state WHERE conversation_id = ?`)
        .run(conversation!.conversationId);
      rawDb
        .prepare(`UPDATE conversations SET bootstrapped_at = NULL WHERE conversation_id = ?`)
        .run(conversation!.conversationId);
    } finally {
      closeLcmConnection(rawDb);
    }

    corruptSessionFilePreservingObservedStats(sessionFile);

    await expect(engine.bootstrap({ sessionId, sessionFile })).resolves.toEqual({
      bootstrapped: false,
      importedMessages: 0,
      reason: "conversation already has messages",
    });
  });

  it("preserves existing conversation data when the session file rotates", async () => {
    const firstSessionFile = createSessionFilePath("rotation-old");
    const firstManager = SessionManager.open(firstSessionFile);
    firstManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "old user" }],
    } as AgentMessage);
    firstManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "old assistant" }],
    } as AgentMessage);

    const engine = createEngine();
    const sessionId = "bootstrap-rotation";

    const first = await engine.bootstrap({ sessionId, sessionFile: firstSessionFile });
    expect(first).toEqual({
      bootstrapped: true,
      importedMessages: 2,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    await engine.getSummaryStore().insertSummary({
      summaryId: "sum_rotation_old",
      conversationId: conversation!.conversationId,
      kind: "leaf",
      content: "old summary",
      tokenCount: 5,
    });
    await engine.getSummaryStore().appendContextSummary(conversation!.conversationId, "sum_rotation_old");

    const rotatedSessionFile = createSessionFilePath("rotation-new");
    const rotatedManager = SessionManager.open(rotatedSessionFile);
    rotatedManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "old user" }],
    } as AgentMessage);
    rotatedManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "old assistant" }],
    } as AgentMessage);
    rotatedManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "new user" }],
    } as AgentMessage);
    rotatedManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "new assistant" }],
    } as AgentMessage);

    const second = await engine.bootstrap({ sessionId, sessionFile: rotatedSessionFile });
    expect(second).toEqual({
      bootstrapped: true,
      importedMessages: 2,
      reason: "reconciled missing session messages",
    });

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old user",
      "old assistant",
      "new user",
      "new assistant",
    ]);

    const contextItems = await engine.getSummaryStore().getContextItems(conversation!.conversationId);
    expect(contextItems.some((item) => item.itemType === "summary")).toBe(true);
    expect(contextItems.filter((item) => item.itemType === "message")).toHaveLength(4);

    const rotatedBootstrapState = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(rotatedBootstrapState?.sessionFilePath).toBe(rotatedSessionFile);
    expect(await engine.getSummaryStore().getSummary("sum_rotation_old")).not.toBeNull();
  });

  it("preserves conversation history when the session file rotates across a stable sessionKey", async () => {
    const engine = createEngine();
    const firstSessionId = "bootstrap-rotation-session-key-1";
    const secondSessionId = "bootstrap-rotation-session-key-2";
    const sessionKey = "agent:main:test:bootstrap-rotation";
    const firstSessionFile = createSessionFilePath("rotation-session-key-old");
    const firstManager = SessionManager.open(firstSessionFile);
    firstManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "old keyed user" }],
    } as AgentMessage);
    firstManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "old keyed assistant" }],
    } as AgentMessage);

    const first = await engine.bootstrap({
      sessionId: firstSessionId,
      sessionKey,
      sessionFile: firstSessionFile,
    });
    expect(first).toEqual({
      bootstrapped: true,
      importedMessages: 2,
    });

    const firstConversation = await engine.getConversationStore().getConversationForSession({
      sessionId: firstSessionId,
      sessionKey,
    });
    expect(firstConversation).not.toBeNull();

    await engine.getSummaryStore().insertSummary({
      summaryId: "sum_rotation_session_key_old",
      conversationId: firstConversation!.conversationId,
      kind: "leaf",
      content: "old keyed summary",
      tokenCount: 5,
    });
    await engine
      .getSummaryStore()
      .appendContextSummary(firstConversation!.conversationId, "sum_rotation_session_key_old");

    const rotatedSessionFile = createSessionFilePath("rotation-session-key-new");
    const rotatedManager = SessionManager.open(rotatedSessionFile);
    rotatedManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "old keyed user" }],
    } as AgentMessage);
    rotatedManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "old keyed assistant" }],
    } as AgentMessage);
    rotatedManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "new keyed user" }],
    } as AgentMessage);
    rotatedManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "new keyed assistant" }],
    } as AgentMessage);

    const second = await engine.bootstrap({
      sessionId: secondSessionId,
      sessionKey,
      sessionFile: rotatedSessionFile,
    });
    expect(second).toEqual({
      bootstrapped: true,
      importedMessages: 2,
      reason: "reconciled missing session messages",
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId: secondSessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    expect(conversation!.conversationId).toBe(firstConversation!.conversationId);
    expect(conversation!.sessionId).toBe(secondSessionId);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old keyed user",
      "old keyed assistant",
      "new keyed user",
      "new keyed assistant",
    ]);

    const contextItems = await engine.getSummaryStore().getContextItems(conversation!.conversationId);
    expect(contextItems.some((item) => item.itemType === "summary")).toBe(true);
    expect(contextItems.filter((item) => item.itemType === "message")).toHaveLength(4);

    const rotatedBootstrapState = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(rotatedBootstrapState?.sessionFilePath).toBe(rotatedSessionFile);
    expect(await engine.getSummaryStore().getSummary("sum_rotation_session_key_old")).not.toBeNull();
  });

  it("rotates to a fresh conversation when a stable sessionKey resumes on a new transcript after the old file disappears", async () => {
    const engine = createEngine();
    const firstSessionId = "bootstrap-missed-reset-fallback-1";
    const secondSessionId = "bootstrap-missed-reset-fallback-2";
    const sessionKey = "agent:main:test:bootstrap-missed-reset-fallback";
    const firstSessionFile = createSessionFilePath("missed-reset-fallback-old");
    const firstManager = SessionManager.open(firstSessionFile);
    firstManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "old user" }],
    } as AgentMessage);
    firstManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "old assistant" }],
    } as AgentMessage);

    const first = await engine.bootstrap({
      sessionId: firstSessionId,
      sessionKey,
      sessionFile: firstSessionFile,
    });
    expect(first).toEqual({
      bootstrapped: true,
      importedMessages: 2,
    });

    const originalConversation = await engine.getConversationStore().getConversationForSession({
      sessionId: firstSessionId,
      sessionKey,
    });
    expect(originalConversation).not.toBeNull();

    await engine.getSummaryStore().insertSummary({
      summaryId: "sum_missed_reset_fallback_old",
      conversationId: originalConversation!.conversationId,
      kind: "leaf",
      content: "old summary",
      tokenCount: 5,
    });
    await engine
      .getSummaryStore()
      .appendContextSummary(originalConversation!.conversationId, "sum_missed_reset_fallback_old");

    rmSync(firstSessionFile, { force: true });

    const secondSessionFile = createSessionFilePath("missed-reset-fallback-new");
    const secondManager = SessionManager.open(secondSessionFile);
    secondManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "new user" }],
    } as AgentMessage);
    secondManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "new assistant" }],
    } as AgentMessage);

    const second = await engine.bootstrap({
      sessionId: secondSessionId,
      sessionKey,
      sessionFile: secondSessionFile,
    });
    expect(second).toEqual({
      bootstrapped: true,
      importedMessages: 2,
    });

    const activeConversation = await engine.getConversationStore().getConversationForSession({
      sessionId: secondSessionId,
      sessionKey,
    });
    expect(activeConversation).not.toBeNull();
    expect(activeConversation!.conversationId).not.toBe(originalConversation!.conversationId);
    expect(activeConversation!.sessionId).toBe(secondSessionId);
    expect(activeConversation!.active).toBe(true);

    const archivedConversation = await engine.getConversationStore().getConversation(
      originalConversation!.conversationId,
    );
    expect(archivedConversation?.active).toBe(false);
    expect(archivedConversation?.archivedAt).not.toBeNull();

    const archivedMessages = await engine.getConversationStore().getMessages(
      originalConversation!.conversationId,
    );
    expect(archivedMessages.map((message) => message.content)).toEqual([
      "old user",
      "old assistant",
    ]);

    const activeMessages = await engine.getConversationStore().getMessages(
      activeConversation!.conversationId,
    );
    expect(activeMessages.map((message) => message.content)).toEqual([
      "new user",
      "new assistant",
    ]);
  });

  it("rotates before assemble when a stable sessionKey points at a pruned transcript", async () => {
    const engine = createEngine();
    const firstSessionId = "assemble-missed-reset-fallback-1";
    const secondSessionId = "assemble-missed-reset-fallback-2";
    const sessionKey = "agent:main:test:assemble-missed-reset-fallback";
    const firstSessionFile = createSessionFilePath("assemble-missed-reset-fallback-old");
    writeLeafTranscript(firstSessionFile, [
      { role: "user", content: "what model produced this response?" },
      { role: "assistant", content: "openai-codex/gpt-5.5" },
    ]);

    const first = await engine.bootstrap({
      sessionId: firstSessionId,
      sessionKey,
      sessionFile: firstSessionFile,
    });
    expect(first).toEqual({
      bootstrapped: true,
      importedMessages: 2,
    });

    const originalConversation = await engine.getConversationStore().getConversationForSession({
      sessionId: firstSessionId,
      sessionKey,
    });
    expect(originalConversation).not.toBeNull();

    rmSync(firstSessionFile, { force: true });

    const newSessionFile = createSessionFilePath("assemble-missed-reset-fallback-new");
    writeLeafTranscript(newSessionFile, [
      { role: "user", content: "new live prompt" },
      { role: "assistant", content: "new assistant reply" },
    ]);
    const liveMessages = [makeMessage({ role: "user", content: "new live prompt" })];
    const assembled = await engine.assemble({
      sessionId: secondSessionId,
      sessionKey,
      messages: liveMessages,
      tokenBudget: 4_096,
    });

    expect(assembled.messages).toEqual(liveMessages);
    expect(
      assembled.messages.some((message) => message.content === "openai-codex/gpt-5.5"),
    ).toBe(false);

    const activeConversationBeforeAfterTurn = await engine.getConversationStore().getConversationForSession({
      sessionId: secondSessionId,
      sessionKey,
    });
    expect(activeConversationBeforeAfterTurn).toBeNull();

    const archivedConversation = await engine.getConversationStore().getConversation(
      originalConversation!.conversationId,
    );
    expect(archivedConversation?.active).toBe(false);
    expect(archivedConversation?.archivedAt).not.toBeNull();

    await engine.afterTurn({
      sessionId: secondSessionId,
      sessionKey,
      sessionFile: newSessionFile,
      messages: [makeMessage({ role: "assistant", content: "new assistant reply" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const activeConversation = await engine.getConversationStore().getConversationForSession({
      sessionId: secondSessionId,
      sessionKey,
    });
    expect(activeConversation).not.toBeNull();
    expect(activeConversation!.conversationId).not.toBe(originalConversation!.conversationId);
    expect(activeConversation!.sessionId).toBe(secondSessionId);
    expect(activeConversation!.active).toBe(true);

    const storedActiveMessages = await engine.getConversationStore().getMessages(
      activeConversation!.conversationId,
    );
    expect(storedActiveMessages.map((message) => message.content)).toEqual([
      "new live prompt",
      "new assistant reply",
    ]);
  });

  it("preserves the active conversation when the tracked transcript stat fails for a non-missing reason", async () => {
    const engine = createEngine();
    const firstSessionId = "bootstrap-stat-failure-fallback-1";
    const secondSessionId = "bootstrap-stat-failure-fallback-2";
    const sessionKey = "agent:main:test:bootstrap-stat-failure-fallback";
    const firstSessionFile = createSessionFilePath("stat-failure-fallback-old");
    const firstManager = SessionManager.open(firstSessionFile);
    firstManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "old user" }],
    } as AgentMessage);
    firstManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "old assistant" }],
    } as AgentMessage);

    const first = await engine.bootstrap({
      sessionId: firstSessionId,
      sessionKey,
      sessionFile: firstSessionFile,
    });
    expect(first).toEqual({
      bootstrapped: true,
      importedMessages: 2,
    });

    const originalConversation = await engine.getConversationStore().getConversationForSession({
      sessionId: firstSessionId,
      sessionKey,
    });
    expect(originalConversation).not.toBeNull();

    await engine.getSummaryStore().insertSummary({
      summaryId: "sum_stat_failure_fallback_old",
      conversationId: originalConversation!.conversationId,
      kind: "leaf",
      content: "old summary",
      tokenCount: 5,
    });
    await engine
      .getSummaryStore()
      .appendContextSummary(originalConversation!.conversationId, "sum_stat_failure_fallback_old");

    const secondSessionFile = createSessionFilePath("stat-failure-fallback-new");
    const secondManager = SessionManager.open(secondSessionFile);
    secondManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "old user" }],
    } as AgentMessage);
    secondManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "old assistant" }],
    } as AgentMessage);
    secondManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "new user" }],
    } as AgentMessage);
    secondManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "new assistant" }],
    } as AgentMessage);

    const firstSessionDir = dirname(firstSessionFile);
    const firstSessionDirMode = statSync(firstSessionDir).mode & 0o777;
    chmodSync(firstSessionDir, 0o000);

    let second: Awaited<ReturnType<LcmContextEngine["bootstrap"]>>;
    try {
      second = await engine.bootstrap({
        sessionId: secondSessionId,
        sessionKey,
        sessionFile: secondSessionFile,
      });
    } finally {
      chmodSync(firstSessionDir, firstSessionDirMode);
    }

    expect(second).toEqual({
      bootstrapped: true,
      importedMessages: 2,
      reason: "reconciled missing session messages",
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId: secondSessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    expect(conversation!.conversationId).toBe(originalConversation!.conversationId);
    expect(conversation!.sessionId).toBe(secondSessionId);
    expect(conversation!.active).toBe(true);

    const archivedConversation = await engine.getConversationStore().getConversation(
      originalConversation!.conversationId,
    );
    expect(archivedConversation?.archivedAt).toBeNull();

    const storedMessages = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(storedMessages.map((message) => message.content)).toEqual([
      "old user",
      "old assistant",
      "new user",
      "new assistant",
    ]);

    expect(await engine.getSummaryStore().getSummary("sum_stat_failure_fallback_old")).not.toBeNull();
  });

  it("does not reapply bootstrapMaxTokens after session file rotation", async () => {
    const engine = createEngineWithConfig({ bootstrapMaxTokens: 250 });
    const firstSessionId = "bootstrap-rotation-full-reseed-1";
    const secondSessionId = "bootstrap-rotation-full-reseed-2";
    const sessionKey = "agent:main:test:bootstrap-rotation-full-reseed";
    const firstSessionFile = createSessionFilePath("rotation-full-reseed-old");
    const firstManager = SessionManager.open(firstSessionFile);
    firstManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "old seed user" }],
    } as AgentMessage);
    firstManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "old seed assistant" }],
    } as AgentMessage);

    const first = await engine.bootstrap({
      sessionId: firstSessionId,
      sessionKey,
      sessionFile: firstSessionFile,
    });
    expect(first).toEqual({
      bootstrapped: true,
      importedMessages: 2,
    });

    const rotatedSessionFile = createSessionFilePath("rotation-full-reseed-new");
    const rotatedManager = SessionManager.open(rotatedSessionFile);
    const originalMessages = [
      {
        role: "user",
        content: [{ type: "text", text: "old seed user" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "old seed assistant" }],
      },
    ] as AgentMessage[];
    for (const message of originalMessages) {
      rotatedManager.appendMessage(message);
    }
    const rotatedMessages = Array.from({ length: 5 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `rotated turn ${index} ${"x".repeat(396)}` }],
    })) as AgentMessage[];
    for (const message of rotatedMessages) {
      rotatedManager.appendMessage(message);
    }

    const second = await engine.bootstrap({
      sessionId: secondSessionId,
      sessionKey,
      sessionFile: rotatedSessionFile,
    });
    expect(second).toEqual({
      bootstrapped: true,
      importedMessages: 5,
      reason: "reconciled missing session messages",
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId: secondSessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual(
      [...originalMessages, ...rotatedMessages].map(
        (message) => (message.content[0] as { text: string }).text,
      ),
    );
  });

  it("rotates the current transcript in place without replacing the conversation", async () => {
    const sessionFile = createSessionFilePath("lcm-rotate-storage");
    const sessionKey = "agent:main:main";
    const sessionId = "rotate-storage-session";
    const sm = SessionManager.open(sessionFile);
    const originalMessages = [
      { role: "user", content: [{ type: "text", text: "old user 1" }] },
      { role: "assistant", content: [{ type: "text", text: "old assistant 1" }] },
      { role: "user", content: [{ type: "text", text: "old user 2" }] },
      { role: "assistant", content: [{ type: "text", text: "old assistant 2" }] },
      { role: "user", content: [{ type: "text", text: "tail user" }] },
      { role: "assistant", content: [{ type: "text", text: "tail assistant" }] },
    ] as AgentMessage[];
    for (const message of originalMessages) {
      sm.appendMessage(message);
    }

    const engine = createEngineWithConfig({ freshTailCount: 2 });

    const first = await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    expect(first).toEqual({
      bootstrapped: true,
      importedMessages: 6,
    });

    const original = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(original).not.toBeNull();
    const originalStoredMessages = await engine.getConversationStore().getMessages(original!.conversationId);

    await engine.getSummaryStore().insertSummary({
      summaryId: "sum_rotate_old_history",
      conversationId: original!.conversationId,
      kind: "leaf",
      content: "summarized old history",
      tokenCount: 12,
    });
    await engine.getSummaryStore().linkSummaryToMessages(
      "sum_rotate_old_history",
      originalStoredMessages.slice(0, 4).map((message) => message.messageId),
    );
    await engine.getSummaryStore().replaceContextRangeWithSummary({
      conversationId: original!.conversationId,
      startOrdinal: 0,
      endOrdinal: 3,
      summaryId: "sum_rotate_old_history",
    });

    const originalSize = statSync(sessionFile).size;
    const rotate = await engine.rotateSessionStorage({
      sessionId,
      sessionKey,
      sessionFile,
    });
    expect(rotate).toEqual({
      kind: "rotated",
      conversationId: original!.conversationId,
      preservedTailMessageCount: 2,
      checkpointSize: statSync(sessionFile).size,
      bytesRemoved: expect.any(Number),
    });
    expect(rotate.kind === "rotated" ? rotate.bytesRemoved : 0).toBeGreaterThan(0);
    expect(statSync(sessionFile).size).toBeLessThan(originalSize);

    const active = await engine.getConversationStore().getConversationForSession({ sessionId, sessionKey });
    expect(active?.conversationId).toBe(original!.conversationId);
    expect(await engine.getConversationStore().getMessageCount(active!.conversationId)).toBe(6);
    expect(await engine.getSummaryStore().getSummary("sum_rotate_old_history")).not.toBeNull();

    const rotatedBootstrapState = await engine
      .getSummaryStore()
      .getConversationBootstrapState(original!.conversationId);
    expect(rotatedBootstrapState?.sessionFilePath).toBe(sessionFile);
    expect(rotatedBootstrapState?.lastProcessedOffset).toBe(statSync(sessionFile).size);
    expect(rotatedBootstrapState?.lastProcessedEntryHash).toMatch(/^[a-f0-9]{64}$/);

    const rotatedManager = SessionManager.open(sessionFile);
    const rotatedBranchMessages = rotatedManager
      .getBranch()
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message);
    expect(rotatedBranchMessages.map((message) => (message.content[0] as { text: string }).text)).toEqual([
      "tail user",
      "tail assistant",
    ]);

    const checkpointHit = await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    expect(checkpointHit.bootstrapped).toBe(false);
    expect(checkpointHit.importedMessages).toBe(0);

    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "new user" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "new assistant" }],
    } as AgentMessage);

    const appended = await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    expect(appended).toEqual({
      bootstrapped: true,
      importedMessages: 2,
      reason: "reconciled missing session messages",
    });

    const storedMessages = await engine.getConversationStore().getMessages(original!.conversationId);
    expect(storedMessages.map((message) => message.content)).toEqual([
      "old user 1",
      "old assistant 1",
      "old user 2",
      "old assistant 2",
      "tail user",
      "tail assistant",
      "new user",
      "new assistant",
    ]);
  });

  it("waits for an in-flight managed transaction before backing up and rotating", async () => {
    const sessionFile = createSessionFilePath("lcm-rotate-storage-wait");
    const sessionManager = SessionManager.inMemory(process.cwd());
    sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "existing" }],
    } as AgentMessage);
    writeFileSync(
      sessionFile,
      [
        JSON.stringify(sessionManager.getHeader()),
        ...sessionManager.getBranch().map((entry) => JSON.stringify(entry)),
      ].join("\n") + "\n",
    );
    const engine = createEngine();
    const sessionId = "rotate-storage-wait-session";
    const sessionKey = "agent:main:main";

    const first = await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    expect(first).toEqual({
      bootstrapped: true,
      importedMessages: 1,
    });

    const current = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(current).not.toBeNull();

    let releaseTransaction!: () => void;
    let notifyTransactionStarted!: () => void;
    const transactionStarted = new Promise<void>((resolve) => {
      notifyTransactionStarted = resolve;
    });
    const transactionGate = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });

    const pendingTransaction = engine.getConversationStore().withTransaction(async () => {
      const nextSeq = (await engine.getConversationStore().getMaxSeq(current!.conversationId)) + 1;
      await engine.getConversationStore().createMessage({
        conversationId: current!.conversationId,
        seq: nextSeq,
        role: "assistant",
        content: "queued rotate message",
        tokenCount: 3,
      });
      notifyTransactionStarted();
      await transactionGate;
    });

    await transactionStarted;

    let rotateResolved = false;
    const rotatePromise = engine
      .rotateSessionStorageWithBackup({
        sessionId,
        sessionKey,
        sessionFile,
        lockTimeoutMs: 1_000,
      })
      .then((result) => {
        rotateResolved = true;
        return result;
      });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(rotateResolved).toBe(false);

    releaseTransaction();
    await pendingTransaction;

    const rotate = await rotatePromise;
    expect(rotate).toMatchObject({
      kind: "rotated",
      currentConversationId: current!.conversationId,
      currentMessageCount: 2,
      preservedTailMessageCount: 1,
    });
    if (rotate.kind !== "rotated") {
      throw new Error(`Expected rotate to succeed, received ${rotate.kind}`);
    }

    const backupDb = createLcmDatabaseConnection(rotate.backupPath);
    try {
      const backedUpMessageCount = backupDb
        .prepare(`SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?`)
        .get(current!.conversationId) as { count: number };
      expect(backedUpMessageCount.count).toBe(2);
    } finally {
      closeLcmConnection(backupDb);
    }
  });

  it("reports rotate as unavailable when the session transcript cannot be read", async () => {
    const engine = createEngine();

    const conversation = await engine.getConversationStore().createConversation({
      sessionId: "rotate-unreadable-session",
      sessionKey: "agent:main:main",
    });
    await engine.getConversationStore().createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: "seed",
        tokenCount: 1,
      },
    ]);

    const result = await engine.rotateSessionStorage({
      sessionId: "rotate-unreadable-session",
      sessionKey: "agent:main:main",
      sessionFile: join(tmpdir(), `missing-rotate-transcript-${Date.now()}.jsonl`),
    });

    expect(result.kind).toBe("unavailable");
    expect(result.reason).toContain("could not rotate the current session transcript");
  });

  it("defers oversized session-file rewrites from afterTurn runtime hooks", async () => {
    const sessionFile = createSessionFilePath("auto-rotate-runtime");
    const messages = createBulkySession(sessionFile, 14);
    const original = readFileSync(sessionFile, "utf8");
    const beforeSize = statSync(sessionFile).size;
    const databaseDir = mkdtempSync(join(tmpdir(), "lossless-claw-auto-rotate-db-"));
    tempDirs.push(databaseDir);
    const databasePath = join(databaseDir, "lcm.db");
    const latestBackupPath = join(databaseDir, "lcm.db.rotate-latest.bak");
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const engine = createEngineWithDeps(
      {
        databasePath,
        freshTailCount: 1,
        autoRotateSessionFiles: {
          enabled: true,
          createBackups: false,
          sizeBytes: 1_500,
          startup: "off",
          runtime: "rotate",
        },
      },
      { log },
    );
    const sessionId = "auto-rotate-runtime-session";
    const sessionKey = "agent:main:test:auto-rotate-runtime";

    await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages,
      prePromptMessageCount: messages.length,
    });

    const afterSize = statSync(sessionFile).size;
    expect(beforeSize).toBeGreaterThan(1_500);
    expect(afterSize).toBe(beforeSize);
    expect(readFileSync(sessionFile, "utf8")).toBe(original);
    const autoRotateLogs = log.info.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith("[lcm] auto-rotate:"));
    const skipLog = autoRotateLogs.find((message) =>
      message.includes("phase=runtime action=skip"),
    );
    expect(skipLog).toContain(`sessionId=${sessionId}`);
    expect(skipLog).toContain(`sessionKey=${sessionKey}`);
    expect(skipLog).toContain(`sessionFile=${sessionFile}`);
    expect(skipLog).toContain("sizeBytes=");
    expect(skipLog).toContain("thresholdBytes=1500");
    expect(skipLog).toContain("durationMs=");
    expect(skipLog).toContain("reason=after-turn-session-file-rewrite-deferred-to-startup-or-manual-rotate");
    expect(autoRotateLogs.some((message) => message.includes("phase=runtime action=rotate"))).toBe(false);
    expect(existsSync(latestBackupPath)).toBe(false);
  });

  it("does not directly auto-rotate session files during background maintenance", async () => {
    const sessionFile = createSessionFilePath("auto-rotate-background-maintenance");
    createBulkySession(sessionFile, 14);
    const original = readFileSync(sessionFile, "utf8");
    const beforeSize = statSync(sessionFile).size;
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const engine = createEngineWithDeps(
      {
        freshTailCount: 1,
        autoRotateSessionFiles: {
          enabled: true,
          createBackups: false,
          sizeBytes: 1_500,
          startup: "off",
          runtime: "rotate",
        },
      },
      { log },
    );
    const sessionId = "auto-rotate-background-maintenance-session";
    const sessionKey = "agent:main:test:auto-rotate-background-maintenance";

    await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    await engine.maintain({
      sessionId,
      sessionKey,
      sessionFile,
      runtimeContext: {
        allowDeferredCompactionExecution: true,
      },
    });

    const afterSize = statSync(sessionFile).size;
    expect(beforeSize).toBeGreaterThan(1_500);
    expect(afterSize).toBe(beforeSize);
    expect(readFileSync(sessionFile, "utf8")).toBe(original);
    const autoRotateLogs = log.info.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith("[lcm] auto-rotate:"));
    const skipLog = autoRotateLogs.find((message) =>
      message.includes("phase=runtime action=skip"),
    );
    expect(skipLog).toContain(`sessionId=${sessionId}`);
    expect(skipLog).toContain(`sessionKey=${sessionKey}`);
    expect(skipLog).toContain(`sessionFile=${sessionFile}`);
    expect(skipLog).toContain("sizeBytes=");
    expect(skipLog).toContain("thresholdBytes=1500");
    expect(skipLog).toContain("durationMs=");
    expect(skipLog).toContain("reason=runtime-session-file-rewrite-deferred-to-startup-or-manual-rotate");
    expect(autoRotateLogs.some((message) => message.includes("phase=runtime action=rotate"))).toBe(false);
  });

  it("does not rewrite oversized session files from maintain runtime checks", async () => {
    const sessionFile = createSessionFilePath("auto-rotate-maintain-active-turn");
    createBulkySession(sessionFile, 14);
    const original = readFileSync(sessionFile, "utf8");
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const engine = createEngineWithDeps(
      {
        freshTailCount: 1,
        autoRotateSessionFiles: {
          enabled: true,
          createBackups: false,
          sizeBytes: 1_500,
          startup: "off",
          runtime: "rotate",
        },
      },
      { log },
    );
    const sessionId = "auto-rotate-maintain-active-turn-session";
    const sessionKey = "agent:main:test:auto-rotate-maintain-active-turn";

    await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    await engine.maintain({
      sessionId,
      sessionKey,
      sessionFile,
      runtimeContext: {},
    });

    expect(readFileSync(sessionFile, "utf8")).toBe(original);
    const autoRotateLogs = log.info.mock.calls.map(([message]) => String(message));
    expect(autoRotateLogs).toEqual(
      expect.arrayContaining([
        expect.stringContaining("phase=runtime action=skip"),
        expect.stringContaining("reason=runtime-session-file-rewrite-deferred-to-startup-or-manual-rotate"),
      ]),
    );
  });

  it("leaves below-threshold session files alone while logging the decision", async () => {
    const sessionFile = createSessionFilePath("auto-rotate-below-threshold");
    const messages = createBulkySession(sessionFile, 4);
    const beforeSize = statSync(sessionFile).size;
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const engine = createEngineWithDeps(
      {
        autoRotateSessionFiles: {
          enabled: true,
          createBackups: false,
          sizeBytes: beforeSize + 1_000,
          startup: "off",
          runtime: "rotate",
        },
      },
      { log },
    );
    const sessionId = "auto-rotate-below-session";
    const sessionKey = "agent:main:test:auto-rotate-below";

    await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages,
      prePromptMessageCount: messages.length,
    });

    expect(statSync(sessionFile).size).toBe(beforeSize);
    const autoRotateLogs = log.info.mock.calls.map(([message]) => String(message));
    expect(autoRotateLogs).toEqual(
      expect.arrayContaining([
        expect.stringContaining("phase=runtime action=skip"),
        expect.stringContaining("reason=below-threshold"),
      ]),
    );
  });

  it("skips ignored, stateless, and untracked runtime sessions", async () => {
    const sessionFile = createSessionFilePath("auto-rotate-skip-guards");
    const messages = createBulkySession(sessionFile, 10);
    const original = readFileSync(sessionFile, "utf8");
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const engine = createEngineWithDeps(
      {
        ignoreSessionPatterns: ["agent:*:cron:**"],
        statelessSessionPatterns: ["agent:*:subagent:**"],
        autoRotateSessionFiles: {
          enabled: true,
          createBackups: false,
          sizeBytes: 500,
          startup: "off",
          runtime: "rotate",
        },
      },
      { log },
    );

    await engine.afterTurn({
      sessionId: "auto-rotate-ignored-session",
      sessionKey: "agent:main:cron:nightly",
      sessionFile,
      messages,
      prePromptMessageCount: messages.length,
    });
    await engine.afterTurn({
      sessionId: "auto-rotate-stateless-session",
      sessionKey: "agent:main:subagent:worker",
      sessionFile,
      messages,
      prePromptMessageCount: messages.length,
    });
    await engine.afterTurn({
      sessionId: "auto-rotate-untracked-session",
      sessionKey: "agent:main:test:auto-rotate-untracked",
      sessionFile,
      messages: [messages[0]!],
      prePromptMessageCount: 0,
      isHeartbeat: true,
    });

    expect(readFileSync(sessionFile, "utf8")).toBe(original);
    const autoRotateLogs = log.info.mock.calls.map(([message]) => String(message));
    expect(autoRotateLogs).toEqual(
      expect.arrayContaining([
        expect.stringContaining("reason=session-excluded"),
        expect.stringContaining("reason=stateless-session"),
        expect.stringContaining("reason=no-active-conversation"),
      ]),
    );
  });

  it("startup scan rotates oversized active conversations with checkpointed files", async () => {
    const sessionFile = createSessionFilePath("auto-rotate-startup");
    const messages = createBulkySession(sessionFile, 14);
    const beforeSize = statSync(sessionFile).size;
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const sessionId = "auto-rotate-startup-session";
    const sessionKey = "agent:main:test:auto-rotate-startup";
    const listStartupSessionFileCandidates = vi.fn(async () => [
      { sessionId, sessionKey, sessionFile },
    ]);
    const engine = createEngineWithDeps(
      {
        freshTailCount: 1,
        autoRotateSessionFiles: {
          enabled: true,
          createBackups: false,
          sizeBytes: 1_500,
          startup: "rotate",
          runtime: "off",
        },
      },
      { log, listStartupSessionFileCandidates },
    );

    await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    await engine.autoRotateManagedSessionFilesAtStartup();

    expect(beforeSize).toBeGreaterThan(1_500);
    expect(statSync(sessionFile).size).toBeLessThan(beforeSize);
    const autoRotateLogs = log.info.mock.calls.map(([message]) => String(message));
    expect(autoRotateLogs).toEqual(
      expect.arrayContaining([
        expect.stringContaining("phase=startup action=rotate"),
      ]),
    );
    expect(autoRotateLogs.some((message) => message.includes("backupPath="))).toBe(false);
    const summaryLog = autoRotateLogs.find((message) => message.includes("action=summary"));
    expect(summaryLog).toContain("backupCreated=0");
    expect(readSessionMessages(sessionFile)).toHaveLength(1);
    expect(readSessionMessages(sessionFile)[0]?.role).toBe(messages[messages.length - 1]?.role);
  });

  it("startup scan ignores stale active LCM conversations outside indexed candidates", async () => {
    const indexedSessionFile = createSessionFilePath("auto-rotate-indexed-startup");
    const staleSessionFile = createSessionFilePath("auto-rotate-stale-startup");
    createBulkySession(indexedSessionFile, 14);
    createBulkySession(staleSessionFile, 14);
    const indexedBeforeSize = statSync(indexedSessionFile).size;
    const staleBeforeSize = statSync(staleSessionFile).size;
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const indexedSessionId = "auto-rotate-indexed-session";
    const indexedSessionKey = "agent:main:test:auto-rotate-indexed";
    const staleSessionId = "auto-rotate-stale-session";
    const staleSessionKey = "agent:old:test:auto-rotate-stale";
    const engine = createEngineWithDeps(
      {
        freshTailCount: 1,
        autoRotateSessionFiles: {
          enabled: true,
          createBackups: false,
          sizeBytes: 1_500,
          startup: "rotate",
          runtime: "off",
        },
      },
      {
        log,
        listStartupSessionFileCandidates: vi.fn(async () => [
          {
            sessionId: indexedSessionId,
            sessionKey: indexedSessionKey,
            sessionFile: indexedSessionFile,
          },
        ]),
      },
    );

    await engine.bootstrap({
      sessionId: indexedSessionId,
      sessionKey: indexedSessionKey,
      sessionFile: indexedSessionFile,
    });
    await engine.bootstrap({
      sessionId: staleSessionId,
      sessionKey: staleSessionKey,
      sessionFile: staleSessionFile,
    });
    await engine.autoRotateManagedSessionFilesAtStartup();

    expect(statSync(indexedSessionFile).size).toBeLessThan(indexedBeforeSize);
    expect(statSync(staleSessionFile).size).toBe(staleBeforeSize);
    const autoRotateLogs = log.info.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith("[lcm] auto-rotate:"));
    expect(autoRotateLogs.filter((message) => message.includes("action=rotate"))).toHaveLength(1);
    const summaryLog = autoRotateLogs.find((message) => message.includes("action=summary"));
    expect(summaryLog).toContain("scanned=1");
    expect(summaryLog).toContain("eligible=1");
    expect(summaryLog).toContain("rotated=1");
    expect(summaryLog).toContain("skipped=0");
  });

  it("startup scan logs one compact summary for quiet skips", async () => {
    const rotateSessionFile = createSessionFilePath("auto-rotate-summary-rotate");
    const belowSessionFile = createSessionFilePath("auto-rotate-summary-below");
    const missingSessionFile = createSessionFilePath("auto-rotate-summary-missing");
    createBulkySession(rotateSessionFile, 14);
    createBulkySession(belowSessionFile, 4);
    const belowThresholdBytes = statSync(belowSessionFile).size + 500;
    rmSync(missingSessionFile, { force: true });
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const rotateSessionId = "auto-rotate-summary-rotate-session";
    const rotateSessionKey = "agent:main:test:auto-rotate-summary-rotate";
    const belowSessionId = "auto-rotate-summary-below-session";
    const belowSessionKey = "agent:main:test:auto-rotate-summary-below";
    const missingSessionId = "auto-rotate-summary-missing-session";
    const missingSessionKey = "agent:main:test:auto-rotate-summary-missing";
    const noBootstrapSessionId = "auto-rotate-summary-no-bootstrap-session";
    const noBootstrapSessionKey = "agent:main:test:auto-rotate-summary-no-bootstrap";
    const engine = createEngineWithDeps(
      {
        freshTailCount: 1,
        autoRotateSessionFiles: {
          enabled: true,
          createBackups: false,
          sizeBytes: belowThresholdBytes,
          startup: "rotate",
          runtime: "off",
        },
      },
      {
        log,
        listStartupSessionFileCandidates: vi.fn(async () => [
          { sessionId: rotateSessionId, sessionKey: rotateSessionKey, sessionFile: rotateSessionFile },
          { sessionId: belowSessionId, sessionKey: belowSessionKey, sessionFile: belowSessionFile },
          { sessionId: missingSessionId, sessionKey: missingSessionKey, sessionFile: missingSessionFile },
          {
            sessionId: noBootstrapSessionId,
            sessionKey: noBootstrapSessionKey,
            sessionFile: createSessionFilePath("auto-rotate-summary-no-bootstrap"),
          },
        ]),
      },
    );

    await engine.bootstrap({
      sessionId: rotateSessionId,
      sessionKey: rotateSessionKey,
      sessionFile: rotateSessionFile,
    });
    await engine.bootstrap({
      sessionId: belowSessionId,
      sessionKey: belowSessionKey,
      sessionFile: belowSessionFile,
    });
    const missingConversation = await engine.getConversationStore().createConversation({
      sessionId: missingSessionId,
      sessionKey: missingSessionKey,
    });
    await engine.getSummaryStore().upsertConversationBootstrapState({
      conversationId: missingConversation.conversationId,
      sessionFilePath: missingSessionFile,
      lastSeenSize: 2_000,
      lastSeenMtimeMs: Date.now(),
      lastProcessedOffset: 0,
    });
    await engine.getConversationStore().createConversation({
      sessionId: noBootstrapSessionId,
      sessionKey: noBootstrapSessionKey,
    });
    await engine.autoRotateManagedSessionFilesAtStartup();

    const autoRotateInfoLogs = log.info.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith("[lcm] auto-rotate:"));
    const autoRotateWarnLogs = log.warn.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith("[lcm] auto-rotate:"));
    expect(autoRotateInfoLogs.filter((message) => message.includes("action=summary"))).toHaveLength(1);
    expect(autoRotateInfoLogs.filter((message) => message.includes("action=skip"))).toHaveLength(0);
    expect(autoRotateWarnLogs).toHaveLength(0);
    const summaryLog = autoRotateInfoLogs.find((message) => message.includes("action=summary"));
    expect(summaryLog).toContain("scanned=4");
    expect(summaryLog).toContain("eligible=1");
    expect(summaryLog).toContain("rotated=1");
    expect(summaryLog).toContain("warned=0");
    expect(summaryLog).toContain("skipped=3");
  });

  it("startup batch creates one pre-rotation backup for multiple rotations", async () => {
    const firstSessionFile = createSessionFilePath("auto-rotate-batch-first");
    const secondSessionFile = createSessionFilePath("auto-rotate-batch-second");
    createBulkySession(firstSessionFile, 14);
    createBulkySession(secondSessionFile, 14);
    const firstBeforeSize = statSync(firstSessionFile).size;
    const secondBeforeSize = statSync(secondSessionFile).size;
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const firstSessionId = "auto-rotate-batch-first-session";
    const firstSessionKey = "agent:main:test:auto-rotate-batch-first";
    const secondSessionId = "auto-rotate-batch-second-session";
    const secondSessionKey = "agent:main:test:auto-rotate-batch-second";
    const engine = createEngineWithDeps(
      {
        freshTailCount: 1,
        autoRotateSessionFiles: {
          enabled: true,
          createBackups: true,
          sizeBytes: 1_500,
          startup: "rotate",
          runtime: "off",
        },
      },
      {
        log,
        listStartupSessionFileCandidates: vi.fn(async () => [
          { sessionId: firstSessionId, sessionKey: firstSessionKey, sessionFile: firstSessionFile },
          { sessionId: secondSessionId, sessionKey: secondSessionKey, sessionFile: secondSessionFile },
        ]),
      },
    );

    await engine.bootstrap({
      sessionId: firstSessionId,
      sessionKey: firstSessionKey,
      sessionFile: firstSessionFile,
    });
    await engine.bootstrap({
      sessionId: secondSessionId,
      sessionKey: secondSessionKey,
      sessionFile: secondSessionFile,
    });
    const firstConversation = await engine
      .getConversationStore()
      .getConversationForSession({ sessionId: firstSessionId, sessionKey: firstSessionKey });
    const secondConversation = await engine
      .getConversationStore()
      .getConversationForSession({ sessionId: secondSessionId, sessionKey: secondSessionKey });

    await engine.autoRotateManagedSessionFilesAtStartup();

    expect(statSync(firstSessionFile).size).toBeLessThan(firstBeforeSize);
    expect(statSync(secondSessionFile).size).toBeLessThan(secondBeforeSize);
    const autoRotateLogs = log.info.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith("[lcm] auto-rotate:"));
    const rotateLogs = autoRotateLogs.filter((message) =>
      message.includes("phase=startup action=rotate"),
    );
    expect(rotateLogs).toHaveLength(2);
    const backupPaths = new Set(
      rotateLogs.map((message) => message.match(/backupPath=([^ ]+)/)?.[1]).filter(Boolean),
    );
    expect(backupPaths.size).toBe(1);
    const backupPath = Array.from(backupPaths)[0]!;
    const backupDb = createLcmDatabaseConnection(backupPath);
    try {
      const firstBackupState = backupDb
        .prepare(`SELECT last_seen_size AS lastSeenSize FROM conversation_bootstrap_state WHERE conversation_id = ?`)
        .get(firstConversation!.conversationId) as { lastSeenSize: number } | undefined;
      const secondBackupState = backupDb
        .prepare(`SELECT last_seen_size AS lastSeenSize FROM conversation_bootstrap_state WHERE conversation_id = ?`)
        .get(secondConversation!.conversationId) as { lastSeenSize: number } | undefined;
      expect(firstBackupState?.lastSeenSize).toBe(firstBeforeSize);
      expect(secondBackupState?.lastSeenSize).toBe(secondBeforeSize);
    } finally {
      closeLcmConnection(backupDb);
    }
    const summaryLog = autoRotateLogs.find((message) => message.includes("action=summary"));
    expect(summaryLog).toContain("scanned=2");
    expect(summaryLog).toContain("eligible=2");
    expect(summaryLog).toContain("rotated=2");
    expect(summaryLog).toContain("backupCreated=1");
  });

  it("does not repeatedly rewrite oversized transcripts during runtime deferral", async () => {
    const sessionFile = createSessionFilePath("auto-rotate-no-loop");
    createBulkySession(sessionFile, 14);
    const original = readFileSync(sessionFile, "utf8");
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const engine = createEngineWithDeps(
      {
        freshTailCount: 1,
        autoRotateSessionFiles: {
          enabled: true,
          createBackups: false,
          sizeBytes: 1_500,
          startup: "off",
          runtime: "rotate",
        },
      },
      { log },
    );
    const sessionId = "auto-rotate-no-loop-session";
    const sessionKey = "agent:main:test:auto-rotate-no-loop";

    await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    await engine.maintain({
      sessionId,
      sessionKey,
      sessionFile,
      runtimeContext: {
        allowDeferredCompactionExecution: true,
      },
    });
    await engine.maintain({
      sessionId,
      sessionKey,
      sessionFile,
      runtimeContext: {
        allowDeferredCompactionExecution: true,
      },
    });

    const autoRotateLogs = log.info.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith("[lcm] auto-rotate:"));
    expect(readFileSync(sessionFile, "utf8")).toBe(original);
    expect(autoRotateLogs.filter((message) => message.includes("action=rotate"))).toHaveLength(0);
    expect(
      autoRotateLogs.filter((message) =>
        message.includes("reason=runtime-session-file-rewrite-deferred-to-startup-or-manual-rotate"),
      ),
    ).toHaveLength(2);
  });

  it("reconciles missing tail messages when JSONL advanced past LCM", async () => {
    const sessionFile = createSessionFilePath("reconcile-tail");
    const sm = SessionManager.open(sessionFile);
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "seed user" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "seed assistant" }],
    } as AgentMessage);

    const engine = createEngine();
    const sessionId = "bootstrap-reconcile-tail";

    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first.bootstrapped).toBe(true);
    expect(first.importedMessages).toBe(2);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const firstBootstrapState = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(firstBootstrapState).not.toBeNull();

    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "lost user turn" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "lost assistant turn" }],
    } as AgentMessage);

    const second = await engine.bootstrap({ sessionId, sessionFile });
    expect(second.bootstrapped).toBe(true);
    expect(second.importedMessages).toBe(2);
    expect(second.reason).toBe("reconciled missing session messages");

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "seed user",
      "seed assistant",
      "lost user turn",
      "lost assistant turn",
    ]);

    const bootstrapState = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    const sessionFileStats = statSync(sessionFile);
    expect(bootstrapState).not.toBeNull();
    expect(bootstrapState?.lastSeenSize).toBe(sessionFileStats.size);
    expect(bootstrapState?.lastSeenMtimeMs).toBe(Math.trunc(sessionFileStats.mtimeMs));
    expect(bootstrapState?.lastProcessedOffset).toBe(sessionFileStats.size);
    expect(bootstrapState?.lastProcessedEntryHash).toMatch(/^[a-f0-9]{64}$/);
    expect(bootstrapState?.lastSeenSize).toBeGreaterThan(firstBootstrapState!.lastSeenSize);
    expect(bootstrapState?.lastProcessedEntryHash).not.toBe(firstBootstrapState!.lastProcessedEntryHash);
  });

  it("imports appended tail messages without replaying full reconciliation", async () => {
    const sessionFile = createSessionFilePath("append-only-tail");
    const sm = SessionManager.open(sessionFile);
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "seed user" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "seed assistant" }],
    } as AgentMessage);

    const engine = createEngine();
    const sessionId = "bootstrap-append-only-tail";

    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first.bootstrapped).toBe(true);
    expect(first.importedMessages).toBe(2);

    const reconcileSpy = vi.spyOn(engine as any, "reconcileSessionTail");

    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "tail user" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "tail assistant" }],
    } as AgentMessage);

    const second = await engine.bootstrap({ sessionId, sessionFile });
    expect(second).toEqual({
      bootstrapped: true,
      importedMessages: 2,
      reason: "reconciled missing session messages",
    });
    expect(reconcileSpy).not.toHaveBeenCalled();
  });

  it("keeps the append-only fast path after heartbeat pruning changes the DB frontier", async () => {
    const sessionFile = createSessionFilePath("append-only-heartbeat-prune");
    const sm = SessionManager.open(sessionFile);
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "seed user" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "seed assistant" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly." }],
    } as AgentMessage);
    sm.appendMessage({
      role: "tool",
      content: "# HEARTBEAT.md\n\n## Worker heartbeat (minimal)",
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "HEARTBEAT_OK" }],
    } as AgentMessage);

    const engine = createEngineWithConfig({ pruneHeartbeatOk: true });
    const sessionId = "bootstrap-append-only-heartbeat-prune";
    const sessionKey = "agent:main:test:bootstrap-append-only-heartbeat-prune";

    const first = await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    expect(first.bootstrapped).toBe(true);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const storedAfterPrune = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(storedAfterPrune.map((message) => message.content)).toEqual(["seed user", "seed assistant"]);

    const reconcileSpy = vi.spyOn(engine as any, "reconcileSessionTail");

    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "tail user" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "tail assistant" }],
    } as AgentMessage);

    const second = await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    expect(second).toEqual({
      bootstrapped: true,
      importedMessages: 2,
      reason: "reconciled missing session messages",
    });
    expect(reconcileSpy).not.toHaveBeenCalled();

    const storedAfterAppend = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(storedAfterAppend.map((message) => message.content)).toEqual([
      "seed user",
      "seed assistant",
      "tail user",
      "tail assistant",
    ]);
  });

  it("ignores non-message envelopes in appended transcript tails without forcing reconcile", async () => {
    const sessionFile = createSessionFilePath("append-only-noncanonical-envelope");
    const sm = SessionManager.open(sessionFile);
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "seed user" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "seed assistant" }],
    } as AgentMessage);

    const engine = createEngine();
    const sessionId = "bootstrap-append-only-noncanonical-envelope";

    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first.bootstrapped).toBe(true);

    const reconcileSpy = vi.spyOn(engine as any, "reconcileSessionTail");

    appendFileSync(
      sessionFile,
      `${JSON.stringify({ type: "commentary", message: { role: "assistant", content: "ignore me" } })}\n`,
      "utf8",
    );
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "tail user" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "tail assistant" }],
    } as AgentMessage);

    const second = await engine.bootstrap({ sessionId, sessionFile });
    expect(second).toEqual({
      bootstrapped: true,
      importedMessages: 2,
      reason: "reconciled missing session messages",
    });
    expect(reconcileSpy).not.toHaveBeenCalled();
  });

  it("tolerates custom bootstrap sidecar entries in append-only suffixes", async () => {
    const sessionFile = createSessionFilePath("append-only-bootstrap-sidecar");
    const sm = SessionManager.open(sessionFile);
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "seed user" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "seed assistant" }],
    } as AgentMessage);

    const engine = createEngine();
    const sessionId = "bootstrap-append-only-bootstrap-sidecar";

    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first.bootstrapped).toBe(true);

    const reconcileSpy = vi.spyOn(engine as any, "reconcileSessionTail");

    appendFileSync(
      sessionFile,
      `${JSON.stringify({ type: "custom", customType: "openclaw:bootstrap-context:full", data: { ok: true } })}\n`,
      "utf8",
    );
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "tail user" }],
    } as AgentMessage);

    const second = await engine.bootstrap({ sessionId, sessionFile });
    expect(second).toEqual({
      bootstrapped: true,
      importedMessages: 1,
      reason: "reconciled missing session messages",
    });
    expect(reconcileSpy).not.toHaveBeenCalled();
  });

  it("refreshes the bootstrap checkpoint after afterTurn heartbeat pruning", async () => {
    const sessionFile = createSessionFilePath("append-only-after-turn-heartbeat-prune");
    const sm = SessionManager.open(sessionFile);
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "seed user" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "seed assistant" }],
    } as AgentMessage);

    const engine = createEngineWithConfig({ pruneHeartbeatOk: true });
    const sessionId = "bootstrap-append-only-after-turn-heartbeat-prune";
    const sessionKey = "agent:main:test:bootstrap-append-only-after-turn-heartbeat-prune";

    const first = await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    expect(first.bootstrapped).toBe(true);

    const heartbeatBatch = [
      makeMessage({
        role: "user",
        content: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.",
      }),
      makeMessage({
        role: "tool",
        content: "# HEARTBEAT.md\n\n## Worker heartbeat (minimal)",
      }),
      makeMessage({
        role: "assistant",
        content: "HEARTBEAT_OK",
      }),
    ];
    for (const message of heartbeatBatch) {
      sm.appendMessage(message as AgentMessage);
    }

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: heartbeatBatch,
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "tail user" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "tail assistant" }],
    } as AgentMessage);

    const reconcileSpy = vi.spyOn(engine as any, "reconcileSessionTail");
    const second = await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    expect(second).toEqual({
      bootstrapped: true,
      importedMessages: 2,
      reason: "reconciled missing session messages",
    });
    expect(reconcileSpy).not.toHaveBeenCalled();
  });

  it("refreshes the bootstrap checkpoint after a normal afterTurn before the next append-only bootstrap", async () => {
    const sessionFile = createSessionFilePath("append-only-after-turn-normal-ingest");
    const sm = SessionManager.open(sessionFile);
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "seed user" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "seed assistant" }],
    } as AgentMessage);

    const engine = createEngine();
    const sessionId = "bootstrap-append-only-after-turn-normal-ingest";

    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first.bootstrapped).toBe(true);

    const realTurn = [
      makeMessage({
        role: "user",
        content: "new user",
      }),
      makeMessage({
        role: "assistant",
        content: "new assistant",
      }),
    ];
    for (const message of realTurn) {
      sm.appendMessage(message as AgentMessage);
    }

    await engine.afterTurn({
      sessionId,
      sessionFile,
      messages: realTurn,
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "tail user" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "tail assistant" }],
    } as AgentMessage);

    const reconcileSpy = vi.spyOn(engine as any, "reconcileSessionTail");
    const second = await engine.bootstrap({ sessionId, sessionFile });
    expect(second).toEqual({
      bootstrapped: true,
      importedMessages: 2,
      reason: "reconciled missing session messages",
    });
    expect(reconcileSpy).not.toHaveBeenCalled();
  });

  it("reconciles foreground transcript messages before assistant-only afterTurn deltas", async () => {
    const sessionFile = createSessionFilePath("after-turn-foreground-transcript-reconcile");
    const sm = SessionManager.open(sessionFile);
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "kick off workers" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "same status reply" }],
    } as AgentMessage);

    const engine = createEngine();
    const sessionId = "after-turn-foreground-transcript-reconcile";

    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first.bootstrapped).toBe(true);

    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "You set up a monitor too right?" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "same status reply" }],
    } as AgentMessage);

    await engine.afterTurn({
      sessionId,
      sessionFile,
      messages: [makeMessage({ role: "assistant", content: "same status reply" })],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "kick off workers",
      "same status reply",
      "You set up a monitor too right?",
      "same status reply",
    ]);

    const sessionFileStats = statSync(sessionFile);
    const bootstrapState = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(bootstrapState?.lastProcessedOffset).toBe(sessionFileStats.size);
  });

  it("falls back to full reconciliation when append-only checkpoint validation mismatches", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "lcm.db");
    const sessionFile = createSessionFilePath("append-only-mismatch");
    const sm = SessionManager.open(sessionFile);
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "seed user" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "seed assistant" }],
    } as AgentMessage);

    const engine = createEngineAtDatabasePath(dbPath);
    const sessionId = "bootstrap-append-only-mismatch";

    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first.bootstrapped).toBe(true);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const rawDb = createLcmDatabaseConnection(dbPath);
    try {
      rawDb
        .prepare(
          `UPDATE conversation_bootstrap_state
           SET last_processed_entry_hash = ?
           WHERE conversation_id = ?`,
        )
        .run("mismatch", conversation!.conversationId);
    } finally {
      closeLcmConnection(rawDb);
    }

    const reconcileSpy = vi.spyOn(engine as any, "reconcileSessionTail");

    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "tail user" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "tail assistant" }],
    } as AgentMessage);

    const second = await engine.bootstrap({ sessionId, sessionFile });
    expect(second).toEqual({
      bootstrapped: true,
      importedMessages: 2,
      reason: "reconciled missing session messages",
    });
    expect(reconcileSpy).toHaveBeenCalledTimes(1);
  });

  it("reconciles missing structured tool-call tail when prior empty tool content exists", async () => {
    const sessionFile = createSessionFilePath("reconcile-tool-tail");
    const sm = SessionManager.open(sessionFile);
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "seed user" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "seed assistant" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_existing", name: "read", input: { path: "a.txt" } }],
    } as AgentMessage);
    sm.appendMessage({
      role: "toolResult",
      toolCallId: "call_existing",
      content: [{ type: "tool_result", tool_use_id: "call_existing", output: { ok: true } }],
    } as AgentMessage);

    const engine = createEngine();
    const sessionId = "bootstrap-reconcile-tool-tail";

    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first.bootstrapped).toBe(true);
    expect(first.importedMessages).toBe(4);

    sm.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_missing", name: "read", input: { path: "b.txt" } }],
    } as AgentMessage);
    sm.appendMessage({
      role: "toolResult",
      toolCallId: "call_missing",
      content: [{ type: "tool_result", tool_use_id: "call_missing", output: { ok: true } }],
    } as AgentMessage);

    const second = await engine.bootstrap({ sessionId, sessionFile });
    expect(second.bootstrapped).toBe(true);
    expect(second.importedMessages).toBe(2);
    expect(second.reason).toBe("reconciled missing session messages");

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored).toHaveLength(6);
    expect(stored[4].role).toBe("assistant");
    expect(stored[4].content).toBe("");
    expect(stored[5].role).toBe("tool");
    expect(stored[5].content).toBe("");
  });

  it("bootstraps a bounded same-path transcript epoch after the file shrinks", async () => {
    const warnLog = vi.fn();
    const sessionFile = createSessionFilePath("bootstrap-same-path-shrink");
    writeLeafTranscript(sessionFile, [
      { role: "user", content: "old bootstrap shrink user" },
      { role: "assistant", content: "old bootstrap shrink assistant" },
    ]);
    appendFileSync(
      sessionFile,
      `${JSON.stringify({ type: "custom", payload: "x".repeat(20_000) })}\n`,
      "utf8",
    );

    const engine = createEngineWithDeps(
      {},
      {
        log: { info: vi.fn(), warn: warnLog, error: vi.fn(), debug: vi.fn() },
      },
    );
    const sessionId = "bootstrap-same-path-shrink";

    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first.bootstrapped).toBe(true);
    expect(first.importedMessages).toBe(2);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const oldCheckpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(oldCheckpoint?.sessionFilePath).toBe(sessionFile);

    writeLeafTranscript(sessionFile, [
      { role: "user", content: "missed bootstrap shrink user" },
      { role: "assistant", content: "missed bootstrap shrink assistant" },
    ]);
    expect(oldCheckpoint!.lastProcessedOffset).toBeGreaterThan(statSync(sessionFile).size);

    const second = await engine.bootstrap({ sessionId, sessionFile });
    expect(second).toEqual({
      bootstrapped: true,
      importedMessages: 2,
      reason: "reconciled missing session messages",
    });
    expect(
      warnLog.mock.calls
        .map((c) => String(c[0]))
        .some((m) => m.includes("same-path-shrink")),
    ).toBe(true);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old bootstrap shrink user",
      "old bootstrap shrink assistant",
      "missed bootstrap shrink user",
      "missed bootstrap shrink assistant",
    ]);

    const newCheckpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(newCheckpoint?.sessionFilePath).toBe(sessionFile);
    expect(newCheckpoint?.lastProcessedOffset).toBe(statSync(sessionFile).size);
  });

  it("blocks same-path shrink import when raw ids belong to another active conversation", async () => {
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: { info: vi.fn(), warn: warnLog, error: vi.fn(), debug: vi.fn() },
      },
    );

    const mainSessionId = "bootstrap-same-path-shrink-cross-main";
    const mainSessionKey = "agent:main:main";
    const mainSessionFile = createSessionFilePath("bootstrap-same-path-shrink-cross-main");
    writeLeafTranscript(mainSessionFile, [
      { role: "user", content: "main old user" },
      { role: "assistant", content: "main old assistant" },
    ]);
    appendFileSync(
      mainSessionFile,
      `${JSON.stringify({ type: "custom", payload: "x".repeat(20_000) })}\n`,
      "utf8",
    );

    const first = await engine.bootstrap({
      sessionId: mainSessionId,
      sessionKey: mainSessionKey,
      sessionFile: mainSessionFile,
    });
    expect(first.bootstrapped).toBe(true);
    expect(first.importedMessages).toBe(2);

    const mainConversation = await engine.getConversationStore().getConversationForSession({
      sessionId: mainSessionId,
      sessionKey: mainSessionKey,
    });
    expect(mainConversation).not.toBeNull();
    const oldCheckpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(mainConversation!.conversationId);
    expect(oldCheckpoint?.sessionFilePath).toBe(mainSessionFile);

    const duplicateMessages = [
      makeMessage({
        role: "user",
        content: [{ type: "text", id: "raw-cross-user", text: "telegram duplicate user" }],
      }),
      makeMessage({
        role: "assistant",
        content: [{ type: "text", id: "raw-cross-assistant", text: "telegram duplicate assistant" }],
      }),
    ];
    const directSessionFile = createSessionFilePath("bootstrap-same-path-shrink-cross-direct");
    writeLeafTranscriptMessages(directSessionFile, duplicateMessages);
    await engine.bootstrap({
      sessionId: "bootstrap-same-path-shrink-cross-direct",
      sessionKey: "agent:main:telegram:default:direct:8455538490",
      sessionFile: directSessionFile,
    });

    writeLeafTranscriptMessages(mainSessionFile, duplicateMessages);
    expect(oldCheckpoint!.lastProcessedOffset).toBeGreaterThan(statSync(mainSessionFile).size);

    const second = await engine.bootstrap({
      sessionId: mainSessionId,
      sessionKey: mainSessionKey,
      sessionFile: mainSessionFile,
    });
    expect(second).toEqual({
      bootstrapped: false,
      importedMessages: 0,
      reason: "reconcile duplicate raw ids",
    });
    expect(
      warnLog.mock.calls
        .map((c) => String(c[0]))
        .some((m) => m.includes("blocked same-path-shrink no-anchor import")),
    ).toBe(true);

    const stored = await engine.getConversationStore().getMessages(mainConversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "main old user",
      "main old assistant",
    ]);

    const checkpointAfterBlock = await engine
      .getSummaryStore()
      .getConversationBootstrapState(mainConversation!.conversationId);
    expect(checkpointAfterBlock?.lastProcessedOffset).toBe(oldCheckpoint?.lastProcessedOffset);
  });

  it("imports the full bounded same-path shrink epoch instead of trusting a stale externalized frontier", async () => {
    const sessionFile = createSessionFilePath("bootstrap-same-path-shrink-externalized");
    const rawFrontier = "externalized raw shrink frontier";
    writeLeafTranscript(sessionFile, [
      { role: "assistant", content: rawFrontier },
    ]);
    appendFileSync(
      sessionFile,
      `${JSON.stringify({ type: "custom", payload: "x".repeat(20_000) })}\n`,
      "utf8",
    );

    const engine = createEngine();
    const sessionId = "bootstrap-same-path-shrink-externalized";
    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first.bootstrapped).toBe(true);
    expect(first.importedMessages).toBe(1);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const firstStored = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(firstStored).toHaveLength(1);

    const rawDb = createLcmDatabaseConnection(engine.config.databasePath);
    try {
      rawDb
        .prepare(`UPDATE messages SET content = ?, token_count = ? WHERE message_id = ?`)
        .run(
          "[LCM externalized payload reference]",
          estimateTokens("[LCM externalized payload reference]"),
          firstStored[0].messageId,
        );
    } finally {
      closeLcmConnection(rawDb);
    }

    const oldCheckpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(oldCheckpoint?.lastProcessedEntryHash).toMatch(/^[a-f0-9]{64}$/);

    writeLeafTranscript(sessionFile, [
      { role: "assistant", content: rawFrontier },
      { role: "user", content: "tail after externalized shrink" },
    ]);
    expect(oldCheckpoint!.lastProcessedOffset).toBeGreaterThan(statSync(sessionFile).size);

    const second = await engine.bootstrap({ sessionId, sessionFile });
    expect(second).toEqual({
      bootstrapped: true,
      importedMessages: 2,
      reason: "reconciled missing session messages",
    });

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "[LCM externalized payload reference]",
      rawFrontier,
      "tail after externalized shrink",
    ]);
  });

  it("imports a full same-path shrink epoch when new content repeats an old frontier message", async () => {
    const sessionFile = createSessionFilePath("bootstrap-same-path-shrink-duplicate-frontier");
    writeLeafTranscript(sessionFile, [
      { role: "user", content: "old duplicate frontier user" },
      { role: "assistant", content: "OK" },
    ]);
    appendFileSync(
      sessionFile,
      `${JSON.stringify({ type: "custom", payload: "x".repeat(20_000) })}\n`,
      "utf8",
    );

    const engine = createEngine();
    const sessionId = "bootstrap-same-path-shrink-duplicate-frontier";
    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first.bootstrapped).toBe(true);
    expect(first.importedMessages).toBe(2);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const oldCheckpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);

    writeLeafTranscript(sessionFile, [
      { role: "user", content: "new duplicate frontier user" },
      { role: "assistant", content: "OK" },
      { role: "user", content: "new duplicate frontier tail" },
    ]);
    expect(oldCheckpoint!.lastProcessedOffset).toBeGreaterThan(statSync(sessionFile).size);

    const second = await engine.bootstrap({ sessionId, sessionFile });
    expect(second).toEqual({
      bootstrapped: true,
      importedMessages: 3,
      reason: "reconciled missing session messages",
    });

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old duplicate frontier user",
      "OK",
      "new duplicate frontier user",
      "OK",
      "new duplicate frontier tail",
    ]);
  });

  it("does not append JSONL when no overlapping anchor exists in LCM", async () => {
    const sessionFile = createSessionFilePath("reconcile-no-overlap");
    const sm = SessionManager.open(sessionFile);
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "json only user" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "json only assistant" }],
    } as AgentMessage);

    const engine = createEngine();
    const sessionId = "bootstrap-reconcile-no-overlap";
    await engine.ingest({
      sessionId,
      message: { role: "user", content: "db only user" } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: { role: "assistant", content: "db only assistant" } as AgentMessage,
    });

    const result = await engine.bootstrap({ sessionId, sessionFile });
    expect(result.bootstrapped).toBe(false);
    expect(result.importedMessages).toBe(0);
    expect(result.reason).toBe("conversation already has messages");

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual(["db only user", "db only assistant"]);
  });

  it("does not advance the bootstrap checkpoint when reconcile aborts at the import cap", async () => {
    const warnLog = vi.fn();
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "lcm.db");
    const sessionFile = createSessionFilePath("reconcile-import-cap");
    const sm = SessionManager.open(sessionFile);
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "seed user" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "seed assistant" }],
    } as AgentMessage);

    const config = createTestConfig(dbPath);
    const db = createLcmDatabaseConnection(config.databasePath);
    const engine = new LcmContextEngine(
      createTestDeps(config, {
        log: {
          info: vi.fn(),
          warn: warnLog,
          error: vi.fn(),
          debug: vi.fn(),
        },
      }),
      db,
    );
    const sessionId = "bootstrap-reconcile-import-cap";
    const sessionKey = "agent:main:test:bootstrap-reconcile-import-cap";

    const first = await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    expect(first.bootstrapped).toBe(true);
    expect(first.importedMessages).toBe(2);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const firstBootstrapState = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(firstBootstrapState).not.toBeNull();

    const rawDb = createLcmDatabaseConnection(dbPath);
    try {
      rawDb
        .prepare(
          `UPDATE conversation_bootstrap_state
           SET last_processed_entry_hash = ?
           WHERE conversation_id = ?`,
        )
        .run("mismatch", conversation!.conversationId);
    } finally {
      closeLcmConnection(rawDb);
    }

    const staleBootstrapState = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(staleBootstrapState).not.toBeNull();
    expect(staleBootstrapState?.lastProcessedEntryHash).toBe("mismatch");

    for (let index = 0; index < 60; index += 1) {
      sm.appendMessage({
        role: index % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `missing tail ${index}` }],
      } as AgentMessage);
    }

    const second = await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    expect(second).toEqual({
      bootstrapped: false,
      importedMessages: 0,
      reason: "reconcile import capped",
    });
    expect(warnLog).toHaveBeenCalledWith(
      `[lcm] reconcileSessionTail: import cap exceeded for conversation=${conversation!.conversationId} session=${sessionId} sessionKey=${sessionKey} — would import 60 messages (existing: 2). Aborting to prevent flood.`,
    );

    const storedAfterCap = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(storedAfterCap.map((message) => message.content)).toEqual(["seed user", "seed assistant"]);

    const secondBootstrapState = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(secondBootstrapState).toEqual(staleBootstrapState);

    const reconcileSpy = vi.spyOn(engine as any, "reconcileSessionTail");
    const third = await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    expect(third).toEqual({
      bootstrapped: false,
      importedMessages: 0,
      reason: "reconcile import capped",
    });
    expect(reconcileSpy).toHaveBeenCalledTimes(1);
  });

  it("uses the live ingest path for initial bootstrap", async () => {
    const sessionFile = createSessionFilePath("bootstrap-ingest-path");
    const sm = SessionManager.open(sessionFile);
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "ingest one" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "ingest two" }],
    } as AgentMessage);

    const warnLog = vi.fn();
    const engine = createEngineWithDepsOverrides({
      log: {
        info: vi.fn(),
        warn: warnLog,
        error: vi.fn(),
        debug: vi.fn(),
      },
    });
    const bulkSpy = vi.spyOn(engine.getConversationStore(), "createMessagesBulk");
    const singleSpy = vi.spyOn(engine.getConversationStore(), "createMessage");

    const result = await engine.bootstrap({
      sessionId: "bootstrap-ingest-path",
      sessionFile,
    });

    expect(result.bootstrapped).toBe(true);
    expect(result.importedMessages).toBe(2);
    expect(bulkSpy).not.toHaveBeenCalled();
    expect(singleSpy).toHaveBeenCalledTimes(2);
  });

  it("externalizes oversized file blocks during first-time bootstrap and still reconciles later tail messages", async () => {
    await withTempHome(async () => {
      const sessionFile = createSessionFilePath("bootstrap-large-file-parity");
      const fileText = `${"bootstrap file line\n".repeat(160)}done`;
      writeFileSync(
        sessionFile,
        `${JSON.stringify({
          role: "user",
          content: `<file name="bootstrap.md" mime="text/markdown">${fileText}</file>`,
        })}\n`,
        "utf8",
      );

      const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
      const sessionId = "bootstrap-large-file-parity";
      const first = await engine.bootstrap({ sessionId, sessionFile });
      expect(first).toEqual({
        bootstrapped: true,
        importedMessages: 1,
      });

      const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();

      const initiallyStored = await engine
        .getConversationStore()
        .getMessages(conversation!.conversationId);
      expect(initiallyStored).toHaveLength(1);
      expect(initiallyStored[0].content).toContain("[LCM File: file_");
      expect(initiallyStored[0].content).not.toContain("<file name=");
      expect(initiallyStored[0].content).not.toContain(fileText.slice(0, 64));

      const fileIdMatch = initiallyStored[0].content.match(/file_[a-f0-9]{16}/);
      expect(fileIdMatch).not.toBeNull();
      const storedFile = await engine.getSummaryStore().getLargeFile(fileIdMatch![0]);
      expect(storedFile).not.toBeNull();
      expect(storedFile!.fileName).toBe("bootstrap.md");
      expect(readFileSync(storedFile!.storageUri, "utf8")).toBe(fileText);

      const parts = await engine.getConversationStore().getMessageParts(initiallyStored[0].messageId);
      expect(parts).toHaveLength(1);
      expect(parts[0].textContent).toContain("[LCM File: file_");

      appendFileSync(
        sessionFile,
        `${JSON.stringify({
          role: "assistant",
          content: [{ type: "text", text: "tail after externalized bootstrap" }],
        })}\n`,
        "utf8",
      );

      const second = await engine.bootstrap({ sessionId, sessionFile });
      expect(second).toEqual({
        bootstrapped: true,
        importedMessages: 1,
        reason: "reconciled missing session messages",
      });

      const afterReconcile = await engine
        .getConversationStore()
        .getMessages(conversation!.conversationId);
      expect(afterReconcile.map((message) => message.content)).toEqual([
        initiallyStored[0].content,
        "tail after externalized bootstrap",
      ]);
    });
  });

  it("externalizes inline images during first-time bootstrap", async () => {
    const largeFilesDir = mkdtempSync(join(tmpdir(), "lossless-claw-large-files-"));
    tempDirs.push(largeFilesDir);
    const sessionFile = createSessionFilePath("bootstrap-inline-image-parity");
    const base64Image = `iVBOR${"A".repeat(600)}`;
    writeFileSync(
      sessionFile,
      `${JSON.stringify({
        role: "user",
        content: `[media attached: bootstrap.png]\n${base64Image}\n`,
      })}\n`,
      "utf8",
    );

    const engine = createEngineWithConfig({
      largeFileTokenThreshold: 1000,
      largeFilesDir,
    });
    const sessionId = "bootstrap-inline-image-parity";
    const result = await engine.bootstrap({ sessionId, sessionFile });
    expect(result.bootstrapped).toBe(true);
    expect(result.importedMessages).toBe(1);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const messages = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain("[User image: bootstrap.png");
    expect(messages[0].content).not.toContain(base64Image.slice(0, 32));

    const fileIdMatch = messages[0].content.match(/file_[a-f0-9]{16}/);
    expect(fileIdMatch).not.toBeNull();
    const storedFile = await engine.getSummaryStore().getLargeFile(fileIdMatch![0]);
    expect(storedFile).not.toBeNull();
    expect(storedFile!.mimeType).toBe("image/png");
    expect(storedFile!.storageUri).toContain(`${largeFilesDir}/${conversation!.conversationId}/`);
  });

  it("externalizes oversized tool results during first-time bootstrap", async () => {
    await withTempHome(async () => {
      const sessionFile = createSessionFilePath("bootstrap-tool-result-parity");
      const sm = SessionManager.open(sessionFile);
      const toolOutput = `${"bootstrap tool output\n".repeat(160)}done`;
      sm.appendMessage({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_bootstrap_externalized",
            name: "exec",
            input: { cmd: "cat large.txt" },
          },
        ],
      } as AgentMessage);
      sm.appendMessage({
        role: "toolResult",
        toolCallId: "call_bootstrap_externalized",
        toolName: "exec",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_bootstrap_externalized",
            name: "exec",
            content: [{ type: "text", text: toolOutput }],
          },
        ],
      } as AgentMessage);

      const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
      const sessionId = "bootstrap-tool-result-parity";
      const result = await engine.bootstrap({ sessionId, sessionFile });
      expect(result.bootstrapped).toBe(true);
      expect(result.importedMessages).toBe(2);

      const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();
      const messages = await engine.getConversationStore().getMessages(conversation!.conversationId);
      expect(messages).toHaveLength(2);
      expect(messages[1].content).toContain("[LCM Tool Output: file_");
      expect(messages[1].content).toContain("tool=exec");
      expect(messages[1].content).not.toContain(toolOutput.slice(0, 64));

      const fileIdMatch = messages[1].content.match(/file_[a-f0-9]{16}/);
      expect(fileIdMatch).not.toBeNull();
      const fileId = fileIdMatch![0];
      const storedFile = await engine.getSummaryStore().getLargeFile(fileId);
      expect(storedFile).not.toBeNull();
      expect(storedFile!.fileName).toBe("exec.txt");
      expect(readFileSync(storedFile!.storageUri, "utf8")).toBe(toolOutput);

      const parts = await engine.getConversationStore().getMessageParts(messages[1].messageId);
      expect(parts).toHaveLength(1);
      const metadata = JSON.parse(parts[0].metadata ?? "{}") as Record<string, unknown>;
      expect(metadata).toMatchObject({
        externalizedFileId: fileId,
        originalByteSize: Buffer.byteLength(toolOutput, "utf8"),
        toolOutputExternalized: true,
        externalizationReason: "large_tool_result",
      });
    });
  });

  it("limits first-time bootstrap imports to the newest messages within bootstrapMaxTokens", async () => {
    const sessionFile = createSessionFilePath("bootstrap-token-cap");
    const sm = SessionManager.open(sessionFile);
    for (let index = 0; index < 5; index += 1) {
      sm.appendMessage({
        role: index % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `turn ${index} ${"x".repeat(396)}` }],
      } as AgentMessage);
    }

    const engine = createEngineWithConfig({ bootstrapMaxTokens: 250 });
    const sessionId = "bootstrap-token-cap";
    const result = await engine.bootstrap({ sessionId, sessionFile });

    expect(result.bootstrapped).toBe(true);
    expect(result.importedMessages).toBe(2);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      `turn 3 ${"x".repeat(396)}`,
      `turn 4 ${"x".repeat(396)}`,
    ]);
  });

  it("drops an oversized singleton bootstrap tail that exceeds bootstrapMaxTokens", async () => {
    const sessionFile = createSessionFilePath("bootstrap-oversized-singleton");
    const sm = SessionManager.open(sessionFile);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "x".repeat(5000) }],
    } as AgentMessage);

    const engine = createEngineWithConfig({ bootstrapMaxTokens: 100 });
    const sessionId = "bootstrap-oversized-singleton";
    const result = await engine.bootstrap({ sessionId, sessionFile });

    expect(result.bootstrapped).toBe(false);
    expect(result.importedMessages).toBe(0);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored).toEqual([]);
  });

  it("streams JSONL replay and skips malformed lines while keeping later messages", async () => {
    const sessionFile = createSessionFilePath("streaming-jsonl");
    const lines: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      const role = index % 2 === 0 ? "user" : "assistant";
      lines.push(
        JSON.stringify({
          message: {
            role,
            content: [{ type: "text", text: `${role}-${index}` }],
          },
        }),
      );
      if (index === 17) {
        lines.push("{ malformed json line");
      }
    }
    writeFileSync(sessionFile, `${lines.join("\n")}\n`, "utf8");

    const engine = createEngine();
    const sessionId = "bootstrap-streaming-jsonl";

    const result = await engine.bootstrap({ sessionId, sessionFile });
    expect(result.bootstrapped).toBe(true);
    expect(result.importedMessages).toBe(40);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored).toHaveLength(40);
    expect(stored[0]?.content).toBe("user-0");
    expect(stored[39]?.content).toBe("assistant-39");
  });

  it("prepareSubagentSpawn resolves parent conversation by sessionKey before UUID backfill", async () => {
    const sessionKey = "agent:main:main";
    const engine = createEngineWithDepsOverrides({
      resolveSessionIdFromSessionKey: async () => "runtime-fresh",
    });

    await engine.ingest({
      sessionId: "runtime-stale",
      sessionKey,
      message: makeMessage({ role: "assistant", content: "parent context" }),
    });

    const preparation = await engine.prepareSubagentSpawn({
      parentSessionKey: sessionKey,
      childSessionKey: "agent:main:subagent:test-child",
    });

    expect(preparation).toBeDefined();
    preparation?.rollback();
  });

  it("skips full read when file is unchanged and conversation is already bootstrapped", async () => {
    const infoLog = vi.fn();
    const debugLog = vi.fn();
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "lcm.db");
    const sessionFile = createSessionFilePath("cache-guard");
    const sm = SessionManager.open(sessionFile);
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "one" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "two" }],
    } as AgentMessage);

    const config = createTestConfig(dbPath);
    const db = createLcmDatabaseConnection(config.databasePath);
    const engine = new LcmContextEngine(
      createTestDeps(config, {
        log: {
          info: infoLog,
          warn: vi.fn(),
          error: vi.fn(),
          debug: debugLog,
        },
      }),
      db,
    );

    const sessionId = "cache-guard";

    // First bootstrap: full read
    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first.bootstrapped).toBe(true);

    // Corrupt both the checkpoint stats and hash to force BOTH the checkpoint
    // fast path and the append-only fast path to fail, exercising the file-level
    // cache guard.
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    const rawDb = createLcmDatabaseConnection(dbPath);
    try {
      rawDb
        .prepare(
          `UPDATE conversation_bootstrap_state
           SET last_processed_entry_hash = ?,
               last_seen_size = 0,
               last_seen_mtime_ms = 0
           WHERE conversation_id = ?`,
        )
        .run("corrupted", conversation!.conversationId);
    } finally {
      closeLcmConnection(rawDb);
    }

    // Second bootstrap: checkpoint path fails (stats corrupted), append-only
    // path fails (hash corrupted + size condition), but file-level cache guard
    // skips the full read because the file hasn't changed since the first read
    const second = await engine.bootstrap({ sessionId, sessionFile });
    expect(second).toEqual({
      bootstrapped: false,
      importedMessages: 0,
      reason: "already bootstrapped",
    });

    // Verify the cache guard fired (skipped full read)
    const cacheGuardLogs = debugLog.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === "string" && call[0].includes("skipped full read (file unchanged)"),
    );
    expect(cacheGuardLogs).toHaveLength(1);

    // Verify only one full transcript read occurred (the first bootstrap)
    const fullReadLogs = debugLog.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("full transcript read"),
    );
    expect(fullReadLogs).toHaveLength(1);
  });

  it("file-level cache guard allows full read when file changes", async () => {
    const infoLog = vi.fn();
    const debugLog = vi.fn();
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "lcm.db");
    const sessionDir = mkdtempSync(join(tmpdir(), "lossless-claw-session-"));
    tempDirs.push(sessionDir);
    const sessionFile = join(sessionDir, "cache-guard-grows.jsonl");

    // Write initial JSONL directly (avoids SessionManager lifecycle issues)
    writeFileSync(
      sessionFile,
      `${JSON.stringify({ role: "user", content: [{ type: "text", text: "initial" }] })}\n`,
    );

    const config = createTestConfig(dbPath);
    const db = createLcmDatabaseConnection(config.databasePath);
    const engine = new LcmContextEngine(
      createTestDeps(config, {
        log: {
          info: infoLog,
          warn: vi.fn(),
          error: vi.fn(),
          debug: debugLog,
        },
      }),
      db,
    );

    const sessionId = "cache-guard-grows";

    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first.bootstrapped).toBe(true);

    // Corrupt checkpoint stats AND hash so both fast paths fail
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    db.prepare(
      `UPDATE conversation_bootstrap_state
       SET last_processed_entry_hash = ?,
           last_seen_size = 0,
           last_seen_mtime_ms = 0
       WHERE conversation_id = ?`,
    ).run("corrupted", conversation!.conversationId);

    // Grow the file so the cache guard also sees a size change
    appendFileSync(
      sessionFile,
      `${JSON.stringify({ role: "assistant", content: [{ type: "text", text: "reply" }] })}\n`,
    );

    // Bootstrap should NOT use cache guard (file changed), should do full read
    const second = await engine.bootstrap({ sessionId, sessionFile });
    // The newly appended assistant message must be picked up by the full read —
    // a vacuous `>= 0` assertion here would pass even if readLeafPathMessages
    // silently returned no rows, which is exactly the failure mode this test
    // is supposed to catch.
    expect(second.importedMessages).toBeGreaterThanOrEqual(1);

    // Two full reads should have occurred
    const fullReadLogs = debugLog.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("full transcript read"),
    );
    expect(fullReadLogs).toHaveLength(2);

    // And the cache guard must not have fired after the file grew
    const skippedLogs = debugLog.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === "string" && call[0].includes("skipped full read (file unchanged)"),
    );
    expect(skippedLogs).toHaveLength(0);
  });
});

// ── Assemble canonical path with fallback ───────────────────────────────────

describe("LcmContextEngine.assemble canonical path", () => {
  it("strips assistant prefill tails when no DB conversation exists", async () => {
    const engine = createEngine();
    const liveMessages: AgentMessage[] = [
      { role: "user", content: "first turn" },
      { role: "assistant", content: "first reply" },
    ] as AgentMessage[];

    const result = await engine.assemble({
      sessionId: "session-missing",
      messages: liveMessages,
      tokenBudget: 100,
    });

    expect(result.messages).not.toBe(liveMessages);
    expect(result.messages).toStrictEqual([{ role: "user", content: "first turn" }]);
    expect(result.estimatedTokens).toBe(0);
    expect(result.contextProjection).toBeUndefined();
  });

  it("falls back when DB context clearly trails live context", async () => {
    const engine = createEngine();
    const sessionId = "session-incomplete";
    await engine.ingest({
      sessionId,
      message: { role: "user", content: "persisted only one message" } as AgentMessage,
    });

    const liveMessages: AgentMessage[] = [
      { role: "user", content: "live message 1" },
      { role: "assistant", content: "live message 2" },
      { role: "user", content: "live message 3" },
    ] as AgentMessage[];

    const result = await engine.assemble({
      sessionId,
      messages: liveMessages,
      tokenBudget: 256,
    });

    expect(result.messages).not.toBe(liveMessages);
    expect(result.messages).toStrictEqual(liveMessages);
    expect(result.estimatedTokens).toBe(0);
    expect(result.contextProjection).toBeUndefined();
  });

  it("assembles context from DB when coverage exists", async () => {
    const engine = createEngine();
    const sessionId = "session-canonical";

    await engine.ingest({
      sessionId,
      message: { role: "user", content: "persisted message one" } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: { role: "assistant", content: "persisted message two" } as AgentMessage,
    });

    const liveMessages: AgentMessage[] = [{ role: "user", content: "live turn" }] as AgentMessage[];
    const result = await engine.assemble({
      sessionId,
      messages: liveMessages,
      tokenBudget: 10_000,
    });

    expect(result.messages).not.toBe(liveMessages);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toBe("persisted message one");
    expect(result.messages[1].role).toBe("assistant");
    expect(result.estimatedTokens).toBeGreaterThan(0);
    expect(result.contextProjection).toEqual({
      mode: "thread_bootstrap",
      epoch: expect.stringMatching(/^summary-prefix-v1:\d+:[a-f0-9]{32}$/),
    });
  });

  async function seedPromptRecallFixture(params: {
    engine: LcmContextEngine;
    sessionId: string;
    summaryId: string;
    summaryContent: string;
    memoryUserContent?: string;
    memoryAssistantContent?: string;
    tailUserContent?: string;
    tailAssistantContent?: string;
    prompt?: string;
  }): Promise<{ liveMessages: AgentMessage[]; prompt: string }> {
    const memoryUserContent =
      params.memoryUserContent ??
      "Reply with this exact memory marker: CRABPOT_LCM_FACT is blue-lantern-42.";
    const memoryAssistantContent =
      params.memoryAssistantContent ?? "CRABPOT_LCM_FACT is blue-lantern-42.";
    const prompt =
      params.prompt ?? "What is CRABPOT_LCM_FACT? Answer with only the remembered value.";

    await params.engine.ingest({
      sessionId: params.sessionId,
      message: {
        role: "user",
        content: memoryUserContent,
      } as AgentMessage,
    });
    await params.engine.ingest({
      sessionId: params.sessionId,
      message: { role: "assistant", content: memoryAssistantContent } as AgentMessage,
    });
    await params.engine.ingest({
      sessionId: params.sessionId,
      message: {
        role: "user",
        content: params.tailUserContent ?? "Say one neutral filler response.",
      } as AgentMessage,
    });
    await params.engine.ingest({
      sessionId: params.sessionId,
      message: { role: "assistant", content: params.tailAssistantContent ?? "ok" } as AgentMessage,
    });

    const conversation = await params.engine.getConversationStore().getConversationForSession({
      sessionId: params.sessionId,
    });
    expect(conversation).toBeTruthy();
    const messages = await params.engine.getConversationStore().getMessages(conversation!.conversationId);
    const summaryStore = params.engine.getSummaryStore();
    await summaryStore.insertSummary({
      summaryId: params.summaryId,
      conversationId: conversation!.conversationId,
      kind: "leaf",
      depth: 0,
      content: params.summaryContent,
      tokenCount: estimateTokens(params.summaryContent),
    });
    await summaryStore.linkSummaryToMessages(
      params.summaryId,
      messages.slice(0, 2).map((message) => message.messageId),
    );
    await summaryStore.replaceContextRangeWithSummary({
      conversationId: conversation!.conversationId,
      startOrdinal: 0,
      endOrdinal: 1,
      summaryId: params.summaryId,
    });

    return {
      liveMessages: [
        {
          role: "user",
          content: prompt,
        },
      ] as AgentMessage[],
      prompt,
    };
  }

  it("adds raw prompt-recall matches when summary-covered history omits an exact memory key", async () => {
    const engine = createEngine();
    const sessionId = "session-prompt-recall-after-rotate";

    await engine.ingest({
      sessionId,
      message: {
        role: "user",
        content: "Reply with this exact memory marker: CRABPOT_LCM_FACT is blue-lantern-42.",
      } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: { role: "assistant", content: "CRABPOT_LCM_FACT is blue-lantern-42." } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: { role: "user", content: "Say one neutral filler response." } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: { role: "assistant", content: "ok" } as AgentMessage,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({ sessionId });
    expect(conversation).toBeTruthy();
    const messages = await engine.getConversationStore().getMessages(conversation!.conversationId);
    const summaryStore = engine.getSummaryStore();
    await summaryStore.insertSummary({
      summaryId: "sum_prompt_recall_omits_exact_key",
      conversationId: conversation!.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Older setup turn established a recall fact, but this summary omits the exact key.",
      tokenCount: estimateTokens("Older setup turn established a recall fact."),
    });
    await summaryStore.linkSummaryToMessages(
      "sum_prompt_recall_omits_exact_key",
      messages.slice(0, 2).map((message) => message.messageId),
    );
    await summaryStore.replaceContextRangeWithSummary({
      conversationId: conversation!.conversationId,
      startOrdinal: 0,
      endOrdinal: 1,
      summaryId: "sum_prompt_recall_omits_exact_key",
    });

    const searchSpy = vi.spyOn(engine.getConversationStore(), "searchMessages");
    const result = await engine.assemble({
      sessionId,
      messages: [
        {
          role: "user",
          content: "What is CRABPOT_LCM_FACT? Answer with only the remembered value.",
        },
      ] as AgentMessage[],
      prompt: "What is CRABPOT_LCM_FACT? Answer with only the remembered value.",
      tokenBudget: 10_000,
    });

    const rendered = result.messages.map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    );
    expect(
      rendered.some(
        (content) =>
          content.includes("<lossless_claw_prompt_recall>") &&
          content.includes("CRABPOT_LCM_FACT is blue-lantern-42"),
      ),
    ).toBe(true);
    expect(searchSpy).toHaveBeenCalledWith(expect.objectContaining({
      mode: "full_text",
      query: "CRABPOT_LCM_FACT",
    }));
    expect(result.contextProjection?.fingerprint).toMatch(/^prompt-recall-v1:[a-f0-9]{32}$/);
  });

  it("adds prompt-recall sentence context before a requested key", async () => {
    const engine = createEngine();
    const sessionId = "session-prompt-recall-value-before-key";
    const prompt = "What is CRABPOT_LCM_FACT?";
    const { liveMessages } = await seedPromptRecallFixture({
      engine,
      sessionId,
      summaryId: "sum_prompt_recall_value_before_key",
      summaryContent: "Older setup turn established a recall fact, but this summary omits the exact key.",
      memoryUserContent: "Remember blue-lantern-42 as CRABPOT_LCM_FACT.",
      memoryAssistantContent: "ok",
      prompt,
    });

    const result = await engine.assemble({
      sessionId,
      messages: liveMessages,
      prompt,
      tokenBudget: 10_000,
    });

    const rendered = result.messages.map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    );
    const recallCue = rendered.find((content) => content.includes("<lossless_claw_prompt_recall>"));
    expect(recallCue).toEqual(expect.any(String));
    expect(recallCue).toContain("Remember blue-lantern-42 as CRABPOT_LCM_FACT.");
  });

  it("skips prompt-recall matches when the cue would exceed the assembly budget", async () => {
    const engine = createEngine();
    const sessionId = "session-prompt-recall-budget";

    await engine.ingest({
      sessionId,
      message: {
        role: "user",
        content: "Reply with this exact memory marker: CRABPOT_LCM_FACT is blue-lantern-42.",
      } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: { role: "assistant", content: "CRABPOT_LCM_FACT is blue-lantern-42." } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: { role: "user", content: "Say one neutral filler response." } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: { role: "assistant", content: "ok" } as AgentMessage,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({ sessionId });
    expect(conversation).toBeTruthy();
    const messages = await engine.getConversationStore().getMessages(conversation!.conversationId);
    const summaryStore = engine.getSummaryStore();
    await summaryStore.insertSummary({
      summaryId: "sum_prompt_recall_budget",
      conversationId: conversation!.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Older setup turn established a recall fact, but this summary omits the exact key.",
      tokenCount: estimateTokens("Older setup turn established a recall fact."),
    });
    await summaryStore.linkSummaryToMessages(
      "sum_prompt_recall_budget",
      messages.slice(0, 2).map((message) => message.messageId),
    );
    await summaryStore.replaceContextRangeWithSummary({
      conversationId: conversation!.conversationId,
      startOrdinal: 0,
      endOrdinal: 1,
      summaryId: "sum_prompt_recall_budget",
    });

    const liveMessages = [
      {
        role: "user",
        content: "What is CRABPOT_LCM_FACT? Answer with only the remembered value.",
      },
    ] as AgentMessage[];
    const baseline = await engine.assemble({
      sessionId,
      messages: liveMessages,
      tokenBudget: 10_000,
    });

    const constrained = await engine.assemble({
      sessionId,
      messages: liveMessages,
      prompt: "What is CRABPOT_LCM_FACT? Answer with only the remembered value.",
      tokenBudget: baseline.estimatedTokens,
    });

    const rendered = constrained.messages.map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    );
    expect(rendered.some((content) => content.includes("<lossless_claw_prompt_recall>"))).toBe(false);
    expect(constrained.estimatedTokens).toBeLessThanOrEqual(baseline.estimatedTokens);
  });

  it("drops prompt-recall when volatile live input needs the remaining budget", async () => {
    const engine = createEngine();
    const sessionId = "session-prompt-recall-live-budget";
    const prompt = "What is CRABPOT_LCM_FACT?";
    await seedPromptRecallFixture({
      engine,
      sessionId,
      summaryId: "sum_prompt_recall_live_budget",
      summaryContent: "Fact omitted.",
      prompt,
    });
    const volatileEvent =
      "[Inter-session message] sourceSession=agent:main:subagent:prompt-recall-budget sourceTool=subagent_announce\n" +
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n" +
      "[Internal task completion event]\n" +
      "Keep the current volatile live input intact. ".repeat(160) +
      "\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
    const liveMessages = [{ role: "user", content: volatileEvent }] as AgentMessage[];

    const baseline = await engine.assemble({
      sessionId,
      messages: liveMessages,
      tokenBudget: 10_000,
    });

    const constrained = await engine.assemble({
      sessionId,
      messages: liveMessages,
      prompt,
      tokenBudget: baseline.estimatedTokens,
    });

    const rendered = constrained.messages.map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    );
    expect(rendered.some((content) => content.includes("<lossless_claw_prompt_recall>"))).toBe(false);
    expect(rendered.some((content) => content.includes("Keep the current volatile live input intact."))).toBe(true);
    expect(constrained.estimatedTokens).toBeLessThanOrEqual(baseline.estimatedTokens);
  });

  it("does not add prompt-recall when volatile live input already mentions the requested key", async () => {
    const engine = createEngine();
    const sessionId = "session-prompt-recall-volatile-correction";
    const prompt = "What is CRABPOT_LCM_FACT?";
    await seedPromptRecallFixture({
      engine,
      sessionId,
      summaryId: "sum_prompt_recall_volatile_correction",
      summaryContent: "Older setup turn established a recall fact, but this summary omits the exact key.",
      memoryUserContent: "CRABPOT_LCM_FACT is stale-blue-lantern-42.",
      memoryAssistantContent: "ok",
      prompt,
    });
    const volatileEvent =
      "[Inter-session message] sourceSession=agent:main:subagent:prompt-recall-correction sourceTool=subagent_announce\n" +
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n" +
      "[Internal task completion event]\n" +
      "Correction: CRABPOT_LCM_FACT is green-lantern-88.\n" +
      "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
    const liveMessages = [{ role: "user", content: volatileEvent }] as AgentMessage[];
    const searchSpy = vi.spyOn(engine.getConversationStore(), "searchMessages");

    const result = await engine.assemble({
      sessionId,
      messages: liveMessages,
      prompt,
      tokenBudget: 10_000,
    });

    const rendered = result.messages.map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    );
    expect(rendered.some((content) => content.includes("<lossless_claw_prompt_recall>"))).toBe(false);
    expect(rendered.some((content) => content.includes("CRABPOT_LCM_FACT is green-lantern-88"))).toBe(true);
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it("drops prompt-recall before evicting assembled context for volatile live input", async () => {
    const engine = createEngine();
    const sessionId = "session-prompt-recall-preserve-summary";
    const prompt = "What is CRABPOT_LCM_FACT?";
    await seedPromptRecallFixture({
      engine,
      sessionId,
      summaryId: "sum_prompt_recall_preserve_summary",
      summaryContent: "Long unrelated summary. ".repeat(100),
      prompt,
    });
    const volatileEvent =
      "[Inter-session message] sourceSession=agent:main:subagent:prompt-recall-preserve sourceTool=subagent_announce\n" +
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n" +
      "[Internal task completion event]\n" +
      "Small live note.\n" +
      "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
    const liveMessages = [{ role: "user", content: volatileEvent }] as AgentMessage[];
    const baseline = await engine.assemble({
      sessionId,
      messages: liveMessages,
      tokenBudget: 10_000,
    });

    const constrained = await engine.assemble({
      sessionId,
      messages: liveMessages,
      prompt,
      tokenBudget: baseline.estimatedTokens + 20,
    });

    const rendered = constrained.messages.map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    );
    expect(rendered.some((content) => content.includes("<lossless_claw_prompt_recall>"))).toBe(false);
    expect(rendered.some((content) => content.includes("<summary id=\"sum_prompt_recall_preserve_summary\""))).toBe(
      true,
    );
    expect(rendered.some((content) => content.includes("Small live note."))).toBe(true);
    expect(constrained.estimatedTokens).toBeLessThanOrEqual(baseline.estimatedTokens + 20);
  });

  it("does not add prompt-recall when the active summary already carries the exact fact", async () => {
    const infoLog = vi.fn();
    const engine = createEngineWithDepsOverrides({
      log: {
        info: infoLog,
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    });
    const sessionId = "session-prompt-recall-duplicate-fact";
    const { liveMessages, prompt } = await seedPromptRecallFixture({
      engine,
      sessionId,
      summaryId: "sum_prompt_recall_exact_fact",
      summaryContent:
        "Older setup turn established CRABPOT_LCM_FACT is blue-lantern-42 but omits the full raw prompt.",
    });

    const result = await engine.assemble({
      sessionId,
      messages: liveMessages,
      prompt,
      tokenBudget: 10_000,
    });

    const rendered = result.messages.map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    );
    expect(rendered.some((content) => content.includes("<lossless_claw_prompt_recall>"))).toBe(false);
    const assembleDoneLog = infoLog.mock.calls
      .map((call: unknown[]) => call[0])
      .find((entry: unknown) => typeof entry === "string" && entry.includes("[lcm] assemble: done"));
    expect(assembleDoneLog).toEqual(expect.any(String));
    expect(assembleDoneLog).not.toContain("promptRecallMatches=");
  });

  it("does not add prompt-recall when an active summary already mentions the requested key", async () => {
    const engine = createEngine();
    const sessionId = "session-prompt-recall-summary-correction";
    const { liveMessages, prompt } = await seedPromptRecallFixture({
      engine,
      sessionId,
      summaryId: "sum_prompt_recall_summary_correction",
      summaryContent: "Correction: CRABPOT_LCM_FACT is green-lantern-88.",
      memoryUserContent: "CRABPOT_LCM_FACT is stale-blue-lantern-42.",
      memoryAssistantContent: "ok",
    });
    const searchSpy = vi.spyOn(engine.getConversationStore(), "searchMessages");

    const result = await engine.assemble({
      sessionId,
      messages: liveMessages,
      prompt,
      tokenBudget: 10_000,
    });

    const rendered = result.messages.map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    );
    expect(rendered.some((content) => content.includes("<lossless_claw_prompt_recall>"))).toBe(false);
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it("does not add prompt-recall when a newer raw tail already mentions the requested key", async () => {
    const engine = createEngine();
    const sessionId = "session-prompt-recall-tail-correction";
    const { liveMessages, prompt } = await seedPromptRecallFixture({
      engine,
      sessionId,
      summaryId: "sum_prompt_recall_tail_correction",
      summaryContent: "Older setup turn established a recall fact, but this summary omits the exact key.",
      memoryUserContent: "CRABPOT_LCM_FACT is stale-blue-lantern-42.",
      memoryAssistantContent: "ok",
      tailUserContent: "Correction: CRABPOT_LCM_FACT is green-lantern-88.",
      tailAssistantContent: "noted",
    });
    const searchSpy = vi.spyOn(engine.getConversationStore(), "searchMessages");

    const result = await engine.assemble({
      sessionId,
      messages: liveMessages,
      prompt,
      tokenBudget: 10_000,
    });

    const rendered = result.messages.map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    );
    expect(rendered.some((content) => content.includes("<lossless_claw_prompt_recall>"))).toBe(false);
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it("does not recall substring or secret-shaped identifiers", async () => {
    const boundaryEngine = createEngine();
    const boundary = await seedPromptRecallFixture({
      engine: boundaryEngine,
      sessionId: "session-prompt-recall-boundary",
      summaryId: "sum_prompt_recall_boundary",
      summaryContent: "Older setup turn had a related backup key, but not the requested exact key.",
      memoryUserContent: "CRABPOT_LCM_FACT_BACKUP is red-lantern-99.",
      memoryAssistantContent: "ok",
      prompt: "What is CRABPOT_LCM_FACT?",
    });
    const boundaryResult = await boundaryEngine.assemble({
      sessionId: "session-prompt-recall-boundary",
      messages: boundary.liveMessages,
      prompt: boundary.prompt,
      tokenBudget: 10_000,
    });
    const boundaryRendered = boundaryResult.messages.map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    );
    expect(boundaryRendered.some((content) => content.includes("<lossless_claw_prompt_recall>"))).toBe(false);

    const mixedCaseBoundaryEngine = createEngine();
    const mixedCaseBoundary = await seedPromptRecallFixture({
      engine: mixedCaseBoundaryEngine,
      sessionId: "session-prompt-recall-mixed-case-boundary",
      summaryId: "sum_prompt_recall_mixed_case_boundary",
      summaryContent: "Older setup turn had a similar mixed-case key, but not the requested exact key.",
      memoryUserContent: "CRABPOT_LCM_FACTv2 is green-lantern-88.",
      memoryAssistantContent: "ok",
      prompt: "What is CRABPOT_LCM_FACT?",
    });
    const mixedCaseBoundaryResult = await mixedCaseBoundaryEngine.assemble({
      sessionId: "session-prompt-recall-mixed-case-boundary",
      messages: mixedCaseBoundary.liveMessages,
      prompt: mixedCaseBoundary.prompt,
      tokenBudget: 10_000,
    });
    const mixedCaseBoundaryRendered = mixedCaseBoundaryResult.messages.map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    );
    expect(
      mixedCaseBoundaryRendered.some((content) => content.includes("<lossless_claw_prompt_recall>")),
    ).toBe(false);

    const secretEngine = createEngine();
    const secret = await seedPromptRecallFixture({
      engine: secretEngine,
      sessionId: "session-prompt-recall-secret",
      summaryId: "sum_prompt_recall_secret",
      summaryContent: "Older setup turn had a secret-like key that should not be auto-surfaced.",
      memoryUserContent: "API_KEY is redacted-test-value.",
      memoryAssistantContent: "ok",
      prompt: "What is API_KEY?",
    });
    const searchSpy = vi.spyOn(secretEngine.getConversationStore(), "searchMessages");
    const secretResult = await secretEngine.assemble({
      sessionId: "session-prompt-recall-secret",
      messages: secret.liveMessages,
      prompt: secret.prompt,
      tokenBudget: 10_000,
    });
    const secretRendered = secretResult.messages.map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    );
    expect(secretRendered.some((content) => content.includes("<lossless_claw_prompt_recall>"))).toBe(false);
    expect(searchSpy).not.toHaveBeenCalled();

    const contiguousSecretEngine = createEngine();
    const contiguousSecret = await seedPromptRecallFixture({
      engine: contiguousSecretEngine,
      sessionId: "session-prompt-recall-contiguous-secret",
      summaryId: "sum_prompt_recall_contiguous_secret",
      summaryContent: "Older setup turn had a secret-like key that should not be auto-surfaced.",
      memoryUserContent: "OPENAI_APIKEY is redacted-test-value.",
      memoryAssistantContent: "ok",
      prompt: "What is OPENAI_APIKEY?",
    });
    const contiguousSearchSpy = vi.spyOn(contiguousSecretEngine.getConversationStore(), "searchMessages");
    const contiguousSecretResult = await contiguousSecretEngine.assemble({
      sessionId: "session-prompt-recall-contiguous-secret",
      messages: contiguousSecret.liveMessages,
      prompt: contiguousSecret.prompt,
      tokenBudget: 10_000,
    });
    const contiguousSecretRendered = contiguousSecretResult.messages.map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    );
    expect(
      contiguousSecretRendered.some((content) => content.includes("<lossless_claw_prompt_recall>")),
    ).toBe(false);
    expect(contiguousSearchSpy).not.toHaveBeenCalled();
  });

  it("does not add prompt-recall snippets that include unrelated sensitive material", async () => {
    const engine = createEngine();
    const sessionId = "session-prompt-recall-sensitive-snippet";
    const prompt = "What is PROJECT_ID?";
    const { liveMessages } = await seedPromptRecallFixture({
      engine,
      sessionId,
      summaryId: "sum_prompt_recall_sensitive_snippet",
      summaryContent: "Older setup turn established a project fact, but this summary omits the exact key.",
      memoryUserContent: "PROJECT_ID is launch-alpha; api_key is redacted-test-value.",
      memoryAssistantContent: "ok",
      prompt,
    });

    const result = await engine.assemble({
      sessionId,
      messages: liveMessages,
      prompt,
      tokenBudget: 10_000,
    });

    const rendered = result.messages.map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    );
    expect(rendered.some((content) => content.includes("<lossless_claw_prompt_recall>"))).toBe(false);
    expect(rendered.some((content) => content.includes("api_key"))).toBe(false);
    expect(rendered.some((content) => content.includes("redacted-test-value"))).toBe(false);
  });

  it("does not add prompt-recall snippets that include underscore provider tokens", async () => {
    const engine = createEngine();
    const sessionId = "session-prompt-recall-underscore-provider-token";
    const prompt = "What is PROJECT_ID?";
    const fakeLiveKey = ["sk", "live", "a".repeat(24)].join("_");
    const { liveMessages } = await seedPromptRecallFixture({
      engine,
      sessionId,
      summaryId: "sum_prompt_recall_underscore_provider_token",
      summaryContent: "Older setup turn established a project fact, but this summary omits the exact key.",
      memoryUserContent: `PROJECT_ID is launch-alpha; ${fakeLiveKey}.`,
      memoryAssistantContent: "ok",
      prompt,
    });

    const result = await engine.assemble({
      sessionId,
      messages: liveMessages,
      prompt,
      tokenBudget: 10_000,
    });

    const rendered = result.messages.map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    );
    expect(rendered.some((content) => content.includes("<lossless_claw_prompt_recall>"))).toBe(false);
    expect(rendered.some((content) => content.includes(fakeLiveKey))).toBe(false);
  });

  it("continues prompt-recall search past filtered newer matches", async () => {
    const engine = createEngine();
    const sessionId = "session-prompt-recall-filtered-starvation";
    const prompt = "What is STARVED_FACT?";

    await engine.ingest({
      sessionId,
      message: { role: "user", content: "STARVED_FACT is blue-lantern-42." } as AgentMessage,
    });
    for (let index = 0; index < 8; index += 1) {
      await engine.ingest({
        sessionId,
        message: {
          role: "user",
          content: `STARVED_FACT candidate ${index}; API_KEY is redacted-test-value-${index}.`,
        } as AgentMessage,
      });
    }
    await engine.ingest({
      sessionId,
      message: { role: "user", content: "Say one neutral filler response." } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: { role: "assistant", content: "ok" } as unknown as AgentMessage,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({ sessionId });
    expect(conversation).toBeTruthy();
    const messages = await engine.getConversationStore().getMessages(conversation!.conversationId);
    const summaryStore = engine.getSummaryStore();
    await summaryStore.insertSummary({
      summaryId: "sum_prompt_recall_filtered_starvation",
      conversationId: conversation!.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Older setup turns established a recall fact, but this summary omits the exact key.",
      tokenCount: estimateTokens("Older setup turns established a recall fact."),
    });
    await summaryStore.linkSummaryToMessages(
      "sum_prompt_recall_filtered_starvation",
      messages.slice(0, 9).map((message) => message.messageId),
    );
    await summaryStore.replaceContextRangeWithSummary({
      conversationId: conversation!.conversationId,
      startOrdinal: 0,
      endOrdinal: 8,
      summaryId: "sum_prompt_recall_filtered_starvation",
    });
    const rankedMatches = [...messages.slice(1, 9).reverse(), messages[0]].map((message) => ({
      messageId: message.messageId,
      conversationId: conversation!.conversationId,
      role: message.role,
      snippet: message.content,
      createdAt: message.createdAt,
      rank: 0,
    }));
    const searchSpy = vi.spyOn(engine.getConversationStore(), "searchMessages").mockImplementation(async (input) =>
      rankedMatches.slice(0, input.limit ?? 0),
    );

    const result = await engine.assemble({
      sessionId,
      messages: [{ role: "user", content: prompt }] as AgentMessage[],
      prompt,
      tokenBudget: 10_000,
    });

    const rendered = result.messages.map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    );
    const recallCue = rendered.find((content) => content.includes("<lossless_claw_prompt_recall>"));
    expect(recallCue).toEqual(expect.any(String));
    expect(recallCue).toContain("STARVED_FACT is blue-lantern-42");
    expect(recallCue).not.toContain("API_KEY");
    expect(recallCue).not.toContain("redacted-test-value");
    expect(searchSpy).toHaveBeenCalledWith(expect.objectContaining({
      limit: 32,
      mode: "full_text",
      query: "STARVED_FACT",
      sort: "recency",
    }));
  });

  it("recalls multiple requested identifiers from the same historical message", async () => {
    const engine = createEngine();
    const sessionId = "session-prompt-recall-same-message-identifiers";
    const prompt = "Recall ALPHA_FACT and BETA_FACT.";
    const { liveMessages } = await seedPromptRecallFixture({
      engine,
      sessionId,
      summaryId: "sum_prompt_recall_same_message_identifiers",
      summaryContent: "Older setup turn established two named facts, but this summary omits the exact keys.",
      memoryUserContent: "ALPHA_FACT is blue-lantern-42. BETA_FACT is green-lantern-88.",
      memoryAssistantContent: "ok",
      prompt,
    });

    const result = await engine.assemble({
      sessionId,
      messages: liveMessages,
      prompt,
      tokenBudget: 10_000,
    });

    const rendered = result.messages.map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    );
    const recallCue = rendered.find((content) => content.includes("<lossless_claw_prompt_recall>"));
    expect(recallCue).toEqual(expect.any(String));
    expect(recallCue).toContain("ALPHA_FACT is blue-lantern-42");
    expect(recallCue).toContain("BETA_FACT is green-lantern-88");
  });

  it("changes the projection fingerprint when prompt-recall cue content changes", async () => {
    const engine = createEngine();
    const sessionId = "session-prompt-recall-projection-fingerprint";
    await seedPromptRecallFixture({
      engine,
      sessionId,
      summaryId: "sum_prompt_recall_projection_fingerprint",
      summaryContent: "Older setup turn established two named facts, but this summary omits the exact keys.",
      memoryUserContent: "ALPHA_FACT is blue-lantern-42. BETA_FACT is green-lantern-88.",
      memoryAssistantContent: "ok",
      prompt: "Recall ALPHA_FACT.",
    });

    const alphaResult = await engine.assemble({
      sessionId,
      messages: [{ role: "user", content: "Recall ALPHA_FACT." }] as AgentMessage[],
      prompt: "Recall ALPHA_FACT.",
      tokenBudget: 10_000,
    });
    const betaResult = await engine.assemble({
      sessionId,
      messages: [{ role: "user", content: "Recall BETA_FACT." }] as AgentMessage[],
      prompt: "Recall BETA_FACT.",
      tokenBudget: 10_000,
    });

    expect(alphaResult.contextProjection?.epoch).toBe(betaResult.contextProjection?.epoch);
    expect(alphaResult.contextProjection?.fingerprint).toMatch(/^prompt-recall-v1:[a-f0-9]{32}$/);
    expect(betaResult.contextProjection?.fingerprint).toMatch(/^prompt-recall-v1:[a-f0-9]{32}$/);
    expect(alphaResult.contextProjection?.fingerprint).not.toBe(
      betaResult.contextProjection?.fingerprint,
    );
  });

  it("bounds prompt-recall searches to four full-text identifier lookups", async () => {
    const engine = createEngine();
    const sessionId = "session-prompt-recall-search-bound";
    const prompt = "Recall ALPHA_FACT, BETA_FACT, GAMMA_FACT, DELTA_FACT, and EPSILON_FACT.";
    const { liveMessages } = await seedPromptRecallFixture({
      engine,
      sessionId,
      summaryId: "sum_prompt_recall_search_bound",
      summaryContent: "Older setup turn established a recall fact, but this summary omits the exact key.",
      memoryUserContent: "ALPHA_FACT is blue-lantern-42.",
      memoryAssistantContent: "ok",
      prompt,
    });
    const searchSpy = vi.spyOn(engine.getConversationStore(), "searchMessages");

    await engine.assemble({
      sessionId,
      messages: liveMessages,
      prompt,
      tokenBudget: 10_000,
    });

    expect(searchSpy).toHaveBeenCalledTimes(4);
    expect(searchSpy.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ mode: "full_text", query: "ALPHA_FACT" }),
      expect.objectContaining({ mode: "full_text", query: "BETA_FACT" }),
      expect.objectContaining({ mode: "full_text", query: "GAMMA_FACT" }),
      expect.objectContaining({ mode: "full_text", query: "DELTA_FACT" }),
    ]);
  });

  it("continues with assembled DB context when optional prompt recall lookup fails", async () => {
    const warnLog = vi.fn();
    const engine = createEngineWithDepsOverrides({
      log: {
        info: vi.fn(),
        warn: warnLog,
        error: vi.fn(),
        debug: vi.fn(),
      },
    });
    const sessionId = "session-prompt-recall-lookup-failure";
    const { liveMessages, prompt } = await seedPromptRecallFixture({
      engine,
      sessionId,
      summaryId: "sum_prompt_recall_lookup_failure",
      summaryContent: "Older setup turn established a recall fact, but this summary omits the exact key.",
    });
    vi.spyOn(engine.getConversationStore(), "searchMessages").mockRejectedValueOnce(
      new Error("simulated prompt recall failure"),
    );

    const result = await engine.assemble({
      sessionId,
      messages: liveMessages,
      prompt,
      tokenBudget: 10_000,
    });

    expect(result.contextProjection).toEqual({
      mode: "thread_bootstrap",
      epoch: expect.stringMatching(/^summary-prefix-v1:\d+:[a-f0-9]{32}$/),
    });
    expect(result.estimatedTokens).toBeGreaterThan(0);
    expect(result.messages).not.toStrictEqual(liveMessages);
    expect(warnLog).toHaveBeenCalledWith(expect.stringContaining("prompt recall failed"));
  });

  it("logs the emitted context projection epoch", async () => {
    const infoLog = vi.fn();
    const engine = createEngineWithDepsOverrides({
      log: {
        info: infoLog,
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    });
    const sessionId = "session-projection-log";

    await engine.ingest({
      sessionId,
      message: { role: "user", content: "persisted message one" } as AgentMessage,
    });
    const result = await engine.assemble({
      sessionId,
      messages: [],
      tokenBudget: 10_000,
    });

    const assembleDoneLog = infoLog.mock.calls
      .map((call: unknown[]) => call[0])
      .find((entry: unknown) => typeof entry === "string" && entry.includes("[lcm] assemble: done"));
    expect(assembleDoneLog).toEqual(expect.any(String));
    expect(assembleDoneLog).toContain("contextProjectionMode=thread_bootstrap");
    expect(assembleDoneLog).toContain(`contextProjectionEpoch=${result.contextProjection?.epoch}`);
    expect(assembleDoneLog).toContain("summaryContextItems=0");
  });

  it("keeps projection epochs stable across raw tail growth and changes them for summaries", async () => {
    const engine = createEngine();
    const sessionId = "session-projection-epoch";

    await engine.ingest({
      sessionId,
      message: { role: "user", content: "persisted message one" } as AgentMessage,
    });
    const first = await engine.assemble({
      sessionId,
      messages: [],
      tokenBudget: 10_000,
    });
    expect(first.contextProjection?.mode).toBe("thread_bootstrap");

    await engine.ingest({
      sessionId,
      message: { role: "assistant", content: "persisted message two" } as AgentMessage,
    });
    const afterRawTail = await engine.assemble({
      sessionId,
      messages: [],
      tokenBudget: 10_000,
    });
    expect(afterRawTail.contextProjection?.epoch).toBe(first.contextProjection?.epoch);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    await engine.getSummaryStore().insertSummary({
      summaryId: "sum_projection_epoch",
      conversationId: conversation!.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Summary projection content",
      tokenCount: 8,
      descendantCount: 0,
    });
    await engine
      .getSummaryStore()
      .appendContextSummary(conversation!.conversationId, "sum_projection_epoch");

    const afterSummary = await engine.assemble({
      sessionId,
      messages: [],
      tokenBudget: 10_000,
    });
    expect(afterSummary.contextProjection?.epoch).not.toBe(first.contextProjection?.epoch);
  });

  it("changes projection epochs when active focus state changes", async () => {
    const engine = createEngine();
    const sessionId = "session-projection-focus";

    await engine.ingest({
      sessionId,
      message: { role: "user", content: "covered source message" } as AgentMessage,
    });
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const [sourceMessage] = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId, { limit: 1 });
    expect(sourceMessage).toBeDefined();

    await engine.getSummaryStore().insertSummary({
      summaryId: "sum_projection_focus",
      conversationId: conversation!.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Covered summary projection content",
      tokenCount: 8,
      latestAt: new Date("2026-05-16T00:00:00.000Z"),
      descendantCount: 0,
    });
    await engine
      .getSummaryStore()
      .linkSummaryToMessages("sum_projection_focus", [sourceMessage!.messageId]);
    await engine
      .getSummaryStore()
      .replaceContextRangeWithSummary({
        conversationId: conversation!.conversationId,
        startOrdinal: 0,
        endOrdinal: 0,
        summaryId: "sum_projection_focus",
      });

    const baseline = await engine.assemble({
      sessionId,
      messages: [],
      tokenBudget: 10_000,
    });
    const focusStore = engine.getFocusBriefStore();
    const watermark = await focusStore.getCoveredWatermark(conversation!.conversationId);
    const activeBrief = await focusStore.createFocusBrief({
      conversationId: conversation!.conversationId,
      prompt: "focus projection",
      content: "Active focus brief content.",
      status: "active",
      tokenCount: 5,
      targetTokens: 12,
      coveredLatestAt: watermark.coveredLatestAt,
      coveredMessageSeq: watermark.coveredMessageSeq,
      sourceContextHash: "projection-focus-test",
      sources: [{ summaryId: "sum_projection_focus", ordinal: 0, role: "active_input" }],
      supersedeCurrentDrafts: true,
    });

    const focused = await engine.assemble({
      sessionId,
      messages: [],
      tokenBudget: 10_000,
    });
    expect(focused.contextProjection?.epoch).not.toBe(baseline.contextProjection?.epoch);

    await focusStore.deactivateActiveFocusBriefs(conversation!.conversationId);
    const unfocused = await engine.assemble({
      sessionId,
      messages: [],
      tokenBudget: 10_000,
    });
    expect(unfocused.contextProjection?.epoch).toBe(baseline.contextProjection?.epoch);
    expect(await focusStore.getFocusBrief(activeBrief.briefId)).toMatchObject({
      status: "inactive",
    });
  });

  it("respects token budget in assembled output", async () => {
    const engine = createEngine();
    const sessionId = "session-budget";

    for (let i = 0; i < 12; i++) {
      await engine.ingest({
        sessionId,
        message: {
          role: "user",
          content: `turn ${i} ${"x".repeat(396)}`,
        } as AgentMessage,
      });
    }

    const result = await engine.assemble({
      sessionId,
      messages: [{ role: "user", content: "live tail marker" }] as AgentMessage[],
      tokenBudget: 500,
    });

    expect(result.messages.length).toBeLessThan(12);
    expect(result.messages[0].content).not.toBe(`turn 0 ${"x".repeat(396)}`);
  });

  it("falls back to live messages if assembler throws", async () => {
    const engine = createEngine();
    const sessionId = "session-assemble-error";

    await engine.ingest({
      sessionId,
      message: { role: "user", content: "persisted message" } as AgentMessage,
    });

    const originalAssembler = (engine as unknown as { assembler: { assemble: unknown } }).assembler;
    (engine as unknown as { assembler: { assemble: () => Promise<never> } }).assembler = {
      ...originalAssembler,
      assemble: async () => {
        throw new Error("boom");
      },
    };

    const liveMessages: AgentMessage[] = [
      { role: "user", content: "live fallback message" },
    ] as AgentMessage[];
    const result = await engine.assemble({
      sessionId,
      messages: liveMessages,
      tokenBudget: 1000,
    });

    expect(result.messages).not.toBe(liveMessages);
    expect(result.messages).toStrictEqual(liveMessages);
    expect(result.estimatedTokens).toBe(0);
  });

  it("falls back to live context when assembled result has no user turns (cold-cache new session)", async () => {
    // Reproduces the cold-cache new session scenario:
    // Session starts with only an assistant greeting before any user message.
    // When the cache goes cold and assemble() is called, the assembled DB context
    // contains only the assistant greeting — no user turns.  This would cause a
    // prefill error on providers that require conversations to end with a user message.
    // The guard should detect the missing user turns and fall back to live context.
    const engine = createEngine();
    const sessionId = "session-cold-cache-no-user-turns";

    await engine.ingest({
      sessionId,
      message: { role: "assistant", content: "Hello! How can I help you today?" } as AgentMessage,
    });

    // Simulate the first real user message arriving (params.messages = current turn only)
    const liveMessages: AgentMessage[] = [
      { role: "user", content: "Hi, I need help with something." },
    ] as AgentMessage[];
    const result = await engine.assemble({
      sessionId,
      messages: liveMessages,
      tokenBudget: 10_000,
    });

    // Should fall back to live context, not return the assistant-only DB context.
    // The fallback must be a *new* array so the gateway hook's reference-equality
    // check (`assembled.messages !== sourceMessages`) treats it as assembled —
    // returning the same reference falls through to raw sourceMessages and
    // re-introduces the prefill-rejection bug fixed by safeFallback.
    expect(result.messages).not.toBe(liveMessages);
    expect(result.messages).toStrictEqual(liveMessages);
    expect(result.estimatedTokens).toBe(0);
  });

  it("does not fall back when assembled result has user turns even if it ends with assistant", async () => {
    // Normal session: DB has [user, assistant].  The assembled result ends with an
    // assistant turn, but it contains user turns — this is valid because the framework
    // appends the current user turn after the assembled context.
    const engine = createEngine();
    const sessionId = "session-ends-with-assistant-has-user-turns";

    await engine.ingest({
      sessionId,
      message: { role: "user", content: "persisted message one" } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: { role: "assistant", content: "persisted message two" } as AgentMessage,
    });

    const liveMessages: AgentMessage[] = [
      { role: "user", content: "live turn" },
    ] as AgentMessage[];
    const result = await engine.assemble({
      sessionId,
      messages: liveMessages,
      tokenBudget: 10_000,
    });

    // Should use the DB context (has user turns), not fall back to live
    expect(result.messages).not.toBe(liveMessages);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[1].role).toBe("assistant");
  });

  it("drops orphan tool results during assembled transcript repair", async () => {
    const engine = createEngine();
    const sessionId = "session-orphan-tool-result";

    await engine.ingest({
      sessionId,
      message: {
        role: "toolResult",
        toolCallId: "call_orphan",
        content: [{ type: "tool_result", tool_use_id: "call_orphan", content: "ok" }],
      } as AgentMessage,
    });

    const result = await engine.assemble({
      sessionId,
      messages: [],
      tokenBudget: 10_000,
    });

    expect(result.messages).toEqual([]);
  });

  it("inserts synthetic tool results when fresh-tail tool calls have no result", async () => {
    const engine = createEngine();
    const sessionId = "session-missing-tool-result";

    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_2", name: "read", input: { path: "foo.txt" } }],
      } as AgentMessage,
    });

    const result = await engine.assemble({
      sessionId,
      messages: [],
      tokenBudget: 10_000,
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.role).toBe("assistant");
    expect(result.messages[1]?.role).toBe("toolResult");
    expect((result.messages[1] as { toolCallId?: string }).toolCallId).toBe("call_2");
  });

  it("drops older orphaned assistant tool calls instead of surfacing synthetic repair results", async () => {
    const engine = createEngine();
    const sessionId = "session-historical-missing-tool-result";

    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_old", name: "read", input: { path: "foo.txt" } }],
      } as AgentMessage,
    });

    for (let i = 0; i < 8; i += 1) {
      await engine.ingest({
        sessionId,
        message: { role: "user", content: `fresh message ${i}` } as AgentMessage,
      });
    }

    const result = await engine.assemble({
      sessionId,
      messages: [],
      tokenBudget: 10_000,
    });

    expect(result.messages).toHaveLength(8);
    expect(
      result.messages.some(
        (message) =>
          message.role === "assistant" &&
          Array.isArray(message.content) &&
          message.content.some(
            (block) =>
              block &&
              typeof block === "object" &&
              "id" in block &&
              (block as { id?: unknown }).id === "call_old",
          ),
      ),
    ).toBe(false);
    expect(
      result.messages.some(
        (message) =>
          message.role === "toolResult" &&
          (message as { toolCallId?: string }).toolCallId === "call_old",
      ),
    ).toBe(false);
  });

  it("preserves non-tool content and matched tool calls when older assistant turns have stale orphaned calls", async () => {
    const engine = createEngine();
    const sessionId = "session-historical-mixed-tool-result";

    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check two things." },
          { type: "toolCall", id: "call_kept", name: "read", input: { path: "kept.txt" } },
          { type: "toolCall", id: "call_dropped", name: "read", input: { path: "dropped.txt" } },
        ],
      } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: {
        role: "toolResult",
        toolCallId: "call_kept",
        toolName: "read",
        content: [{ type: "text", text: "kept result" }],
      } as AgentMessage,
    });

    for (let i = 0; i < 8; i += 1) {
      await engine.ingest({
        sessionId,
        message: { role: "user", content: `fresh message ${i}` } as AgentMessage,
      });
    }

    const result = await engine.assemble({
      sessionId,
      messages: [],
      tokenBudget: 10_000,
    });

    const assistantMessage = result.messages.find(
      (message) => message.role === "assistant" && Array.isArray(message.content),
    );
    expect(assistantMessage).toBeDefined();
    expect(assistantMessage?.content).toEqual([
      { type: "text", text: "Let me check two things." },
      { type: "toolCall", id: "call_kept", name: "read", arguments: { path: "kept.txt" } },
    ]);
    expect(
      result.messages.some(
        (message) =>
          message.role === "toolResult" &&
          (message as { toolCallId?: string }).toolCallId === "call_kept",
      ),
    ).toBe(true);
    expect(
      result.messages.some(
        (message) =>
          message.role === "toolResult" &&
          (message as { toolCallId?: string }).toolCallId === "call_dropped",
      ),
    ).toBe(false);
  });

  it("assemble forwards fresh-tail and prompt-aware options", async () => {
    const engine = createEngineWithConfig({
      freshTailCount: 2,
      freshTailMaxTokens: 123,
      promptAwareEviction: false,
    });
    const privateEngine = engine as unknown as {
      assembler: {
        assemble: (input: unknown) => Promise<unknown>;
      };
    };
    const sessionId = "session-assembly-options";

    await engine.ingest({
      sessionId,
      message: { role: "user", content: "persisted message" } as AgentMessage,
    });
    const assembleSpy = vi.spyOn(privateEngine.assembler, "assemble");

    await engine.assemble({
      sessionId,
      messages: [makeMessage({ role: "user", content: "live message" })],
      tokenBudget: 10_000,
      prompt: "persisted",
    });

    expect(assembleSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        freshTailCount: 2,
        freshTailMaxTokens: 123,
        promptAwareEviction: false,
        prompt: "persisted",
      }),
    );
  });

  it("bounds previous assembled prefix snapshots with LRU eviction", async () => {
    const engine = createEngine();
    const cache = (
      engine as unknown as {
        previousAssembledMessagesByConversation: Map<number, unknown>;
      }
    ).previousAssembledMessagesByConversation;

    let firstConversationId: number | undefined;
    let secondConversationId: number | undefined;

    for (let i = 0; i < 101; i += 1) {
      const sessionId = `session-prefix-cache-${i}`;
      await engine.ingest({
        sessionId,
        message: { role: "user", content: `persisted message ${i}` } as AgentMessage,
      });
      await engine.assemble({
        sessionId,
        messages: [],
        tokenBudget: 10_000,
      });

      const newestConversationId = [...cache.keys()].at(-1);
      if (i === 0) {
        firstConversationId = newestConversationId;
      } else if (i === 1) {
        secondConversationId = newestConversationId;
      }
    }

    expect(firstConversationId).toBeTypeOf("number");
    expect(secondConversationId).toBeTypeOf("number");
    expect(cache.size).toBe(100);
    expect(cache.has(firstConversationId as number)).toBe(false);
    expect(cache.has(secondConversationId as number)).toBe(true);

    await engine.assemble({
      sessionId: "session-prefix-cache-0",
      messages: [],
      tokenBudget: 10_000,
    });

    expect(cache.size).toBe(100);
    expect(cache.has(firstConversationId as number)).toBe(true);
    expect(cache.has(secondConversationId as number)).toBe(false);
  });

  it("logs previous and current divergence message summaries when assembled prefixes change", async () => {
    const debugLog = vi.fn();
    const engine = createEngineWithDepsOverrides({
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: debugLog,
      },
    });
    const sessionId = "session-prefix-divergence-debug";

    await engine.ingest({
      sessionId,
      message: { role: "user", content: "persisted message" } as AgentMessage,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    (
      engine as unknown as {
        previousAssembledMessagesByConversation: Map<
          number,
          { serializedMessages: string[]; messageSummaries: string[]; fullHash: string }
        >;
      }
    ).previousAssembledMessagesByConversation.set(conversation!.conversationId, {
      serializedMessages: [JSON.stringify({ role: "assistant", content: "older different message" })],
      messageSummaries: ["seed-prev"],
      fullHash: "seed-hash",
    });

    await engine.assemble({
      sessionId,
      messages: [],
      tokenBudget: 10_000,
    });

    const assembleDebugLog = debugLog.mock.calls
      .map((call: unknown[]) => call[0])
      .find(
        (entry: unknown) =>
          typeof entry === "string" &&
          entry.includes("[lcm] assemble-debug") &&
          entry.includes(`conversation=${conversation!.conversationId}`),
      );

    expect(assembleDebugLog).toEqual(expect.any(String));
    expect(assembleDebugLog).toContain("previousWasPrefix=false");
    expect(assembleDebugLog).toContain("firstDivergenceIndex=0");
    expect(assembleDebugLog).toContain("previousDivergenceMessage=seed-prev");
    expect(assembleDebugLog).toContain("currentDivergenceMessage=user|content=text");
  });

  it("adds compact overflow diagnostics to stressed assemble debug logs", async () => {
    const debugLog = vi.fn();
    const engine = createEngineWithDepsOverrides({
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: debugLog,
      },
    });
    const sessionId = "session-overflow-diagnostics";
    const secretMarker = "PRIVATE_OVERFLOW_MARKER";

    await engine.ingest({
      sessionId,
      message: {
        role: "user",
        content: `large prompt contributor ${secretMarker} ${"x".repeat(1200)}`,
      } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: `second prompt contributor ${"y".repeat(600)}`,
      } as AgentMessage,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    (
      engine as unknown as {
        recordRecentBootstrapImport: (
          conversationId: number,
          importedMessages: number,
          reason: string | null,
        ) => void;
      }
    ).recordRecentBootstrapImport(
      conversation!.conversationId,
      7,
      "reconciled missing session messages",
    );

    await engine.assemble({
      sessionId,
      messages: [],
      tokenBudget: 100,
    });

    const assembleDebugLog = debugLog.mock.calls
      .map((call: unknown[]) => call[0])
      .find(
        (entry: unknown) =>
          typeof entry === "string" &&
          entry.includes("[lcm] assemble-debug") &&
          entry.includes("overflowDiagnostics="),
      ) as string | undefined;

    expect(assembleDebugLog).toEqual(expect.any(String));
    expect(assembleDebugLog).not.toContain(secretMarker);
    const diagnostics = JSON.parse(
      assembleDebugLog!
        .slice(assembleDebugLog!.indexOf("overflowDiagnostics="))
        .replace("overflowDiagnostics=", ""),
    ) as Record<string, unknown>;
    expect(diagnostics).toMatchObject({
      tokenBudget: 100,
      rawMessageCount: 2,
      summaryCount: 0,
      totalContextItems: 2,
      recentBootstrapImportCount: 7,
      recentBootstrapImportReason: "reconciled missing session messages",
    });
    expect(diagnostics.topMessageContributors).toEqual([
      expect.objectContaining({
        seq: 1,
        role: "user",
        selected: true,
      }),
      expect.objectContaining({
        seq: 2,
        role: "assistant",
        selected: true,
      }),
    ]);
  });

  it("repairs OpenAI function_call transcripts without dropping reasoning blocks", async () => {
    const engine = createEngine();
    const sessionId = "session-openai-function-call";

    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "Need to inspect the working directory." }],
          },
          {
            type: "function_call",
            call_id: "fc_1",
            name: "bash",
            arguments: '{"cmd":"pwd"}',
          },
        ],
      } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: { role: "user", content: "interleaved user turn" } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: {
        role: "toolResult",
        toolCallId: "fc_1",
        toolName: "bash",
        content: [{ type: "function_call_output", call_id: "fc_1", output: "/tmp" }],
        isError: false,
        timestamp: Date.now(),
      } as AgentMessage,
    });

    const result = await engine.assemble({
      sessionId,
      messages: [],
      tokenBudget: 10_000,
    });

    expect(result.messages).toHaveLength(3);

    const assistant = result.messages[0] as {
      role: string;
      content?: Array<{ type?: string; call_id?: string }>;
    };
    expect(assistant.role).toBe("assistant");
    expect(assistant.content?.map((block) => block.type)).toEqual(["reasoning", "function_call"]);
    expect(assistant.content?.[1]?.call_id).toBe("fc_1");

    expect(result.messages[1]?.role).toBe("toolResult");
    expect((result.messages[1] as { toolCallId?: string }).toolCallId).toBe("fc_1");
    expect(result.messages[2]?.role).toBe("user");
  });

  it("filters assistant messages with blank-text content during assembly", async () => {
    // Regression: v0.9.3's #506 added an isThinkingOnlyContent filter for the
    // Bedrock empty-content rejection, but did not handle the
    // [{type:"text", text:""}] blank-text shape — Bedrock still rejects with
    // "The text field in the ContentBlock object at messages.N.content.0 is
    // blank". The cleanedEntries filter must strip all-blank messages and blank
    // blocks inside otherwise valid assistant messages.
    const engine = createEngine();
    const sessionId = randomUUID();

    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "Question?" }),
    });
    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "" }],
      } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "   \n\t  " }],
      } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "Real answer." },
        ],
      } as AgentMessage,
    });

    const assembled = await engine.assemble({
      sessionId,
      messages: [],
      tokenBudget: 10_000,
    });

    expect(assembled.messages).toHaveLength(2);
    expect(assembled.messages[0]?.role).toBe("user");
    const assistant = assembled.messages[1] as {
      role: string;
      content?: Array<{ type?: string; text?: string }>;
    };
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toHaveLength(1);
    expect(assistant.content?.[0]?.text).toBe("Real answer.");
  });

  it("filters thinking-only assistant messages during assembly", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();

    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "Explain the result." }),
    });
    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Internal reasoning only." }],
      } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Keep reasoning with visible output." },
          { type: "text", text: "Visible answer." },
        ],
      } as AgentMessage,
    });

    const assembled = await engine.assemble({
      sessionId,
      messages: [],
      tokenBudget: 10_000,
    });

    expect(assembled.messages).toHaveLength(2);
    expect(assembled.messages[0]?.role).toBe("user");
    const assistant = assembled.messages[1] as {
      role: string;
      content?: Array<{ type?: string; text?: string }>;
    };
    expect(assistant.role).toBe("assistant");
    expect(assistant.content?.map((block) => block.type)).toEqual(["thinking", "text"]);
    expect(assistant.content?.[1]?.text).toBe("Visible answer.");
  });

  it("rebuilds raw function_call blocks from stored columns when raw arguments are objects", async () => {
    const engine = createEngine();
    const sessionId = "session-openai-function-call-raw-arguments-object";

    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [
          {
            type: "function_call",
            call_id: "fc_raw",
            name: "bash",
            arguments: '{"cmd":"pwd"}',
          },
        ],
      } as AgentMessage,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const storedMessages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(storedMessages).toHaveLength(1);

    const parts = await engine.getConversationStore().getMessageParts(storedMessages[0].messageId);
    expect(parts).toHaveLength(1);

    const db = (engine.getConversationStore() as unknown as {
      db: { prepare: (sql: string) => { run: (metadata: string, partId: string) => void } };
    }).db;

    const metadata = JSON.parse(parts[0].metadata ?? "{}") as {
      raw?: Record<string, unknown>;
    };
    expect(metadata.raw?.arguments).toBe('{"cmd":"pwd"}');
    metadata.raw = {
      ...(metadata.raw ?? {}),
      arguments: { cmd: "pwd" },
    };
    db.prepare("UPDATE message_parts SET metadata = ? WHERE part_id = ?").run(
      JSON.stringify(metadata),
      parts[0].partId,
    );

    const assembler = new ContextAssembler(engine.getConversationStore(), engine.getSummaryStore());
    const assembled = await assembler.assemble({
      conversationId: conversation!.conversationId,
      tokenBudget: 10_000,
    });

    const assistant = assembled.messages[0] as {
      role: string;
      content?: Array<{ type?: string; call_id?: string; arguments?: unknown }>;
    };
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toEqual([
      {
        type: "function_call",
        call_id: "fc_raw",
        name: "bash",
        arguments: '{"cmd":"pwd"}',
      },
    ]);
  });

  it("does not emit assembly-specific system prompt guidance when no summaries exist", async () => {
    const engine = createEngine();
    const sessionId = "session-no-summary-guidance";

    await engine.ingest({
      sessionId,
      message: { role: "user", content: "plain context one" } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: { role: "assistant", content: "plain context two" } as AgentMessage,
    });

    const result = await engine.assemble({
      sessionId,
      messages: [],
      tokenBudget: 10_000,
    });

    const promptAddition = (result as { systemPromptAddition?: string }).systemPromptAddition;
    expect(promptAddition).toBeUndefined();
  });

  it("does not emit assembly-specific system prompt guidance when summaries are present", async () => {
    const engine = createEngine();
    const sessionId = "session-summary-guidance";

    await engine.ingest({
      sessionId,
      message: { role: "user", content: "seed message" } as AgentMessage,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    await engine.getSummaryStore().insertSummary({
      summaryId: "sum_guidance_leaf",
      conversationId: conversation!.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Leaf summary content",
      tokenCount: 16,
      descendantCount: 0,
    });
    await engine
      .getSummaryStore()
      .appendContextSummary(conversation!.conversationId, "sum_guidance_leaf");

    const result = await engine.assemble({
      sessionId,
      messages: [],
      tokenBudget: 10_000,
    });

    const promptAddition = (result as { systemPromptAddition?: string }).systemPromptAddition;
    expect(promptAddition).toBeUndefined();
  });
});

describe("LcmContextEngine fidelity and token budget", () => {
  it("normalizes tool_result blocks without inflating stored token accounting", async () => {
    // Verify that tool_result blocks with large raw metadata blobs are
    // normalized through toolResultBlockFromPart rather than returned
    // verbatim. Raw metadata should NOT leak into the assembled payload —
    // only the dedicated part columns (toolOutput, textContent) matter.
    const engine = createEngine();
    const sessionId = randomUUID();
    const rawBlob = "x".repeat(24_000);

    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_large_raw", name: "read", input: { path: "foo.txt" } },
        ],
      } as AgentMessage,
    });

    await engine.ingest({
      sessionId,
      message: {
        role: "toolResult",
        toolCallId: "call_large_raw",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_large_raw",
            metadata: {
              raw: rawBlob,
              details: { payload: rawBlob.slice(0, 8_000) },
            },
          },
        ],
      } as AgentMessage,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const contextTokens = await engine
      .getSummaryStore()
      .getContextTokenCount(conversation!.conversationId);
    const assembler = new ContextAssembler(engine.getConversationStore(), engine.getSummaryStore());
    const assembled = await assembler.assemble({
      conversationId: conversation!.conversationId,
      tokenBudget: 500_000,
    });
    const assembledPayloadTokens = estimateAssembledPayloadTokens(assembled.messages);

    // The assembled payload should be small — the 24K raw metadata blob
    // must NOT appear in the output. Tool results use dedicated columns,
    // not the raw metadata object.
    expect(contextTokens).toBe(assembledPayloadTokens);
    expect(assembledPayloadTokens).toBeLessThan(500);
  });

  it("preserves structured toolResult content via message_parts and assembler", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const assistantToolCall = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_123", name: "read", input: { path: "foo.txt" } }],
    } as AgentMessage;
    const toolResult = {
      role: "toolResult",
      toolCallId: "call_123",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_123",
          content: [{ type: "text", text: "command output" }],
        },
      ],
    } as AgentMessage;

    await engine.ingest({
      sessionId,
      message: assistantToolCall,
    });

    await engine.ingest({
      sessionId,
      message: toolResult,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const storedMessages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(storedMessages).toHaveLength(2);
    expect(storedMessages[1].role).toBe("tool");

    const parts = await engine.getConversationStore().getMessageParts(storedMessages[1].messageId);
    expect(parts).toHaveLength(1);
    expect(parts[0].partType).toBe("tool");
    expect(parts[0].toolCallId).toBe("call_123");

    const assembler = new ContextAssembler(engine.getConversationStore(), engine.getSummaryStore());
    const assembled = await assembler.assemble({
      conversationId: conversation!.conversationId,
      tokenBudget: 10_000,
    });
    expect(assembled.messages).toHaveLength(2);
    expect(assembled.messages[0]?.role).toBe("assistant");

    const assembledMessage = assembled.messages[1] as {
      role: string;
      toolCallId?: string;
      content?: unknown;
    };
    expect(assembledMessage.role).toBe("toolResult");
    expect(assembledMessage.toolCallId).toBe("call_123");
    expect(Array.isArray(assembledMessage.content)).toBe(true);
    expect((assembledMessage.content as Array<{ type?: string }>)[0]?.type).toBe("tool_result");
    expect(
      (assembledMessage.content as Array<{ content?: unknown }>)[0]?.content,
    ).toEqual([{ type: "text", text: "command output" }]);
  });

  it("does not leak OpenAI function tool payloads into stored message content fallbacks", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();

    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [
          { type: "function_call", call_id: "fc_only", name: "bash", arguments: '{"cmd":"pwd"}' },
        ],
      } as AgentMessage,
    });

    await engine.ingest({
      sessionId,
      message: {
        role: "toolResult",
        toolCallId: "fc_only",
        toolName: "bash",
        content: [{ type: "function_call_output", call_id: "fc_only", output: "/tmp" }],
        isError: false,
      } as AgentMessage,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const storedMessages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(storedMessages).toHaveLength(2);
    expect(storedMessages[0]?.content).toBe("");
    expect(storedMessages[1]?.content).toBe("");

    const assembled = await engine.assemble({
      sessionId,
      messages: [],
      tokenBudget: 10_000,
    });
    const assistant = assembled.messages[0] as { content?: Array<{ type?: string }> };
    const toolResult = assembled.messages[1] as { content?: Array<{ type?: string }> };
    expect(assistant.content?.[0]?.type).toBe("function_call");
    expect(toolResult.content?.[0]?.type).toBe("function_call_output");
  });

  it("preserves toolName through ingest-assemble round-trip for Gemini compatibility", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();

    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_456", name: "bash", input: { command: "ls" } }],
      } as AgentMessage,
    });

    await engine.ingest({
      sessionId,
      message: {
        role: "toolResult",
        toolCallId: "call_456",
        toolName: "bash",
        content: [{ type: "text", text: "file1.txt\nfile2.txt" }],
        isError: false,
      } as AgentMessage,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const storedMessages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    const parts = await engine
      .getConversationStore()
      .getMessageParts(storedMessages[1].messageId);
    expect(parts[0].toolName).toBe("bash");

    const assembler = new ContextAssembler(engine.getConversationStore(), engine.getSummaryStore());
    const assembled = await assembler.assemble({
      conversationId: conversation!.conversationId,
      tokenBudget: 10_000,
    });

    const result = assembled.messages[1] as {
      role: string;
      toolCallId?: string;
      toolName?: string;
      isError?: boolean;
    };
    expect(result.role).toBe("toolResult");
    expect(result.toolCallId).toBe("call_456");
    expect(result.toolName).toBe("bash");
    expect(result.isError).toBe(false);
  });

  it("preserves toolResult error state through ingest-assemble round-trip", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();

    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_457", name: "bash", input: { command: "false" } }],
      } as AgentMessage,
    });

    await engine.ingest({
      sessionId,
      message: {
        role: "toolResult",
        toolCallId: "call_457",
        toolName: "bash",
        content: [{ type: "text", text: "command failed" }],
        isError: true,
      } as AgentMessage,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const storedMessages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    const parts = await engine
      .getConversationStore()
      .getMessageParts(storedMessages[1].messageId);
    expect(JSON.parse(parts[0].metadata ?? "{}")).toMatchObject({ isError: true });

    const assembler = new ContextAssembler(engine.getConversationStore(), engine.getSummaryStore());
    const assembled = await assembler.assemble({
      conversationId: conversation!.conversationId,
      tokenBudget: 10_000,
    });

    const result = assembled.messages[1] as {
      role: string;
      toolCallId?: string;
      toolName?: string;
      isError?: boolean;
    };
    expect(result.role).toBe("toolResult");
    expect(result.toolCallId).toBe("call_457");
    expect(result.toolName).toBe("bash");
    expect(result.isError).toBe(true);
  });

  it("preserves top-level tool metadata for string-content tool results", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();

    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_458", name: "bash", input: { command: "pwd" } }],
      } as AgentMessage,
    });

    await engine.ingest({
      sessionId,
      message: {
        role: "toolResult",
        toolCallId: "call_458",
        toolName: "bash",
        content: "/tmp/project",
        isError: false,
      } as AgentMessage,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const storedMessages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    const parts = await engine
      .getConversationStore()
      .getMessageParts(storedMessages[1].messageId);
    expect(parts[0].partType).toBe("text");
    expect(JSON.parse(parts[0].metadata ?? "{}")).toMatchObject({
      toolCallId: "call_458",
      toolName: "bash",
      isError: false,
    });

    const assembler = new ContextAssembler(engine.getConversationStore(), engine.getSummaryStore());
    const assembled = await assembler.assemble({
      conversationId: conversation!.conversationId,
      tokenBudget: 10_000,
    });

    const result = assembled.messages[1] as {
      role: string;
      toolCallId?: string;
      toolName?: string;
      isError?: boolean;
      content?: unknown;
    };
    expect(result.role).toBe("toolResult");
    expect(result.toolCallId).toBe("call_458");
    expect(result.toolName).toBe("bash");
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "/tmp/project" }]);
  });

  it("reconstructs OpenAI reasoning and function call blocks when raw metadata is missing", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();

    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "Need shell output before replying." }],
          },
          {
            type: "function_call",
            call_id: "fc_2",
            name: "bash",
            arguments: '{"cmd":"pwd"}',
          },
        ],
      } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: {
        role: "toolResult",
        toolCallId: "fc_2",
        toolName: "bash",
        content: [{ type: "function_call_output", call_id: "fc_2", output: { cwd: "/tmp" } }],
        isError: false,
        timestamp: Date.now(),
      } as AgentMessage,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const storedMessages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(storedMessages).toHaveLength(2);

    const assistantParts = await engine
      .getConversationStore()
      .getMessageParts(storedMessages[0].messageId);
    expect(assistantParts.map((part) => part.partType)).toEqual(["reasoning", "tool"]);
    expect(assistantParts[1].toolCallId).toBe("fc_2");

    const toolResultParts = await engine
      .getConversationStore()
      .getMessageParts(storedMessages[1].messageId);
    expect(toolResultParts).toHaveLength(1);
    expect(toolResultParts[0].partType).toBe("tool");
    expect(toolResultParts[0].toolCallId).toBe("fc_2");

    const db = (engine.getConversationStore() as unknown as {
      db: { prepare: (sql: string) => { run: (metadata: string, partId: string) => void } };
    }).db;

    for (const part of [...assistantParts, ...toolResultParts]) {
      const metadata = JSON.parse(part.metadata ?? "{}") as Record<string, unknown>;
      delete metadata.raw;
      db.prepare("UPDATE message_parts SET metadata = ? WHERE part_id = ?").run(
        JSON.stringify(metadata),
        part.partId,
      );
    }

    const assembler = new ContextAssembler(engine.getConversationStore(), engine.getSummaryStore());
    const assembled = await assembler.assemble({
      conversationId: conversation!.conversationId,
      tokenBudget: 10_000,
    });

    expect(assembled.messages).toHaveLength(2);

    const assistant = assembled.messages[0] as {
      role: string;
      content?: Array<{ type?: string; text?: string; call_id?: string; arguments?: unknown }>;
    };
    expect(assistant.role).toBe("assistant");
    expect(assistant.content?.map((block) => block.type)).toEqual(["reasoning", "function_call"]);
    expect(assistant.content?.[0]?.text).toBe("Need shell output before replying.");
    expect(assistant.content?.[1]?.call_id).toBe("fc_2");
    expect(assistant.content?.[1]?.arguments).toBe('{"cmd":"pwd"}');

    const toolResult = assembled.messages[1] as {
      role: string;
      toolCallId?: string;
      content?: Array<{ type?: string; call_id?: string; output?: unknown }>;
    };
    expect(toolResult.role).toBe("toolResult");
    expect(toolResult.toolCallId).toBe("fc_2");
    expect(toolResult.content?.[0]?.type).toBe("function_call_output");
    expect(toolResult.content?.[0]?.call_id).toBe("fc_2");
    expect(toolResult.content?.[0]?.output).toEqual({ cwd: "/tmp" });
  });

  it("skips unknown roles instead of storing them as assistant messages", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();

    const result = await engine.ingest({
      sessionId,
      message: makeMessage({ role: "custom-event", content: "opaque payload" }),
    });

    expect(result.ingested).toBe(false);
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).toBeNull();
  });

  it("uses explicit compact tokenBudget over legacy tokenBudget", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (conversationId: number, tokenBudget: number) => Promise<unknown>;
        compactUntilUnder: (input: unknown) => Promise<unknown>;
      };
    };
    const evaluateSpy = vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "none",
      currentTokens: 12,
      threshold: 9,
    });
    const compactSpy = vi.spyOn(privateEngine.compaction, "compactUntilUnder");

    await engine.ingest({
      sessionId: "budget-session",
      message: makeMessage({ role: "user", content: "hello world" }),
    });

    const result = await engine.compact({
      sessionId: "budget-session",
      sessionFile: "/tmp/unused.jsonl",
      tokenBudget: 123,
      legacyParams: { tokenBudget: 999 },
    });

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(evaluateSpy).toHaveBeenCalledWith(expect.any(Number), 123);
    expect(compactSpy).not.toHaveBeenCalled();
  });

  it("ingests completed turn batches with ingestBatch", async () => {
    const engine = createEngine();
    const sessionId = "batch-ingest-session";
    const messages: AgentMessage[] = [
      makeMessage({ role: "user", content: "turn user 1" }),
      makeMessage({ role: "assistant", content: "turn assistant 1" }),
      makeMessage({ role: "user", content: "turn user 2" }),
    ];

    const result = await engine.ingestBatch({
      sessionId,
      messages,
    });
    expect(result.ingestedCount).toBe(3);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    expect(await engine.getConversationStore().getMessageCount(conversation!.conversationId)).toBe(
      3,
    );
    expect(
      (await engine.getSummaryStore().getContextItems(conversation!.conversationId)).length,
    ).toBe(3);
  });

  it("skips heartbeat turn batches in ingestBatch", async () => {
    const engine = createEngine();
    const sessionId = "batch-ingest-heartbeat-session";

    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "keep this turn" }),
    });

    const heartbeatBatch: AgentMessage[] = [
      makeMessage({ role: "user", content: "heartbeat poll: pending" }),
      makeMessage({ role: "assistant", content: "worker snapshot: large payload" }),
    ];

    const result = await engine.ingestBatch({
      sessionId,
      messages: heartbeatBatch,
      isHeartbeat: true,
    });

    expect(result.ingestedCount).toBe(0);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    expect(await engine.getConversationStore().getMessageCount(conversation!.conversationId)).toBe(
      1,
    );
    expect(
      (await engine.getSummaryStore().getContextItems(conversation!.conversationId)).length,
    ).toBe(1);

    const assembled = await engine.assemble({
      sessionId,
      messages: [],
      tokenBudget: 10_000,
    });

    const assembledText = assembled.messages
      .map((message) => (typeof message.content === "string" ? message.content : ""))
      .join("\n");
    expect(assembledText).toContain("keep this turn");
    expect(assembledText).not.toContain("heartbeat poll");
    expect(assembledText).not.toContain("worker snapshot");
  });

  it("afterTurn ingests auto-compaction summary and new turn messages", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-ingest";

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-ingest"),
      messages: [
        makeMessage({ role: "user", content: "already present before prompt" }),
        makeMessage({ role: "assistant", content: "new assistant reply" }),
      ],
      prePromptMessageCount: 1,
      autoCompactionSummary: "[summary] compacted older history",
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "[summary] compacted older history",
      "new assistant reply",
    ]);
  });

  it("afterTurn deduplicates replayed history before prepending auto-compaction summary", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-summary-replay";

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-summary-replay-seed"),
      messages: [
        makeMessage({ role: "user", content: "old question" }),
        makeMessage({ role: "assistant", content: "old answer" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-summary-replay"),
      messages: [
        makeMessage({ role: "system", content: "system prompt" }),
        makeMessage({ role: "user", content: "old question" }),
        makeMessage({ role: "assistant", content: "old answer" }),
        makeMessage({ role: "user", content: "new question" }),
        makeMessage({ role: "assistant", content: "new answer" }),
      ],
      prePromptMessageCount: 1,
      autoCompactionSummary: "[summary] compacted older history",
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old question",
      "old answer",
      "[summary] compacted older history",
      "new question",
      "new answer",
    ]);
  });

  it("afterTurn skips new-message content already covered by auto-compaction summary", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-summary-overlap";
    const repeatedInstruction =
      "kick off workers to review all of these pull requests and report back";

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-summary-overlap"),
      messages: [
        makeMessage({ role: "user", content: repeatedInstruction }),
        makeMessage({ role: "assistant", content: "Workers are running now." }),
      ],
      prePromptMessageCount: 0,
      autoCompactionSummary: `Summary of compacted context: the user said "${repeatedInstruction}" and the assistant began coordinating the work.`,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      `Summary of compacted context: the user said "${repeatedInstruction}" and the assistant began coordinating the work.`,
      "Workers are running now.",
    ]);
  });

  it("afterTurn does not drop short messages just because they appear in auto-compaction summary", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-summary-short-overlap";

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-summary-short-overlap"),
      messages: [
        makeMessage({ role: "user", content: "yes" }),
        makeMessage({ role: "assistant", content: "Proceeding." }),
      ],
      prePromptMessageCount: 0,
      autoCompactionSummary: "Summary: the user previously said yes to the plan.",
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "Summary: the user previously said yes to the plan.",
      "yes",
      "Proceeding.",
    ]);
  });

  it("afterTurn keeps a 24+ char user message that only collides as a substring of the summary narrative (F6)", async () => {
    // PR-6 #566 / F6: bare summary.includes(content) was too loose. A medium-
    // length user instruction that coincidentally appears inside a long
    // narrative summary must NOT be silently dropped — only anchored or
    // quoted matches count as covered.
    const engine = createEngine();
    const sessionId = "after-turn-summary-substring-collision";
    const collidingInstruction = "please update the readme file"; // 30 chars
    const summary =
      "Summary of compacted context: the assistant was asked to please " +
      "update the readme file with new sections, then verify CI passes " +
      "and report back to the operator before EOD.";
    expect(summary.toLowerCase()).toContain(collidingInstruction);

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-summary-substring-collision"),
      messages: [
        makeMessage({ role: "user", content: collidingInstruction }),
        makeMessage({ role: "assistant", content: "Acknowledged." }),
      ],
      prePromptMessageCount: 0,
      autoCompactionSummary: summary,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    // The user instruction must survive: it's only a coincidental substring,
    // not anchored or quoted.
    expect(stored.map((message) => message.content)).toEqual([
      summary,
      collidingInstruction,
      "Acknowledged.",
    ]);
  });

  it("afterTurn drops a user message when the summary ends with that exact content (F6 anchored)", async () => {
    // Anchored truth case: content appears at the end of the summary's
    // normalized text — that's a real coverage signal, drop the dup.
    const engine = createEngine();
    const sessionId = "after-turn-summary-suffix-anchored";
    const repeatedInstruction = "kick off the workers and check back in an hour";
    const summary = `Summary of compacted context. ${repeatedInstruction}`;

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-summary-suffix-anchored"),
      messages: [
        makeMessage({ role: "user", content: repeatedInstruction }),
        makeMessage({ role: "assistant", content: "On it." }),
      ],
      prePromptMessageCount: 0,
      autoCompactionSummary: summary,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([summary, "On it."]);
  });

  it("afterTurn runs inline threshold compaction only after context threshold is crossed", async () => {
    const engine = createEngineWithConfig({
      proactiveThresholdCompactionMode: "inline",
    });
    const sessionId = "after-turn-inline-threshold-compact";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };

    const leafTriggerSpy = vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger");
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 3_500,
      threshold: 3_072,
    });
    const compactSpy = vi.spyOn(engine, "compact").mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
      result: {
        tokensBefore: 3_500,
        tokensAfter: 2_000,
      },
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-inline-threshold-compact"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
      runtimeContext: { currentTokenCount: 3_500 },
    });

    expect(leafTriggerSpy).not.toHaveBeenCalled();
    expect(compactSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        tokenBudget: 4_096,
        currentTokenCount: 3_500,
        compactionTarget: "threshold",
      }),
    );
  });

  it("afterTurn runs inline threshold compaction when projected raw backlog crosses threshold", async () => {
    const engine = createEngineWithConfig({
      proactiveThresholdCompactionMode: "inline",
      freshTailCount: 1,
    });
    const sessionId = "after-turn-inline-projected-raw-backlog-threshold";
    await seedBacklogContext(engine, sessionId, [100, 100, 100]);
    const compactSpy = vi.spyOn(engine, "compact").mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-inline-projected-raw-backlog-threshold"),
      messages: [makeMessage({ role: "assistant", content: "fresh projected turn" })],
      prePromptMessageCount: 0,
      tokenBudget: 600,
      runtimeContext: { currentTokenCount: 300 },
    });

    expect(compactSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        tokenBudget: 600,
        currentTokenCount: 300,
        compactionTarget: "threshold",
      }),
    );
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    await expect(
      engine.getSummaryStore().getContextTokenCount(conversation!.conversationId),
    ).resolves.toBeLessThan(450);
  });

  it("afterTurn records deferred threshold debt when projected raw backlog crosses threshold", async () => {
    const debugLog = vi.fn();
    const engine = createEngineWithDeps(
      { freshTailCount: 1 },
      {
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: debugLog },
      },
    );
    const sessionId = "after-turn-deferred-projected-raw-backlog-threshold";
    const privateEngine = engine as unknown as {
      scheduleDeferredCompactionDebtDrain: (params: unknown) => void;
    };
    await seedBacklogContext(engine, sessionId, [100, 100, 100]);
    const scheduleSpy = vi
      .spyOn(privateEngine, "scheduleDeferredCompactionDebtDrain")
      .mockImplementation(() => undefined);
    const compactSpy = vi.spyOn(engine, "compact");

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-deferred-projected-raw-backlog-threshold"),
      messages: [makeMessage({ role: "assistant", content: "fresh projected turn" })],
      prePromptMessageCount: 0,
      tokenBudget: 600,
      runtimeContext: { currentTokenCount: 300 },
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation!.conversationId);
    expect(compactSpy).not.toHaveBeenCalled();
    expect(scheduleSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        tokenBudget: 600,
        currentTokenCount: 300,
        reason: "threshold",
      }),
    );
    expect(maintenance).toMatchObject({
      pending: true,
      running: false,
      reason: "threshold",
      tokenBudget: 600,
      currentTokenCount: 300,
      projectedTokenCount: expect.any(Number),
      rawTokensOutsideTail: expect.any(Number),
    });
    await expect(
      engine.getSummaryStore().getContextTokenCount(conversation!.conversationId),
    ).resolves.toBeLessThan(450);
    const deferredDebtLog = debugLog.mock.calls
      .map((call) => String(call[0]))
      .find((message) => message.includes("deferred compaction debt recorded"));
    expect(deferredDebtLog).toContain("projectedTokenCount=");
    expect(deferredDebtLog).not.toContain("projectedTokenCount=null");
    expect(deferredDebtLog).toContain("rawTokensOutsideTail=");
    expect(deferredDebtLog).not.toContain("rawTokensOutsideTail=null");
  });

  it("afterTurn ignores raw leaf pressure below the context threshold", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-below-threshold-ignores-leaf-pressure";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
      scheduleDeferredCompactionDebtDrain: (params: unknown) => void;
    };

    const leafTriggerSpy = vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger");
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 20_000,
      threshold: 96_000,
    });
    const scheduleSpy = vi.spyOn(privateEngine, "scheduleDeferredCompactionDebtDrain");
    const compactSpy = vi.spyOn(engine, "compact");

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-below-threshold-ignores-leaf-pressure"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 128_000,
      runtimeContext: { currentTokenCount: 20_000 },
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation!.conversationId);
    expect(leafTriggerSpy).not.toHaveBeenCalled();
    expect(compactSpy).not.toHaveBeenCalled();
    expect(scheduleSpy).not.toHaveBeenCalled();
    expect(maintenance?.pending ?? false).toBe(false);
  });

  it("afterTurn resolves tokenBudget from runtimeContext and forwards it as legacyParams", async () => {
    const engine = createEngineWithConfig({
      proactiveThresholdCompactionMode: "inline",
    });
    const sessionId = "after-turn-runtime-context";
    const runtimeContext = {
      provider: "anthropic",
      model: "claude-opus-4-5",
      tokenBudget: 2048,
      currentTokenCount: 1800,
    };
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };

    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 1800,
      threshold: 1536,
    });
    const compactSpy = vi.spyOn(engine, "compact").mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-runtime-context"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      runtimeContext,
    });

    expect(compactSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenBudget: 2048,
        currentTokenCount: 1800,
        legacyParams: runtimeContext,
        compactionTarget: "threshold",
      }),
    );
  });

  it("afterTurn keeps the bootstrap checkpoint stale and records retry debt when inline threshold compaction fails", async () => {
    const engine = createEngineWithConfig({
      proactiveThresholdCompactionMode: "inline",
    });
    const sessionId = "after-turn-inline-threshold-compaction-failure";
    const sessionFile = createSessionFilePath("after-turn-inline-threshold-compaction-failure");
    writeFileSync(sessionFile, "0123456789\n");

    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    const sessionFileStats = statSync(sessionFile);
    await engine.getSummaryStore().upsertConversationBootstrapState({
      conversationId: conversation.conversationId,
      sessionFilePath: sessionFile,
      lastSeenSize: 1,
      lastSeenMtimeMs: Math.trunc(sessionFileStats.mtimeMs),
      lastProcessedOffset: 1,
      lastProcessedEntryHash: null,
    });

    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };

    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 3_500,
      threshold: 3_072,
    });
    const compactSpy = vi.spyOn(engine, "compact").mockResolvedValue({
      ok: false,
      compacted: false,
      reason: "provider auth failure",
    });

    await engine.afterTurn({
      sessionId,
      sessionFile,
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
      runtimeContext: { currentTokenCount: 3_500 },
    });

    const bootstrapState = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation.conversationId);
    expect(bootstrapState).not.toBeNull();
    expect(bootstrapState?.lastSeenSize).toBe(1);
    expect(bootstrapState?.lastProcessedOffset).toBe(1);

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(maintenance).not.toBeNull();
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.running).toBe(false);
    expect(maintenance?.reason).toBe("threshold");
    expect(maintenance?.tokenBudget).toBe(4_096);
    expect(compactSpy).toHaveBeenCalled();
  });

  it("afterTurn waits for inline threshold compaction before completing", async () => {
    const engine = createEngineWithConfig({
      proactiveThresholdCompactionMode: "inline",
    });
    const sessionId = "after-turn-inline-threshold-compaction-queue-order";
    const sessionFile = createSessionFilePath("after-turn-inline-threshold-compaction-queue-order");
    writeFileSync(sessionFile, "0123456789\n");

    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    const sessionFileStats = statSync(sessionFile);
    await engine.getSummaryStore().upsertConversationBootstrapState({
      conversationId: conversation.conversationId,
      sessionFilePath: sessionFile,
      lastSeenSize: 1,
      lastSeenMtimeMs: Math.trunc(sessionFileStats.mtimeMs),
      lastProcessedOffset: 1,
      lastProcessedEntryHash: null,
    });

    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };

    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 3_500,
      threshold: 3_072,
    });

    let releaseCompaction!: () => void;
    let notifyCompactionStarted!: () => void;
    const compactionStarted = new Promise<void>((resolve) => {
      notifyCompactionStarted = resolve;
    });
    const compactionGate = new Promise<void>((resolve) => {
      releaseCompaction = resolve;
    });

    vi.spyOn(engine, "compact").mockImplementation(async () => {
      notifyCompactionStarted();
      await compactionGate;
      return {
        ok: false,
        compacted: false,
        reason: "provider auth failure",
      };
    });

    const afterTurnPromise = engine.afterTurn({
      sessionId,
      sessionFile,
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
      runtimeContext: { currentTokenCount: 3_500 },
    });

    await compactionStarted;

    let afterTurnResolved = false;
    afterTurnPromise.then(() => {
      afterTurnResolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(afterTurnResolved).toBe(false);

    releaseCompaction();

    await afterTurnPromise;
    expect(afterTurnResolved).toBe(true);

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(maintenance).not.toBeNull();
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.reason).toBe("threshold");
  });

  it("afterTurn falls back to the default token budget when no budget is provided", async () => {
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      {
        proactiveThresholdCompactionMode: "inline",
      },
      {
        log: {
          info: vi.fn(),
          warn: warnLog,
          error: vi.fn(),
          debug: vi.fn(),
        },
      },
    );
    const sessionId = "after-turn-default-token-budget";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };

    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 100_000,
      threshold: 96_000,
    });
    const compactSpy = vi.spyOn(engine, "compact").mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-default-token-budget"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      runtimeContext: { currentTokenCount: 100_000 },
    });

    expect(compactSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        tokenBudget: 128_000,
        compactionTarget: "threshold",
      }),
    );
    expect(warnLog).toHaveBeenCalledWith(
      "[lcm] afterTurn: tokenBudget not provided; using default 128000",
    );
  });

  it("afterTurn falls back to legacyCompactionParams when runtimeContext is missing", async () => {
    const engine = createEngineWithConfig({
      proactiveThresholdCompactionMode: "inline",
    });
    const sessionId = "after-turn-legacy-compaction-params";
    const legacyCompactionParams = { provider: "anthropic", model: "claude-opus-4-5" };
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };

    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 3_500,
      threshold: 3_072,
    });
    const compactSpy = vi.spyOn(engine, "compact").mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-legacy-compaction-params"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
      legacyCompactionParams,
      currentTokenCount: 3_500,
    });

    expect(compactSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        legacyParams: legacyCompactionParams,
      }),
    );
  });

  it("afterTurn prefers runtimeContext when both runtimeContext and legacyCompactionParams are set", async () => {
    const engine = createEngineWithConfig({
      proactiveThresholdCompactionMode: "inline",
    });
    const sessionId = "after-turn-runtime-context-priority";
    const runtimeContext = { provider: "anthropic", model: "claude-opus-4-5", source: "rt" };
    const legacyCompactionParams = {
      provider: "anthropic",
      model: "claude-opus-4-5",
      source: "legacy",
    };
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };

    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 3_500,
      threshold: 3_072,
    });
    const compactSpy = vi.spyOn(engine, "compact").mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-runtime-context-priority"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
      runtimeContext,
      legacyCompactionParams,
    });

    expect((compactSpy.mock.calls[0]?.[0] as { legacyParams?: unknown }).legacyParams).toBe(
      runtimeContext,
    );
  });

  it("afterTurn prefers runtimeContext.currentTokenCount for compaction decisions", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-runtime-current-token-count";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };

    const evaluateSpy = vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "none",
      currentTokens: 500,
      threshold: 3_072,
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-runtime-current-token-count"),
      messages: [makeMessage({ role: "assistant", content: "tiny" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
      runtimeContext: {
        provider: "openai",
        model: "gpt-5.4",
        currentTokenCount: 500,
      },
    });

    expect(evaluateSpy).toHaveBeenCalledWith(expect.any(Number), 4_096, 500);
  });

  it("afterTurn falls back to local message token estimates when runtimeContext.currentTokenCount is absent", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-local-current-token-count-fallback";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };

    const evaluateSpy = vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "none",
      currentTokens: 1,
      threshold: 3_072,
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-local-current-token-count-fallback"),
      messages: [makeMessage({ role: "assistant", content: "tiny" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
      runtimeContext: {
        provider: "openai",
        model: "gpt-5.4",
      },
    });

    expect(evaluateSpy).toHaveBeenCalledWith(expect.any(Number), 4_096, estimateTokens("tiny"));
  });

  it("afterTurn records deferred threshold debt instead of compacting inline by default", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
      scheduleDeferredCompactionDebtDrain: (params: unknown) => void;
    };
    const sessionId = "after-turn-deferred-compaction-debt";
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 3_500,
      threshold: 3_072,
    });
    const scheduleSpy = vi
      .spyOn(privateEngine, "scheduleDeferredCompactionDebtDrain")
      .mockImplementation(() => undefined);
    const compactSpy = vi.spyOn(engine, "compact");

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-deferred-compaction-debt"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
      runtimeContext: { currentTokenCount: 3_500 },
    });

    expect(compactSpy).not.toHaveBeenCalled();
    expect(scheduleSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        reason: "threshold",
        tokenBudget: 4_096,
      }),
    );
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation!.conversationId);
    expect(maintenance).not.toBeNull();
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.running).toBe(false);
    expect(maintenance?.reason).toBe("threshold");
    expect(maintenance?.requestedAt).toBeInstanceOf(Date);
  });

  it("afterTurn evaluates threshold compaction when ingestBatch is empty", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-empty-ingest-still-evaluates-compaction";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (conversationId: number, tokenBudget: number, observed?: number) => Promise<unknown>;
      };
      deduplicateAfterTurnBatch: (
        sessionId: string,
        sessionKey: string | undefined,
        messages: AgentMessage[],
        opts: unknown,
      ) => Promise<AgentMessage[]>;
      scheduleDeferredCompactionDebtDrain: (params: unknown) => void;
    };

    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "seed message" }),
    });
    vi.spyOn(privateEngine, "deduplicateAfterTurnBatch").mockResolvedValue([]);
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 200_000,
      threshold: 180_000,
    });
    vi.spyOn(privateEngine, "scheduleDeferredCompactionDebtDrain").mockImplementation(() => undefined);
    const compactSpy = vi.spyOn(engine, "compact");

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-empty-ingest-still-evaluates-compaction"),
      messages: [
        makeMessage({ role: "user", content: "already-stored user message" }),
        makeMessage({ role: "assistant", content: "already-stored assistant reply" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 258_000,
      runtimeContext: { currentTokenCount: 200_000 },
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation!.conversationId);
    expect(maintenance).not.toBeNull();
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.reason).toBe("threshold");
    expect(compactSpy).not.toHaveBeenCalled();
  });

  it("afterTurn skips compaction work when ingestBatch is empty AND conversation is below threshold", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-empty-ingest-below-threshold-noop";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (conversationId: number, tokenBudget: number, observed?: number) => Promise<unknown>;
      };
      deduplicateAfterTurnBatch: (
        sessionId: string,
        sessionKey: string | undefined,
        messages: AgentMessage[],
        opts: unknown,
      ) => Promise<AgentMessage[]>;
    };

    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "seed message" }),
    });
    vi.spyOn(privateEngine, "deduplicateAfterTurnBatch").mockResolvedValue([]);
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 30_000,
      threshold: 180_000,
    });
    const compactSpy = vi.spyOn(engine, "compact");

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-empty-ingest-below-threshold-noop"),
      messages: [makeMessage({ role: "assistant", content: "already-stored" })],
      prePromptMessageCount: 0,
      tokenBudget: 258_000,
      runtimeContext: { currentTokenCount: 30_000 },
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation!.conversationId);
    expect(maintenance?.pending ?? false).toBe(false);
    expect(compactSpy).not.toHaveBeenCalled();
  });

  it("afterTurn schedules a deferred threshold drain even when compactionTelemetry has no provider/model", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-no-cache-context-threshold";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
      scheduleDeferredCompactionDebtDrain: (params: unknown) => void;
    };
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 3_500,
      threshold: 3_072,
    });
    const scheduleSpy = vi
      .spyOn(privateEngine, "scheduleDeferredCompactionDebtDrain")
      .mockImplementation(() => undefined);

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-no-cache-context-threshold"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
      runtimeContext: { currentTokenCount: 3_500 },
    });

    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    expect(scheduleSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        reason: "threshold",
        tokenBudget: 4_096,
      }),
    );
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation!.conversationId);
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.reason).toBe("threshold");
  });

  it("afterTurn caps the transcript-reconcile slow path to one full re-read per session+file (F7)", async () => {
    // PR-6 #566 / F7: PR #551 added reconcileTranscriptTailForAfterTurn but
    // its slow path called readLeafPathMessages on the entire session file
    // every afterTurn when the checkpoint was missing or path-mismatched.
    // After PR-6: the slow path runs once per (session-key|id, sessionFile),
    // refreshes the checkpoint, and subsequent afterTurns take the
    // incremental path or the cap branch.
    const infoLog = vi.fn();
    const debugLog = vi.fn();
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: { info: infoLog, warn: warnLog, error: vi.fn(), debug: vi.fn() },
      },
    );
    const sessionId = "after-turn-reconcile-slow-path-cap";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };
    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    });
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 0,
      threshold: 3_072,
    });

    // Seed conversation by ingesting one turn through afterTurn first, with
    // a DIFFERENT sessionFile so the next call has a path-mismatched
    // checkpoint and is forced into the slow path.
    const seedSessionFile = createSessionFilePath("after-turn-reconcile-slow-path-seed");
    writeLeafTranscript(seedSessionFile, [{ role: "assistant", content: "seed turn" }]);
    await engine.afterTurn({
      sessionId,
      sessionFile: seedSessionFile,
      messages: [makeMessage({ role: "assistant", content: "seed turn" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    // Spy on the (module-scoped) full reader by spying on the slow-path
    // log, since readLeafPathMessages is a free function. The slow-path warn
    // is the canonical signal that the full re-read happened.
    warnLog.mockClear();
    debugLog.mockClear();

    // First call with a different sessionFile triggers the slow path.
    // Pre-populate the target sessionFile with at least one historical
    // overlapping message so readLeafPathMessages returns a successful
    // same-frontier full read and the slow-path cap can be remembered.
    const targetSessionFile = createSessionFilePath("after-turn-reconcile-slow-path-target");
    writeLeafTranscript(targetSessionFile, [{ role: "assistant", content: "seed turn" }]);
    await engine.afterTurn({
      sessionId,
      sessionFile: targetSessionFile,
      messages: [makeMessage({ role: "assistant", content: "next turn one" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });
    const slowPathWarns = warnLog.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes("transcript reconcile slow path"));
    expect(slowPathWarns.length).toBe(1);

    // Second call against the SAME (sessionId, sessionFile) tuple must NOT
    // re-enter the slow path. After the first slow-path read we refresh the
    // checkpoint, so this normally goes through the fast (incremental) path
    // and emits no slow-path warn. If somehow the slow path is reached again
    // (e.g. checkpoint not append-only-eligible), the cap log fires instead
    // of a second full re-read.
    warnLog.mockClear();
    debugLog.mockClear();
    await engine.afterTurn({
      sessionId,
      sessionFile: targetSessionFile,
      messages: [makeMessage({ role: "assistant", content: "next turn two" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });
    const secondSlowPathWarns = warnLog.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes("transcript reconcile slow path (full re-read)"));
    expect(secondSlowPathWarns.length).toBe(0);
  });

  it("afterTurn treats missing tracked transcripts as a cheap degraded path without full reread", async () => {
    const warnLog = vi.fn();
    const debugLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: { info: vi.fn(), warn: warnLog, error: vi.fn(), debug: debugLog },
      },
    );
    const sessionId = "after-turn-missing-transcript-cheap-skip";
    const sessionKey = "agent:main:test:missing-transcript-cheap-skip";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey,
    });
    const bulkMessages = await engine.getConversationStore().createMessagesBulk(
      Array.from({ length: 120 }, (_, index) => ({
        conversationId: conversation.conversationId,
        seq: index,
        role: index % 2 === 0 ? "user" : "assistant",
        content: `persisted historical message ${index}`,
        tokenCount: 5,
        skipReplayTimestampFloodGuard: true,
      })),
    );
    await engine
      .getSummaryStore()
      .appendContextMessages(
        conversation.conversationId,
        bulkMessages.map((message) => message.messageId),
      );
    const missingSessionFile = createSessionFilePath("after-turn-missing-transcript-cheap-skip");
    await engine.getSummaryStore().upsertConversationBootstrapState({
      conversationId: conversation.conversationId,
      sessionFilePath: missingSessionFile,
      lastSeenSize: 24_000,
      lastSeenMtimeMs: 1_700_000_000_000,
      lastProcessedOffset: 24_000,
      lastProcessedEntryHash: "checkpoint-hash",
    });

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile: missingSessionFile,
      messages: [
        makeMessage({ role: "assistant", content: "persisted historical message 119" }),
        makeMessage({ role: "user", content: "live user after missing transcript" }),
        makeMessage({ role: "assistant", content: "live assistant after missing transcript" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const stored = await engine.getConversationStore().getMessages(conversation.conversationId);
    expect(stored.slice(-2).map((message) => message.content)).toEqual([
      "live user after missing transcript",
      "live assistant after missing transcript",
    ]);
    const checkpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation.conversationId);
    expect(checkpoint).toMatchObject({
      sessionFilePath: missingSessionFile,
      lastSeenSize: 24_000,
      lastProcessedOffset: 24_000,
      lastProcessedEntryHash: "checkpoint-hash",
    });
    expect(
      warnLog.mock.calls
        .map((c) => String(c[0]))
        .some((m) => m.includes("session file missing; skipping transcript reconcile full reread")),
    ).toBe(true);
    expect(
      warnLog.mock.calls
        .map((c) => String(c[0]))
        .some((m) => m.includes("transcript reconcile slow path (full re-read)")),
    ).toBe(false);
  });

  it("seeds placeholder bootstrap_state when afterTurn stat-fail fallback runs (#649 follow-up)", async () => {
    // #649 added a permissive stat-fail fallback in the slow path that
    // returns hasOverlap:true to allow live afterTurn ingest even when the
    // transcript cannot be stat-ed. It assumed the afterTurn-tail
    // refreshAfterTurnBootstrapState hook would persist the checkpoint, but
    // that hook delegates to refreshBootstrapState, which itself stat()s and
    // throws on failure; the catch then logs a warn and leaves
    // conversation_bootstrap_state NULL. Every subsequent afterTurn then
    // re-enters the slow path with reason="checkpoint-missing" (excluded
    // from allowNoAnchorImport), the slow path returns hasOverlap:false +
    // 0 imports, and the outer transcriptReconcileUnsafeToAdvance guard
    // skips the ingest batch. The conversation gets stuck in a
    // transparent-passthrough state where assemble() falls back to
    // params.messages and compaction never runs (LCM effectively becomes a
    // no-op for that conversation).
    //
    // Observed in production: a long-running session got stuck in this
    // state for ~11 hours before auto-healing when the host runtime
    // rewrote the JSONL small enough to flip the slow-path reason to
    // `same-path-shrink`, which IS in the allowNoAnchorImport whitelist.
    //
    // Fix: seed a placeholder bootstrap_state row directly (no stat call)
    // anchored to the current sessionFile with `lastProcessedOffset=0`.
    // On the next afterTurn whose stat() succeeds, the placeholder recovery
    // path re-walks from offset=0 but reconciles against the DB frontier so
    // already-ingested live afterTurn messages are not duplicated.
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: { info: vi.fn(), warn: warnLog, error: vi.fn(), debug: vi.fn() },
      },
    );
    const sessionId = "after-turn-stat-fail-checkpoint-seed";
    const sessionKey = "agent:main:test:after-turn-stat-fail-checkpoint-seed";

    // Prime a conversation row WITHOUT a bootstrap_state row by ingesting
    // one message directly. This matches the production incident shape
    // (one message already in the DB but the very first afterTurn
    // slow-path hit stat() failure and never persisted a bootstrap_state
    // row).
    await engine.ingest({
      sessionId,
      sessionKey,
      message: makeMessage({ role: "user", content: "primer" }),
    });
    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const preState = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(preState).toBeNull();

    // First turn: transcript file does not exist yet. stat() will throw
    // ENOENT, readLeafPathMessages() will return []. This must NOT leave
    // the conversation in checkpoint-missing deadlock state.
    const sessionFile = createSessionFilePath("after-turn-stat-fail-checkpoint-seed");
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [
        makeMessage({ role: "user", content: "first user turn" }),
        makeMessage({ role: "assistant", content: "first assistant turn" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    // Placeholder checkpoint must exist pointing at the current sessionFile
    // with offset=0 so the next turn can recover from the beginning.
    const seededState = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(seededState).not.toBeNull();
    expect(seededState?.sessionFilePath).toBe(sessionFile);
    expect(seededState?.lastProcessedOffset).toBe(0);
    expect(seededState?.lastSeenSize).toBe(0);

    const statFailWarn = warnLog.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes("could not stat/read transcript"));
    expect(statFailWarn).toBeDefined();
    expect(statFailWarn).toContain("seeding placeholder bootstrap_state at offset=0");

    // Second turn: transcript now exists with real content. Placeholder
    // recovery should read from offset=0 but only ingest messages after the
    // already-stored frontier.
    writeLeafTranscript(sessionFile, [
      { role: "user", content: "first user turn" },
      { role: "assistant", content: "first assistant turn" },
      { role: "user", content: "second user turn" },
      { role: "assistant", content: "second assistant turn" },
    ]);
    warnLog.mockClear();
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [makeMessage({ role: "assistant", content: "second assistant turn" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    // Without the checkpoint seed, ingestion stays at 0 messages forever.
    // With placeholder recovery, only genuinely missing transcript messages
    // are imported; the first turn was already persisted by the live
    // afterTurn batch and must not be replayed from offset=0.
    const messages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    const contents = messages.map((m) => m.content);
    expect(contents).toContain("first user turn");
    expect(contents).toContain("first assistant turn");
    expect(contents).toContain("second user turn");
    expect(contents).toContain("second assistant turn");
    await expect(
      engine
        .getConversationStore()
        .countMessagesByIdentity(conversation!.conversationId, "user", "first user turn"),
    ).resolves.toBe(1);
    await expect(
      engine
        .getConversationStore()
        .countMessagesByIdentity(
          conversation!.conversationId,
          "assistant",
          "first assistant turn",
        ),
    ).resolves.toBe(1);
    await expect(
      engine
        .getConversationStore()
        .countMessagesByIdentity(conversation!.conversationId, "user", "second user turn"),
    ).resolves.toBe(1);
    await expect(
      engine
        .getConversationStore()
        .countMessagesByIdentity(
          conversation!.conversationId,
          "assistant",
          "second assistant turn",
        ),
    ).resolves.toBe(1);

    // After successful ingest, checkpoint should be advanced past offset=0
    // (via the fast-path refreshBootstrapState call).
    const advancedState = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(advancedState).not.toBeNull();
    expect(advancedState?.lastProcessedOffset).toBeGreaterThan(0);
  });

  it("bootstrap imports a bounded path-mismatched transcript with no old anchor as a new epoch", async () => {
    const engine = createEngine();
    const sessionId = "bootstrap-transcript-epoch-no-anchor";
    const sessionKey = "agent:main:test:direct:transcript-epoch";

    const oldSessionFile = createSessionFilePath("bootstrap-transcript-epoch-old");
    writeLeafTranscript(oldSessionFile, [
      { role: "user", content: "old runtime question" },
      { role: "assistant", content: "old runtime answer" },
    ]);
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile: oldSessionFile,
      messages: [
        makeMessage({ role: "user", content: "old runtime question" }),
        makeMessage({ role: "assistant", content: "old runtime answer" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const newSessionFile = createSessionFilePath("bootstrap-transcript-epoch-new");
    writeLeafTranscript(newSessionFile, [
      { role: "user", content: "current codex user report" },
      { role: "assistant", content: "current codex assistant reply" },
    ]);

    const result = await engine.bootstrap({
      sessionId,
      sessionKey,
      sessionFile: newSessionFile,
    });

    expect(result.bootstrapped).toBe(true);
    expect(result.importedMessages).toBe(2);
    expect(result.reason).toBe("reconciled missing session messages");

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old runtime question",
      "old runtime answer",
      "current codex user report",
      "current codex assistant reply",
    ]);

    const checkpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(checkpoint?.sessionFilePath).toBe(newSessionFile);
    expect(checkpoint?.lastProcessedOffset).toBe(statSync(newSessionFile).size);
  });

  it("afterTurn reconciles a path-mismatched no-anchor transcript before oversized delta dedup", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-transcript-epoch-no-anchor";
    const sessionKey = "agent:main:test:direct:transcript-epoch";

    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };
    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    } as unknown as Record<string, unknown>);
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 0,
      threshold: 3_072,
    });

    const oldSessionFile = createSessionFilePath("after-turn-transcript-epoch-old");
    writeLeafTranscript(oldSessionFile, [
      { role: "user", content: "old turn user 1" },
      { role: "assistant", content: "old turn assistant 1" },
      { role: "user", content: "old turn user 2" },
      { role: "assistant", content: "old turn assistant 2" },
    ]);
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile: oldSessionFile,
      messages: [
        makeMessage({ role: "user", content: "old turn user 1" }),
        makeMessage({ role: "assistant", content: "old turn assistant 1" }),
        makeMessage({ role: "user", content: "old turn user 2" }),
        makeMessage({ role: "assistant", content: "old turn assistant 2" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const newSessionFile = createSessionFilePath("after-turn-transcript-epoch-new");
    writeLeafTranscript(newSessionFile, [
      { role: "user", content: "new codex user prompt" },
      { role: "assistant", content: "new codex assistant delta" },
    ]);

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile: newSessionFile,
      messages: [makeMessage({ role: "assistant", content: "new codex assistant delta" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old turn user 1",
      "old turn assistant 1",
      "old turn user 2",
      "old turn assistant 2",
      "new codex user prompt",
      "new codex assistant delta",
    ]);

    const checkpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(checkpoint?.sessionFilePath).toBe(newSessionFile);
    expect(checkpoint?.lastProcessedOffset).toBe(statSync(newSessionFile).size);
  });

  it("afterTurn archives a stale active conversation when the prior keyed transcript was pruned", async () => {
    const engine = createEngine();
    const firstSessionId = "after-turn-missed-reset-fallback-1";
    const secondSessionId = "after-turn-missed-reset-fallback-2";
    const sessionKey = "agent:main:test:after-turn-missed-reset-fallback";
    const oldSessionFile = createSessionFilePath("after-turn-missed-reset-fallback-old");
    writeLeafTranscript(oldSessionFile, [
      { role: "user", content: "old turn user" },
      { role: "assistant", content: "openai-codex/gpt-5.5" },
    ]);

    const first = await engine.bootstrap({
      sessionId: firstSessionId,
      sessionKey,
      sessionFile: oldSessionFile,
    });
    expect(first).toEqual({
      bootstrapped: true,
      importedMessages: 2,
    });

    const originalConversation = await engine.getConversationStore().getConversationForSession({
      sessionId: firstSessionId,
      sessionKey,
    });
    expect(originalConversation).not.toBeNull();

    rmSync(oldSessionFile, { force: true });

    const newSessionFile = createSessionFilePath("after-turn-missed-reset-fallback-new");
    writeLeafTranscript(newSessionFile, [
      { role: "user", content: "new turn user" },
      { role: "assistant", content: "new turn assistant" },
    ]);

    await engine.afterTurn({
      sessionId: secondSessionId,
      sessionKey,
      sessionFile: newSessionFile,
      messages: [makeMessage({ role: "assistant", content: "new turn assistant" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const activeConversation = await engine.getConversationStore().getConversationForSession({
      sessionId: secondSessionId,
      sessionKey,
    });
    expect(activeConversation).not.toBeNull();
    expect(activeConversation!.conversationId).not.toBe(originalConversation!.conversationId);
    expect(activeConversation!.sessionId).toBe(secondSessionId);
    expect(activeConversation!.active).toBe(true);

    const archivedConversation = await engine.getConversationStore().getConversation(
      originalConversation!.conversationId,
    );
    expect(archivedConversation?.active).toBe(false);
    expect(archivedConversation?.archivedAt).not.toBeNull();

    const activeMessages = await engine.getConversationStore().getMessages(
      activeConversation!.conversationId,
    );
    expect(activeMessages.map((message) => message.content)).toEqual([
      "new turn user",
      "new turn assistant",
    ]);
  });

  it("afterTurn skips assistant-only rollover when the replacement transcript is unreadable", async () => {
    const engine = createEngine();
    const firstSessionId = "after-turn-missed-reset-unreadable-1";
    const secondSessionId = "after-turn-missed-reset-unreadable-2";
    const sessionKey = "agent:main:test:after-turn-missed-reset-unreadable";
    const oldSessionFile = createSessionFilePath("after-turn-missed-reset-unreadable-old");
    writeLeafTranscript(oldSessionFile, [
      { role: "user", content: "old unreadable user" },
      { role: "assistant", content: "old unreadable assistant" },
    ]);

    await engine.bootstrap({
      sessionId: firstSessionId,
      sessionKey,
      sessionFile: oldSessionFile,
    });
    const originalConversation = await engine.getConversationStore().getConversationForSession({
      sessionId: firstSessionId,
      sessionKey,
    });
    expect(originalConversation).not.toBeNull();

    rmSync(oldSessionFile, { force: true });
    const unreadableSessionFile = createSessionFilePath("after-turn-missed-reset-unreadable-new");
    writeFileSync(unreadableSessionFile, '{"message":', "utf8");

    await engine.afterTurn({
      sessionId: secondSessionId,
      sessionKey,
      sessionFile: unreadableSessionFile,
      messages: [makeMessage({ role: "assistant", content: "new unreadable assistant delta" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const archivedConversation = await engine.getConversationStore().getConversation(
      originalConversation!.conversationId,
    );
    expect(archivedConversation?.active).toBe(false);
    expect(archivedConversation?.archivedAt).not.toBeNull();

    const activeConversation = await engine.getConversationStore().getConversationForSession({
      sessionId: secondSessionId,
      sessionKey,
    });
    expect(activeConversation).toBeNull();
  });

  it("afterTurn bounds initial transcript imports to the bootstrap budget", async () => {
    const engine = createEngineWithConfig({ bootstrapMaxTokens: 120 });
    const sessionId = "after-turn-initial-transcript-budget";
    const sessionKey = "agent:main:test:after-turn-initial-transcript-budget";
    const sessionFile = createSessionFilePath("after-turn-initial-transcript-budget");
    const transcriptMessages = Array.from({ length: 60 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `initial afterTurn bulk transcript ${index} ${"x".repeat(200)}`,
    })) as Array<{ role: AgentMessage["role"]; content: string }>;
    writeLeafTranscript(sessionFile, transcriptMessages);

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [
        makeMessage({
          role: "assistant",
          content: transcriptMessages[transcriptMessages.length - 1]!.content,
        }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.length).toBeLessThan(10);
    expect(stored.map((message) => message.content)).toContain(
      transcriptMessages[transcriptMessages.length - 1]!.content,
    );
  });

  it("afterTurn skips persistence when full reread finds no anchor and imports nothing", async () => {
    const engine = createEngineWithDeps({}, {
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
    const sessionId = "after-turn-no-anchor-no-import";
    const sessionKey = "agent:main:test:direct:no-anchor-no-import";

    const privateEngine = engine as unknown as {
      config: LcmConfig;
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };
    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    });
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 0,
      threshold: 3_072,
    });

    const sessionFile = createSessionFilePath("after-turn-no-anchor-no-import");
    writeLeafTranscript(sessionFile, [
      { role: "user", content: "old no-anchor user" },
      { role: "assistant", content: "old no-anchor assistant" },
    ]);
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [
        makeMessage({ role: "user", content: "old no-anchor user" }),
        makeMessage({ role: "assistant", content: "old no-anchor assistant" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const oldCheckpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(oldCheckpoint?.sessionFilePath).toBe(sessionFile);

    const rawDb = createLcmDatabaseConnection(privateEngine.config.databasePath);
    try {
      rawDb
        .prepare(`DELETE FROM conversation_bootstrap_state WHERE conversation_id = ?`)
        .run(conversation!.conversationId);
    } finally {
      closeLcmConnection(rawDb);
    }

    writeLeafTranscript(sessionFile, [
      { role: "user", content: "rewritten missing prefix user" },
      { role: "assistant", content: "rewritten missing prefix assistant" },
    ]);

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [
        makeMessage({ role: "user", content: "live no-anchor user" }),
        makeMessage({ role: "assistant", content: "live no-anchor assistant" }),
        makeMessage({ role: "user", content: "live no-anchor follow-up" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const checkpointAfterNoImport = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(checkpointAfterNoImport).toBeNull();

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old no-anchor user",
      "old no-anchor assistant",
    ]);
  });

  it("afterTurn imports a bounded same-path transcript epoch after the file shrinks", async () => {
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: { info: vi.fn(), warn: warnLog, error: vi.fn(), debug: vi.fn() },
      },
    );
    const sessionId = "after-turn-same-path-shrink";
    const sessionKey = "agent:main:test:direct:same-path-shrink";

    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };
    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    });
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 0,
      threshold: 3_072,
    });

    const sessionFile = createSessionFilePath("after-turn-same-path-shrink");
    writeLeafTranscript(sessionFile, [
      { role: "user", content: "old shrink user" },
      { role: "assistant", content: "old shrink assistant" },
    ]);
    appendFileSync(
      sessionFile,
      `${JSON.stringify({ type: "custom", payload: "x".repeat(20_000) })}\n`,
      "utf8",
    );
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [
        makeMessage({ role: "user", content: "old shrink user" }),
        makeMessage({ role: "assistant", content: "old shrink assistant" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const oldCheckpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(oldCheckpoint?.sessionFilePath).toBe(sessionFile);

    writeLeafTranscript(sessionFile, [
      { role: "user", content: "missed shrink prefix user" },
      { role: "assistant", content: "missed shrink prefix assistant" },
      { role: "user", content: "live shrink user" },
      { role: "assistant", content: "live shrink assistant" },
    ]);
    expect(oldCheckpoint!.lastProcessedOffset).toBeGreaterThan(statSync(sessionFile).size);
    const shrinkStats = statSync(sessionFile);
    (
      engine as unknown as {
        afterTurnReconcileFullReadStates: Map<string, { size: number; mtimeMs: number }>;
      }
    ).afterTurnReconcileFullReadStates.set(`${sessionKey}\u0000${sessionFile}`, {
      size: shrinkStats.size,
      mtimeMs: Math.trunc(shrinkStats.mtimeMs),
    });

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [
        makeMessage({ role: "user", content: "live shrink user" }),
        makeMessage({ role: "assistant", content: "live shrink assistant" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    expect(
      warnLog.mock.calls
        .map((c) => String(c[0]))
        .some((m) => m.includes("same-path-shrink")),
    ).toBe(true);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old shrink user",
      "old shrink assistant",
      "missed shrink prefix user",
      "missed shrink prefix assistant",
      "live shrink user",
      "live shrink assistant",
    ]);

    const newCheckpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(newCheckpoint?.sessionFilePath).toBe(sessionFile);
    expect(newCheckpoint?.lastProcessedOffset).toBe(statSync(sessionFile).size);
  });

  it("afterTurn imports the full bounded same-path shrink epoch instead of trusting a stale externalized frontier", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-same-path-shrink-externalized";
    const sessionKey = "agent:main:test:direct:same-path-shrink-externalized";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };
    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    });
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 0,
      threshold: 3_072,
    });

    const sessionFile = createSessionFilePath("after-turn-same-path-shrink-externalized");
    const rawFrontier = "afterTurn externalized raw shrink frontier";
    writeLeafTranscript(sessionFile, [
      { role: "assistant", content: rawFrontier },
    ]);
    appendFileSync(
      sessionFile,
      `${JSON.stringify({ type: "custom", payload: "x".repeat(20_000) })}\n`,
      "utf8",
    );

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [makeMessage({ role: "assistant", content: rawFrontier })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const firstStored = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(firstStored).toHaveLength(1);

    const rawDb = createLcmDatabaseConnection(engine.config.databasePath);
    try {
      rawDb
        .prepare(`UPDATE messages SET content = ?, token_count = ? WHERE message_id = ?`)
        .run(
          "[LCM afterTurn externalized payload reference]",
          estimateTokens("[LCM afterTurn externalized payload reference]"),
          firstStored[0].messageId,
        );
    } finally {
      closeLcmConnection(rawDb);
    }

    const oldCheckpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(oldCheckpoint?.lastProcessedEntryHash).toMatch(/^[a-f0-9]{64}$/);

    writeLeafTranscript(sessionFile, [
      { role: "assistant", content: rawFrontier },
      { role: "user", content: "afterTurn tail after externalized shrink" },
    ]);
    expect(oldCheckpoint!.lastProcessedOffset).toBeGreaterThan(statSync(sessionFile).size);

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [makeMessage({ role: "user", content: "afterTurn tail after externalized shrink" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "[LCM afterTurn externalized payload reference]",
      rawFrontier,
      "afterTurn tail after externalized shrink",
    ]);
  });

  it("afterTurn imports a full same-path shrink epoch when new content repeats an old frontier message", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-same-path-shrink-duplicate-frontier";
    const sessionKey = "agent:main:test:direct:same-path-shrink-duplicate-frontier";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };
    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    });
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 0,
      threshold: 3_072,
    });

    const sessionFile = createSessionFilePath("after-turn-same-path-shrink-duplicate-frontier");
    writeLeafTranscript(sessionFile, [
      { role: "user", content: "old afterTurn duplicate frontier user" },
      { role: "assistant", content: "OK" },
    ]);
    appendFileSync(
      sessionFile,
      `${JSON.stringify({ type: "custom", payload: "x".repeat(20_000) })}\n`,
      "utf8",
    );

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [
        makeMessage({ role: "user", content: "old afterTurn duplicate frontier user" }),
        makeMessage({ role: "assistant", content: "OK" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const oldCheckpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);

    writeLeafTranscript(sessionFile, [
      { role: "user", content: "new afterTurn duplicate frontier user" },
      { role: "assistant", content: "OK" },
      { role: "user", content: "new afterTurn duplicate frontier tail" },
    ]);
    expect(oldCheckpoint!.lastProcessedOffset).toBeGreaterThan(statSync(sessionFile).size);

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [makeMessage({ role: "user", content: "new afterTurn duplicate frontier tail" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old afterTurn duplicate frontier user",
      "OK",
      "new afterTurn duplicate frontier user",
      "OK",
      "new afterTurn duplicate frontier tail",
    ]);
  });

  it("afterTurn keeps the old checkpoint when a path-mismatched no-anchor import is capped", async () => {
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      { proactiveThresholdCompactionMode: "inline" },
      {
        log: { info: vi.fn(), warn: warnLog, error: vi.fn(), debug: vi.fn() },
      },
    );
    const sessionId = "after-turn-transcript-epoch-no-anchor-capped";
    const sessionKey = "agent:main:test:direct:transcript-epoch";

    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };
    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    });
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 0,
      threshold: 3_072,
    });

    const oldSessionFile = createSessionFilePath("after-turn-transcript-epoch-capped-old");
    writeLeafTranscript(oldSessionFile, [
      { role: "user", content: "old capped user" },
      { role: "assistant", content: "old capped assistant" },
    ]);
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile: oldSessionFile,
      messages: [
        makeMessage({ role: "user", content: "old capped user" }),
        makeMessage({ role: "assistant", content: "old capped assistant" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const oldCheckpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(oldCheckpoint?.sessionFilePath).toBe(oldSessionFile);

    const newSessionFile = createSessionFilePath("after-turn-transcript-epoch-capped-new");
    writeLeafTranscript(
      newSessionFile,
      Array.from({ length: 60 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `oversized no-anchor epoch ${index}`,
      })),
    );

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile: newSessionFile,
      messages: [
        makeMessage({ role: "user", content: "live after capped epoch user" }),
        makeMessage({ role: "assistant", content: "live after capped epoch assistant" }),
        makeMessage({ role: "user", content: "live after capped epoch follow-up" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    expect(
      warnLog.mock.calls
        .map((c) => String(c[0]))
        .some((m) => m.includes("no anchor import cap exceeded")),
    ).toBe(true);

    const checkpointAfterCap = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(checkpointAfterCap).toEqual(oldCheckpoint);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old capped user",
      "old capped assistant",
    ]);

    appendFileSync(
      newSessionFile,
      `${JSON.stringify({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "live after capped epoch assistant" }],
        },
      })}\n${JSON.stringify({
        message: {
          role: "user",
          content: [{ type: "text", text: "second live after capped epoch user" }],
        },
      })}\n`,
      "utf8",
    );

    warnLog.mockClear();
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile: newSessionFile,
      messages: [
        makeMessage({ role: "assistant", content: "live after capped epoch assistant" }),
        makeMessage({ role: "user", content: "second live after capped epoch user" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    expect(
      warnLog.mock.calls
        .map((c) => String(c[0]))
        .some((m) => m.includes("no anchor import cap exceeded")),
    ).toBe(true);
    const checkpointAfterRetry = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(checkpointAfterRetry).toEqual(oldCheckpoint);

    const storedAfterRetry = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(storedAfterRetry.map((message) => message.content)).toEqual([
      "old capped user",
      "old capped assistant",
    ]);
  });

  it("afterTurn retries a capped reconcile when the transcript file changed with an append-only-ineligible suffix (F7)", async () => {
    const infoLog = vi.fn();
    const debugLog = vi.fn();
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: { info: infoLog, warn: warnLog, error: vi.fn(), debug: vi.fn() },
      },
    );
    const sessionId = "after-turn-reconcile-cap-retries-on-file-change";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };
    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    });
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 0,
      threshold: 3_072,
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-reconcile-cap-retry-seed"),
      messages: [makeMessage({ role: "assistant", content: "seed turn" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const targetSessionFile = createSessionFilePath("after-turn-reconcile-cap-retry-target");
    writeFileSync(
      targetSessionFile,
      `${JSON.stringify({
        message: { role: "assistant", content: [{ type: "text", text: "seed turn" }] },
      })}\n`,
      "utf8",
    );

    warnLog.mockClear();
    debugLog.mockClear();
    await engine.afterTurn({
      sessionId,
      sessionFile: targetSessionFile,
      messages: [makeMessage({ role: "assistant", content: "next turn one" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });
    expect(
      warnLog.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes("transcript reconcile slow path (full re-read)")),
    ).toHaveLength(1);

    appendFileSync(
      targetSessionFile,
      `not-json\n${JSON.stringify({
        message: {
          role: "user",
          content: [{ type: "text", text: "append-only-ineligible user" }],
        },
      })}\n`,
      "utf8",
    );

    warnLog.mockClear();
    debugLog.mockClear();
    await engine.afterTurn({
      sessionId,
      sessionFile: targetSessionFile,
      messages: [makeMessage({ role: "assistant", content: "append-only-ineligible assistant" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    expect(
      infoLog.mock.calls
        .map((c) => String(c[0]))
        .some((m) => m.includes("transcript reconcile slow path skipped")),
    ).toBe(false);
    expect(
      warnLog.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes("transcript reconcile slow path (full re-read)")),
    ).toHaveLength(1);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "seed turn",
      "next turn one",
      "append-only-ineligible user",
      "append-only-ineligible assistant",
    ]);

    const checkpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(checkpoint?.lastProcessedOffset).toBe(statSync(targetSessionFile).size);
  });

  it("afterTurn drains deferred threshold debt in the background without cache telemetry", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-background-threshold-drain";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 3_500,
      threshold: 3_072,
    });
    const executeCompactionCoreSpy = vi.spyOn(
      privateEngine,
      "executeCompactionCore",
    ).mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-background-threshold-drain"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
      runtimeContext: { currentTokenCount: 3_500 },
    });

    await vi.waitFor(() => {
      expect(executeCompactionCoreSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId,
          tokenBudget: 4_096,
          currentTokenCount: 3_500,
          compactionTarget: "threshold",
        }),
      );
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation!.conversationId);
    expect(maintenance?.pending).toBe(false);
    expect(maintenance?.running).toBe(false);
  });

  it("background deferred drain leaves threshold debt durable when the session is busy", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-background-busy-threshold-debt";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 3_500,
    });
    const privateEngine = engine as unknown as {
      withSessionQueue<T>(queueKey: string, operation: () => Promise<T>): Promise<T>;
      drainDeferredCompactionDebtIfIdle: (params: unknown) => Promise<void>;
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    const executeCompactionCoreSpy = vi.spyOn(privateEngine, "executeCompactionCore");

    let releaseQueue!: () => void;
    const heldQueue = privateEngine.withSessionQueue(sessionId, async () => {
      await new Promise<void>((resolve) => {
        releaseQueue = resolve;
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await privateEngine.drainDeferredCompactionDebtIfIdle({
      conversationId: conversation.conversationId,
      sessionId,
      tokenBudget: 4_096,
      currentTokenCount: 3_500,
      reason: "threshold",
      queueKey: sessionId,
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(executeCompactionCoreSpy).not.toHaveBeenCalled();
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.running).toBe(false);

    releaseQueue();
    await heldQueue;
  });

  it("maintain() leaves deferred threshold debt pending until the host opts in", async () => {
    const engine = createEngine();
    const sessionId = "maintain-deferred-compaction-disabled";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 3_500,
    });

    const compactSpy = vi.spyOn(engine, "compact");
    const maintenanceResult = await engine.maintain({
      sessionId,
      sessionFile: createSessionFilePath("maintain-deferred-compaction-disabled-maintain"),
      runtimeContext: {
        allowDeferredCompactionExecution: false,
      },
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(maintenance).not.toBeNull();
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.running).toBe(false);
    expect(compactSpy).not.toHaveBeenCalled();
    expect(maintenanceResult.changed).toBe(false);
  });

  it("maintain() consumes deferred threshold debt when the host opts in", async () => {
    const engine = createEngine();
    const sessionId = "maintain-deferred-compaction-enabled";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 3_500,
    });
    const privateEngine = engine as unknown as {
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    const executeCompactionCoreSpy = vi.spyOn(
      privateEngine,
      "executeCompactionCore",
    ).mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    const maintenanceResult = await engine.maintain({
      sessionId,
      sessionFile: createSessionFilePath("maintain-deferred-compaction-enabled-maintain"),
      runtimeContext: {
        allowDeferredCompactionExecution: true,
        tokenBudget: 4_096,
        currentTokenCount: 3_500,
      },
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(executeCompactionCoreSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: conversation.conversationId,
        sessionId,
        tokenBudget: 4_096,
        currentTokenCount: 3_500,
        compactionTarget: "threshold",
      }),
    );
    expect(maintenance?.pending).toBe(false);
    expect(maintenance?.running).toBe(false);
    expect(maintenanceResult.changed).toBe(true);
  });

  it("maintain() clears stale legacy non-threshold debt when threshold no longer applies", async () => {
    const engine = createEngine();
    const sessionId = "maintain-legacy-leaf-debt-cleared";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "leaf-trigger",
      tokenBudget: 4_096,
      currentTokenCount: 1_024,
    });
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (conversationId: number, tokenBudget: number, observed?: number) => Promise<unknown>;
      };
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    const evaluateSpy = vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 1_024,
      threshold: 3_072,
    });
    const executeCompactionCoreSpy = vi.spyOn(privateEngine, "executeCompactionCore");

    const maintenanceResult = await engine.maintain({
      sessionId,
      sessionFile: createSessionFilePath("maintain-legacy-leaf-debt-cleared"),
      runtimeContext: {
        allowDeferredCompactionExecution: true,
        tokenBudget: 4_096,
        currentTokenCount: 1_024,
      },
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(evaluateSpy).toHaveBeenCalledWith(conversation.conversationId, 4_096, 1_024);
    expect(executeCompactionCoreSpy).not.toHaveBeenCalled();
    expect(maintenance?.pending).toBe(false);
    expect(maintenance?.running).toBe(false);
    expect(maintenanceResult.changed).toBe(false);
    expect(maintenanceResult.reason).toBe("legacy deferred compaction no longer needed");
  });

  it("maintain() revalidates legacy non-threshold debt as threshold work when still over threshold", async () => {
    const engine = createEngine();
    const sessionId = "maintain-legacy-leaf-debt-threshold-revalidated";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "cold-cache-catchup",
      tokenBudget: 4_096,
      currentTokenCount: 3_500,
    });
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (conversationId: number, tokenBudget: number, observed?: number) => Promise<unknown>;
      };
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 3_500,
      threshold: 3_072,
    });
    const executeCompactionCoreSpy = vi.spyOn(
      privateEngine,
      "executeCompactionCore",
    ).mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    await engine.maintain({
      sessionId,
      sessionFile: createSessionFilePath("maintain-legacy-leaf-debt-threshold-revalidated"),
      runtimeContext: {
        allowDeferredCompactionExecution: true,
        tokenBudget: 4_096,
        currentTokenCount: 3_500,
      },
    });

    expect(executeCompactionCoreSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: conversation.conversationId,
        sessionId,
        tokenBudget: 4_096,
        currentTokenCount: 3_500,
        compactionTarget: "threshold",
      }),
    );
  });

  it("maintain() keeps threshold debt pending when compaction fails", async () => {
    const engine = createEngine();
    const sessionId = "maintain-deferred-compaction-auth-failure";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 3_500,
    });
    const privateEngine = engine as unknown as {
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    vi.spyOn(privateEngine, "executeCompactionCore").mockResolvedValue({
      ok: false,
      compacted: false,
      reason: "provider auth failure",
    });

    const result = await engine.maintain({
      sessionId,
      sessionFile: createSessionFilePath("maintain-deferred-compaction-auth-failure-maintain"),
      runtimeContext: {
        allowDeferredCompactionExecution: true,
        tokenBudget: 4_096,
        currentTokenCount: 3_500,
      },
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.running).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.reason).toBe("provider auth failure");
  });

  it("maintain() keeps threshold debt pending when partial compaction remains over target", async () => {
    const engine = createEngine();
    const sessionId = "maintain-deferred-partial-still-over-threshold";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 3_500,
    });
    const privateEngine = engine as unknown as {
      compaction: {
        compactFullSweep: (input: unknown) => Promise<unknown>;
      };
    };
    const compactFullSweepSpy = vi
      .spyOn(privateEngine.compaction, "compactFullSweep")
      .mockResolvedValue({
        actionTaken: true,
        tokensBefore: 3_500,
        tokensAfter: 3_200,
        condensed: false,
      });

    const result = await engine.maintain({
      sessionId,
      sessionFile: createSessionFilePath("maintain-deferred-partial-still-over-threshold"),
      runtimeContext: {
        allowDeferredCompactionExecution: true,
        tokenBudget: 4_096,
        currentTokenCount: 3_500,
      },
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(compactFullSweepSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: conversation.conversationId,
        tokenBudget: 4_096,
        force: true,
        hardTrigger: false,
        stopAtTokens: 1,
      }),
    );
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.running).toBe(false);
    expect(maintenance?.lastFailureSummary).toBe("compacted but still over target");
    expect(result.changed).toBe(true);
    expect(result.reason).toBe("compacted but still over target");
  });

  it("assemble() leaves pending threshold debt for post-turn maintenance while under budget", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    const sessionId = "assemble-threshold-debt-left-pending";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 3_500,
    });
    const executeCompactionCoreSpy = vi.spyOn(
      privateEngine,
      "executeCompactionCore",
    ).mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    const assembleResult = await engine.assemble({
      sessionId,
      messages: [makeMessage({ role: "user", content: "hello" })],
      tokenBudget: 4_096,
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(executeCompactionCoreSpy).not.toHaveBeenCalled();
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.running).toBe(false);
    expect(assembleResult.messages).toHaveLength(1);
  });

  it("assemble() drains pending threshold debt as an emergency when already over budget", async () => {
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const engine = createEngineWithDepsOverrides({ log });
    const privateEngine = engine as unknown as {
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    const sessionId = "assemble-threshold-debt-over-budget-drains";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 3_500,
    });
    const executeCompactionCoreSpy = vi.spyOn(
      privateEngine,
      "executeCompactionCore",
    ).mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    const assembleResult = await engine.assemble({
      sessionId,
      messages: [makeMessage({ role: "user", content: "hello ".repeat(200) })],
      tokenBudget: 10,
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(executeCompactionCoreSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: conversation.conversationId,
        sessionId,
        tokenBudget: 10,
        compactionTarget: "threshold",
      }),
    );
    expect(maintenance?.pending).toBe(false);
    expect(maintenance?.running).toBe(false);
    expect(assembleResult.messages).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "[lcm] assemble: emergency deferred compaction debt draining pre-assembly",
      ),
    );
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("reason=over-budget"));
  });

  it("assemble() drains pending threshold debt when recorded runtime tokens are over budget", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    const sessionId = "assemble-threshold-debt-runtime-over-budget-drains";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 5_000,
    });
    const executeCompactionCoreSpy = vi.spyOn(
      privateEngine,
      "executeCompactionCore",
    ).mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    const assembleResult = await engine.assemble({
      sessionId,
      messages: [makeMessage({ role: "user", content: "hello" })],
      tokenBudget: 4_096,
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(executeCompactionCoreSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: conversation.conversationId,
        sessionId,
        tokenBudget: 4_096,
        currentTokenCount: 5_000,
        compactionTarget: "threshold",
      }),
    );
    expect(maintenance?.pending).toBe(false);
    expect(maintenance?.running).toBe(false);
    expect(assembleResult.messages).toHaveLength(1);
  });

  it("assemble() uses projected deferred pressure for emergency drain without passing it as observed tokens", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    const sessionId = "assemble-threshold-debt-projected-over-budget-drains";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 300,
      projectedTokenCount: 5_000,
      rawTokensOutsideTail: 4_700,
    });
    const executeCompactionCoreSpy = vi.spyOn(
      privateEngine,
      "executeCompactionCore",
    ).mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    const assembleResult = await engine.assemble({
      sessionId,
      messages: [makeMessage({ role: "user", content: "hello" })],
      tokenBudget: 4_096,
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(executeCompactionCoreSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: conversation.conversationId,
        sessionId,
        tokenBudget: 4_096,
        currentTokenCount: 300,
        compactionTarget: "threshold",
      }),
    );
    expect(maintenance?.pending).toBe(false);
    expect(maintenance?.running).toBe(false);
    expect(assembleResult.messages).toHaveLength(1);
  });

  it("assemble() does not wait for the session queue when deferred threshold debt is not urgent", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      withSessionQueue<T>(queueKey: string, operation: () => Promise<T>): Promise<T>;
      consumeDeferredCompactionDebt: (params: unknown) => Promise<unknown>;
    };
    const sessionId = "assemble-deferred-compaction-not-urgent";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 42,
    });
    const consumeSpy = vi.spyOn(privateEngine, "consumeDeferredCompactionDebt");

    let releaseQueue!: () => void;
    const heldQueue = privateEngine.withSessionQueue(sessionId, async () => {
      await new Promise<void>((resolve) => {
        releaseQueue = resolve;
      });
    });

    let assembleSettled = false;
    const assemblePromise = engine.assemble({
      sessionId,
      messages: [makeMessage({ role: "user", content: "hello" })],
      tokenBudget: 4_096,
    }).then((result) => {
      assembleSettled = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(consumeSpy).not.toHaveBeenCalled();
    expect(assembleSettled).toBe(true);

    releaseQueue();
    await heldQueue;
    const assembleResult = await assemblePromise;

    expect(consumeSpy).not.toHaveBeenCalled();
    expect(assembleResult.messages).toHaveLength(1);
  });

  it("assemble() waits for the session queue before emergency deferred threshold compaction", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      withSessionQueue<T>(queueKey: string, operation: () => Promise<T>): Promise<T>;
      consumeDeferredCompactionDebt: (params: unknown) => Promise<unknown>;
    };
    const sessionId = "assemble-deferred-compaction-queued";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 42,
    });
    const consumeSpy = vi.spyOn(privateEngine, "consumeDeferredCompactionDebt");

    let releaseQueue!: () => void;
    const heldQueue = privateEngine.withSessionQueue(sessionId, async () => {
      await new Promise<void>((resolve) => {
        releaseQueue = resolve;
      });
    });

    let assembleSettled = false;
    const assemblePromise = engine.assemble({
      sessionId,
      messages: [makeMessage({ role: "user", content: "hello ".repeat(200) })],
      tokenBudget: 10,
    }).then((result) => {
      assembleSettled = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(consumeSpy).not.toHaveBeenCalled();
    expect(assembleSettled).toBe(false);

    releaseQueue();
    await heldQueue;
    const assembleResult = await assemblePromise;

    expect(consumeSpy).toHaveBeenCalledTimes(1);
    expect(assembleResult.messages).toHaveLength(1);
  });

  it("maintain() uses the stricter current token budget for deferred threshold debt", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    const sessionId = "maintain-deferred-compaction-current-budget";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 1_024,
    });

    const executeCompactionCoreSpy = vi.spyOn(
      privateEngine,
      "executeCompactionCore",
    ).mockResolvedValue({
      ok: true,
      compacted: false,
      reason: "already under target",
    });

    await engine.maintain({
      sessionId,
      sessionFile: createSessionFilePath("maintain-deferred-compaction-current-budget"),
      runtimeContext: {
        allowDeferredCompactionExecution: true,
        tokenBudget: 2_048,
      },
    });

    expect(executeCompactionCoreSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenBudget: 2_048,
      }),
    );
  });

  it("afterTurn persists prompt-cache telemetry for hot sessions", async () => {
    const debugLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: debugLog,
        },
      },
    );
    const sessionId = "after-turn-prompt-cache-hot";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };

    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    });
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "none",
      currentTokens: 500,
      threshold: 3_072,
    });
    vi.spyOn(engine, "compact").mockResolvedValue({
      ok: true,
      compacted: false,
      reason: "below threshold",
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-prompt-cache-hot"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
      runtimeContext: {
        promptCache: {
          retention: "long",
          lastCallUsage: {
            input: 512,
            cacheRead: 1_024,
            cacheWrite: 128,
          },
          observation: {
            broke: false,
          },
        },
      },
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const telemetry = await engine
      .getCompactionTelemetryStore()
      .getConversationCompactionTelemetry(conversation!.conversationId);
    expect(telemetry).not.toBeNull();
    expect(telemetry).toMatchObject({
      cacheState: "hot",
      lastObservedCacheRead: 1_024,
      lastObservedCacheWrite: 128,
      lastObservedPromptTokenCount: 1_664,
      retention: "long",
    });
    expect(telemetry?.lastObservedCacheHitAt).toBeInstanceOf(Date);
    expect(telemetry?.lastObservedCacheBreakAt).toBeNull();
    expect(debugLog).toHaveBeenCalledWith(
      expect.stringContaining("[lcm] compaction telemetry updated:"),
    );
    expect(debugLog).toHaveBeenCalledWith(
      expect.stringContaining("cacheState=hot"),
    );
  });

  it("afterTurn prefers runtime prompt tokens over transcript estimates for compaction decisions", async () => {
    const debugLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: debugLog,
        },
      },
    );
    const sessionId = "after-turn-runtime-prompt-tokens";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number, leafChunkTokens?: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };

    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    });
    const evaluateSpy = vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "none",
      currentTokens: 204_800,
      threshold: 98_304,
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-runtime-prompt-tokens"),
      messages: [makeMessage({ role: "assistant", content: "small transcript estimate" })],
      prePromptMessageCount: 0,
      tokenBudget: 128_000,
      runtimeContext: {
        usage: {
          prompt_tokens: 204_800,
        },
      },
    });

    expect(evaluateSpy).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), 204_800);
    expect(debugLog).toHaveBeenCalledWith(
      expect.stringContaining("using runtime prompt token count currentTokenCount=204800"),
    );
  });

  it("afterTurn skips compaction when ingest fails", async () => {
    const errorLog = vi.fn();
    const engine = createEngineWithDepsOverrides({
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: errorLog,
        debug: vi.fn(),
      },
    });
    const sessionId = "after-turn-ingest-failure";

    const ingestBatchSpy = vi
      .spyOn(engine, "ingestBatch")
      .mockRejectedValue(new Error("ingest exploded"));
    const evaluateLeafTriggerSpy = vi.spyOn(engine, "evaluateLeafTrigger");
    const compactSpy = vi.spyOn(engine, "compact");
    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-ingest-failure"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    expect(ingestBatchSpy).toHaveBeenCalled();
    expect(evaluateLeafTriggerSpy).not.toHaveBeenCalled();
    expect(compactSpy).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(
      "[lcm] afterTurn: ingest failed, skipping compaction: ingest exploded",
    );
  });

  it("afterTurn prunes heartbeat-shaped ACK turns before compaction even without the heartbeat flag", async () => {
    const infoLog = vi.fn();
    const debugLog = vi.fn();
    const engine = createEngineWithDepsOverrides({
      log: {
        info: infoLog,
        warn: vi.fn(),
        error: vi.fn(),
        debug: debugLog,
      },
    });
    const sessionId = "after-turn-heartbeat-prune";
    const sessionKey = "agent:main:test:after-turn-heartbeat-prune";
    const heartbeatMessages = [
      makeMessage({
        role: "user",
        content:
          "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.",
      }),
      makeMessage({
        role: "tool",
        content: "# HEARTBEAT.md\n\n## Worker heartbeat (minimal)",
      }),
      makeMessage({
        role: "tool",
        content: '{\n  "active_session_ids": []\n}',
      }),
      makeMessage({ role: "assistant", content: "HEARTBEAT_OK" }),
    ];
    const sessionFile = createSessionFilePath("after-turn-heartbeat-prune");
    writeLeafTranscriptMessages(sessionFile, heartbeatMessages);

    const evaluateLeafTriggerSpy = vi.spyOn(engine, "evaluateLeafTrigger");
    const compactSpy = vi.spyOn(engine, "compact");
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: heartbeatMessages,
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored).toHaveLength(0);
    expect(evaluateLeafTriggerSpy).not.toHaveBeenCalled();
    expect(compactSpy).not.toHaveBeenCalled();
    expect(infoLog).toHaveBeenCalledWith(
      expect.stringContaining(
        `heartbeat ack messages for conversation=${conversation!.conversationId} session=${sessionId} sessionKey=${sessionKey}`,
      ),
    );
  });

  it("afterTurn heartbeat flag skips non-empty transcript imports", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-heartbeat-flag-transcript-skip";
    const sessionKey = "agent:main:test:after-turn-heartbeat-flag-transcript-skip";
    const sessionFile = createSessionFilePath("after-turn-heartbeat-flag-transcript-skip");
    writeLeafTranscript(sessionFile, [
      { role: "user", content: "heartbeat transcript user" },
      { role: "assistant", content: "HEARTBEAT_OK" },
    ]);

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [makeMessage({ role: "assistant", content: "HEARTBEAT_OK" })],
      isHeartbeat: true,
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).toBeNull();
  });
});

// ── afterTurn dedup guard ────────────────────────────────────────────────────

describe("LcmContextEngine afterTurn dedup guard", () => {
  it("ingests all messages when no prior conversation exists (new session)", async () => {
    const infoLog = vi.fn();
    const engine = createEngineWithDepsOverrides({
      log: {
        info: infoLog,
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    });
    const sessionId = "dedup-new-session";

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("dedup-new-session"),
      messages: [
        makeMessage({ role: "user", content: "hello" }),
        makeMessage({ role: "assistant", content: "hi there" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((m) => m.content)).toEqual(["hello", "hi there"]);
  });

  it("does not persist custom transcript context as assistant messages", async () => {
    const engine = createEngine();
    const sessionId = "dedup-custom-context";

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("dedup-custom-context"),
      messages: [
        {
          type: "custom_message",
          customType: "openclaw.runtime-context",
          content: "Conversation info (untrusted metadata)",
        } as unknown as AgentMessage,
        makeMessage({ role: "assistant", content: "real reply" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((m) => m.content)).toEqual(["real reply"]);
  });

  it("ingests all genuinely new messages (normal afterTurn, no restart)", async () => {
    const engine = createEngine();
    const sessionId = "dedup-normal";

    // Seed DB with initial messages via first afterTurn
    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("dedup-normal"),
      messages: [
        makeMessage({ role: "user", content: "first question" }),
        makeMessage({ role: "assistant", content: "first answer" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    // Second afterTurn with genuinely new messages
    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("dedup-normal-2"),
      messages: [
        makeMessage({ role: "user", content: "first question" }),
        makeMessage({ role: "assistant", content: "first answer" }),
        makeMessage({ role: "user", content: "second question" }),
        makeMessage({ role: "assistant", content: "second answer" }),
      ],
      prePromptMessageCount: 2, // first two are pre-prompt
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((m) => m.content)).toEqual([
      "first question",
      "first answer",
      "second question",
      "second answer",
    ]);
  });

  it("skips all duplicates when gateway restart replays full history", async () => {
    const engine = createEngine();
    const sessionId = "dedup-restart-all-dup";

    // Seed DB
    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("dedup-restart-all-dup"),
      messages: [
        makeMessage({ role: "user", content: "msg A" }),
        makeMessage({ role: "assistant", content: "msg B" }),
        makeMessage({ role: "user", content: "msg C" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    // Restart replays the full history (prePromptMessageCount only covers system prompt)
    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("dedup-restart-all-dup-2"),
      messages: [
        makeMessage({ role: "system", content: "system prompt" }),
        makeMessage({ role: "user", content: "msg A" }),
        makeMessage({ role: "assistant", content: "msg B" }),
        makeMessage({ role: "user", content: "msg C" }),
      ],
      prePromptMessageCount: 1,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    // Should still only have the original 3 messages
    expect(stored.map((m) => m.content)).toEqual(["msg A", "msg B", "msg C"]);
  });

  it("deduplicates old messages but ingests new ones after restart", async () => {
    const engine = createEngine();
    const sessionId = "dedup-restart-mixed";

    // Seed DB with some messages
    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("dedup-restart-mixed"),
      messages: [
        makeMessage({ role: "user", content: "old A" }),
        makeMessage({ role: "assistant", content: "old B" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    // Restart replays old + adds new
    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("dedup-restart-mixed-2"),
      messages: [
        makeMessage({ role: "system", content: "system prompt" }),
        makeMessage({ role: "user", content: "old A" }),
        makeMessage({ role: "assistant", content: "old B" }),
        makeMessage({ role: "user", content: "new C" }),
        makeMessage({ role: "assistant", content: "new D" }),
      ],
      prePromptMessageCount: 1,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((m) => m.content)).toEqual(["old A", "old B", "new C", "new D"]);
  });

  it("deduplicates replay when runtime sessionId changes but stable sessionKey continues", async () => {
    const engine = createEngine();
    const firstSessionId = "dedup-session-key-runtime-1";
    const secondSessionId = "dedup-session-key-runtime-2";
    const sessionKey = "agent:main:main";

    await engine.afterTurn({
      sessionId: firstSessionId,
      sessionKey,
      sessionFile: createSessionFilePath("dedup-session-key-runtime-1"),
      messages: [
        makeMessage({ role: "user", content: "old A" }),
        makeMessage({ role: "assistant", content: "old B" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    const firstConversation = await engine.getConversationStore().getConversationForSession({
      sessionId: firstSessionId,
      sessionKey,
    });
    expect(firstConversation).not.toBeNull();

    await engine.afterTurn({
      sessionId: secondSessionId,
      sessionKey,
      sessionFile: createSessionFilePath("dedup-session-key-runtime-2"),
      messages: [
        makeMessage({ role: "system", content: "system prompt" }),
        makeMessage({ role: "user", content: "old A" }),
        makeMessage({ role: "assistant", content: "old B" }),
        makeMessage({ role: "user", content: "new C" }),
        makeMessage({ role: "assistant", content: "new D" }),
      ],
      prePromptMessageCount: 1,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId: secondSessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    expect(conversation!.conversationId).toBe(firstConversation!.conversationId);
    expect(conversation!.sessionId).toBe(secondSessionId);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((m) => m.content)).toEqual(["old A", "old B", "new C", "new D"]);
  });

  it("handles empty batch after slicing", async () => {
    const engine = createEngine();
    const sessionId = "dedup-empty";

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("dedup-empty"),
      messages: [
        makeMessage({ role: "system", content: "system prompt" }),
      ],
      prePromptMessageCount: 1,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).toBeNull();
  });

  it("handles repeated identical content (e.g. empty tool results) with occurrence counting", async () => {
    const engine = createEngine();
    const sessionId = "dedup-repeated";

    // Seed with repeated content
    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("dedup-repeated"),
      messages: [
        makeMessage({ role: "user", content: "request" }),
        makeMessage({ role: "tool", content: "" }),
        makeMessage({ role: "tool", content: "" }),
        makeMessage({ role: "assistant", content: "done" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    // Restart replays all + adds new with another empty tool result
    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("dedup-repeated-2"),
      messages: [
        makeMessage({ role: "user", content: "request" }),
        makeMessage({ role: "tool", content: "" }),
        makeMessage({ role: "tool", content: "" }),
        makeMessage({ role: "assistant", content: "done" }),
        makeMessage({ role: "user", content: "more work" }),
        makeMessage({ role: "tool", content: "" }),
        makeMessage({ role: "assistant", content: "done again" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((m) => m.content)).toEqual([
      "request",
      "",
      "",
      "done",
      "more work",
      "",
      "done again",
    ]);
  });

  it("skips fully replayed suffix batches when the stored prefix is absent", async () => {
    const engine = createEngine();
    const sessionId = "dedup-full-suffix-replay";

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("dedup-full-suffix-replay"),
      messages: [
        makeMessage({ role: "user", content: "old B" }),
        makeMessage({ role: "assistant", content: "old C" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("dedup-full-suffix-replay-2"),
      messages: [
        makeMessage({ role: "user", content: "compacted old A" }),
        makeMessage({ role: "user", content: "old B" }),
        makeMessage({ role: "assistant", content: "old C" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((m) => m.content)).toEqual(["old B", "old C"]);
  });

  it("uses the actual stored tail for oversized single-message replays", async () => {
    const engine = createEngine();
    const sessionId = "dedup-oversized-single-tail";

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("dedup-oversized-single-tail"),
      messages: [
        makeMessage({ role: "user", content: "old A" }),
        makeMessage({ role: "assistant", content: "old B" }),
        makeMessage({ role: "user", content: "old C" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("dedup-oversized-single-tail-2"),
      messages: [
        makeMessage({ role: "system", content: "system prompt" }),
        makeMessage({ role: "user", content: "old C" }),
      ],
      prePromptMessageCount: 1,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((m) => m.content)).toEqual(["old A", "old B", "old C"]);
  });

  it("does not treat a one-message terminal match as a fully replayed batch", async () => {
    const engine = createEngine();
    const sessionId = "dedup-terminal-single-match";

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("dedup-terminal-single-match"),
      messages: [makeMessage({ role: "assistant", content: "same answer" })],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("dedup-terminal-single-match-2"),
      messages: [
        makeMessage({ role: "user", content: "new question" }),
        makeMessage({ role: "assistant", content: "same answer" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((m) => m.content)).toEqual([
      "same answer",
      "new question",
      "same answer",
    ]);
  });

  it("ingests single genuinely new message without dedup interference", async () => {
    const engine = createEngine();
    const sessionId = "dedup-single";

    // Seed
    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("dedup-single"),
      messages: [makeMessage({ role: "user", content: "hello" })],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    // Single new message
    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("dedup-single-2"),
      messages: [
        makeMessage({ role: "user", content: "hello" }),
        makeMessage({ role: "assistant", content: "world" }),
      ],
      prePromptMessageCount: 1,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((m) => m.content)).toEqual(["hello", "world"]);
  });

  it("fails closed for oversized no-overlap afterTurn batches", async () => {
    const warnLog = vi.fn();
    const engine = createEngineWithDepsOverrides({
      log: {
        info: vi.fn(),
        warn: warnLog,
        error: vi.fn(),
        debug: vi.fn(),
      },
    });
    const sessionId = "dedup-oversized-no-overlap-fail-closed";

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("dedup-oversized-no-overlap-fail-closed"),
      messages: [
        makeMessage({ role: "user", content: "old A" }),
        makeMessage({ role: "assistant", content: "old B" }),
        makeMessage({ role: "tool", content: "old C" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    // Simulates a short afterTurn runtime snapshot that has no overlap with
    // the longer stored LCM conversation. Before this guard, LCM imported the
    // whole batch as fresh rows and polluted context; the transcript reconcile
    // path is responsible for genuine missing JSONL tail imports before this
    // dedup check runs.
    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("dedup-oversized-no-overlap-fail-closed-2"),
      messages: [
        makeMessage({ role: "user", content: "unanchored user" }),
        makeMessage({ role: "assistant", content: "unanchored assistant" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((m) => m.content)).toEqual(["old A", "old B", "old C"]);
    expect(warnLog).toHaveBeenCalledWith(
      `[lcm] dedup: oversized, storedCount=3 batchLen=2, no overlap found — fail-closed skipping full batch`,
    );
  });

  it("preserves a legitimate repeated first new message", async () => {
    const engine = createEngine();
    const sessionId = "dedup-repeated-first-new-message";

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("dedup-repeated-first-new-message"),
      messages: [
        makeMessage({ role: "user", content: "hello" }),
        makeMessage({ role: "assistant", content: "first reply" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("dedup-repeated-first-new-message-2"),
      messages: [
        makeMessage({ role: "user", content: "hello" }),
        makeMessage({ role: "assistant", content: "first reply" }),
        makeMessage({ role: "user", content: "hello" }),
        makeMessage({ role: "assistant", content: "second reply" }),
      ],
      prePromptMessageCount: 2,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((m) => m.content)).toEqual([
      "hello",
      "first reply",
      "hello",
      "second reply",
    ]);
  });
});

describe("LcmContextEngine compaction telemetry", () => {
  it("does not feed engine-ingested reasoning parts into compaction summarizer input", async () => {
    const privateReasoning = "PRIVATE_STORED_REASONING_TRACE";
    let summarizerInput = "";
    const engine = createEngineWithDeps(
      {
        freshTailCount: 0,
        leafMinFanout: 2,
        leafChunkTokens: 1_000,
        incrementalMaxDepth: 0,
      },
      {
        complete: vi.fn(async (request) => {
          const message = request.messages?.[0];
          summarizerInput =
            message && typeof message === "object" && "content" in message
              ? String((message as { content?: unknown }).content ?? "")
              : "";
          return { content: [{ type: "text", text: "Safe compacted summary." }] };
        }),
        resolveModel: vi.fn(() => ({ provider: "vllm", model: "qwen3.5-122b" })),
      },
    );
    const sessionId = randomUUID();

    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [
          { type: "reasoning", summary: [{ text: privateReasoning }] },
          { type: "text", text: "Visible assistant answer." },
        ],
      } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: makeMessage({
        role: "user",
        content: `Follow-up ${"x".repeat(400)}`,
      }),
    });

    const result = await engine.compact({
      sessionId,
      sessionFile: createSessionFilePath("reasoning-parts-compact"),
      tokenBudget: 10_000,
      force: true,
      legacyParams: { provider: "vllm", model: "qwen3.5-122b" },
    });

    expect(result.compacted).toBe(true);
    expect(summarizerInput).toContain("Visible assistant answer.");
    expect(summarizerInput).not.toContain(privateReasoning);
  });

  it("does not feed redacted-thinking-only ingested parts into compaction summarizer input", async () => {
    const privateReasoning = "PRIVATE_REDACTED_THINKING_ONLY_TRACE";
    let summarizerInput = "";
    const engine = createEngineWithDeps(
      {
        freshTailCount: 0,
        leafMinFanout: 2,
        leafChunkTokens: 1_000,
        incrementalMaxDepth: 0,
      },
      {
        complete: vi.fn(async (request) => {
          const message = request.messages?.[0];
          summarizerInput =
            message && typeof message === "object" && "content" in message
              ? String((message as { content?: unknown }).content ?? "")
              : "";
          return { content: [{ type: "text", text: "Safe compacted summary." }] };
        }),
        resolveModel: vi.fn(() => ({ provider: "vllm", model: "qwen3.5-122b" })),
      },
    );
    const sessionId = randomUUID();

    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [
          { type: "redacted_thinking", text: privateReasoning },
        ],
      } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: makeMessage({
        role: "user",
        content: `Follow-up ${"x".repeat(400)}`,
      }),
    });

    const result = await engine.compact({
      sessionId,
      sessionFile: createSessionFilePath("redacted-thinking-only-compact"),
      tokenBudget: 10_000,
      force: true,
      legacyParams: { provider: "vllm", model: "qwen3.5-122b" },
    });

    expect(result.compacted).toBe(true);
    expect(summarizerInput).toContain("Follow-up");
    expect(summarizerInput).not.toContain(privateReasoning);
  });

  it("does not append synthetic system messages for compaction passes", async () => {
    const infoLog = vi.fn();
    const debugLog = vi.fn();
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
    tempDirs.push(tempDir);
    const config = createTestConfig(join(tempDir, "lcm.db"));
    const db = createLcmDatabaseConnection(config.databasePath);
    const engine = new LcmContextEngine(
      createTestDeps(
        {
          ...config,
          freshTailCount: 1,
          leafMinFanout: 2,
          leafChunkTokens: 1,
          incrementalMaxDepth: 0,
        },
        {
          log: {
            info: infoLog,
            warn: vi.fn(),
            error: vi.fn(),
            debug: debugLog,
          },
        },
      ),
      db,
    );
    const sessionId = "compact-leaf-no-telemetry";

    await engine.ingestBatch({
      sessionId,
      messages: [
        makeMessage({ role: "user", content: "Question one that should compact." }),
        makeMessage({ role: "assistant", content: "Answer one that should compact." }),
        makeMessage({ role: "user", content: "Question two stays in the fresh tail." }),
        makeMessage({ role: "assistant", content: "Answer two stays in the fresh tail." }),
      ],
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const before = await engine.getConversationStore().getMessages(conversation!.conversationId);
    let summaryIndex = 0;
    const result = await engine.compact({
      sessionId,
      sessionFile: createSessionFilePath("compact-leaf-no-telemetry"),
      tokenBudget: 4096,
      force: true,
      legacyParams: {
        summarize: async () => `short summary ${summaryIndex++}`,
      },
    });

    expect(result.compacted).toBe(true);

    const after = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(after).toHaveLength(before.length);
    expect(after.some((message) => message.role === "system")).toBe(false);
    expect(infoLog).toHaveBeenCalledWith(
      expect.stringContaining("[lcm] LCM compaction leaf pass"),
    );
  });

  it("passes injected-context strip tags into production compaction", async () => {
    const engine = createEngineWithConfig({
      freshTailCount: 1,
      leafMinFanout: 2,
      leafChunkTokens: 20_000,
      incrementalMaxDepth: 0,
      stripInjectedContextTags: ["hindsight_memories"],
    });
    const sessionId = "compact-strip-injected-context";
    const summarize = vi.fn(async () => "safe compacted summary");

    await engine.ingestBatch({
      sessionId,
      messages: [
        makeMessage({
          role: "user",
          content: [
            "<hindsight_memories>",
            "Injected memory that should not become durable summary content.",
            "</hindsight_memories>",
            "",
            "Actual user request that should compact.",
          ].join("\n"),
        }),
        makeMessage({ role: "assistant", content: "Actual assistant answer." }),
        makeMessage({ role: "user", content: "Fresh tail question." }),
        makeMessage({ role: "assistant", content: "Fresh tail answer." }),
      ],
    });

    const result = await engine.compact({
      sessionId,
      sessionFile: createSessionFilePath("compact-strip-injected-context"),
      tokenBudget: 4096,
      force: true,
      legacyParams: { summarize },
    });

    expect(result.compacted).toBe(true);
    expect(summarize).toHaveBeenCalled();
    const summarizedText = String(summarize.mock.calls[0]?.[0] ?? "");
    expect(summarizedText).toContain("Actual user request that should compact.");
    expect(summarizedText).not.toContain("Injected memory that should not become durable");
    expect(summarizedText).not.toContain("hindsight_memories");
  });


});

// ── Compact token budget plumbing ───────────────────────────────────────────

describe("LcmContextEngine.compact token budget plumbing", () => {
  it("preserves explicit empty-string customInstructions overrides over config defaults", async () => {
    const completeSpy = vi.fn(async () => ({
      content: [{ type: "text", text: "summary output" }],
    }));
    const engine = createEngineWithDeps(
      { customInstructions: "Write in third person." },
      { complete: completeSpy },
    );
    const privateEngine = engine as unknown as {
      resolveSummarize: (params: {
        legacyParams?: Record<string, unknown>;
        customInstructions?: string;
      }) => Promise<{
        summarize: (text: string, aggressive?: boolean) => Promise<string>;
        summaryModel: string;
      }>;
    };

    const { summarize } = await privateEngine.resolveSummarize({
      legacyParams: { provider: "anthropic", model: "claude-opus-4-5" },
      customInstructions: "",
    });

    await summarize("segment text");

    const firstCall = completeSpy.mock.calls[0]?.[0] as
      | { messages?: Array<{ content?: string }> }
      | undefined;
    const prompt = firstCall?.messages?.[0]?.content;
    expect(typeof prompt).toBe("string");
    expect(prompt).toContain("Operator instructions: (none)");
    expect(prompt).not.toContain("Write in third person.");
  });

  it("supports openai-codex large-file summarization through runtime-owned auth", async () => {
    const completeSpy = vi.fn(async () => ({
      content: [{ type: "text", text: "codex large-file summary" }],
    }));
    const engine = createEngineWithDeps(
      {
        largeFileSummaryProvider: "openai-codex",
        largeFileSummaryModel: "gpt-5.4",
      },
      {
        complete: completeSpy,
        resolveModel: vi.fn((modelRef?: string, providerHint?: string) => ({
          provider: providerHint ?? "openai-codex",
          model: modelRef ?? "gpt-5.4",
        })),
      },
    );
    const privateEngine = engine as unknown as {
      resolveLargeFileTextSummarizer: () => Promise<((prompt: string) => Promise<string | null>) | undefined>;
    };

    const summarizeText = await privateEngine.resolveLargeFileTextSummarizer();
    expect(summarizeText).toBeTypeOf("function");

    const summary = await summarizeText!("Large file prompt");
    expect(summary).toBe("codex large-file summary");
    expect(completeSpy).toHaveBeenCalledTimes(1);
    expect(completeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeModelOverride: {
          configField: "largeFileSummaryModel",
          configPath: "plugins.entries.lossless-claw.config.largeFileSummaryModel",
          modelRef: "openai-codex/gpt-5.4",
        },
      }),
    );
  });

  it("passes context-engine runtime llm and session identity to compaction summaries", async () => {
    const completeSpy = vi.fn(async () => ({
      content: [{ type: "text", text: "bound runtime summary" }],
    }));
    const runtimeLlmComplete = vi.fn(async () => ({
      text: "bound runtime summary",
      provider: "anthropic",
      model: "claude-opus-4-5",
      agentId: "research",
    }));
    const engine = createEngineWithDeps(
      {
        leafMinFanout: 2,
        leafChunkTokens: 1,
        incrementalMaxDepth: 0,
      },
      {
        complete: completeSpy,
      },
    );
    const sessionId = "compact-bound-runtime-llm";
    const sessionKey = "agent:research:session:abc";
    const privateEngine = engine as unknown as {
      compaction: {
        compactFullSweep: (input: {
          summarize: (text: string, aggressive?: boolean) => Promise<string>;
        }) => Promise<unknown>;
      };
    };
    vi.spyOn(privateEngine.compaction, "compactFullSweep").mockImplementation(async (input) => {
      await input.summarize("Question and answer text that should compact.");
      return {
        actionTaken: true,
        tokensBefore: 900,
        tokensAfter: 520,
        condensed: false,
      };
    });

    await engine.ingestBatch({
      sessionId,
      sessionKey,
      messages: [
        makeMessage({ role: "user", content: "Question that should compact." }),
        makeMessage({ role: "assistant", content: "Answer that should compact." }),
      ],
    });

    await engine.compact({
      sessionId,
      sessionKey,
      sessionFile: createSessionFilePath("compact-bound-runtime-llm"),
      tokenBudget: 4096,
      force: true,
      runtimeContext: {
        provider: "anthropic",
        model: "claude-opus-4-5",
        llm: { complete: runtimeLlmComplete },
      },
    });

    expect(completeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeLlmComplete,
        agentId: "research",
      }),
    );
  });

  it("forwards config customInstructions to large-file summarization", async () => {
    const completeSpy = vi.fn(async () => ({
      content: [{ type: "text", text: "summary output" }],
    }));
    const engine = createEngineWithDeps(
      {
        customInstructions: "Use terse factual prose.",
        largeFileSummaryProvider: "anthropic",
        largeFileSummaryModel: "claude-opus-4-5",
      },
      { complete: completeSpy },
    );
    const privateEngine = engine as unknown as {
      resolveLargeFileTextSummarizer: () => Promise<((prompt: string) => Promise<string | null>) | undefined>;
    };

    const summarizeText = await privateEngine.resolveLargeFileTextSummarizer();
    expect(summarizeText).toBeTypeOf("function");

    await summarizeText!("Large file prompt");

    const firstCall = completeSpy.mock.calls[0]?.[0] as
      | { messages?: Array<{ content?: string }> }
      | undefined;
    const prompt = firstCall?.messages?.[0]?.content;
    expect(typeof prompt).toBe("string");
    expect(prompt).toContain("Operator instructions:\nUse terse factual prose.");
  });

  it("fails when compact token budget is missing", async () => {
    const engine = createEngine();
    const sessionId = "session-missing-budget";

    await engine.ingest({
      sessionId,
      message: { role: "user", content: "hello compact" } as AgentMessage,
    });

    const result = await engine.compact({
      sessionId,
      sessionFile: "/tmp/session.jsonl",
      legacyParams: {
        provider: "anthropic",
        model: "claude-opus-4-5",
      },
    });

    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(false);
    expect(result.reason).toContain("missing token budget");
  });

  it("reads tokenBudget and currentTokenCount from runtimeContext", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
        compactFullSweep: (input: unknown) => Promise<unknown>;
      };
    };

    const evaluateSpy = vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 500,
      threshold: 300,
    });
    const compactFullSweepSpy = vi
      .spyOn(privateEngine.compaction, "compactFullSweep")
      .mockResolvedValue({
        actionTaken: true,
        tokensBefore: 500,
        tokensAfter: 280,
        condensed: false,
      });

    await engine.ingest({
      sessionId: "runtime-context-token-session",
      message: { role: "user", content: "trigger" } as AgentMessage,
    });

    const result = await engine.compact({
      sessionId: "runtime-context-token-session",
      sessionFile: "/tmp/session.jsonl",
      runtimeContext: {
        tokenBudget: 400,
        currentTokenCount: 500,
      },
      compactionTarget: "threshold",
    });

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(evaluateSpy).toHaveBeenCalledWith(expect.any(Number), 400, 500);
    expect(compactFullSweepSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: expect.any(Number),
        tokenBudget: 400,
        summarize: expect.any(Function),
        force: false,
        hardTrigger: false,
      }),
    );
  });

  it("forces one compaction round for manual compaction requests in runtimeContext", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (conversationId: number, tokenBudget: number) => Promise<unknown>;
        compactFullSweep: (input: unknown) => Promise<unknown>;
        compactUntilUnder: (input: unknown) => Promise<unknown>;
      };
    };

    const evaluateSpy = vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "none",
      currentTokens: 116_000,
      threshold: 150_000,
    });
    const compactFullSweepSpy = vi
      .spyOn(privateEngine.compaction, "compactFullSweep")
      .mockResolvedValue({
        actionTaken: true,
        tokensBefore: 116_000,
        tokensAfter: 92_000,
        condensed: false,
      });
    const compactUntilUnderSpy = vi.spyOn(privateEngine.compaction, "compactUntilUnder");

    await engine.ingest({
      sessionId: "manual-compact-runtime-context",
      message: { role: "user", content: "trigger manual compact" } as AgentMessage,
    });

    const result = await engine.compact({
      sessionId: "manual-compact-runtime-context",
      sessionFile: "/tmp/session.jsonl",
      runtimeContext: {
        tokenBudget: 200_000,
        manualCompaction: true,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.reason).toBe("compacted");
    expect(evaluateSpy).toHaveBeenCalledWith(expect.any(Number), 200_000);
    expect(compactFullSweepSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: expect.any(Number),
        tokenBudget: 200_000,
        summarize: expect.any(Function),
        force: true,
        hardTrigger: false,
      }),
    );
    expect(compactUntilUnderSpy).not.toHaveBeenCalled();
  });

  it("prefers runtimeContext over legacyParams when both are provided", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (conversationId: number, tokenBudget: number) => Promise<unknown>;
        compactUntilUnder: (input: unknown) => Promise<unknown>;
      };
    };
    const evaluateSpy = vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "none",
      currentTokens: 12,
      threshold: 9,
    });
    const compactSpy = vi.spyOn(privateEngine.compaction, "compactUntilUnder");

    await engine.ingest({
      sessionId: "runtime-context-priority-session",
      message: makeMessage({ role: "user", content: "hello world" }),
    });

    const result = await engine.compact({
      sessionId: "runtime-context-priority-session",
      sessionFile: "/tmp/unused.jsonl",
      runtimeContext: { tokenBudget: 123 },
      legacyParams: { tokenBudget: 999 },
    });

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(evaluateSpy).toHaveBeenCalledWith(expect.any(Number), 123);
    expect(compactSpy).not.toHaveBeenCalled();
  });

  it("accepts explicit token budget without falling back to defaults", async () => {
    const engine = createEngineWithConfig({ contextThreshold: 0.9 });
    const sessionId = "session-explicit-budget";

    await engine.ingest({
      sessionId,
      message: { role: "user", content: "small message" } as AgentMessage,
    });

    const result = await engine.compact({
      sessionId,
      sessionFile: "/tmp/session.jsonl",
      legacyParams: {
        tokenBudget: 10_000,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("below threshold");
  });

  it("forces one compaction round for manual compaction requests", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (conversationId: number, tokenBudget: number) => Promise<unknown>;
        compactFullSweep: (input: unknown) => Promise<unknown>;
        compactUntilUnder: (input: unknown) => Promise<unknown>;
      };
    };

    const evaluateSpy = vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "none",
      currentTokens: 116_000,
      threshold: 150_000,
    });
    const compactFullSweepSpy = vi
      .spyOn(privateEngine.compaction, "compactFullSweep")
      .mockResolvedValue({
        actionTaken: true,
        tokensBefore: 116_000,
        tokensAfter: 92_000,
        condensed: false,
      });
    const compactUntilUnderSpy = vi.spyOn(privateEngine.compaction, "compactUntilUnder");

    await engine.ingest({
      sessionId: "manual-compact-session",
      message: { role: "user", content: "trigger manual compact" } as AgentMessage,
    });

    const result = await engine.compact({
      sessionId: "manual-compact-session",
      sessionFile: "/tmp/session.jsonl",
      tokenBudget: 200_000,
      legacyParams: {
        manualCompaction: true,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.reason).toBe("compacted");
    expect(evaluateSpy).toHaveBeenCalledWith(expect.any(Number), 200_000);
    expect(compactFullSweepSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: expect.any(Number),
        tokenBudget: 200_000,
        summarize: expect.any(Function),
        force: true,
        hardTrigger: false,
      }),
    );
    expect(compactUntilUnderSpy).not.toHaveBeenCalled();
  });

  it("uses threshold target for proactive threshold compaction mode", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (conversationId: number, tokenBudget: number) => Promise<unknown>;
        compactFullSweep: (input: unknown) => Promise<unknown>;
        compactUntilUnder: (input: unknown) => Promise<unknown>;
      };
    };

    const evaluateSpy = vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 380,
      threshold: 300,
    });
    const compactFullSweepSpy = vi
      .spyOn(privateEngine.compaction, "compactFullSweep")
      .mockResolvedValue({
        actionTaken: true,
        tokensBefore: 380,
        tokensAfter: 280,
        condensed: false,
      });
    const compactUntilUnderSpy = vi.spyOn(privateEngine.compaction, "compactUntilUnder");

    await engine.ingest({
      sessionId: "threshold-target-session",
      message: { role: "user", content: "trigger" } as AgentMessage,
    });

    const result = await engine.compact({
      sessionId: "threshold-target-session",
      sessionFile: "/tmp/session.jsonl",
      tokenBudget: 400,
      compactionTarget: "threshold",
    });

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(evaluateSpy).toHaveBeenCalledWith(expect.any(Number), 400);
    expect(compactFullSweepSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: expect.any(Number),
        tokenBudget: 400,
        summarize: expect.any(Function),
        force: false,
        hardTrigger: false,
      }),
    );
    expect(compactUntilUnderSpy).not.toHaveBeenCalled();
  });

  it("passes currentTokenCount through to compaction evaluation and loop", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
        compactFullSweep: (input: unknown) => Promise<unknown>;
        compactUntilUnder: (input: unknown) => Promise<unknown>;
      };
    };

    const evaluateSpy = vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 500,
      threshold: 300,
    });
    const compactFullSweepSpy = vi
      .spyOn(privateEngine.compaction, "compactFullSweep")
      .mockResolvedValue({
        actionTaken: true,
        tokensBefore: 500,
        tokensAfter: 280,
        condensed: false,
      });

    await engine.ingest({
      sessionId: "observed-token-session",
      message: { role: "user", content: "trigger" } as AgentMessage,
    });

    const result = await engine.compact({
      sessionId: "observed-token-session",
      sessionFile: "/tmp/session.jsonl",
      tokenBudget: 400,
      currentTokenCount: 500,
      compactionTarget: "threshold",
    });

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(evaluateSpy).toHaveBeenCalledWith(expect.any(Number), 400, 500);
    expect(compactFullSweepSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: expect.any(Number),
        tokenBudget: 400,
        summarize: expect.any(Function),
        force: false,
        hardTrigger: false,
      }),
    );
  });

  it("forces threshold sweeps to account for runtime prompt overhead", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
        compactFullSweep: (input: unknown) => Promise<unknown>;
      };
    };

    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      storedTokens: 7_000,
      observedTokens: 12_000,
      currentTokens: 12_000,
      threshold: 8_200,
    });
    const compactFullSweepSpy = vi
      .spyOn(privateEngine.compaction, "compactFullSweep")
      .mockResolvedValue({
        actionTaken: true,
        tokensBefore: 7_000,
        tokensAfter: 3_200,
        condensed: false,
      });

    await engine.ingest({
      sessionId: "threshold-runtime-overhead-session",
      message: { role: "user", content: "trigger threshold compact" } as AgentMessage,
    });

    const result = await engine.compact({
      sessionId: "threshold-runtime-overhead-session",
      sessionFile: "/tmp/session.jsonl",
      tokenBudget: 10_000,
      currentTokenCount: 12_000,
      compactionTarget: "threshold",
    });

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.reason).toBe("compacted");
    expect(compactFullSweepSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: expect.any(Number),
        tokenBudget: 10_000,
        summarize: expect.any(Function),
        force: true,
        hardTrigger: false,
        stopAtTokens: 3_200,
      }),
    );
    expect(result.result?.details).toEqual(
      expect.objectContaining({
        targetTokens: 3_200,
        observedOverheadTokens: 5_000,
        projectedTokensAfter: 8_200,
      }),
    );
  });

  it("forces threshold sweeps to account for projected raw backlog pressure", async () => {
    const infoLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: { info: infoLog, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      },
    );
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
        compactFullSweep: (input: unknown) => Promise<unknown>;
      };
    };

    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      storedTokens: 300,
      observedTokens: 300,
      rawTokensOutsideTail: 200,
      projectedTokens: 500,
      currentTokens: 500,
      threshold: 450,
    });
    const compactFullSweepSpy = vi
      .spyOn(privateEngine.compaction, "compactFullSweep")
      .mockResolvedValue({
        actionTaken: true,
        tokensBefore: 300,
        tokensAfter: 240,
        condensed: false,
      });

    await engine.ingest({
      sessionId: "threshold-projected-raw-backlog-session",
      message: { role: "user", content: "trigger projected threshold compact" } as AgentMessage,
    });

    const result = await engine.compact({
      sessionId: "threshold-projected-raw-backlog-session",
      sessionFile: "/tmp/session.jsonl",
      tokenBudget: 600,
      currentTokenCount: 300,
      compactionTarget: "threshold",
    });

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(compactFullSweepSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: expect.any(Number),
        tokenBudget: 600,
        summarize: expect.any(Function),
        force: true,
        hardTrigger: false,
      }),
    );
    expect(result.result?.tokensBefore).toBe(500);
    expect(result.result?.details).toEqual(
      expect.objectContaining({
        targetTokens: 450,
        observedOverheadTokens: 0,
        projectedTokensBefore: 500,
        projectedTokensAfter: 240,
        rawTokensOutsideTail: 200,
      }),
    );
    expect(
      infoLog.mock.calls
        .map((call) => String(call[0]))
        .some(
          (message) =>
            message.includes("projectedTokens=500") &&
            message.includes("rawTokensOutsideTail=200") &&
            message.includes("thresholdPressureTokens=500"),
        ),
    ).toBe(true);
  });

  it("does not clear threshold pressure when persisted tokens are under target but runtime tokens remain over", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
        compactFullSweep: (input: unknown) => Promise<unknown>;
      };
    };

    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      storedTokens: 7_000,
      observedTokens: 12_000,
      currentTokens: 12_000,
      threshold: 8_200,
    });
    vi.spyOn(privateEngine.compaction, "compactFullSweep").mockResolvedValue({
      actionTaken: false,
      tokensBefore: 7_000,
      tokensAfter: 7_000,
      condensed: false,
    });

    await engine.ingest({
      sessionId: "threshold-runtime-still-over-session",
      message: { role: "user", content: "trigger threshold compact" } as AgentMessage,
    });

    const result = await engine.compact({
      sessionId: "threshold-runtime-still-over-session",
      sessionFile: "/tmp/session.jsonl",
      tokenBudget: 10_000,
      currentTokenCount: 12_000,
      compactionTarget: "threshold",
    });

    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("live context still exceeds target");
    expect(result.result?.tokensBefore).toBe(12_000);
    expect(result.result?.tokensAfter).toBe(7_000);
    expect(result.result?.details).toEqual(
      expect.objectContaining({
        targetTokens: 3_200,
        observedOverheadTokens: 5_000,
        projectedTokensAfter: 12_000,
      }),
    );
  });

  it("reports already under target when compaction rounds are zero", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (conversationId: number, tokenBudget: number) => Promise<unknown>;
        compactUntilUnder: (input: unknown) => Promise<unknown>;
      };
    };

    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 2_050,
      threshold: 1_500,
    });
    vi.spyOn(privateEngine.compaction, "compactUntilUnder").mockResolvedValue({
      success: true,
      rounds: 0,
      finalTokens: 2_000,
    });

    await engine.ingest({
      sessionId: "under-target-session",
      message: { role: "user", content: "trigger" } as AgentMessage,
    });

    const result = await engine.compact({
      sessionId: "under-target-session",
      sessionFile: "/tmp/session.jsonl",
      tokenBudget: 2_000,
    });

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("already under target");
  });

  it("treats full-sweep compaction as already under target when tokensAfter is below budget", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
        compactFullSweep: (input: unknown) => Promise<unknown>;
      };
    };

    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 12_000,
      threshold: 8_200,
    });
    vi.spyOn(privateEngine.compaction, "compactFullSweep").mockResolvedValue({
      actionTaken: false,
      tokensBefore: 12_000,
      tokensAfter: 4_200,
      condensed: false,
    });

    await engine.ingest({
      sessionId: "manual-observed-token-session",
      message: { role: "user", content: "trigger manual compact" } as AgentMessage,
    });

    const result = await engine.compact({
      sessionId: "manual-observed-token-session",
      sessionFile: "/tmp/session.jsonl",
      tokenBudget: 10_000,
      currentTokenCount: 12_000,
      legacyParams: {
        manualCompaction: true,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("already under target");
    expect(result.result?.tokensBefore).toBe(12_000);
    expect(result.result?.tokensAfter).toBe(4_200);
  });

  it("reports threshold full-sweep compaction as incomplete when tokensAfter remains over target", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
        compactFullSweep: (input: unknown) => Promise<unknown>;
      };
    };

    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 12_000,
      threshold: 8_200,
    });
    vi.spyOn(privateEngine.compaction, "compactFullSweep").mockResolvedValue({
      actionTaken: true,
      tokensBefore: 12_000,
      tokensAfter: 9_000,
      condensed: false,
    });

    await engine.ingest({
      sessionId: "threshold-sweep-partial-over-target",
      message: { role: "user", content: "trigger threshold compact" } as AgentMessage,
    });

    const result = await engine.compact({
      sessionId: "threshold-sweep-partial-over-target",
      sessionFile: "/tmp/session.jsonl",
      tokenBudget: 10_000,
      currentTokenCount: 12_000,
      compactionTarget: "threshold",
    });

    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(true);
    expect(result.reason).toBe("compacted but still over target");
    expect(result.result?.tokensBefore).toBe(12_000);
    expect(result.result?.tokensAfter).toBe(9_000);
    expect(result.result?.details).toEqual(
      expect.objectContaining({
        rounds: 1,
        targetTokens: 8_200,
      }),
    );
  });

  it("routes forced budget recovery through compactUntilUnder for the issue #268 overflow shape", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
        compactFullSweep: (input: unknown) => Promise<unknown>;
        compactUntilUnder: (input: unknown) => Promise<unknown>;
      };
    };

    const evaluateSpy = vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 277_403,
      threshold: 150_000,
    });
    const compactFullSweepSpy = vi.spyOn(privateEngine.compaction, "compactFullSweep");
    const compactUntilUnderSpy = vi.spyOn(privateEngine.compaction, "compactUntilUnder").mockResolvedValue({
      success: true,
      rounds: 2,
      finalTokens: 199_500,
    });

    await engine.ingest({
      sessionId: "forced-sweep-live-overflow",
      message: { role: "user", content: "trigger" } as AgentMessage,
    });

    const result = await engine.compact({
      sessionId: "forced-sweep-live-overflow",
      sessionFile: "/tmp/session.jsonl",
      tokenBudget: 200_000,
      currentTokenCount: 277_403,
      force: true,
      compactionTarget: "budget",
    });

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.reason).toBe("compacted");
    expect(result.result?.tokensBefore).toBe(277_403);
    expect(result.result?.tokensAfter).toBe(199_500);
    expect(result.result?.details).toEqual(
      expect.objectContaining({
        rounds: 2,
        targetTokens: 200_000,
      }),
    );
    expect(evaluateSpy).toHaveBeenCalledWith(expect.any(Number), 200_000, 277_403);
    expect(compactFullSweepSpy).not.toHaveBeenCalled();
    expect(compactUntilUnderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: expect.any(Number),
        tokenBudget: 200_000,
        targetTokens: 200_000,
        currentTokens: 277_403,
        summarize: expect.any(Function),
      }),
    );
  });

  it("uses tokenBudget as currentTokens for forced recovery when observed tokens are unavailable", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
        compactFullSweep: (input: unknown) => Promise<unknown>;
        compactUntilUnder: (input: unknown) => Promise<unknown>;
      };
    };

    const evaluateSpy = vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 150_000,
      threshold: 120_000,
    });
    const compactFullSweepSpy = vi.spyOn(privateEngine.compaction, "compactFullSweep");
    const compactUntilUnderSpy = vi.spyOn(privateEngine.compaction, "compactUntilUnder").mockResolvedValue({
      success: true,
      rounds: 1,
      finalTokens: 118_000,
    });

    await engine.ingest({
      sessionId: "forced-sweep-unknown-observed-tokens",
      message: { role: "user", content: "trigger" } as AgentMessage,
    });

    const result = await engine.compact({
      sessionId: "forced-sweep-unknown-observed-tokens",
      sessionFile: "/tmp/session.jsonl",
      tokenBudget: 120_000,
      force: true,
      compactionTarget: "budget",
    });

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.reason).toBe("compacted");
    expect(result.result?.tokensBefore).toBe(150_000);
    expect(result.result?.tokensAfter).toBe(118_000);
    expect(evaluateSpy).toHaveBeenCalledWith(expect.any(Number), 120_000);
    expect(compactFullSweepSpy).not.toHaveBeenCalled();
    expect(compactUntilUnderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: expect.any(Number),
        tokenBudget: 120_000,
        targetTokens: 120_000,
        currentTokens: 120_000,
        summarize: expect.any(Function),
      }),
    );
  });
});

describe("LcmContextEngine.assemble maxAssemblyTokenBudget cap", () => {
  it("caps token budget when maxAssemblyTokenBudget is set and runtime budget exceeds it", async () => {
    const engine = createEngineWithConfig({ maxAssemblyTokenBudget: 5000 });
    const sessionId = "session-budget-cap";

    for (let i = 0; i < 20; i++) {
      await engine.ingest({
        sessionId,
        message: {
          role: i % 2 === 0 ? "user" : "assistant",
          content: `turn ${i} ${"x".repeat(400)}`,
        } as AgentMessage,
      });
    }

    const result = await engine.assemble({
      sessionId,
      messages: [],
      tokenBudget: 200_000,
    });

    expect(result.estimatedTokens).toBeLessThanOrEqual(5000);
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  it("uses full runtime budget when maxAssemblyTokenBudget is not set", async () => {
    const engine = createEngine();
    const sessionId = "session-no-cap";

    for (let i = 0; i < 10; i++) {
      await engine.ingest({
        sessionId,
        message: {
          role: i % 2 === 0 ? "user" : "assistant",
          content: `turn ${i} ${"x".repeat(200)}`,
        } as AgentMessage,
      });
    }

    const result = await engine.assemble({
      sessionId,
      messages: [],
      tokenBudget: 100_000,
    });

    expect(result.messages.length).toBe(10);
  });

  it("caps the 128k fallback when maxAssemblyTokenBudget is set and no runtime budget provided", async () => {
    const engine = createEngineWithConfig({ maxAssemblyTokenBudget: 3000 });
    const sessionId = "session-fallback-cap";

    for (let i = 0; i < 20; i++) {
      await engine.ingest({
        sessionId,
        message: {
          role: i % 2 === 0 ? "user" : "assistant",
          content: `turn ${i} ${"x".repeat(400)}`,
        } as AgentMessage,
      });
    }

    const result = await engine.assemble({
      sessionId,
      messages: [],
    });

    expect(result.estimatedTokens).toBeLessThanOrEqual(3000);
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  it("caps token budget in compact when maxAssemblyTokenBudget is set", async () => {
    const engine = createEngineWithConfig({ maxAssemblyTokenBudget: 5000 });
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
        compactFullSweep: (input: unknown) => Promise<unknown>;
      };
    };

    const evaluateSpy = vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 6000,
      threshold: 3750,
    });
    const compactFullSweepSpy = vi
      .spyOn(privateEngine.compaction, "compactFullSweep")
      .mockResolvedValue({
        actionTaken: true,
        tokensBefore: 6000,
        tokensAfter: 3500,
        condensed: false,
      });

    await engine.ingest({
      sessionId: "compact-budget-cap",
      message: { role: "user", content: "trigger compact budget cap" } as AgentMessage,
    });

    const result = await engine.compact({
      sessionId: "compact-budget-cap",
      sessionFile: "/tmp/session.jsonl",
      tokenBudget: 200_000,
      compactionTarget: "threshold",
    });

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(evaluateSpy).toHaveBeenCalledWith(expect.any(Number), 5000);
    expect(compactFullSweepSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: expect.any(Number),
        tokenBudget: 5000,
      }),
    );
  });



  it("does not consume summary substring as coverage for volatile live inputs", async () => {
    const engine = createEngine();
    (engine as unknown as { ensureMigrated(): void }).ensureMigrated();
    const sessionId = "session-volatile-not-consumed-by-summary";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {});
    const summaryStore = engine.getSummaryStore();

    // Create a summary that contains text matching a future volatile input.
    // This simulates an older turn where a similar inter-session event was
    // summarized — the summary is stale history, NOT the current live input.
    const repeatedEventContent =
      "[Internal task completion event]\nChild result: subagent finished processing data.";
    const oldSummary =
      "Previous turn context.\n" +
      "[Internal task completion event]\n" +
      "Child result: subagent finished processing data.\n" +
      "End of previous context.";
    await summaryStore.insertSummary({
      summaryId: "sum_old_with_event_text",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: oldSummary,
      tokenCount: estimateTokens(oldSummary),
    });
    await summaryStore.appendContextSummary(conversation.conversationId, "sum_old_with_event_text");

    // A new volatile live input with identical content must NOT be consumed
    // by the old summary — it's a separate event that the model needs to see.
    const volatileEvent =
      "[Inter-session message] sourceSession=agent:main:subagent:summary-consume sourceTool=subagent_announce\n" +
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n" +
      repeatedEventContent + "\n" +
      "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";

    const result = await engine.assemble({
      sessionId,
      messages: [{ role: "user", content: volatileEvent }] as AgentMessage[],
      tokenBudget: 10_000,
    });
    const rendered = result.messages.map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content)
    );
    // The volatile input must appear explicitly as its own message, not be consumed by the summary.
    // It may also appear inside the summary content (historical reference), so we
    // check that it exists as a dedicated volatile-appended entry by verifying
    // the full OPENCLAW_INTERNAL_CONTEXT wrapper is present.
    expect(
      rendered.filter((content) => content.includes("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>") && content.includes(repeatedEventContent))
    ).toHaveLength(1);
    // The old summary should also be present (it's the only assembled context).
    expect(rendered.some((content) => content.includes("Previous turn context"))).toBe(true);
  });

  it("matches tool results without tool names against assembled unknown-name results", async () => {
    const engine = createEngine();
    (engine as unknown as { ensureMigrated(): void }).ensureMigrated();
    const sessionId = "session-tool-name-unknown-coverage";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {});
    const summaryStore = engine.getSummaryStore();

    const oldSummary = "old evictable summary before nameless tool result";
    await summaryStore.insertSummary({
      summaryId: "sum_old_before_nameless_tool",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: oldSummary,
      tokenCount: estimateTokens(oldSummary),
    });
    await summaryStore.appendContextSummary(conversation.conversationId, "sum_old_before_nameless_tool");

    // Ingest a tool result that will be stored with toolName="unknown"
    // by the assembler (assembler fills missing tool names with "unknown").
    const toolCallId = "call_nameless_tool";
    const toolOutput = "tool output without a real tool name must anchor correctly";
    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: toolCallId, name: "unknown", input: {} }],
      } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: {
        role: "toolResult",
        toolCallId,
        toolName: "unknown",
        content: [{ type: "text", text: toolOutput }],
      } as AgentMessage,
    });

    // Live volatile input before the tool result, where the live version
    // has no toolName at all (not even "unknown").
    const volatileEvent =
      "[Inter-session message] sourceSession=agent:main:subagent:nameless-tool sourceTool=subagent_announce\n" +
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n" +
      "[Internal task completion event]\n" +
      "Child result: volatile input must anchor before nameless tool result.\n" +
      "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";

    const result = await engine.assemble({
      sessionId,
      messages: [
        { role: "user", content: volatileEvent },
        // Live tool result without toolName — should match assembled "unknown"
        {
          role: "toolResult",
          toolCallId,
          // No toolName — the assembler would fill "unknown" but live has none
          content: [{ type: "text", text: toolOutput }],
        } as AgentMessage,
      ],
      tokenBudget: 10_000,
    });
    const renderedText = result.messages
      .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
      .join("\n");
    // The volatile input must appear BEFORE the tool result in the output.
    const volatileIndex = renderedText.indexOf("volatile input must anchor before nameless tool result");
    const toolIndex = renderedText.indexOf("tool output without a real tool name");
    expect(volatileIndex).toBeGreaterThanOrEqual(0);
    expect(toolIndex).toBeGreaterThanOrEqual(0);
    expect(volatileIndex).toBeLessThan(toolIndex);
  });

  it("appends suppressed fallback retry prompts that lack internal context markers", async () => {
    const engine = createEngine();
    (engine as unknown as { ensureMigrated(): void }).ensureMigrated();
    const sessionId = "session-fallback-retry-volatile";

    await engine.ingest({
      sessionId,
      message: { role: "user", content: "Original task that persisted before retry." } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: { role: "assistant", content: "The first model attempt failed." } as AgentMessage,
    });

    const retryPrompt =
      "Prior retry context from the session transcript.\n\n" +
      "[Retry after the previous model attempt failed or timed out]\n\n" +
      "Original task that persisted before retry.";

    const result = await engine.assemble({
      sessionId,
      messages: [
        { role: "user", content: "Original task that persisted before retry." },
        { role: "assistant", content: "The first model attempt failed." },
        { role: "user", content: retryPrompt },
      ] as AgentMessage[],
      tokenBudget: 10_000,
    });

    const rendered = result.messages.map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    );
    expect(rendered.some((content) => content.includes("[Retry after the previous model attempt"))).toBe(
      true,
    );
    expect(rendered.some((content) => content.includes("Prior retry context"))).toBe(true);
  });

  it("evicts historical tool-call pairs together when volatile input forces trimming", async () => {
    const engine = createEngineWithConfig({ freshTailCount: 8 });
    (engine as unknown as { ensureMigrated(): void }).ensureMigrated();
    const sessionId = "session-volatile-budget-tool-pair";
    const toolCallId = "call_budget_pair";
    const toolOutput = "large paired tool output " + "x ".repeat(900);

    await engine.ingest({
      sessionId,
      message: { role: "user", content: "Question before tool use." } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: toolCallId, name: "read", input: { path: "big.txt" } }],
      } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: {
        role: "toolResult",
        toolCallId,
        toolName: "read",
        content: [{ type: "text", text: toolOutput }],
      } as AgentMessage,
    });
    for (let index = 0; index < 8; index++) {
      await engine.ingest({
        sessionId,
        message: { role: "user", content: `fresh protected tail message ${index}` } as AgentMessage,
      });
    }

    const assembledWithoutVolatile = await engine.assemble({
      sessionId,
      messages: [],
      tokenBudget: 10_000,
    });
    expect(
      assembledWithoutVolatile.messages.some(
        (message) =>
          message.role === "assistant" &&
          Array.isArray(message.content) &&
          message.content.some(
            (block) =>
              block &&
              typeof block === "object" &&
              "id" in block &&
              (block as { id?: unknown }).id === toolCallId,
          ),
      ),
    ).toBe(true);
    expect(
      assembledWithoutVolatile.messages.some(
        (message) =>
          message.role === "toolResult" &&
          (message as { toolCallId?: string }).toolCallId === toolCallId,
      ),
    ).toBe(true);

    const volatileEvent =
      "[Inter-session message] sourceSession=agent:main:subagent:budget sourceTool=subagent_announce\n" +
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n" +
      "[Internal task completion event]\n" +
      "Child result: volatile input should not leave a synthetic tool repair.\n" +
      "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";

    const result = await engine.assemble({
      sessionId,
      messages: [{ role: "user", content: volatileEvent }] as AgentMessage[],
      tokenBudget: assembledWithoutVolatile.estimatedTokens + estimateTokens(volatileEvent) - 50,
    });

    const rendered = result.messages
      .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
      .join("\n");
    expect(rendered).toContain("volatile input should not leave a synthetic tool repair");
    expect(rendered).not.toContain(
      "[lossless-claw] missing tool result in session history; inserted synthetic error result",
    );
    expect(
      result.messages.some(
        (message) =>
          message.role === "assistant" &&
          Array.isArray(message.content) &&
          message.content.some(
            (block) =>
              block &&
              typeof block === "object" &&
              "id" in block &&
              (block as { id?: unknown }).id === toolCallId,
          ),
      ),
    ).toBe(false);
    expect(
      result.messages.some(
        (message) =>
          message.role === "toolResult" &&
          (message as { toolCallId?: string }).toolCallId === toolCallId,
      ),
    ).toBe(false);
  });

});
