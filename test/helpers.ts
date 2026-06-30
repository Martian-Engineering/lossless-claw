/**
 * Shared test fixtures for LcmContextEngine test suites.
 *
 * Extracted from the former monolithic test/engine.test.ts so that the
 * per-concern engine test files (and other engine-adjacent suites) share a
 * single canonical config/deps/engine factory instead of local copies.
 */
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, vi } from "vitest";
import type { LcmConfig } from "../src/db/config.js";
import { closeLcmConnection, createLcmDatabaseConnection } from "../src/db/connection.js";
import { LcmContextEngine } from "../src/engine.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import { resetDelegatedExpansionGrantsForTests } from "../src/expansion-auth.js";
import type { LcmDependencies } from "../src/types.js";

export const tempDirs: string[] = [];

export function appendSessionMessage(manager: SessionManager, message: AgentMessage): string {
  return manager.appendMessage(
    message as unknown as Parameters<SessionManager["appendMessage"]>[0],
  );
}

export function getEngineConfig(engine: LcmContextEngine): LcmConfig {
  return (engine as unknown as { config: LcmConfig }).config;
}

export function firstCompleteCall(mock: ReturnType<typeof vi.fn>): Parameters<LcmDependencies["complete"]>[0] | undefined {
  return (mock.mock.calls as Array<[Parameters<LcmDependencies["complete"]>[0]]>)[0]?.[0];
}

export function createTestConfig(
  databasePath: string,
  overrides: Partial<LcmConfig> = {},
): LcmConfig {
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
    expansionProvider: "",
    expansionModel: "",
    delegationTimeoutMs: 120_000,
    summaryTimeoutMs: 60_000,
    timezone: "UTC",
    pruneHeartbeatOk: false,
    enableSummaryThinking: true,
    proactiveThresholdCompactionMode: "deferred",
    independentLogFile: {
      enabled: false,
      maxFileBytes: 100 * 1024 * 1024,
    },
    summaryMaxOverageFactor: 3,
    customInstructions: "",
    circuitBreakerThreshold: 5,
    circuitBreakerCooldownMs: 1_800_000,
    replayFloodThresholdExternal: 3,
    replayFloodThresholdInternal: 32,
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
    ...overrides,
  };
}

export function parseAgentSessionKey(sessionKey: string): { agentId: string; suffix: string } | null {
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

export class TestLcmContextEngine extends LcmContextEngine {
}

export function createTestDeps(
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
    readVisibleSessionTranscriptMessageEntries: undefined,
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

export function createEngine(): LcmContextEngine {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
  tempDirs.push(tempDir);
  const config = createTestConfig(join(tempDir, "lcm.db"));
  const db = createLcmDatabaseConnection(config.databasePath);
  return new TestLcmContextEngine(createTestDeps(config), db);
}

export function createEngineWithDepsOverrides(overrides: Partial<LcmDependencies>): LcmContextEngine {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
  tempDirs.push(tempDir);
  const config = createTestConfig(join(tempDir, "lcm.db"));
  const db = createLcmDatabaseConnection(config.databasePath);
  return new TestLcmContextEngine(
    {
      ...createTestDeps(config),
      ...overrides,
    },
    db,
  );
}

export function createEngineWithDepsOverridesAndDb(
  overrides: Partial<LcmDependencies>,
): { engine: LcmContextEngine; db: ReturnType<typeof createLcmDatabaseConnection> } {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
  tempDirs.push(tempDir);
  const config = createTestConfig(join(tempDir, "lcm.db"));
  const db = createLcmDatabaseConnection(config.databasePath);
  return {
    engine: new TestLcmContextEngine(
      {
        ...createTestDeps(config),
        ...overrides,
      },
      db,
    ),
    db,
  };
}

export function createEngineAtDatabasePath(databasePath: string): LcmContextEngine {
  const config = createTestConfig(databasePath);
  const db = createLcmDatabaseConnection(config.databasePath);
  return new TestLcmContextEngine(createTestDeps(config), db);
}

export function createSessionFilePath(name: string): string {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-session-"));
  tempDirs.push(tempDir);
  return join(tempDir, `${name}.jsonl`);
}

export function writeLeafTranscript(
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

export function writeLeafTranscriptMessages(sessionFile: string, messages: AgentMessage[]): void {
  writeFileSync(
    sessionFile,
    messages.map((message) => JSON.stringify({ message })).join("\n") + "\n",
    "utf8",
  );
}

export function createEngineWithConfig(overrides: Partial<LcmConfig>): LcmContextEngine {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
  tempDirs.push(tempDir);
  const config = {
    ...createTestConfig(join(tempDir, "lcm.db")),
    ...overrides,
  };
  const db = createLcmDatabaseConnection(config.databasePath);
  return new TestLcmContextEngine(createTestDeps(config), db);
}

export function createEngineWithDeps(
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
  return new TestLcmContextEngine(createTestDeps(config, depOverrides), db);
}

export async function withTempHome<T>(run: (homeDir: string) => Promise<T>): Promise<T> {
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

export function makeMessage(params: { role?: string; content: unknown }): AgentMessage {
  return {
    role: (params.role ?? "assistant") as AgentMessage["role"],
    content: params.content,
    timestamp: Date.now(),
  } as AgentMessage;
}

export async function seedBacklogContext(
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

export function readSessionMessages(sessionFile: string): AgentMessage[] {
  return SessionManager.open(sessionFile)
    .getBranch()
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message as AgentMessage);
}

export function createBulkySession(sessionFile: string, messageCount: number): AgentMessage[] {
  const sm = SessionManager.open(sessionFile);
  const messages: AgentMessage[] = [];
  for (let index = 0; index < messageCount; index += 1) {
    const message = makeMessage({
      role: index % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `auto rotate payload ${index} ${"x".repeat(160)}` }],
    });
    appendSessionMessage(sm, message);
    messages.push(message);
  }
  return messages;
}

export async function flushImmediate(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

export function corruptSessionFilePreservingObservedStats(sessionFile: string): void {
  const originalStats = statSync(sessionFile);
  writeFileSync(sessionFile, "x".repeat(originalStats.size));
  const restoredMtime = new Date(originalStats.mtimeMs);
  utimesSync(sessionFile, restoredMtime, restoredMtime);
}

export function estimateAssembledPayloadTokens(messages: AgentMessage[]): number {
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

export async function ingestAndReadStoredContent(params: {
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

/**
 * Standard afterEach cleanup for suites built on these fixtures: restores
 * mocks, closes the shared LCM connection, resets delegated expansion grants,
 * and removes any temp directories registered in `tempDirs`.
 */
export function cleanupEngineTestState(): void {
  vi.restoreAllMocks();
  closeLcmConnection();
  resetDelegatedExpansionGrantsForTests();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
