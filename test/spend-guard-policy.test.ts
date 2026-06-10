/**
 * Regression tests for summary spend guard policy (lossless-claw-30b.3).
 *
 * Incident: a threshold sweep made real progress (395k -> 288k stored
 * tokens) but hit its per-sweep wall-clock deadline, recorded "compacted
 * but still over target", and opened a 30-minute spend backoff that then
 * blocked emergency drains AND a user-initiated /compact (silent no-op).
 *
 * Policy under test:
 *  - progress-making attempts never open the spend backoff;
 *  - sweeps chain within the operation deadline instead of failing early;
 *  - manual compaction clears an open backoff instead of no-opping.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LcmConfig } from "../src/db/config.js";
import { closeLcmConnection, createLcmDatabaseConnection } from "../src/db/connection.js";
import { LcmContextEngine } from "../src/engine.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import type { LcmDependencies } from "../src/types.js";

const tempDirs: string[] = [];
const engines: LcmContextEngine[] = [];
const dbs: ReturnType<typeof createLcmDatabaseConnection>[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  engines.splice(0);
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
  return {
    enabled: true,
    databasePath,
    largeFilesDir: join(databasePath, "..", "lcm-files"),
    ignoreSessionPatterns: [],
    statelessSessionPatterns: [],
    skipStatelessSessions: true,
    contextThreshold: 0.75,
    freshTailCount: 4,
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
      criticalBudgetPressureRatio: 0.9,
    },
    dynamicLeafChunkTokens: {
      enabled: true,
      max: 40_000,
    },
    stripInjectedContextTags: [],
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
  return { agentId: parts[1] ?? "main", suffix: parts.slice(2).join(":") };
}

type LogMock = { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> };

function createTestDeps(config: LcmConfig, log: LogMock): LcmDependencies {
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
    readLatestAssistantReply: () => undefined,
    resolveAgentDir: () => tmpdir(),
    resolveSessionIdFromSessionKey: async () => undefined,
    resolveSessionTranscriptFile: async () => undefined,
    agentLaneSubagent: "subagent",
    log,
  } as unknown as LcmDependencies;
}

function createEngine(configOverrides?: Partial<LcmConfig>): { engine: LcmContextEngine; log: LogMock } {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-spend-"));
  tempDirs.push(tempDir);
  const config = { ...createTestConfig(join(tempDir, "lcm.db")), ...configOverrides };
  const db = createLcmDatabaseConnection(config.databasePath);
  dbs.push(db);
  const log: LogMock = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const engine = new LcmContextEngine(createTestDeps(config, log), db);
  engines.push(engine);
  return { engine, log };
}

function createSessionFile(name: string): string {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-spend-session-"));
  tempDirs.push(tempDir);
  const file = join(tempDir, `${name}.jsonl`);
  writeFileSync(file, "");
  return file;
}

type PrivateEngine = {
  compaction: {
    evaluate: (...args: unknown[]) => Promise<unknown>;
    compact: (...args: unknown[]) => Promise<unknown>;
    compactUntilUnder: (...args: unknown[]) => Promise<unknown>;
  };
  resolveSessionQueueKey: (sessionId: string, sessionKey?: string) => string;
  resolveSummarySpendScope: (params: { kind: string; scope: string | undefined }) => string;
  openSummarySpendBackoff: (params: { scopeKey: string; reason: string }) => Date;
  getSummarySpendBackoffUntil: (scopeKey: string) => Date | null;
};

function privateEngine(engine: LcmContextEngine): PrivateEngine {
  return engine as unknown as PrivateEngine;
}

function spendScopeKey(engine: LcmContextEngine, sessionId: string, sessionKey?: string): string {
  const internals = privateEngine(engine);
  return internals.resolveSummarySpendScope({
    kind: "compaction",
    scope: internals.resolveSessionQueueKey(sessionId, sessionKey),
  });
}

async function seedConversation(engine: LcmContextEngine, sessionId: string): Promise<void> {
  await engine.ingest({
    sessionId,
    message: {
      role: "user",
      content: "seed message for compaction tests",
      timestamp: Date.now(),
    } as unknown as AgentMessage,
  });
}

const thresholdEvaluation = {
  shouldCompact: true,
  reason: "over threshold",
  currentTokens: 5_000,
  storedTokens: 5_000,
  threshold: 3_000,
};

describe("summary spend guard policy", () => {
  it("manual compaction clears an open spend backoff and proceeds", async () => {
    const { engine, log } = createEngine();
    const sessionId = "spend-manual-bypass";
    await seedConversation(engine, sessionId);

    const internals = privateEngine(engine);
    const scopeKey = spendScopeKey(engine, sessionId);
    internals.openSummarySpendBackoff({ scopeKey, reason: "earlier automatic failure" });
    expect(internals.getSummarySpendBackoffUntil(scopeKey)).not.toBeNull();

    vi.spyOn(internals.compaction, "evaluate").mockResolvedValue(thresholdEvaluation);
    const compactSpy = vi.spyOn(internals.compaction, "compact").mockResolvedValue({
      actionTaken: true,
      tokensBefore: 5_000,
      tokensAfter: 1_000,
    });

    const result = await engine.compact({
      sessionId,
      sessionFile: createSessionFile("spend-manual-bypass"),
      tokenBudget: 4_096,
      runtimeContext: { manualCompaction: true },
    });

    expect(result.reason).not.toBe("summary spend backoff open");
    expect(result.compacted).toBe(true);
    expect(compactSpy).toHaveBeenCalled();
    expect(internals.getSummarySpendBackoffUntil(scopeKey)).toBeNull();
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("manual request cleared summary spend backoff"),
    );
  });

  it("does not open the spend backoff when a deadline-bounded sweep is still progressing", async () => {
    // Tiny chain deadline: the first sweep "runs out of time" while making
    // real progress, exactly like the production deadline-partial.
    const { engine, log } = createEngine({ compactUntilUnderDeadlineMs: 1 });
    const sessionId = "spend-progressing-no-backoff";
    await seedConversation(engine, sessionId);

    const internals = privateEngine(engine);
    vi.spyOn(internals.compaction, "evaluate").mockResolvedValue(thresholdEvaluation);
    vi.spyOn(internals.compaction, "compact").mockImplementation(async () => {
      // Outlast the 1ms chain deadline so the loop deterministically stops
      // after this progress-making round.
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        actionTaken: true,
        tokensBefore: 5_000,
        tokensAfter: 4_200,
      };
    });

    const result = await engine.compact({
      sessionId,
      sessionFile: createSessionFile("spend-progressing"),
      tokenBudget: 4_096,
      currentTokenCount: 5_000,
      compactionTarget: "threshold",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("compacted but still over target");
    expect(internals.getSummarySpendBackoffUntil(spendScopeKey(engine, sessionId))).toBeNull();
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("spend backoff skipped"),
    );
  });

  it("opens the spend backoff when the sweep chain stalls without progress", async () => {
    const { engine } = createEngine();
    const sessionId = "spend-stalled-backoff";
    await seedConversation(engine, sessionId);

    const internals = privateEngine(engine);
    vi.spyOn(internals.compaction, "evaluate").mockResolvedValue(thresholdEvaluation);
    vi.spyOn(internals.compaction, "compact")
      .mockResolvedValueOnce({ actionTaken: true, tokensBefore: 5_000, tokensAfter: 4_500 })
      .mockResolvedValue({ actionTaken: true, tokensBefore: 4_500, tokensAfter: 4_500 });

    const result = await engine.compact({
      sessionId,
      sessionFile: createSessionFile("spend-stalled"),
      tokenBudget: 4_096,
      currentTokenCount: 5_000,
      compactionTarget: "threshold",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("compacted but still over target");
    expect(internals.getSummarySpendBackoffUntil(spendScopeKey(engine, sessionId))).not.toBeNull();
  });

  it("chains threshold sweeps until the target is reached", async () => {
    const { engine } = createEngine();
    const sessionId = "spend-chained-success";
    await seedConversation(engine, sessionId);

    const internals = privateEngine(engine);
    vi.spyOn(internals.compaction, "evaluate").mockResolvedValue(thresholdEvaluation);
    const compactSpy = vi
      .spyOn(internals.compaction, "compact")
      .mockResolvedValueOnce({ actionTaken: true, tokensBefore: 5_000, tokensAfter: 4_500 })
      .mockResolvedValueOnce({ actionTaken: true, tokensBefore: 4_500, tokensAfter: 3_600 })
      .mockResolvedValueOnce({ actionTaken: true, tokensBefore: 3_600, tokensAfter: 2_800 });

    const result = await engine.compact({
      sessionId,
      sessionFile: createSessionFile("spend-chained"),
      tokenBudget: 4_096,
      currentTokenCount: 5_000,
      compactionTarget: "threshold",
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("compacted");
    expect(compactSpy).toHaveBeenCalledTimes(3);
    expect(result.result?.details?.rounds).toBe(3);
    expect(internals.getSummarySpendBackoffUntil(spendScopeKey(engine, sessionId))).toBeNull();
  });

});
