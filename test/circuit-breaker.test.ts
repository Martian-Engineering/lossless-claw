import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LcmContextEngine } from "../src/engine.js";
import { LcmProviderAuthError } from "../src/summarize.js";

function makeAuthError(): LcmProviderAuthError {
  return new LcmProviderAuthError({
    provider: "test",
    model: "test-model",
    failure: { statusCode: 401, message: "auth failed", missingModelRequestScope: false },
  });
}
import type { LcmConfig } from "../src/db/config.js";
import type { LcmDependencies } from "../src/types.js";

function createTestConfig(overrides: Partial<LcmConfig> = {}): LcmConfig {
  return {
    enabled: true,
    databasePath: ":memory:",
    ignoreSessionPatterns: [],
    statelessSessionPatterns: [],
    skipStatelessSessions: false,
    contextThreshold: 0.75,
    freshTailCount: 4,
    leafMinFanout: 4,
    condensedMinFanout: 4,
    condensedMinFanoutHard: 2,
    incrementalMaxDepth: 0,
    leafChunkTokens: 2000,
    leafTargetTokens: 600,
    condensedTargetTokens: 900,
    maxExpandTokens: 10000,
    largeFileTokenThreshold: 5000,
    summaryProvider: "",
    summaryModel: "",
    largeFileSummaryProvider: "",
    largeFileSummaryModel: "",
    expansionProvider: "",
    expansionModel: "",
    autocompactDisabled: false,
    timezone: "UTC",
    pruneHeartbeatOk: false,
    proactiveThresholdCompactionMode: "deferred",
    summaryMaxOverageFactor: 3,
    delegationTimeoutMs: 120000,
    customInstructions: "",
    circuitBreakerThreshold: 3, // Low threshold for testing
    circuitBreakerCooldownMs: 5000, // 5 seconds for testing
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
      max: 4_000,
    },
    ...overrides,
  };
}

function createTestDeps(config: LcmConfig): LcmDependencies {
  return {
    config,
    complete: async () => ({ content: [{ type: "text", text: "Summary" }] }),
    callGateway: async () => undefined,
    resolveModel: (modelRef: string | undefined, providerHint?: string) => ({
      provider: providerHint ?? "test",
      model: modelRef ?? "test-model",
    }),
    parseAgentSessionKey: () => null,
    isSubagentSessionKey: () => false,
    normalizeAgentId: (id?: string) => id ?? "",
    buildSubagentSystemPrompt: () => "",
    readLatestAssistantReply: () => undefined,
    resolveAgentDir: () => "",
    agentLaneSubagent: "subagent",
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    resolveSessionIdFromSessionKey: async () => undefined,
    resolveWorkspaceDir: () => undefined,
  } as unknown as LcmDependencies;
}

function seedRuntimeSession(name: string = randomUUID()) {
  const seededSessionId = randomUUID();
  const seededSessionKey = `agent:test:direct:${name}:${seededSessionId}`;
  const messages = [];
  for (let i = 0; i < 20; i++) {
    messages.push({
      role: "user" as const,
      content: `Message ${i}: ${"x".repeat(500)}`,
    });
    messages.push({
      role: "assistant" as const,
      content: `Response ${i}: ${"y".repeat(500)}`,
    });
  }

  return {
    sessionId: seededSessionId,
    sessionKey: seededSessionKey,
    messages,
  };
}

