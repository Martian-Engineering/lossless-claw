import { randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextAssembler } from "../src/assembler.js";
import type { LcmConfig } from "../src/db/config.js";
import { closeLcmConnection, createLcmDatabaseConnection } from "../src/db/connection.js";
import { LcmContextEngine } from "../src/engine.js";
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
    getApiKey: vi.fn(async () => process.env.ANTHROPIC_API_KEY),
    requireApiKey: vi.fn(async () => process.env.ANTHROPIC_API_KEY ?? "test-api-key"),
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

  it("stores externalized inline images under largeFilesDir", async () => {
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

  it("maintain() requests transcript rewrites for summarized externalized tool results", async () => {
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

      const result = await engine.maintain({
        sessionId,
        sessionFile,
        runtimeContext: {
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

  it("uses the bulk import path for initial bootstrap", async () => {
    const sessionFile = createSessionFilePath("bulk");
    const sm = SessionManager.open(sessionFile);
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "bulk one" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "bulk two" }],
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
      sessionId: "bootstrap-bulk",
      sessionFile,
    });

    expect(result.bootstrapped).toBe(true);
    expect(bulkSpy).toHaveBeenCalledTimes(1);
    expect(singleSpy).not.toHaveBeenCalled();
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
          debug: vi.fn(),
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
    const cacheGuardLogs = infoLog.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === "string" && call[0].includes("skipped full read (file unchanged)"),
    );
    expect(cacheGuardLogs).toHaveLength(1);

    // Verify only one full transcript read occurred (the first bootstrap)
    const fullReadLogs = infoLog.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("full transcript read"),
    );
    expect(fullReadLogs).toHaveLength(1);
  });

  it("file-level cache guard allows full read when file changes", async () => {
    const infoLog = vi.fn();
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
          debug: vi.fn(),
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
    const fullReadLogs = infoLog.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("full transcript read"),
    );
    expect(fullReadLogs).toHaveLength(2);

    // And the cache guard must not have fired after the file grew
    const skippedLogs = infoLog.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === "string" && call[0].includes("skipped full read (file unchanged)"),
    );
    expect(skippedLogs).toHaveLength(0);
  });
});

// ── Assemble canonical path with fallback ───────────────────────────────────

