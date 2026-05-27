import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LcmConfig } from "../src/db/config.js";
import { closeLcmConnection, createLcmDatabaseConnection } from "../src/db/connection.js";
import { LcmContextEngine } from "../src/engine.js";
import {
  getRuntimeExpansionAuthManager,
  resetDelegatedExpansionGrantsForTests,
  resolveDelegatedExpansionGrantId,
} from "../src/expansion-auth.js";
import type { LcmDependencies } from "../src/types.js";

const tempDirs: string[] = [];
const dbs: ReturnType<typeof createLcmDatabaseConnection>[] = [];

function createTestConfig(databasePath: string, overrides: Partial<LcmConfig> = {}): LcmConfig {
  const filesDir = join(databasePath, "..", "lcm-files");
  return {
    enabled: true,
    databasePath,
    largeFilesDir: filesDir,
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
      criticalBudgetPressureRatio: 0.90,
    },
    dynamicLeafChunkTokens: {
      enabled: true,
      max: 40_000,
    },
    ...overrides,
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

function createTestDeps(config: LcmConfig, overrides?: Partial<LcmDependencies>): LcmDependencies {
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
        if (message.role === "assistant" && typeof message.content === "string") {
          return message.content;
        }
      }
      return undefined;
    },
    resolveAgentDir: () => process.env.HOME ?? tmpdir(),
    resolveSessionIdFromSessionKey: async () => undefined,
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

function createEngine(
  configOverrides: Partial<LcmConfig> = {},
  depOverrides?: Partial<LcmDependencies>,
): LcmContextEngine {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
  tempDirs.push(tempDir);
  const config = createTestConfig(join(tempDir, "lcm.db"), configOverrides);
  const db = createLcmDatabaseConnection(config.databasePath);
  dbs.push(db);
  return new LcmContextEngine(createTestDeps(config, depOverrides), db);
}

function makeMessage(params: { role?: string; content: unknown }): AgentMessage {
  return {
    role: (params.role ?? "assistant") as AgentMessage["role"],
    content: params.content,
    timestamp: Date.now(),
  } as AgentMessage;
}

afterEach(() => {
  for (const db of dbs.splice(0)) {
    closeLcmConnection(db);
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  resetDelegatedExpansionGrantsForTests();
});

describe("LcmContextEngine runtime lifecycle", () => {
  it("reports the registered lossless-claw engine id and capabilities", () => {
    const engine = createEngine();

    expect(engine.info).toMatchObject({
      id: "lossless-claw",
      ownsCompaction: true,
      turnMaintenanceMode: "background",
    });
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

  it("bootstraps from runtime messages without a transcript path", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const sessionKey = "agent:main:telegram:group:123:topic:456";

    const result = await engine.bootstrap({
      sessionId,
      sessionKey,
      messages: [
        makeMessage({ role: "user", content: "runtime user" }),
        makeMessage({ role: "assistant", content: "runtime assistant" }),
      ],
    });

    expect(result).toEqual({
      bootstrapped: true,
      importedMessages: 2,
      reason: "bootstrapped from runtime messages",
    });
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "runtime user",
      "runtime assistant",
    ]);
  });

  it("skips bootstrap when the host provides no runtime messages", async () => {
    const engine = createEngine();

    await expect(engine.bootstrap({ sessionId: randomUUID(), messages: [] })).resolves.toEqual({
      bootstrapped: false,
      importedMessages: 0,
      reason: "runtime messages unavailable",
    });
  });

  it("ingests runtime messages and assembles persisted context", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();

    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "persisted context" }),
    });

    const assembled = await engine.assemble({
      sessionId,
      messages: [],
      tokenBudget: 1000,
    });
    expect(assembled.messages.map((message) => message.content)).toContain("persisted context");
  });

  it("afterTurn stores only new runtime messages after the prompt boundary", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();

    await engine.afterTurn({
      sessionId,
      prePromptMessageCount: 1,
      messages: [
        makeMessage({ role: "user", content: "prompt" }),
        makeMessage({ role: "assistant", content: "reply" }),
      ],
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual(["reply"]);
  });

  it("deduplicates replayed runtime afterTurn batches by session key", async () => {
    const engine = createEngine();
    const sessionKey = "agent:main:main";

    await engine.afterTurn({
      sessionId: "runtime-1",
      sessionKey,
      prePromptMessageCount: 0,
      messages: [
        makeMessage({ role: "user", content: "first" }),
        makeMessage({ role: "assistant", content: "second" }),
      ],
    });
    await engine.afterTurn({
      sessionId: "runtime-2",
      sessionKey,
      prePromptMessageCount: 0,
      messages: [
        makeMessage({ role: "user", content: "first" }),
        makeMessage({ role: "assistant", content: "second" }),
        makeMessage({ role: "user", content: "third" }),
      ],
    });

    const conversation = await engine.getConversationStore().getConversationBySessionKey(sessionKey);
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual(["first", "second", "third"]);
  });

  it("skips ignored and stateless session keys", async () => {
    const engine = createEngine({
      ignoreSessionPatterns: ["agent:*:cron:**"],
      statelessSessionPatterns: ["agent:*:subagent:**"],
      skipStatelessSessions: true,
    });

    expect(
      await engine.ingest({
        sessionId: "ignored",
        sessionKey: "agent:main:cron:job",
        message: makeMessage({ role: "user", content: "ignored" }),
      }),
    ).toEqual({ ingested: false });
    expect(
      await engine.ingest({
        sessionId: "stateless",
        sessionKey: "agent:main:subagent:worker",
        message: makeMessage({ role: "user", content: "stateless" }),
      }),
    ).toEqual({ ingested: false });
  });

  it("externalizes oversized user files during runtime ingest", async () => {
    const engine = createEngine({ largeFileTokenThreshold: 10 });
    const sessionId = randomUUID();
    const fileText = "large file payload ".repeat(30);

    await engine.ingest({
      sessionId,
      message: makeMessage({
        role: "user",
        content: `<file name="notes.txt">\n${fileText}\n</file>`,
      }),
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored[0]?.content).toContain("[LCM File:");
    const fileId = stored[0]!.content.match(/file_[a-f0-9]{16}/)?.[0];
    expect(fileId).toBeTruthy();
    const file = await engine.getSummaryStore().getLargeFile(fileId!);
    expect(file).not.toBeNull();
    expect(readFileSync(file!.storageUri, "utf8").trim()).toBe(fileText.trim());
  });

  it("prepares and rolls back subagent grants from a parent session key", async () => {
    const engine = createEngine();
    const parentSessionKey = "agent:main:telegram:group:123";
    await engine.ingest({
      sessionId: "parent-runtime",
      sessionKey: parentSessionKey,
      message: makeMessage({ role: "user", content: "parent context" }),
    });

    const childSessionKey = "agent:main:subagent:worker";
    const preparation = await engine.prepareSubagentSpawn({
      parentSessionKey,
      childSessionKey,
    });

    expect(preparation).toBeDefined();
    preparation?.rollback();
    const grantId = resolveDelegatedExpansionGrantId(childSessionKey);
    expect(grantId ? getRuntimeExpansionAuthManager().getGrant(grantId) : null).toBeNull();
  });
});