describe("Circuit Breaker", () => {
  let tmpDir: string;
  let db: DatabaseSync;
  let engine: LcmContextEngine;
    let sessionId: string;
  let sessionKey: string;

  function seedRuntimeSessionForCurrent() {
    const seeded = seedRuntimeSession();
    sessionId = seeded.sessionId;
    sessionKey = seeded.sessionKey;
    return seeded;
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lcm-cb-test-"));
    ({ sessionId, sessionKey } = seedRuntimeSession());

    const config = createTestConfig();
    const deps = createTestDeps(config);
    db = new DatabaseSync(":memory:");
    engine = new LcmContextEngine(deps, db);
  });

  afterEach(() => {
    try { db.close(); } catch {}
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should allow compaction when circuit breaker is closed", async () => {
    // Bootstrap to seed data
    await engine.bootstrap(seedRuntimeSessionForCurrent());
    
    // Compact with a working summarizer
    const result = await engine.compact({
      sessionId,
      sessionKey,
      tokenBudget: 5000,
      force: true,
      legacyParams: {
        summarize: async (text: string) => `Summary: ${text.slice(0, 50)}`,
      },
    });
    
    // Should attempt compaction (not blocked)
    expect(result.reason).not.toBe("circuit breaker open");
  });

  it("should trip after N consecutive auth failures", async () => {
    await engine.bootstrap(seedRuntimeSessionForCurrent());
    
    let callCount = 0;
    const failingSummarizer = async () => {
      callCount++;
      throw makeAuthError();
    };
    
    // Make 3 compaction attempts (threshold = 3)
    for (let i = 0; i < 3; i++) {
      await engine.compact({
        sessionId,
        sessionKey,
        tokenBudget: 5000,
        force: true,
        legacyParams: { summarize: failingSummarizer },
      });
    }
    
    // 4th attempt should be blocked by circuit breaker
    const blocked = await engine.compact({
      sessionId,
      sessionKey,
      tokenBudget: 5000,
      force: true,
      legacyParams: { summarize: failingSummarizer },
    });
    
    expect(blocked.reason).toBe("circuit breaker open");
    expect(blocked.compacted).toBe(false);
  });

  it("should auto-reset after cooldown", async () => {
    await engine.bootstrap(seedRuntimeSessionForCurrent());
    
    const failingSummarizer = async () => {
      throw makeAuthError();
    };
    
    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      await engine.compact({
        sessionId,
        sessionKey,
        tokenBudget: 5000,
        force: true,
        legacyParams: { summarize: failingSummarizer },
      });
    }
    
    // Verify it's blocked
    let result = await engine.compact({
      sessionId,
      sessionKey,
      tokenBudget: 5000,
      force: true,
      legacyParams: { summarize: failingSummarizer },
    });
    expect(result.reason).toBe("circuit breaker open");

    // Advance time past cooldown (5 seconds). Only `Date` is faked: the
    // breaker cooldown is `Date.now()`-based, and the subsequent compact()
    // call yields the event loop via setImmediate during its sweep, which
    // must still run for real.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.advanceTimersByTime(6000);

    // Should no longer be blocked (breaker auto-reset)
    result = await engine.compact({
      sessionId,
      sessionKey,
      tokenBudget: 5000,
      force: true,
      legacyParams: {
        summarize: async (text: string) => `Summary: ${text.slice(0, 50)}`,
      },
    });
    expect(result.reason).not.toBe("circuit breaker open");
    
    vi.useRealTimers();
  });

  it("should reset on successful compaction", async () => {
    await engine.bootstrap(seedRuntimeSessionForCurrent());
    
    let shouldFail = true;
    const toggleSummarizer = async (text: string) => {
      if (shouldFail) {
        throw makeAuthError();
      }
      return `Summary: ${text.slice(0, 50)}`;
    };
    
    // Accumulate 2 failures (below threshold of 3)
    for (let i = 0; i < 2; i++) {
      await engine.compact({
        sessionId,
        sessionKey,
        tokenBudget: 5000,
        force: true,
        legacyParams: { summarize: toggleSummarizer },
      });
    }
    
    // Now succeed — should reset counter
    shouldFail = false;
    await engine.compact({
      sessionId,
      sessionKey,
      tokenBudget: 5000,
      force: true,
      legacyParams: { summarize: toggleSummarizer },
    });
    
    // Now fail again 2 more times — should NOT trip (counter was reset)
    shouldFail = true;
    for (let i = 0; i < 2; i++) {
      await engine.compact({
        sessionId,
        sessionKey,
        tokenBudget: 5000,
        force: true,
        legacyParams: { summarize: toggleSummarizer },
      });
    }
    
    // Should still work (2 failures, below threshold of 3)
    const result = await engine.compact({
      sessionId,
      sessionKey,
      tokenBudget: 5000,
      force: true,
      legacyParams: { summarize: toggleSummarizer },
    });
    expect(result.reason).not.toBe("circuit breaker open");
  });

  it("should scope provider-backed breakers to the resolved provider/model", async () => {
    const config = createTestConfig({ circuitBreakerThreshold: 1 });
    const providerDeps = createTestDeps(config);
    let summaryOrdinal = 0;
    providerDeps.complete = async (params) => {
      if (params.provider === "broken-provider") {
        throw new LcmProviderAuthError({
          provider: "broken-provider",
          model: params.model,
          failure: { statusCode: 401, message: "auth failed", missingModelRequestScope: false },
        });
      }
      return {
        content: [{
          type: "text",
          text: `Summary ${params.provider ?? "unknown"} ${params.model ?? "unknown"} ${summaryOrdinal++}`,
        }],
      };
    };

    const scopedDb = new DatabaseSync(":memory:");
    const scopedEngine = new LcmContextEngine(providerDeps, scopedDb);
    const brokenSession = seedRuntimeSession("broken-provider");
    const healthySession = seedRuntimeSession("healthy-provider");

    try {
      await scopedEngine.bootstrap(brokenSession);
      await scopedEngine.bootstrap(healthySession);

      await scopedEngine.compact({
        ...brokenSession,
        tokenBudget: 5000,
        force: true,
        legacyParams: { provider: "broken-provider", model: "shared-model" },
      });

      const healthyResult = await scopedEngine.compact({
        ...healthySession,
        tokenBudget: 5000,
        force: true,
        legacyParams: { provider: "healthy-provider", model: "shared-model" },
      });

      expect(healthyResult.reason).not.toBe("circuit breaker open");
    } finally {
      try { scopedDb.close(); } catch {}
    }
  });

  it("should trip after auth failure during later full-sweep passes", async () => {
    const config = createTestConfig({ circuitBreakerThreshold: 1 });
    const deps = createTestDeps(config);
    const sweepDb = new DatabaseSync(":memory:");
    const sweepEngine = new LcmContextEngine(deps, sweepDb);
    const sweepSession = seedRuntimeSession("full-sweep");

    try {
      await sweepEngine.bootstrap(sweepSession);

      let callCount = 0;
      const mixedSummarizer = async (text: string) => {
        callCount++;
        if (callCount === 1) {
          return `Summary: ${text.slice(0, 50)}`;
        }
        throw makeAuthError();
      };

      const first = await sweepEngine.compact({
        ...sweepSession,
        tokenBudget: 5000,
        force: true,
        legacyParams: { summarize: mixedSummarizer },
      });

      const second = await sweepEngine.compact({
        ...sweepSession,
        tokenBudget: 5000,
        force: true,
        legacyParams: {
          summarize: async (text: string) => `Summary: ${text.slice(0, 50)}`,
        },
      });

      expect(callCount).toBeGreaterThan(1);
      expect(first.reason).toBe("provider auth failure after partial compaction");
      expect(second.reason).toBe("circuit breaker open");
    } finally {
      try { sweepDb.close(); } catch {}
    }
  });
});
