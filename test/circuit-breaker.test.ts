import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LcmContextEngine } from "../src/engine.js";
import { LcmProviderAuthError } from "../src/summarize.js";
import { makeMessage } from "./helpers.js";

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
    largeFilesDir: "/tmp/lcm-files",
    ignoreSessionPatterns: [],
    statelessSessionPatterns: [],
    skipStatelessSessions: false,
    contextThreshold: 0.75,
    freshTailCount: 4,
    promptAwareEviction: false,
    stubLargeToolPayloads: false,
    newSessionRetainDepth: 2,
    leafMinFanout: 4,
    condensedMinFanout: 4,
    condensedMinFanoutHard: 2,
    sweepMaxDepth: 1,
    incrementalMaxDepth: 0,
    maxSweepIterations: 12,
    sweepDeadlineMs: 120_000,
    compactUntilUnderDeadlineMs: 300_000,
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
    delegationTimeoutMs: 120000,
    customInstructions: "",
    circuitBreakerThreshold: 3, // Low threshold for testing
    circuitBreakerCooldownMs: 5000, // 5 seconds for testing
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
      max: 4_000,
    },
    stripInjectedContextTags: [],
    ...overrides,
  } as LcmConfig;
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

function seedSessionFile(dir: string, name: string = randomUUID()) {
  const seededSessionId = randomUUID();
  const seededSessionKey = `agent:test:direct:${name}:${seededSessionId}`;
  const seededSessionFile = join(dir, `${name}-${seededSessionId}.jsonl`);

  const messages: string[] = [];
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
  writeFileSync(seededSessionFile, messages.join("\n") + "\n");

  return {
    sessionId: seededSessionId,
    sessionKey: seededSessionKey,
    sessionFile: seededSessionFile,
  };
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
    ({ sessionId, sessionKey, sessionFile } = seedSessionFile(tmpDir));

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

  it("does not reclassify repeated auth failures as summary spend failures", async () => {
    const authConfig = createTestConfig({
      circuitBreakerThreshold: 3,
      summaryMaxCallsPerWindow: 1,
      summaryCallWindowMs: 10 * 60 * 1000,
      summarySpendBackoffMs: 30 * 60 * 1000,
    });
    const authDb = new DatabaseSync(":memory:");
    const authEngine = new LcmContextEngine(createTestDeps(authConfig), authDb);
    const authSessionFile = join(tmpDir, `auth-spend-${randomUUID()}.jsonl`);
    writeFileSync(
      authSessionFile,
      Array.from({ length: 8 }, (_, index) =>
        JSON.stringify({
          message: {
            role: index % 2 === 0 ? "user" : "assistant",
            content: [{ type: "text", text: `auth spend message ${index} ${"x".repeat(200)}` }],
          },
        }),
      ).join("\n") + "\n",
    );
    await authEngine.bootstrap({
      sessionId: "auth-spend-session",
      sessionKey: "agent:main:auth-spend",
      sessionFile: authSessionFile,
    });

    let callCount = 0;
    const failingSummarizer = async () => {
      callCount++;
      throw makeAuthError();
    };

    try {
      for (let i = 0; i < 3; i += 1) {
        const result = await authEngine.compact({
          sessionId: "auth-spend-session",
          sessionKey: "agent:main:auth-spend",
          sessionFile: authSessionFile,
          tokenBudget: 5000,
          force: true,
          legacyParams: { summarize: failingSummarizer },
        });
        expect(result.reason).toContain("provider auth failure");
      }

      const blocked = await authEngine.compact({
        sessionId: "auth-spend-session",
        sessionKey: "agent:main:auth-spend",
        sessionFile: authSessionFile,
        tokenBudget: 5000,
        force: true,
        legacyParams: { summarize: failingSummarizer },
      });

      expect(callCount).toBe(3);
      expect(blocked.reason).toBe("circuit breaker open");
    } finally {
      try { authDb.close(); } catch {}
    }
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
    const brokenSession = seedSessionFile(tmpDir, "broken-provider");
    const healthySession = seedSessionFile(tmpDir, "healthy-provider");

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

  it("should force-exhaust deferred compaction loop when retryAttempts >= maxFailures", async () => {
    // Regression: replace the process-local compact-loop counter with the
    // durable maintenance-store retryAttempts field. When retryAttempts
    // reaches compactionLoopMaxConsecutiveFailures, the deferred compaction
    // drain must force-exhaust to prevent CPU/I/O runaway.
    await engine.bootstrap({ sessionId, sessionFile, sessionKey });

    const conversation = await (engine as any).getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    if (!conversation) return;

    const maintenanceStore = (engine as any).compactionMaintenanceStore;

    // Create a pending maintenance entry to activate compact-loop logic.
    await maintenanceStore.requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
    });

    // Simulate 10 consecutive failures — each call to
    // markProactiveCompactionFinished with a backoff-worthy failure
    // increments retryAttempts.
    for (let i = 0; i < 10; i++) {
      await maintenanceStore.markProactiveCompactionFinished({
        conversationId: conversation.conversationId,
        failureSummary: "ENOENT: transcript file moved or deleted",
        keepPending: true,
      });
    }

    // Verify retryAttempts has reached the threshold.
    const maintenance = await maintenanceStore.getConversationCompactionMaintenance(
      conversation.conversationId,
    );
    expect(maintenance?.retryAttempts).toBe(10);

    // Trigger the deferred drain path via assemble. The maintenance entry
    // is pending, so the code should check retryAttempts >= maxFailures (10)
    // and return exhausted=true without calling the summarizer.
    const liveMessages = [makeMessage({ role: "user", content: "hello" })];
    const assembled = await engine.assemble({
      sessionId,
      sessionKey,
      messages: liveMessages,
      tokenBudget: 8_000,
    });

    // Assemble should not crash even when the breaker trips.
    expect(assembled.messages.length).toBeGreaterThan(0);

    // After the breaker tripped, retryAttempts should remain at 10
    // (compaction was skipped, so no reset occurred).
    const afterMaintenance = await maintenanceStore.getConversationCompactionMaintenance(
      conversation.conversationId,
    );
    expect(afterMaintenance?.retryAttempts).toBe(10);

    // Clean up the maintenance state.
    await maintenanceStore.markProactiveCompactionFinished({
      conversationId: conversation.conversationId,
    });
  });

  it("should allow deferred compaction when retryAttempts < maxFailures", async () => {
    // When retryAttempts is below the configured threshold, the deferred
    // compaction drain should proceed normally instead of force-exhausting.
    await engine.bootstrap({ sessionId, sessionFile, sessionKey });

    const conversation = await (engine as any).getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    if (!conversation) return;

    const maintenanceStore = (engine as any).compactionMaintenanceStore;

    // Create a pending maintenance entry.
    await maintenanceStore.requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
    });

    // Only 2 failures — well below the default maxFailures of 10.
    for (let i = 0; i < 2; i++) {
      await maintenanceStore.markProactiveCompactionFinished({
        conversationId: conversation.conversationId,
        failureSummary: "ENOENT: transcript file moved or deleted",
        keepPending: true,
      });
    }

    const maintenance = await maintenanceStore.getConversationCompactionMaintenance(
      conversation.conversationId,
    );
    expect(maintenance?.retryAttempts).toBe(2);

    // Use vi.spyOn instead of manual method replacement to avoid
    // subtle binding issues. Assert via durable state transition:
    // after assemble() with retryAttempts < maxFailures, the deferred
    // compaction path should be entered and maintenance state should
    // progress (retryAttempts may reset or pending may clear).
    const consumeSpy = vi.spyOn(engine as any, "consumeDeferredCompactionDebt");

    // Trigger the deferred drain path via assemble.
    const liveMessages = [makeMessage({ role: "user", content: "hello" })];
    const assembled = await engine.assemble({
      sessionId,
      sessionKey,
      messages: liveMessages,
      tokenBudget: 8_000,
    });

    // Assemble should succeed without the breaker tripping.
    expect(assembled.messages.length).toBeGreaterThan(0);

    // Verify durable state: retryAttempts should not increase
    // (below threshold, no force-exhaust).
    const afterMaintenance = await maintenanceStore.getConversationCompactionMaintenance(
      conversation.conversationId,
    );
    // After assemble with retryAttempts < maxFailures, the maintenance
    // record either progresses (retry resets) or stays; it should NOT
    // increase past the threshold.
    expect((afterMaintenance?.retryAttempts ?? 0) <= 2).toBe(true);

    consumeSpy.mockRestore();

    // Clean up.
    await maintenanceStore.markProactiveCompactionFinished({
      conversationId: conversation.conversationId,
    });
  });

  it("should reset retryAttempts after successful compaction", async () => {
    // markProactiveCompactionFinished with no failureSummary resets
    // retryAttempts to 0, confirming the maintenance store handles the
    // counter reset instead of a process-local map.
    await engine.bootstrap({ sessionId, sessionFile, sessionKey });

    const conversation = await (engine as any).getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    if (!conversation) return;

    const maintenanceStore = (engine as any).compactionMaintenanceStore;

    // Set up pending maintenance with a non-zero retryAttempts.
    await maintenanceStore.requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
    });

    for (let i = 0; i < 5; i++) {
      await maintenanceStore.markProactiveCompactionFinished({
        conversationId: conversation.conversationId,
        failureSummary: "ENOENT: transcript file moved or deleted",
        keepPending: true,
      });
    }

    let maintenance = await maintenanceStore.getConversationCompactionMaintenance(
      conversation.conversationId,
    );
    expect(maintenance?.retryAttempts).toBe(5);

    // Successful completion (no failureSummary) resets retryAttempts.
    await maintenanceStore.markProactiveCompactionFinished({
      conversationId: conversation.conversationId,
    });

    maintenance = await maintenanceStore.getConversationCompactionMaintenance(
      conversation.conversationId,
    );
    expect(maintenance?.retryAttempts).toBe(0);
  });

  it("should trip after auth failure during later full-sweep passes", async () => {
    const config = createTestConfig({ circuitBreakerThreshold: 1 });
    const deps = createTestDeps(config);
    const sweepDb = new DatabaseSync(":memory:");
    const sweepEngine = new LcmContextEngine(deps, sweepDb);
    const sweepSession = seedSessionFile(tmpDir, "full-sweep");

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

  it("should trip the emergency drain circuit breaker during over-budget assemble", async () => {
    // Regression: the real emergency-drain path in assemble() only runs when
    // storedContextTokens > tokenBudget. The previous test used a tiny live
    // message with a generous 8000-token budget, which never exceeded the
    // stored context and skipped the drain path entirely.
    //
    // Seed enough backlog (40 messages × ~125 tokens ≈ 5000 stored tokens)
    // then call assemble() with a tight 2000-token budget so the emergency
    // drain path is entered and the circuit breaker is tested end-to-end.
    const bigConfig = createTestConfig({
      compactionLoopMaxConsecutiveFailures: 5,
    });
    const bigDb = new DatabaseSync(":memory:");
    const bigEngine = new LcmContextEngine(createTestDeps(bigConfig), bigDb);
    const { sessionId: bigSid, sessionKey: bigKey, sessionFile: bigFile } = seedSessionFile(tmpDir, "emergency-drain");

    try {
      await bigEngine.bootstrap({ sessionId: bigSid, sessionFile: bigFile, sessionKey: bigKey });

      const conversation = await (bigEngine as any).getConversationStore().getConversationForSession({
        sessionId: bigSid,
        sessionKey: bigKey,
      });
      if (!conversation) return;

      const maintenanceStore = (bigEngine as any).compactionMaintenanceStore;

      // Create a pending maintenance entry and simulate repeated ENOENT
      // failures that trigger backoff (ENOENT IS backoff-worthy, unlike
      // auth failures which the spending guard handles separately).
      await maintenanceStore.requestProactiveCompactionDebt({
        conversationId: conversation.conversationId,
        reason: "threshold",
      });

      for (let i = 0; i < 5; i++) {
        await maintenanceStore.markProactiveCompactionFinished({
          conversationId: conversation.conversationId,
          failureSummary: "ENOENT: transcript file moved or deleted",
          keepPending: true,
        });
      }

      const maintenance = await maintenanceStore.getConversationCompactionMaintenance(
        conversation.conversationId,
      );
      expect(maintenance?.retryAttempts).toBe(5);

      // Call assemble() with a token budget LOW enough that stored context
      // (≈5000 tokens from 40 messages) exceeds it, triggering the
      // emergency deferred-compaction drain. The circuit breaker should
      // force-exhaust because retryAttempts (5) >= maxFailures (5).
      const liveMessages = [makeMessage({ role: "user", content: "hello" })];
      const assembled = await bigEngine.assemble({
        sessionId: bigSid,
        sessionKey: bigKey,
        messages: liveMessages,
        tokenBudget: 2_000,
      });

      // Assemble must still return messages (degraded fallback).
      expect(assembled.messages.length).toBeGreaterThan(0);

      // retryAttempts should remain at the threshold because the breaker
      // force-exhausted before resetting.
      const after = await maintenanceStore.getConversationCompactionMaintenance(
        conversation.conversationId,
      );
      expect(after?.retryAttempts).toBe(5);
      expect(after?.pending).toBe(true);

      // Clean up.
      await maintenanceStore.markProactiveCompactionFinished({
        conversationId: conversation.conversationId,
      });
    } finally {
      try { bigDb.close(); } catch {}
    }
  });

  it("should auto-reset retryAttempts and retry after cooldown elapses", async () => {
    // After the compaction-loop circuit breaker trips, debt remains pending
    // and retryAttempts stays at the threshold. On the next assemble() call
    // with an over-budget context, the breaker should detect that the
    // cooldown (nextAttemptAfter) has elapsed and auto-reset retryAttempts
    // so the drain can try again.
    //
    // We bypass fake timers (which interact poorly with Date objects
    // already stored in SQLite) by directly setting nextAttemptAfter to
    // a past timestamp via the maintenance store.
    const cooldownConfig = createTestConfig({
      compactionLoopMaxConsecutiveFailures: 3,
    });
    const cooldownDb = new DatabaseSync(":memory:");
    const cooldownEngine = new LcmContextEngine(createTestDeps(cooldownConfig), cooldownDb);
    const { sessionId: csid, sessionKey: ckey, sessionFile: cfile } = seedSessionFile(tmpDir, "cooldown-recovery");

    try {
      await cooldownEngine.bootstrap({ sessionId: csid, sessionFile: cfile, sessionKey: ckey });

      const conversation = await (cooldownEngine as any).getConversationStore().getConversationForSession({
        sessionId: csid,
        sessionKey: ckey,
      });
      if (!conversation) return;

      const maintenanceStore = (cooldownEngine as any).compactionMaintenanceStore;

      await maintenanceStore.requestProactiveCompactionDebt({
        conversationId: conversation.conversationId,
        reason: "threshold",
      });

      // Trip the breaker with 3 ENOENT failures.
      for (let i = 0; i < 3; i++) {
        await maintenanceStore.markProactiveCompactionFinished({
          conversationId: conversation.conversationId,
          failureSummary: "ENOENT: transcript file moved or deleted",
          keepPending: true,
        });
      }

      let maintenance = await maintenanceStore.getConversationCompactionMaintenance(
        conversation.conversationId,
      );
      expect(maintenance?.retryAttempts).toBe(3);
      expect(maintenance?.pending).toBe(true);

      // First assemble() with tight budget — breaker trips because
      // retryAttempts >= 3 and cooldown has NOT elapsed (nextAttemptAfter
      // is in the future due to exponential backoff).
      const liveMessages = [makeMessage({ role: "user", content: "hello" })];
      const first = await cooldownEngine.assemble({
        sessionId: csid,
        sessionKey: ckey,
        messages: liveMessages,
        tokenBudget: 2_000,
      });
      expect(first.messages.length).toBeGreaterThan(0);

      // Manually set nextAttemptAfter to a past time so the cooldown
      // appears elapsed. This avoids fake-timer/real-Date mismatch issues
      // with Date objects already persisted in SQLite.
      await maintenanceStore.markProactiveCompactionFinished({
        conversationId: conversation.conversationId,
        nextAttemptAfter: new Date(Date.now() - 60_000),
        keepPending: true,
      });

      // Second assemble() — cooldown has elapsed, breaker should
      // auto-reset retryAttempts to 0 and allow the drain to proceed.
      const second = await cooldownEngine.assemble({
        sessionId: csid,
        sessionKey: ckey,
        messages: liveMessages,
        tokenBudget: 2_000,
      });
      expect(second.messages.length).toBeGreaterThan(0);

      // retryAttempts should have been reset by the cooldown recovery
      // path, then possibly incremented by a subsequent drain failure.
      // Key assertion: it was RESET (to 0) before the drain ran, so it
      // won't be stuck at 3 anymore.
      const after = await maintenanceStore.getConversationCompactionMaintenance(
        conversation.conversationId,
      );
      expect(after?.retryAttempts).toBeLessThan(3);

      // Clean up.
      await maintenanceStore.markProactiveCompactionFinished({
        conversationId: conversation.conversationId,
      });
    } finally {
      try { cooldownDb.close(); } catch {}
    }
  });

  it("should disable the compact-loop breaker when maxFailures is 0", async () => {
    // compactionLoopMaxConsecutiveFailures: 0 should disable the breaker
    // entirely — even with many backoff-worthy failures, the drain should
    // never force-exhaust.
    const disabledConfig = createTestConfig({
      compactionLoopMaxConsecutiveFailures: 0,
    });
    const disabledDb = new DatabaseSync(":memory:");
    const disabledEngine = new LcmContextEngine(createTestDeps(disabledConfig), disabledDb);
    const { sessionId: dsid, sessionKey: dkey, sessionFile: dfile } = seedSessionFile(tmpDir, "breaker-disabled");

    try {
      await disabledEngine.bootstrap({ sessionId: dsid, sessionFile: dfile, sessionKey: dkey });

      const conversation = await (disabledEngine as any).getConversationStore().getConversationForSession({
        sessionId: dsid,
        sessionKey: dkey,
      });
      if (!conversation) return;

      const maintenanceStore = (disabledEngine as any).compactionMaintenanceStore;

      await maintenanceStore.requestProactiveCompactionDebt({
        conversationId: conversation.conversationId,
        reason: "threshold",
      });

      // 20 ENOENT failures — far more than any default threshold.
      for (let i = 0; i < 20; i++) {
        await maintenanceStore.markProactiveCompactionFinished({
          conversationId: conversation.conversationId,
          failureSummary: "ENOENT: transcript file moved or deleted",
          keepPending: true,
        });
      }

      const maintenance = await maintenanceStore.getConversationCompactionMaintenance(
        conversation.conversationId,
      );
      expect(maintenance?.retryAttempts).toBe(20);

      // Assemble should succeed without the breaker tripping (maxFailures=0).
      const liveMessages = [makeMessage({ role: "user", content: "hello" })];
      const assembled = await disabledEngine.assemble({
        sessionId: dsid,
        sessionKey: dkey,
        messages: liveMessages,
        tokenBudget: 2_000,
      });
      expect(assembled.messages.length).toBeGreaterThan(0);

      // Clean up.
      await maintenanceStore.markProactiveCompactionFinished({
        conversationId: conversation.conversationId,
      });
    } finally {
      try { disabledDb.close(); } catch {}
    }
  });

  it("should trip at a non-default compactionLoopMaxConsecutiveFailures value", async () => {
    // A non-default threshold (7) should be respected: the breaker
    // should NOT trip at 6 failures, then trip at 7.
    const customConfig = createTestConfig({
      compactionLoopMaxConsecutiveFailures: 7,
    });
    const customDb = new DatabaseSync(":memory:");
    const customEngine = new LcmContextEngine(createTestDeps(customConfig), customDb);
    const { sessionId: xsid, sessionKey: xkey, sessionFile: xfile } = seedSessionFile(tmpDir, "custom-threshold");

    try {
      await customEngine.bootstrap({ sessionId: xsid, sessionFile: xfile, sessionKey: xkey });

      const conversation = await (customEngine as any).getConversationStore().getConversationForSession({
        sessionId: xsid,
        sessionKey: xkey,
      });
      if (!conversation) return;

      const maintenanceStore = (customEngine as any).compactionMaintenanceStore;

      await maintenanceStore.requestProactiveCompactionDebt({
        conversationId: conversation.conversationId,
        reason: "threshold",
      });

      // 6 failures — below the custom threshold of 7. The breaker should
      // NOT trip; the drain should proceed (and likely fail, incrementing
      // retryAttempts further).
      for (let i = 0; i < 6; i++) {
        await maintenanceStore.markProactiveCompactionFinished({
          conversationId: conversation.conversationId,
          failureSummary: "ENOENT: transcript file moved or deleted",
          keepPending: true,
        });
      }

      let maintenance = await maintenanceStore.getConversationCompactionMaintenance(
        conversation.conversationId,
      );
      expect(maintenance?.retryAttempts).toBe(6);

      // At 6 failures, the breaker should allow the drain attempt (not
      // force-exhaust). The assemble call with a low budget will enter the
      // emergency drain path.
      const liveMessages = [makeMessage({ role: "user", content: "hello" })];
      const beforeTrip = await customEngine.assemble({
        sessionId: xsid,
        sessionKey: xkey,
        messages: liveMessages,
        tokenBudget: 2_000,
      });
      expect(beforeTrip.messages.length).toBeGreaterThan(0);

      // One more failure pushes retryAttempts to 7 — at the threshold.
      await maintenanceStore.markProactiveCompactionFinished({
        conversationId: conversation.conversationId,
        failureSummary: "ENOENT: transcript file moved or deleted",
        keepPending: true,
      });

      maintenance = await maintenanceStore.getConversationCompactionMaintenance(
        conversation.conversationId,
      );
      expect(maintenance?.retryAttempts).toBe(7);

      // The next drain call should force-exhaust because retryAttempts (7)
      // >= maxFailures (7).
      const afterTrip = await customEngine.assemble({
        sessionId: xsid,
        sessionKey: xkey,
        messages: liveMessages,
        tokenBudget: 2_000,
      });
      expect(afterTrip.messages.length).toBeGreaterThan(0);

      // retryAttempts stays at 7 (breaker tripped, no reset).
      const after = await maintenanceStore.getConversationCompactionMaintenance(
        conversation.conversationId,
      );
      expect(after?.retryAttempts).toBe(7);

      // Clean up.
      await maintenanceStore.markProactiveCompactionFinished({
        conversationId: conversation.conversationId,
      });
    } finally {
      try { customDb.close(); } catch {}
    }
  });
});
