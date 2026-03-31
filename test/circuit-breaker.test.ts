import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
    summaryMaxOverageFactor: 3,
    circuitBreakerThreshold: 3, // Low threshold for testing
    circuitBreakerCooldownMs: 5000, // 5 seconds for testing
    ...overrides,
  };
}

function createTestDeps(config: LcmConfig): LcmDependencies {
  return {
    config,
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

describe("Circuit Breaker", () => {
  let tmpDir: string;
  let db: DatabaseSync;
  let engine: LcmContextEngine;
  let sessionFile: string;
  let sessionId: string;
  let sessionKey: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lcm-cb-test-"));
    sessionId = randomUUID();
    sessionKey = `agent:test:direct:${sessionId}`;
    sessionFile = join(tmpDir, `${sessionId}.jsonl`);
    
    // Create a session file with enough messages to trigger compaction
    const messages: string[] = [];
    // We need messages that exceed the leafChunkTokens (2000) threshold
    for (let i = 0; i < 20; i++) {
      messages.push(JSON.stringify({
        role: "user",
        content: `Message ${i}: ${"x".repeat(500)}`,
      }));
      messages.push(JSON.stringify({
        role: "assistant",
        content: `Response ${i}: ${"y".repeat(500)}`,
      }));
    }
    writeFileSync(sessionFile, messages.join("\n") + "\n");
    
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
    await engine.bootstrap({ sessionId, sessionFile, sessionKey });
    
    // Compact with a working summarizer
    const result = await engine.compact({
      sessionId,
      sessionKey,
      sessionFile,
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
    await engine.bootstrap({ sessionId, sessionFile, sessionKey });
    
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
        sessionFile,
        tokenBudget: 5000,
        force: true,
        legacyParams: { summarize: failingSummarizer },
      });
    }
    
    // 4th attempt should be blocked by circuit breaker
    const blocked = await engine.compact({
      sessionId,
      sessionKey,
      sessionFile,
      tokenBudget: 5000,
      force: true,
      legacyParams: { summarize: failingSummarizer },
    });
    
    expect(blocked.reason).toBe("circuit breaker open");
    expect(blocked.compacted).toBe(false);
  });

  it("should also block compactLeafAsync when breaker is open", async () => {
    await engine.bootstrap({ sessionId, sessionFile, sessionKey });
    
    const failingSummarizer = async () => {
      throw makeAuthError();
    };
    
    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      await engine.compact({
        sessionId,
        sessionKey,
        sessionFile,
        tokenBudget: 5000,
        force: true,
        legacyParams: { summarize: failingSummarizer },
      });
    }
    
    // compactLeafAsync should also be blocked
    const leafResult = await engine.compactLeafAsync({
      sessionId,
      sessionKey,
      sessionFile,
      tokenBudget: 5000,
      force: true,
      legacyParams: { summarize: failingSummarizer },
    });
    
    expect(leafResult.reason).toBe("circuit breaker open");
  });

  it("should auto-reset after cooldown", async () => {
    await engine.bootstrap({ sessionId, sessionFile, sessionKey });
    
    const failingSummarizer = async () => {
      throw makeAuthError();
    };
    
    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      await engine.compact({
        sessionId,
        sessionKey,
        sessionFile,
        tokenBudget: 5000,
        force: true,
        legacyParams: { summarize: failingSummarizer },
      });
    }
    
    // Verify it's blocked
    let result = await engine.compact({
      sessionId,
      sessionKey,
      sessionFile,
      tokenBudget: 5000,
      force: true,
      legacyParams: { summarize: failingSummarizer },
    });
    expect(result.reason).toBe("circuit breaker open");
    
    // Advance time past cooldown (5 seconds)
    vi.useFakeTimers();
    vi.advanceTimersByTime(6000);
    
    // Should no longer be blocked (breaker auto-reset)
    result = await engine.compact({
      sessionId,
      sessionKey,
      sessionFile,
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
    await engine.bootstrap({ sessionId, sessionFile, sessionKey });
    
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
        sessionFile,
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
      sessionFile,
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
        sessionFile,
        tokenBudget: 5000,
        force: true,
        legacyParams: { summarize: toggleSummarizer },
      });
    }
    
    // Should still work (2 failures, below threshold of 3)
    const result = await engine.compact({
      sessionId,
      sessionKey,
      sessionFile,
      tokenBudget: 5000,
      force: true,
      legacyParams: { summarize: toggleSummarizer },
    });
    expect(result.reason).not.toBe("circuit breaker open");
  });
});