describe("LcmContextEngine.assemble canonical path", () => {
  it("falls back to live messages when no DB conversation exists", async () => {
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

    expect(result.messages).toBe(liveMessages);
    expect(result.estimatedTokens).toBe(0);
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

    expect(result.messages).toBe(liveMessages);
    expect(result.estimatedTokens).toBe(0);
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

    expect(result.messages).toBe(liveMessages);
    expect(result.estimatedTokens).toBe(0);
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

  it("omits dynamic LCM system prompt guidance when no summaries exist", async () => {
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

  it("adds only dynamic compacted-context guidance when summaries are present", async () => {
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
    expect(promptAddition).toContain("## Compacted Conversation Context");
    expect(promptAddition).toContain("Summaries above are compressed context, not full detail");
    expect(promptAddition).toContain("Expand for details about:");
    expect(promptAddition).toContain("expand for details before answering");
    expect(promptAddition).toContain("State uncertainty instead of guessing from compressed summaries");
    expect(promptAddition).not.toContain("## Lossless Recall Policy");
    expect(promptAddition).not.toContain("The lossless-claw plugin is active");
    expect(promptAddition).not.toContain("Recall order for compacted conversation history");
    expect(promptAddition).not.toContain("memory_search");
    expect(promptAddition).not.toContain("memory_get");
    expect(promptAddition).not.toContain("Uncertainty checklist");
    expect(promptAddition).not.toContain("Deeply compacted context");
  });

  it("emphasizes expand-before-asserting when summaries are deeply compacted", async () => {
    const engine = createEngine();
    const sessionId = "session-deep-summary-guidance";

    await engine.ingest({
      sessionId,
      message: { role: "user", content: "seed message" } as AgentMessage,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    await engine.getSummaryStore().insertSummary({
      summaryId: "sum_guidance_deep",
      conversationId: conversation!.conversationId,
      kind: "condensed",
      depth: 2,
      content: "Deep condensed summary",
      tokenCount: 24,
      descendantCount: 12,
    });
    await engine
      .getSummaryStore()
      .appendContextSummary(conversation!.conversationId, "sum_guidance_deep");

    const result = await engine.assemble({
      sessionId,
      messages: [],
      tokenBudget: 10_000,
    });

    const promptAddition = (result as { systemPromptAddition?: string }).systemPromptAddition;
    expect(promptAddition).toContain("## Compacted Conversation Context");
    expect(promptAddition).toContain("Deeply compacted context");
    expect(promptAddition).toContain("expand before asserting specifics");
    expect(promptAddition).toContain("Default recall flow for precision work:");
    expect(promptAddition).toContain("1) `lcm_grep` to locate relevant summary/message IDs");
    expect(promptAddition).toContain("2) `lcm_expand_query` with a focused prompt");
    expect(promptAddition).toContain("3) Answer directly from the retrieved evidence");
    expect(promptAddition).toContain("Keep raw summary IDs in tool context for follow-up");
    expect(promptAddition).toContain("prefer `mode: \"full_text\"` for keyword/topic lookup");
    expect(promptAddition).toContain("quote exact multi-word phrases");
    expect(promptAddition).toContain("use `sort: \"relevance\"` for older-topic retrieval");
    expect(promptAddition).toContain("use `sort: \"hybrid\"` when recency should still influence ranking");
    expect(promptAddition).toContain("uses the same FTS5 full-text search rules as `lcm_grep`");
    expect(promptAddition).toContain("terms are ANDed by default");
    expect(promptAddition).toContain("put the natural-language question in `prompt`");
    expect(promptAddition).toContain("Uncertainty checklist");
    expect(promptAddition).toContain("Am I making an exact factual claim from a compressed or condensed summary?");
    expect(promptAddition).toContain("Could compaction have omitted a crucial detail?");
    expect(promptAddition).toContain("Would I need an expansion step if the user asks for proof or the exact text?");
    expect(promptAddition).toContain("Should I state uncertainty instead of asserting specifics until I expand?");
    expect(promptAddition).toContain("expand first or explicitly say that you need to expand");
    expect(promptAddition).toContain("Do not guess exact commands, SHAs, file paths, timestamps, config values, or causal claims from condensed summaries.");
    expect(promptAddition).not.toContain("## Lossless Recall Policy");
    expect(promptAddition).not.toContain("The lossless-claw plugin is active");
    expect(promptAddition).not.toContain("Recall order for compacted conversation history");
    expect(promptAddition).not.toContain("memory_search");
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

  it("maps unknown roles to assistant instead of silently coercing to user", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();

    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "custom-event", content: "opaque payload" }),
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const storedMessages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(storedMessages).toHaveLength(1);
    expect(storedMessages[0].role).toBe("assistant");
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

  it("afterTurn runs proactive threshold compaction when tokenBudget is provided", async () => {
    const engine = createEngineWithConfig({
      proactiveThresholdCompactionMode: "inline",
    });
    const sessionId = "after-turn-proactive-compact";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
      executeLeafCompactionCore: (...args: unknown[]) => Promise<unknown>;
    };

    const evaluateLeafTriggerSpy = vi
      .spyOn(privateEngine.compaction, "evaluateLeafTrigger")
      .mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    });
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "none",
      currentTokens: 42,
      threshold: 3_072,
    });
    const compactLeafAsyncSpy = vi.spyOn(engine, "compactLeafAsync");
    const compactSpy = vi.spyOn(engine, "compact").mockResolvedValue({
      ok: true,
      compacted: false,
      reason: "below threshold",
      result: {
        tokensBefore: 42,
      },
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-proactive-compact"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    expect(evaluateLeafTriggerSpy).toHaveBeenCalledWith(expect.any(Number));
    expect(compactLeafAsyncSpy).not.toHaveBeenCalled();
    expect(compactSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        tokenBudget: 4096,
        compactionTarget: "threshold",
      }),
    );
  });

  it("afterTurn resolves tokenBudget from runtimeContext and forwards it as legacyParams", async () => {
    const engine = createEngineWithConfig({
      proactiveThresholdCompactionMode: "inline",
    });
    const sessionId = "after-turn-runtime-context";
    const runtimeContext = { provider: "anthropic", model: "claude-opus-4-5", tokenBudget: 2048 };
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
      executeLeafCompactionCore: (...args: unknown[]) => Promise<unknown>;
    };

    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: true,
      rawTokensOutsideTail: 20_000,
      threshold: 20_000,
    });
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "none",
      currentTokens: 500,
      threshold: 1_536,
    });
    const executeLeafCompactionCoreSpy = vi.spyOn(
      privateEngine,
      "executeLeafCompactionCore",
    ).mockResolvedValue({
      ok: true,
      compacted: false,
      reason: "below threshold",
    });
    const compactSpy = vi.spyOn(engine, "compact").mockResolvedValue({
      ok: true,
      compacted: false,
      reason: "below threshold",
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-runtime-context"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      runtimeContext,
    });

    await vi.waitFor(() => {
      expect(executeLeafCompactionCoreSpy).toHaveBeenCalled();
    });
    expect((executeLeafCompactionCoreSpy.mock.calls[0]?.[0] as { tokenBudget?: unknown }).tokenBudget).toBe(2048);
    expect((executeLeafCompactionCoreSpy.mock.calls[0]?.[0] as { legacyParams?: unknown }).legacyParams).toBe(runtimeContext);
    expect(compactSpy).not.toHaveBeenCalled();
  });

  it("afterTurn keeps the bootstrap checkpoint stale and records retry debt when inline leaf compaction fails", async () => {
    const engine = createEngineWithConfig({
      proactiveThresholdCompactionMode: "inline",
    });
    const sessionId = "after-turn-inline-leaf-compaction-failure";
    const sessionFile = createSessionFilePath("after-turn-inline-leaf-compaction-failure");
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
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
      executeLeafCompactionCore: (...args: unknown[]) => Promise<unknown>;
    };

    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: true,
      rawTokensOutsideTail: 20_000,
      threshold: 20_000,
    });
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 500,
      threshold: 3_072,
    });
    const executeLeafCompactionCoreSpy = vi.spyOn(
      privateEngine,
      "executeLeafCompactionCore",
    ).mockResolvedValue({
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
    });

    await vi.waitFor(async () => {
      const maintenance = await engine
        .getCompactionMaintenanceStore()
        .getConversationCompactionMaintenance(conversation.conversationId);
      expect(maintenance?.pending).toBe(true);
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
    expect(maintenance?.reason).toBe("leaf-trigger");
    expect(maintenance?.tokenBudget).toBe(4_096);
    expect(executeLeafCompactionCoreSpy).toHaveBeenCalled();
  });

  it("afterTurn keeps later same-session work behind inline leaf compaction persistence", async () => {
    const engine = createEngineWithConfig({
      proactiveThresholdCompactionMode: "inline",
    });
    const sessionId = "after-turn-inline-leaf-compaction-queue-order";
    const sessionFile = createSessionFilePath("after-turn-inline-leaf-compaction-queue-order");
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
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
      executeLeafCompactionCore: (...args: unknown[]) => Promise<unknown>;
    };

    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: true,
      rawTokensOutsideTail: 20_000,
      threshold: 20_000,
    });
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 500,
      threshold: 3_072,
    });

    let releaseLeafCompaction!: () => void;
    let notifyLeafCompactionStarted!: () => void;
    const leafCompactionStarted = new Promise<void>((resolve) => {
      notifyLeafCompactionStarted = resolve;
    });
    const leafCompactionGate = new Promise<void>((resolve) => {
      releaseLeafCompaction = resolve;
    });

    vi.spyOn(privateEngine, "executeLeafCompactionCore").mockImplementation(async () => {
      notifyLeafCompactionStarted();
      await leafCompactionGate;
      return {
        ok: false,
        compacted: false,
        reason: "provider auth failure",
      };
    });

    await engine.afterTurn({
      sessionId,
      sessionFile,
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    await leafCompactionStarted;

    let ingestResolved = false;
    const ingestPromise = engine
      .ingest({
        sessionId,
        message: makeMessage({ role: "user", content: "queued behind leaf compaction" }),
      })
      .then((result) => {
        ingestResolved = true;
        return result;
      });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(ingestResolved).toBe(false);

    releaseLeafCompaction();

    const ingestResult = await ingestPromise;
    expect(ingestResult.ingested).toBe(true);

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(maintenance).not.toBeNull();
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.reason).toBe("leaf-trigger");
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
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
      executeLeafCompactionCore: (...args: unknown[]) => Promise<unknown>;
    };

    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    });
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "none",
      currentTokens: 42,
      threshold: 96_000,
    });
    const compactSpy = vi.spyOn(engine, "compact").mockResolvedValue({
      ok: true,
      compacted: false,
      reason: "below threshold",
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-default-token-budget"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
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
    const errorLog = vi.fn();
    const engine = createEngineWithDeps(
      {
        proactiveThresholdCompactionMode: "inline",
      },
      {
        log: {
          info: vi.fn(),
          warn: vi.fn(),
          error: errorLog,
          debug: vi.fn(),
        },
      },
    );
    const sessionId = "after-turn-legacy-compaction-params";
    const legacyCompactionParams = { provider: "anthropic", model: "claude-opus-4-5" };
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
      shouldCompact: true,
      rawTokensOutsideTail: 20_000,
      threshold: 20_000,
    });
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "none",
      currentTokens: 500,
      threshold: 3_072,
    });
    const executeLeafCompactionCoreSpy = vi.spyOn(
      privateEngine,
      "executeLeafCompactionCore",
    ).mockResolvedValue({
      ok: true,
      compacted: false,
      reason: "below threshold",
    });
    const compactSpy = vi.spyOn(engine, "compact").mockResolvedValue({
      ok: true,
      compacted: false,
      reason: "below threshold",
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-legacy-compaction-params"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
      legacyCompactionParams,
    });

    await vi.waitFor(() => {
      expect(executeLeafCompactionCoreSpy).toHaveBeenCalled();
    });
    expect((executeLeafCompactionCoreSpy.mock.calls[0]?.[0] as { legacyParams?: unknown }).legacyParams).toBe(legacyCompactionParams);
    expect(compactSpy).not.toHaveBeenCalled();
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
    const compactSpy = vi.spyOn(engine, "compact").mockResolvedValue({
      ok: true,
      compacted: false,
      reason: "below threshold",
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

  it("afterTurn records deferred compaction debt instead of compacting inline by default", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (
          conversationId: number,
          leafChunkTokens?: number,
        ) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };
    const sessionId = "after-turn-deferred-compaction-debt";
    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: true,
      rawTokensOutsideTail: 50_000,
      threshold: 20_000,
    } as unknown as Record<string, unknown>);
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 1_024,
      threshold: 3_072,
    });
    const compactLeafAsyncSpy = vi.spyOn(engine, "compactLeafAsync");
    const compactSpy = vi.spyOn(engine, "compact");

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-deferred-compaction-debt"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    expect(compactLeafAsyncSpy).not.toHaveBeenCalled();
    expect(compactSpy).not.toHaveBeenCalled();
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation!.conversationId);
    expect(maintenance).not.toBeNull();
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.running).toBe(false);
    expect(maintenance?.reason).toBe("leaf-trigger");
    expect(maintenance?.requestedAt).toBeInstanceOf(Date);
  });

  it("afterTurn records deferred leaf debt even when cache heuristics defer execution", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-hot-cache-deferred-leaf-debt";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (
          conversationId: number,
          leafChunkTokens?: number,
        ) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
      evaluateIncrementalCompaction: (params: unknown) => Promise<unknown>;
    };
    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: true,
      rawTokensOutsideTail: 55_000,
      threshold: 20_000,
    } as unknown as Record<string, unknown>);
    vi.spyOn(privateEngine, "evaluateIncrementalCompaction").mockResolvedValue({
      shouldCompact: false,
      reason: "hot-cache-budget-headroom",
      cacheState: "hot",
      maxPasses: 1,
      rawTokensOutsideTail: 55_000,
      threshold: 20_000,
      leafChunkTokens: 20_000,
      fallbackLeafChunkTokens: [20_000, 15_000, 10_000],
      activityBand: "low",
      allowCondensedPasses: false,
    } as unknown as Record<string, unknown>);
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 1_024,
      threshold: 3_072,
    });
    const compactLeafAsyncSpy = vi.spyOn(engine, "compactLeafAsync");
    const compactSpy = vi.spyOn(engine, "compact");

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-hot-cache-deferred-leaf-debt"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    expect(compactLeafAsyncSpy).not.toHaveBeenCalled();
    expect(compactSpy).not.toHaveBeenCalled();
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation!.conversationId);
    expect(maintenance).not.toBeNull();
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.running).toBe(false);
    expect(maintenance?.reason).toBe("leaf-trigger");
  });

  it("afterTurn records threshold debt even when the leaf trigger stays below threshold", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-threshold-deferred-compaction-debt";
    vi.spyOn(
      engine as unknown as { evaluateIncrementalCompaction: () => Promise<unknown> },
      "evaluateIncrementalCompaction",
    ).mockResolvedValue({
      shouldCompact: false,
      reason: "below-leaf-trigger",
      maxPasses: 1,
      allowCondensedPasses: false,
      activityBand: "medium",
      leafChunkTokens: 20_000,
      fallbackLeafChunkTokens: [20_000, 15_000, 10_000],
      triggerLeafChunkTokens: 20_000,
      preferredLeafChunkTokens: 20_000,
      rawTokensOutsideTail: 10_000,
      threshold: 20_000,
    } as unknown as Record<string, unknown>);
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
      currentTokens: 480,
      threshold: 300,
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-threshold-deferred-compaction-debt"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 400,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation!.conversationId);
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.running).toBe(false);
    expect(maintenance?.reason).toBe("threshold");
    expect(maintenance?.tokenBudget).toBe(400);
  });

  it("maintain() leaves deferred compaction debt pending until the host opts in", async () => {
    const engine = createEngine();
    const sessionId = "maintain-deferred-compaction-disabled";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "leaf-trigger",
      tokenBudget: 4_096,
      currentTokenCount: 42,
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

  it("maintain() consumes deferred compaction debt only when the host opts in", async () => {
    const engine = createEngine();
    const sessionId = "maintain-deferred-compaction-enabled";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "leaf-trigger",
      tokenBudget: 4_096,
      currentTokenCount: 42,
    });

    const maintenanceResult = await engine.maintain({
      sessionId,
      sessionFile: createSessionFilePath("maintain-deferred-compaction-enabled-maintain"),
      runtimeContext: {
        allowDeferredCompactionExecution: true,
      },
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(maintenance).not.toBeNull();
    expect(maintenance?.pending).toBe(false);
    expect(maintenance?.running).toBe(false);
    expect(maintenanceResult.changed).toBe(false);
    expect(maintenanceResult.reason).toBe("deferred compaction no longer needed");
  });

  it("maintain() keeps deferred leaf debt pending when raw backlog still exceeds the trigger", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      evaluateIncrementalCompaction: (params: unknown) => Promise<unknown>;
    };
    const sessionId = "maintain-deferred-compaction-still-needed";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "leaf-trigger",
      tokenBudget: 4_096,
      currentTokenCount: 1_024,
    });

    vi.spyOn(privateEngine, "evaluateIncrementalCompaction").mockResolvedValue({
      shouldCompact: false,
      reason: "hot-cache-budget-headroom",
      maxPasses: 1,
      allowCondensedPasses: false,
      activityBand: "high",
      leafChunkTokens: 40_000,
      fallbackLeafChunkTokens: [40_000, 30_000, 20_000],
      rawTokensOutsideTail: 55_000,
      threshold: 40_000,
      cacheState: "hot",
    });

    const maintenanceResult = await engine.maintain({
      sessionId,
      sessionFile: createSessionFilePath("maintain-deferred-compaction-still-needed"),
      runtimeContext: {
        allowDeferredCompactionExecution: true,
      },
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(maintenance).not.toBeNull();
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.running).toBe(false);
    expect(maintenanceResult.changed).toBe(false);
    expect(maintenanceResult.reason).toBe("deferred compaction still needed");
  });

  it("maintain() keeps deferred prompt-mutating debt pending while Anthropic cache is still hot", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      evaluateIncrementalCompaction: (params: unknown) => Promise<unknown>;
    };
    const sessionId = "maintain-deferred-compaction-hot-cache";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "leaf-trigger",
      tokenBudget: 4_096,
      currentTokenCount: 42,
    });
    await engine.getCompactionTelemetryStore().upsertConversationCompactionTelemetry({
      conversationId: conversation.conversationId,
      cacheState: "cold",
      retention: "long",
      lastCacheTouchAt: new Date(),
      provider: "anthropic",
      model: "claude-opus-4-6",
    });

    const evaluateIncrementalCompactionSpy = vi.spyOn(privateEngine, "evaluateIncrementalCompaction");

    const maintenanceResult = await engine.maintain({
      sessionId,
      sessionFile: createSessionFilePath("maintain-deferred-compaction-hot-cache-maintain"),
      runtimeContext: {
        allowDeferredCompactionExecution: true,
      },
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.running).toBe(false);
    expect(evaluateIncrementalCompactionSpy).not.toHaveBeenCalled();
    expect(maintenanceResult.changed).toBe(false);
  });

  it("maintain() treats a recent Anthropic API call as a hot-cache touch when explicit cache telemetry is absent", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      evaluateIncrementalCompaction: (params: unknown) => Promise<unknown>;
    };
    const sessionId = "maintain-deferred-compaction-recent-api-call";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "leaf-trigger",
      tokenBudget: 4_096,
      currentTokenCount: 42,
    });
    await engine.getCompactionTelemetryStore().upsertConversationCompactionTelemetry({
      conversationId: conversation.conversationId,
      cacheState: "unknown",
      retention: "short",
      lastApiCallAt: new Date(),
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });

    const evaluateIncrementalCompactionSpy = vi.spyOn(privateEngine, "evaluateIncrementalCompaction");

    const maintenanceResult = await engine.maintain({
      sessionId,
      sessionFile: createSessionFilePath("maintain-deferred-compaction-recent-api-call"),
      runtimeContext: {
        allowDeferredCompactionExecution: true,
      },
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.running).toBe(false);
    expect(evaluateIncrementalCompactionSpy).not.toHaveBeenCalled();
    expect(maintenanceResult.changed).toBe(false);
  });

  it("maintain() keeps deferred leaf debt pending when compaction hits an auth failure", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      evaluateIncrementalCompaction: (params: unknown) => Promise<unknown>;
      compaction: {
        compactLeaf: (input: unknown) => Promise<unknown>;
      };
    };
    const sessionId = "maintain-deferred-compaction-auth-failure";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "leaf-trigger",
      tokenBudget: 4_096,
      currentTokenCount: 1_024,
    });

    vi.spyOn(privateEngine, "evaluateIncrementalCompaction").mockResolvedValue({
      shouldCompact: true,
      activityBand: "medium",
      leafChunkTokens: 40_000,
      fallbackLeafChunkTokens: [40_000, 30_000, 20_000],
      maxPasses: 1,
      allowCondensedPasses: false,
      reason: "forced-for-test",
    });
    vi.spyOn(privateEngine.compaction, "compactLeaf").mockResolvedValue({
      actionTaken: false,
      authFailure: true,
      tokensBefore: 1_024,
      tokensAfter: 1_024,
      condensed: false,
    });

    const maintenanceResult = await engine.maintain({
      sessionId,
      sessionFile: createSessionFilePath("maintain-deferred-compaction-auth-failure-maintain"),
      runtimeContext: {
        allowDeferredCompactionExecution: true,
      },
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(maintenance).not.toBeNull();
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.running).toBe(false);
    expect(maintenance?.lastFailureSummary).toBe("provider auth failure");
    expect(maintenanceResult.changed).toBe(false);
    expect(maintenanceResult.reason).toBe("provider auth failure");
  });

  it("assemble() consumes deferred Anthropic debt once the prompt cache is stale", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      evaluateIncrementalCompaction: (params: unknown) => Promise<unknown>;
    };
    const sessionId = "assemble-deferred-compaction-stale-cache";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "leaf-trigger",
      tokenBudget: 4_096,
      currentTokenCount: 42,
    });
    await engine.getCompactionTelemetryStore().upsertConversationCompactionTelemetry({
      conversationId: conversation.conversationId,
      cacheState: "cold",
      retention: "short",
      lastCacheTouchAt: new Date(Date.now() - 10 * 60 * 1000),
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    vi.spyOn(privateEngine, "evaluateIncrementalCompaction").mockResolvedValue({
      shouldCompact: false,
      reason: "deferred compaction no longer needed",
      maxPasses: 1,
      allowCondensedPasses: false,
      activityBand: "low",
      leafChunkTokens: 20_000,
      fallbackLeafChunkTokens: [20_000, 15_000, 10_000],
      rawTokensOutsideTail: 0,
      threshold: 20_000,
      cacheState: "cold",
    });

    const assembleResult = await engine.assemble({
      sessionId,
      messages: [makeMessage({ role: "user", content: "hello" })],
      tokenBudget: 4_096,
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(maintenance?.pending).toBe(false);
    expect(maintenance?.running).toBe(false);
    expect(assembleResult.messages).toHaveLength(1);
  });

  it("assemble() keeps deferred leaf debt pending while a hot-cache recheck still exceeds the trigger", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      evaluateIncrementalCompaction: (params: unknown) => Promise<unknown>;
    };
    const sessionId = "assemble-deferred-compaction-still-needed";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "leaf-trigger",
      tokenBudget: 4_096,
      currentTokenCount: 1_024,
    });
    vi.spyOn(privateEngine, "evaluateIncrementalCompaction").mockResolvedValue({
      shouldCompact: false,
      reason: "hot-cache-budget-headroom",
      maxPasses: 1,
      allowCondensedPasses: false,
      activityBand: "high",
      leafChunkTokens: 40_000,
      fallbackLeafChunkTokens: [40_000, 30_000, 20_000],
      rawTokensOutsideTail: 55_000,
      threshold: 40_000,
      cacheState: "hot",
    });

    const assembleResult = await engine.assemble({
      sessionId,
      messages: [makeMessage({ role: "user", content: "hello" })],
      tokenBudget: 4_096,
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.running).toBe(false);
    expect(assembleResult.messages).toHaveLength(1);
  });

  it("assemble() still executes deferred Anthropic leaf debt after TTL expiry when cache smoothing remains effectively hot", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      evaluateIncrementalCompaction: (params: unknown) => Promise<unknown>;
      executeLeafCompactionCore: (params: unknown) => Promise<unknown>;
    };
    const sessionId = "assemble-deferred-compaction-stale-ttl-hysteresis";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "leaf-trigger",
      tokenBudget: 4_096,
      currentTokenCount: 42,
    });
    await engine.getCompactionTelemetryStore().upsertConversationCompactionTelemetry({
      conversationId: conversation.conversationId,
      cacheState: "cold",
      retention: "short",
      lastCacheTouchAt: new Date(Date.now() - 10 * 60 * 1000),
      lastObservedCacheHitAt: new Date(),
      consecutiveColdObservations: 1,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    vi.spyOn(privateEngine, "evaluateIncrementalCompaction").mockResolvedValue({
      shouldCompact: false,
      reason: "hot-cache-budget-headroom",
      maxPasses: 1,
      allowCondensedPasses: false,
      activityBand: "medium",
      leafChunkTokens: 40_000,
      fallbackLeafChunkTokens: [40_000, 30_000, 20_000],
      rawTokensOutsideTail: 55_000,
      threshold: 40_000,
      cacheState: "hot",
    });
    const executeLeafCompactionCoreSpy = vi.spyOn(
      privateEngine,
      "executeLeafCompactionCore",
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
    expect(executeLeafCompactionCoreSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: conversation.conversationId,
        sessionId,
        tokenBudget: 4_096,
        maxPasses: 2,
        leafChunkTokens: 40_000,
        allowCondensedPasses: true,
      }),
    );
    expect(maintenance?.pending).toBe(false);
    expect(maintenance?.running).toBe(false);
    expect(assembleResult.messages).toHaveLength(1);
  });

  it("assemble() uses cold-cache catch-up passes when stale Anthropic debt overrides hot-cache smoothing", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      evaluateIncrementalCompaction: (params: unknown) => Promise<unknown>;
      compaction: {
        compactLeaf: (input: {
          allowCondensedPasses?: boolean;
        }) => Promise<unknown>;
      };
    };
    const sessionId = "assemble-deferred-compaction-stale-ttl-catchup";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "leaf-trigger",
      tokenBudget: 4_096,
      currentTokenCount: 42,
    });
    await engine.getCompactionTelemetryStore().upsertConversationCompactionTelemetry({
      conversationId: conversation.conversationId,
      cacheState: "cold",
      retention: "short",
      lastCacheTouchAt: new Date(Date.now() - 10 * 60 * 1000),
      lastObservedCacheHitAt: new Date(),
      consecutiveColdObservations: 1,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    vi.spyOn(privateEngine, "evaluateIncrementalCompaction").mockResolvedValue({
      shouldCompact: false,
      reason: "hot-cache-budget-headroom",
      maxPasses: 1,
      allowCondensedPasses: false,
      activityBand: "medium",
      leafChunkTokens: 40_000,
      fallbackLeafChunkTokens: [40_000, 30_000, 20_000],
      rawTokensOutsideTail: 55_000,
      threshold: 40_000,
      cacheState: "hot",
    });
    const compactLeafSpy = vi
      .spyOn(privateEngine.compaction, "compactLeaf")
      .mockResolvedValueOnce({
        actionTaken: true,
        tokensBefore: 900,
        tokensAfter: 700,
        condensed: false,
      })
      .mockResolvedValueOnce({
        actionTaken: false,
        tokensBefore: 700,
        tokensAfter: 700,
        condensed: false,
      });

    const assembleResult = await engine.assemble({
      sessionId,
      messages: [makeMessage({ role: "user", content: "hello" })],
      tokenBudget: 4_096,
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(compactLeafSpy).toHaveBeenCalledTimes(2);
    expect(compactLeafSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        allowCondensedPasses: true,
      }),
    );
    expect(maintenance?.pending).toBe(false);
    expect(maintenance?.running).toBe(false);
    expect(assembleResult.messages).toHaveLength(1);
  });

  it("assemble() waits for the session queue before consuming deferred debt", async () => {
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
      reason: "leaf-trigger",
      tokenBudget: 4_096,
      currentTokenCount: 42,
    });
    await engine.getCompactionTelemetryStore().upsertConversationCompactionTelemetry({
      conversationId: conversation.conversationId,
      cacheState: "cold",
      retention: "short",
      lastCacheTouchAt: new Date(Date.now() - 10 * 60 * 1000),
      provider: "anthropic",
      model: "claude-sonnet-4-6",
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
    expect(assembleSettled).toBe(false);

    releaseQueue();
    await heldQueue;
    const assembleResult = await assemblePromise;

    expect(consumeSpy).toHaveBeenCalledTimes(1);
    expect(assembleResult.messages).toHaveLength(1);
  });

  it("maintain() re-evaluates deferred debt with the stricter current token budget", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      evaluateIncrementalCompaction: (params: unknown) => Promise<unknown>;
    };
    const sessionId = "maintain-deferred-compaction-current-budget";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "leaf-trigger",
      tokenBudget: 4_096,
      currentTokenCount: 1_024,
    });

    const evaluateIncrementalCompactionSpy = vi.spyOn(
      privateEngine,
      "evaluateIncrementalCompaction",
    ).mockResolvedValue({
      shouldCompact: false,
      reason: "deferred compaction no longer needed",
      maxPasses: 1,
      allowCondensedPasses: false,
      activityBand: "low",
      leafChunkTokens: 20_000,
      fallbackLeafChunkTokens: [20_000, 15_000, 10_000],
      rawTokensOutsideTail: 0,
      threshold: 20_000,
      cacheState: "unknown",
    });

    await engine.maintain({
      sessionId,
      sessionFile: createSessionFilePath("maintain-deferred-compaction-current-budget"),
      runtimeContext: {
        allowDeferredCompactionExecution: true,
        tokenBudget: 2_048,
      },
    });

    expect(evaluateIncrementalCompactionSpy).toHaveBeenCalledWith(
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

  it("evaluateIncrementalCompaction skips hot-cache maintenance when real budget headroom is comfortable", async () => {
    const infoLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: {
          info: infoLog,
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
      },
    );
    const sessionId = "incremental-hot-cache-budget-headroom";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number, leafChunkTokens?: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
      evaluateIncrementalCompaction: (params: {
        conversationId: number;
        tokenBudget: number;
        currentTokenCount?: number;
      }) => Promise<{
        shouldCompact: boolean;
        cacheState: string;
        leafChunkTokens: number;
      }>;
    };

    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "seed" }),
    });
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    await engine.getCompactionTelemetryStore().upsertConversationCompactionTelemetry({
      conversationId: conversation!.conversationId,
      cacheState: "hot",
      lastObservedCacheRead: 2_048,
      turnsSinceLeafCompaction: 1,
      tokensAccumulatedSinceLeafCompaction: 50_000,
      lastActivityBand: "low",
    });

    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockImplementation(
      async (_conversationId: number, leafChunkTokens?: number) => ({
        shouldCompact: true,
        rawTokensOutsideTail: 50_000,
        threshold: leafChunkTokens ?? 20_000,
      }),
    );
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "none",
      currentTokens: 10_000,
      threshold: 75_000,
    });

    const decision = await privateEngine.evaluateIncrementalCompaction({
      conversationId: conversation!.conversationId,
      tokenBudget: 100_000,
      currentTokenCount: 10_000,
    });

    expect(decision.shouldCompact).toBe(false);
    expect(decision.cacheState).toBe("hot");
    expect(decision.leafChunkTokens).toBe(40_000);
    expect(infoLog).toHaveBeenCalledWith(
      expect.stringContaining("reason=hot-cache-budget-headroom"),
    );
  });

  it("evaluateIncrementalCompaction scales budget-trigger passes by prompt overage", async () => {
    const infoLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: {
          info: infoLog,
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
      },
    );
    const sessionId = "incremental-budget-trigger-catchup";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number, leafChunkTokens?: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
      evaluateIncrementalCompaction: (params: {
        conversationId: number;
        tokenBudget: number;
        currentTokenCount?: number;
      }) => Promise<{
        shouldCompact: boolean;
        cacheState: string;
        leafChunkTokens: number;
        maxPasses: number;
        allowCondensedPasses: boolean;
      }>;
    };

    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "seed" }),
    });
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    await engine.getCompactionTelemetryStore().upsertConversationCompactionTelemetry({
      conversationId: conversation!.conversationId,
      cacheState: "hot",
      lastObservedCacheRead: 2_048,
      turnsSinceLeafCompaction: 1,
      tokensAccumulatedSinceLeafCompaction: 90_000,
      lastActivityBand: "high",
    });

    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockImplementation(
      async (_conversationId: number, leafChunkTokens?: number) => ({
        shouldCompact: true,
        rawTokensOutsideTail: 90_000,
        threshold: leafChunkTokens ?? 20_000,
      }),
    );
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 205_000,
      threshold: 75_000,
    });

    const decision = await privateEngine.evaluateIncrementalCompaction({
      conversationId: conversation!.conversationId,
      tokenBudget: 100_000,
      currentTokenCount: 205_000,
    });

    expect(decision.shouldCompact).toBe(true);
    expect(decision.cacheState).toBe("hot");
    expect(decision.leafChunkTokens).toBe(40_000);
    expect(decision.maxPasses).toBe(4);
    expect(decision.allowCondensedPasses).toBe(true);
    expect(infoLog).toHaveBeenCalledWith(
      expect.stringContaining("reason=budget-trigger"),
    );
    expect(infoLog).toHaveBeenCalledWith(
      expect.stringContaining("maxPasses=4"),
    );
  });

  it("evaluateIncrementalCompaction keeps hot-cache hysteresis for a recent cache hit", async () => {
    const infoLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: {
          info: infoLog,
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
      },
    );
    const sessionId = "incremental-hot-cache-hysteresis";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number, leafChunkTokens?: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
      evaluateIncrementalCompaction: (params: {
        conversationId: number;
        tokenBudget: number;
        currentTokenCount?: number;
      }) => Promise<{
        shouldCompact: boolean;
        cacheState: string;
      }>;
    };

    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "seed" }),
    });
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    await engine.getCompactionTelemetryStore().upsertConversationCompactionTelemetry({
      conversationId: conversation!.conversationId,
      cacheState: "cold",
      lastObservedCacheRead: 4_096,
      lastObservedCacheHitAt: new Date(),
      consecutiveColdObservations: 1,
      turnsSinceLeafCompaction: 1,
      tokensAccumulatedSinceLeafCompaction: 55_000,
      lastActivityBand: "low",
    });

    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockImplementation(
      async (_conversationId: number, leafChunkTokens?: number) => ({
        shouldCompact: true,
        rawTokensOutsideTail: 55_000,
        threshold: leafChunkTokens ?? 20_000,
      }),
    );
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "none",
      currentTokens: 12_000,
      threshold: 75_000,
    });

    const decision = await privateEngine.evaluateIncrementalCompaction({
      conversationId: conversation!.conversationId,
      tokenBudget: 100_000,
      currentTokenCount: 12_000,
    });

    expect(decision.shouldCompact).toBe(false);
    expect(decision.cacheState).toBe("hot");
    expect(infoLog).toHaveBeenCalledWith(
      expect.stringContaining("reason=hot-cache-budget-headroom"),
    );
  });

  it("evaluateIncrementalCompaction treats a single cold reading as non-authoritative when the session was previously hot", async () => {
    const infoLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: {
          info: infoLog,
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
      },
    );
    const sessionId = "incremental-single-cold-non-authoritative";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number, leafChunkTokens?: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
      evaluateIncrementalCompaction: (params: {
        conversationId: number;
        tokenBudget: number;
        currentTokenCount?: number;
      }) => Promise<{
        shouldCompact: boolean;
        cacheState: string;
      }>;
    };

    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "seed" }),
    });
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    await engine.getCompactionTelemetryStore().upsertConversationCompactionTelemetry({
      conversationId: conversation!.conversationId,
      cacheState: "cold",
      lastObservedCacheRead: 8_192,
      lastObservedCacheHitAt: new Date(),
      consecutiveColdObservations: 1,
      turnsSinceLeafCompaction: 9,
      tokensAccumulatedSinceLeafCompaction: 55_000,
      lastActivityBand: "low",
    });

    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockImplementation(
      async (_conversationId: number, leafChunkTokens?: number) => ({
        shouldCompact: true,
        rawTokensOutsideTail: 55_000,
        threshold: leafChunkTokens ?? 20_000,
      }),
    );
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "none",
      currentTokens: 12_000,
      threshold: 75_000,
    });

    const decision = await privateEngine.evaluateIncrementalCompaction({
      conversationId: conversation!.conversationId,
      tokenBudget: 100_000,
      currentTokenCount: 12_000,
    });

    expect(decision.shouldCompact).toBe(false);
    expect(decision.cacheState).toBe("hot");
    expect(infoLog).toHaveBeenCalledWith(
      expect.stringContaining("reason=hot-cache-budget-headroom"),
    );
  });

  it("evaluateIncrementalCompaction eventually treats repeated cold readings as authoritative", async () => {
    const infoLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: {
          info: infoLog,
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
      },
    );
    const sessionId = "incremental-authoritative-cold-streak";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number, leafChunkTokens?: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
      evaluateIncrementalCompaction: (params: {
        conversationId: number;
        tokenBudget: number;
        currentTokenCount?: number;
      }) => Promise<{
        shouldCompact: boolean;
        cacheState: string;
        maxPasses: number;
      }>;
    };

    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "seed" }),
    });
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    await engine.getCompactionTelemetryStore().upsertConversationCompactionTelemetry({
      conversationId: conversation!.conversationId,
      cacheState: "cold",
      lastObservedCacheRead: 8_192,
      lastObservedCacheHitAt: new Date(Date.now() - 60_000),
      consecutiveColdObservations: 3,
      turnsSinceLeafCompaction: 9,
      tokensAccumulatedSinceLeafCompaction: 55_000,
      lastActivityBand: "low",
    });

    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockImplementation(
      async (_conversationId: number, leafChunkTokens?: number) => ({
        shouldCompact: true,
        rawTokensOutsideTail: 55_000,
        threshold: leafChunkTokens ?? 20_000,
      }),
    );
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "none",
      currentTokens: 12_000,
      threshold: 75_000,
    });

    const decision = await privateEngine.evaluateIncrementalCompaction({
      conversationId: conversation!.conversationId,
      tokenBudget: 100_000,
      currentTokenCount: 12_000,
    });

    expect(decision.shouldCompact).toBe(true);
    expect(decision.cacheState).toBe("cold");
    expect(decision.maxPasses).toBe(2);
    expect(infoLog).toHaveBeenCalledWith(
      expect.stringContaining("reason=cold-cache-catchup"),
    );
  });

  it("evaluateIncrementalCompaction keeps hot-cache protection for unknown observations without an explicit break", async () => {
    const infoLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: {
          info: infoLog,
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
      },
    );
    const sessionId = "incremental-unknown-cache-non-authoritative";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number, leafChunkTokens?: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
      evaluateIncrementalCompaction: (params: {
        conversationId: number;
        tokenBudget: number;
        currentTokenCount?: number;
      }) => Promise<{
        shouldCompact: boolean;
        cacheState: string;
      }>;
    };

    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "seed" }),
    });
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    await engine.getCompactionTelemetryStore().upsertConversationCompactionTelemetry({
      conversationId: conversation!.conversationId,
      cacheState: "unknown",
      lastObservedCacheRead: 8_192,
      lastObservedCacheHitAt: new Date(),
      consecutiveColdObservations: 0,
      turnsSinceLeafCompaction: 9,
      tokensAccumulatedSinceLeafCompaction: 55_000,
      lastActivityBand: "low",
    });

    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockImplementation(
      async (_conversationId: number, leafChunkTokens?: number) => ({
        shouldCompact: true,
        rawTokensOutsideTail: 55_000,
        threshold: leafChunkTokens ?? 20_000,
      }),
    );
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "none",
      currentTokens: 12_000,
      threshold: 75_000,
    });

    const decision = await privateEngine.evaluateIncrementalCompaction({
      conversationId: conversation!.conversationId,
      tokenBudget: 100_000,
      currentTokenCount: 12_000,
    });

    expect(decision.shouldCompact).toBe(false);
    expect(decision.cacheState).toBe("hot");
    expect(infoLog).toHaveBeenCalledWith(
      expect.stringContaining("reason=hot-cache-budget-headroom"),
    );
  });

  it("afterTurn allows bounded catch-up passes when prompt cache is cold", async () => {
    const engine = createEngineWithConfig({
      proactiveThresholdCompactionMode: "inline",
    });
    const sessionId = "after-turn-cold-cache-catchup";
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
      shouldCompact: true,
      rawTokensOutsideTail: 20_000,
      threshold: 20_000,
    });
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "none",
      currentTokens: 500,
      threshold: 3_072,
    });
    const executeLeafCompactionCoreSpy = vi.spyOn(
      privateEngine,
      "executeLeafCompactionCore",
    ).mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
      result: {
        tokensBefore: 500,
        tokensAfter: 320,
        details: {
          rounds: 2,
          targetTokens: 4096,
          mode: "leaf",
          maxPasses: 2,
        },
      },
    });
    vi.spyOn(engine, "compact").mockResolvedValue({
      ok: true,
      compacted: false,
      reason: "below threshold",
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-cold-cache-catchup"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
      runtimeContext: {
        promptCache: {
          retention: "long",
          lastCallUsage: {
            cacheRead: 0,
            cacheWrite: 0,
          },
          observation: {
            broke: true,
          },
        },
      },
    });

    await vi.waitFor(() => {
      expect(executeLeafCompactionCoreSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId,
          maxPasses: 2,
        }),
      );
    });
  });

  it("afterTurn increases the working leaf chunk target for busy sessions when dynamic sizing is enabled", async () => {
    const infoLog = vi.fn();
    const engine = createEngineWithDeps(
      {
        proactiveThresholdCompactionMode: "inline",
        dynamicLeafChunkTokens: {
          enabled: true,
          max: 40_000,
        },
      },
      {
        log: {
          info: infoLog,
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
      },
    );
    const sessionId = "after-turn-dynamic-leaf-chunk-high";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number, leafChunkTokens?: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
      executeLeafCompactionCore: (...args: unknown[]) => Promise<unknown>;
    };

    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockImplementation(
      async (_conversationId: number, leafChunkTokens?: number) => ({
        shouldCompact: true,
        rawTokensOutsideTail: 40_000,
        threshold: leafChunkTokens ?? 20_000,
      }),
    );
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "none",
      currentTokens: 500,
      threshold: 3_072,
    });
    const executeLeafCompactionCoreSpy = vi.spyOn(
      privateEngine,
      "executeLeafCompactionCore",
    ).mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });
    vi.spyOn(engine, "compact").mockResolvedValue({
      ok: true,
      compacted: false,
      reason: "below threshold",
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-dynamic-leaf-chunk-high"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 128_000,
    });

    await vi.waitFor(() => {
      expect(executeLeafCompactionCoreSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId,
          leafChunkTokens: 40_000,
          fallbackLeafChunkTokens: [40_000, 30_000, 20_000],
          activityBand: "high",
        }),
      );
    });
    expect(infoLog).toHaveBeenCalledWith(
      expect.stringContaining("activityBand=high"),
    );
    expect(infoLog).toHaveBeenCalledWith(
      expect.stringContaining("preferredLeafChunkTokens=40000"),
    );
  });

  it("afterTurn bumps to the max working leaf chunk when cache-aware compaction is cold", async () => {
    const engine = createEngineWithConfig({
      proactiveThresholdCompactionMode: "inline",
      dynamicLeafChunkTokens: {
        enabled: true,
        max: 40_000,
      },
    });
    const sessionId = "after-turn-dynamic-leaf-chunk-cold-max";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number, leafChunkTokens?: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
      executeLeafCompactionCore: (...args: unknown[]) => Promise<unknown>;
    };

    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "seed" }),
    });
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    await engine.getCompactionTelemetryStore().upsertConversationCompactionTelemetry({
      conversationId: conversation!.conversationId,
      cacheState: "unknown",
      turnsSinceLeafCompaction: 2,
      tokensAccumulatedSinceLeafCompaction: 35_000,
      lastActivityBand: "medium",
    });

    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockImplementation(
      async (_conversationId: number, leafChunkTokens?: number) => ({
        shouldCompact: (leafChunkTokens ?? 20_000) <= 35_000,
        rawTokensOutsideTail: 35_000,
        threshold: leafChunkTokens ?? 20_000,
      }),
    );
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "none",
      currentTokens: 500,
      threshold: 3_072,
    });
    const executeLeafCompactionCoreSpy = vi.spyOn(
      privateEngine,
      "executeLeafCompactionCore",
    ).mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });
    vi.spyOn(engine, "compact").mockResolvedValue({
      ok: true,
      compacted: false,
      reason: "below threshold",
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-dynamic-leaf-chunk-cold-max"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 128_000,
      runtimeContext: {
        promptCache: {
          lastCallUsage: {
            cacheRead: 0,
            cacheWrite: 0,
          },
          observation: {
            broke: true,
          },
        },
      },
    });

    await vi.waitFor(() => {
      expect(executeLeafCompactionCoreSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId,
          leafChunkTokens: 40_000,
          fallbackLeafChunkTokens: [40_000, 30_000, 20_000],
          activityBand: "medium",
        }),
      );
    });
  });

  it("evaluateIncrementalCompaction restricts hot-cache leaf-trigger maintenance to leaf-only passes", async () => {
    const engine = createEngineWithConfig({
      dynamicLeafChunkTokens: {
        enabled: true,
        max: 40_000,
      },
    });
    const sessionId = "after-turn-hot-cache-leaf-only";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number, leafChunkTokens?: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
      evaluateIncrementalCompaction: (params: {
        conversationId: number;
        tokenBudget: number;
        currentTokenCount?: number;
      }) => Promise<{
        shouldCompact: boolean;
        cacheState: string;
        allowCondensedPasses: boolean;
        leafChunkTokens: number;
      }>;
    };

    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "seed" }),
    });
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    await engine.getCompactionTelemetryStore().upsertConversationCompactionTelemetry({
      conversationId: conversation!.conversationId,
      cacheState: "hot",
      lastObservedCacheRead: 8_192,
      lastObservedCacheHitAt: new Date(),
      turnsSinceLeafCompaction: 1,
      tokensAccumulatedSinceLeafCompaction: 170_000,
      lastActivityBand: "medium",
    });

    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockImplementation(
      async (_conversationId: number, leafChunkTokens?: number) => ({
        shouldCompact: true,
        rawTokensOutsideTail: 170_000,
        threshold: leafChunkTokens ?? 20_000,
      }),
    );
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "none",
      currentTokens: 95_000,
      threshold: 75_000,
    });

    const decision = await privateEngine.evaluateIncrementalCompaction({
      conversationId: conversation!.conversationId,
      tokenBudget: 100_000,
      currentTokenCount: 95_000,
    });

    expect(decision.shouldCompact).toBe(true);
    expect(decision.cacheState).toBe("hot");
    expect(decision.leafChunkTokens).toBe(40_000);
    expect(decision.allowCondensedPasses).toBe(false);
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
    const compactLeafAsyncSpy = vi.spyOn(engine, "compactLeafAsync");
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
    expect(compactLeafAsyncSpy).not.toHaveBeenCalled();
    expect(compactSpy).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(
      "[lcm] afterTurn: ingest failed, skipping compaction: ingest exploded",
    );
  });

  it("afterTurn prunes heartbeat-shaped ACK turns before compaction even without the heartbeat flag", async () => {
    const infoLog = vi.fn();
    const engine = createEngineWithDepsOverrides({
      log: {
        info: infoLog,
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    });
    const sessionId = "after-turn-heartbeat-prune";
    const sessionKey = "agent:main:test:after-turn-heartbeat-prune";

    const evaluateLeafTriggerSpy = vi.spyOn(engine, "evaluateLeafTrigger");
    const compactLeafAsyncSpy = vi.spyOn(engine, "compactLeafAsync");
    const compactSpy = vi.spyOn(engine, "compact");
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile: createSessionFilePath("after-turn-heartbeat-prune"),
      messages: [
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
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored).toHaveLength(0);
    expect(evaluateLeafTriggerSpy).not.toHaveBeenCalled();
    expect(compactLeafAsyncSpy).not.toHaveBeenCalled();
    expect(compactSpy).not.toHaveBeenCalled();
    expect(infoLog).toHaveBeenCalledWith(
      expect.stringContaining(
        `heartbeat ack messages for conversation=${conversation!.conversationId} session=${sessionId} sessionKey=${sessionKey}`,
      ),
    );
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
  it("does not append synthetic system messages for compaction passes", async () => {
    const infoLog = vi.fn();
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
            debug: vi.fn(),
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
    const result = await engine.compactLeafAsync({
      sessionId,
      sessionFile: createSessionFilePath("compact-leaf-no-telemetry"),
      tokenBudget: 4096,
      force: true,
      legacyParams: {
        summarize: async () => "short summary",
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

  it("compactLeafAsync can perform multiple bounded catch-up passes", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      compaction: {
        compactLeaf: (input: unknown) => Promise<unknown>;
      };
    };
    const sessionId = "compact-leaf-catchup";

    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "seed" }),
    });

    const compactLeafSpy = vi
      .spyOn(privateEngine.compaction, "compactLeaf")
      .mockResolvedValueOnce({
        actionTaken: true,
        tokensBefore: 900,
        tokensAfter: 700,
        condensed: false,
      })
      .mockResolvedValueOnce({
        actionTaken: true,
        tokensBefore: 700,
        tokensAfter: 520,
        condensed: false,
      })
      .mockResolvedValueOnce({
        actionTaken: false,
        tokensBefore: 520,
        tokensAfter: 520,
        condensed: false,
      });

    const result = await engine.compactLeafAsync({
      sessionId,
      sessionFile: createSessionFilePath("compact-leaf-catchup"),
      tokenBudget: 4096,
      maxPasses: 2,
      legacyParams: {
        summarize: async () => "short summary",
      },
    });

    expect(result.compacted).toBe(true);
    expect(result.result?.details).toEqual(
      expect.objectContaining({
        rounds: 2,
        maxPasses: 2,
      }),
    );
    expect(compactLeafSpy).toHaveBeenCalledTimes(2);
  });

  it("compactLeafAsync logs cache-aware start details at info", async () => {
    const infoLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: {
          info: infoLog,
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
        },
      },
    );
    const privateEngine = engine as unknown as {
      compaction: {
        compactLeaf: (input: { leafChunkTokens?: number }) => Promise<unknown>;
      };
    };
    const sessionId = "compact-leaf-start-log-info";

    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "seed" }),
    });

    vi.spyOn(privateEngine.compaction, "compactLeaf").mockResolvedValue({
      actionTaken: true,
      tokensBefore: 900,
      tokensAfter: 520,
      condensed: false,
    });

    const result = await engine.compactLeafAsync({
      sessionId,
      sessionFile: createSessionFilePath("compact-leaf-start-log-info"),
      tokenBudget: 4096,
      maxPasses: 2,
      leafChunkTokens: 40_000,
      fallbackLeafChunkTokens: [40_000, 30_000, 20_000],
      activityBand: "medium",
      legacyParams: {
        summarize: async () => "short summary",
      },
    });

    expect(result.compacted).toBe(true);
    expect(infoLog).toHaveBeenCalledWith(
      expect.stringContaining("[lcm] compactLeafAsync start:"),
    );
    expect(infoLog).toHaveBeenCalledWith(
      expect.stringContaining("leafChunkTokens=40000"),
    );
    expect(infoLog).toHaveBeenCalledWith(
      expect.stringContaining("fallbackLeafChunkTokens=40000,30000,20000"),
    );
    expect(infoLog).toHaveBeenCalledWith(
      expect.stringContaining("activityBand=medium"),
    );
  });

  it("compactLeafAsync retries with a smaller leaf chunk target after a provider token-limit error", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      compaction: {
        compactLeaf: (input: { leafChunkTokens?: number }) => Promise<unknown>;
      };
    };
    const sessionId = "compact-leaf-retry-smaller-chunk";

    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "seed" }),
    });

    const compactLeafSpy = vi
      .spyOn(privateEngine.compaction, "compactLeaf")
      .mockRejectedValueOnce(new Error("context window exceeded for this request"))
      .mockResolvedValueOnce({
        actionTaken: true,
        tokensBefore: 900,
        tokensAfter: 520,
        condensed: false,
      });

    const result = await engine.compactLeafAsync({
      sessionId,
      sessionFile: createSessionFilePath("compact-leaf-retry-smaller-chunk"),
      tokenBudget: 4096,
      leafChunkTokens: 40_000,
      fallbackLeafChunkTokens: [40_000, 30_000, 20_000],
      legacyParams: {
        summarize: async () => "short summary",
      },
    });

    expect(result.compacted).toBe(true);
    expect(compactLeafSpy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ leafChunkTokens: 40_000 }),
    );
    expect(compactLeafSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ leafChunkTokens: 30_000 }),
    );
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

  it("supports openai-codex large-file summarization without direct-credential retry", async () => {
    const completeSpy = vi.fn(async ({ apiKey }: { apiKey?: string }) => ({
      content: apiKey === "scoped-token"
        ? []
        : [{ type: "text", text: "codex large-file summary" }],
      ...(apiKey === "scoped-token"
        ? {
            error: {
              kind: "provider_auth",
              statusCode: 401,
              message: "Missing required scope: model.request",
            },
          }
        : {}),
    }));
    const getApiKeySpy = vi.fn(async () => "scoped-token");
    const engine = createEngineWithDeps(
      {
        largeFileSummaryProvider: "openai-codex",
        largeFileSummaryModel: "gpt-5.4",
      },
      {
        complete: completeSpy,
        getApiKey: getApiKeySpy,
        isRuntimeManagedAuthProvider: () => true,
      },
    );
    const privateEngine = engine as unknown as {
      resolveLargeFileTextSummarizer: () => Promise<((prompt: string) => Promise<string | null>) | undefined>;
    };

    const summarizeText = await privateEngine.resolveLargeFileTextSummarizer();
    expect(summarizeText).toBeTypeOf("function");

    const summary = await summarizeText!("Large file prompt");
    expect(summary).toBeNull();
    expect(getApiKeySpy).toHaveBeenCalledTimes(1);
    expect(completeSpy).toHaveBeenCalledTimes(1);
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
        tokensAfter: 4500,
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

  it("caps token budget in compactLeafAsync when maxAssemblyTokenBudget is set", async () => {
    const engine = createEngineWithConfig({ maxAssemblyTokenBudget: 4096 });
    const privateEngine = engine as unknown as {
      compaction: {
        compactLeaf: (input: unknown) => Promise<unknown>;
      };
    };

    const compactLeafSpy = vi
      .spyOn(privateEngine.compaction, "compactLeaf")
      .mockResolvedValue({
        actionTaken: true,
        tokensBefore: 6000,
        tokensAfter: 3500,
        condensed: false,
      });

    await engine.ingest({
      sessionId: "compact-leaf-budget-cap",
      message: { role: "user", content: "trigger compact leaf budget cap" } as AgentMessage,
    });

    const result = await engine.compactLeafAsync({
      sessionId: "compact-leaf-budget-cap",
      sessionFile: "/tmp/session.jsonl",
      tokenBudget: 200_000,
      legacyParams: {
        provider: "anthropic",
        model: "claude-opus-4-5",
      },
    });

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(compactLeafSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: expect.any(Number),
        tokenBudget: 4096,
      }),
    );
  });
});
