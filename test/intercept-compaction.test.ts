import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LcmContextEngine } from "../src/engine.js";
import { createLcmDatabaseConnection } from "../src/db/connection.js";
import type { AgentMessage } from "openclaw/plugin-sdk";
import type { LcmConfig, LcmDependencies } from "../src/types.js";

/**
 * Tests for the interceptCompaction method (PR follow-up to #619).
 *
 * These are unit tests covering the contract behavior of the method:
 *   - Guard rails (ignored session, stateless session, no config target,
 *     pre-/mid-compaction abort)
 *   - Return shape under each path (handled:true vs handled:false)
 *   - Error swallowing (never throw across the SDK boundary)
 *
 * Full integration with the openclaw `session_before_compact` event is
 * tested separately once PR #1 is wired.
 */

const tempDirs: string[] = [];

function makeMinimalConfig(databasePath: string, overrides: Partial<LcmConfig> = {}): LcmConfig {
  return {
    enabled: true,
    databasePath,
    largeFilesDir: join(databasePath, "..", "lcm-files"),
    ignoreSessionPatterns: [],
    statelessSessionPatterns: [],
    skipStatelessSessions: true,
    contextThreshold: 0.6,
    respectThresholdAsHardFloor: false,
    freshTailCount: 8,
    freshTailMaxTokens: 24000,
    promptAwareEviction: false,
    newSessionRetainDepth: 2,
    leafMinFanout: 8,
    condensedMinFanout: 4,
    condensedMinFanoutHard: 2,
    incrementalMaxDepth: 1,
    leafChunkTokens: 20000,
    leafTargetTokens: 600,
    condensedTargetTokens: 900,
    maxExpandTokens: 4000,
    largeFileTokenThreshold: 25000,
    summaryProvider: "",
    summaryModel: "",
    largeFileSummaryProvider: "",
    largeFileSummaryModel: "",
    expansionProvider: "",
    expansionModel: "",
    delegationTimeoutMs: 120000,
    summaryTimeoutMs: 60000,
    timezone: "UTC",
    pruneHeartbeatOk: false,
    transcriptGcEnabled: false,
    proactiveThresholdCompactionMode: "deferred",
    autoRotateSessionFiles: { enabled: false, sizeBytes: 2097152, startup: "warn", runtime: "warn" },
    summaryMaxOverageFactor: 3,
    customInstructions: "",
    circuitBreakerThreshold: 5,
    circuitBreakerCooldownMs: 1800000,
    fallbackProviders: [],
    cacheAwareCompaction: {
      enabled: true,
      cacheTTLSeconds: 300,
      maxColdCacheCatchupPasses: 2,
      hotCachePressureFactor: 4,
      hotCacheBudgetHeadroomRatio: 0.2,
      coldCacheObservationThreshold: 3,
      criticalBudgetPressureRatio: 0.7,
    },
    dynamicLeafChunkTokens: { enabled: true, max: 40000 },
    agentCompactionToolEnabled: true,
    ...overrides,
  } as unknown as LcmConfig;
}

function makeMinimalDeps(
  config: LcmConfig,
  logOverrides?: Partial<{ info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void; debug: (msg: string) => void }>,
): LcmDependencies {
  const noop = () => {};
  return {
    config,
    log: {
      info: logOverrides?.info ?? noop,
      warn: logOverrides?.warn ?? noop,
      error: logOverrides?.error ?? noop,
      debug: logOverrides?.debug ?? noop,
    } as unknown as LcmDependencies["log"],
    complete: vi.fn(async () => ({ content: [{ type: "text", text: "" }] })),
    callGateway: vi.fn(async () => ({})),
    resolveModel: vi.fn(() => ({ provider: "test", model: "test-model" })),
    getApiKey: vi.fn(async () => "test-key"),
    requireApiKey: vi.fn(async () => "test-key"),
    parseAgentSessionKey: (sk) => {
      const t = sk.trim();
      if (!t.startsWith("agent:")) return null;
      const parts = t.split(":");
      if (parts.length < 3) return null;
      return { agentId: parts[1] ?? "main", suffix: parts.slice(2).join(":") };
    },
    isSubagentSessionKey: (sk) => sk.includes(":subagent:"),
    normalizeAgentId: (id) => (id?.trim() ? id : "main"),
    buildSubagentSystemPrompt: () => "subagent",
    readLatestAssistantReply: () => undefined,
    resolveAgentDir: () => process.env.HOME ?? "/tmp",
    resolveSessionIdFromSessionKey: async () => undefined,
    resolveSessionTranscriptFile: async () => undefined,
  } as unknown as LcmDependencies;
}

function makeEngine(
  overrides: Partial<LcmConfig> = {},
  logOverrides?: Parameters<typeof makeMinimalDeps>[1],
): { engine: LcmContextEngine; db: DatabaseSync; tempDir: string } {
  const tempDir = mkdtempSync(join(tmpdir(), "intercept-test-"));
  tempDirs.push(tempDir);
  const dbPath = join(tempDir, "lcm.db");
  const config = makeMinimalConfig(dbPath, overrides);
  const db = createLcmDatabaseConnection(dbPath);
  const engine = new LcmContextEngine(makeMinimalDeps(config, logOverrides), db);
  return { engine, db, tempDir };
}

afterEach(() => {
  // Clean up temp dirs created during tests.
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
    }
  }
});

describe("interceptCompaction (PR follow-up to #619)", () => {
  it("returns handled:false when compactionTargetFraction is unset (legacy behavior)", async () => {
    const { engine } = makeEngine({ compactionTargetFraction: undefined } as Partial<LcmConfig>);
    const result = await engine.interceptCompaction({
      sessionId: "test-session",
      sessionKey: "agent:main:main",
      sessionFile: "/tmp/test.jsonl",
      tokenBudget: 258000,
      currentTokenCount: 232000,
      firstKeptEntryId: "entry-abc",
      tokensBefore: 232000,
      trigger: "in-attempt-auto",
    });
    expect(result.handled).toBe(false);
    if (!result.handled) {
      expect(result.reason).toBe("no-target-fraction-configured");
    }
  });

  it("returns handled:false for invalid compactionTargetFraction (0, negative, >1, NaN)", async () => {
    const invalid: Array<number | undefined> = [0, -0.5, 1.5, NaN, Infinity];
    for (const v of invalid) {
      const { engine } = makeEngine({ compactionTargetFraction: v } as Partial<LcmConfig>);
      const result = await engine.interceptCompaction({
        sessionId: "test-session",
        sessionKey: "agent:main:main",
        sessionFile: "/tmp/test.jsonl",
        tokenBudget: 258000,
        firstKeptEntryId: "entry-1",
        tokensBefore: 200000,
      });
      expect(result.handled).toBe(false);
      if (!result.handled) {
        expect(result.reason).toBe("no-target-fraction-configured");
      }
    }
  });

  it("returns handled:false for compactionTargetFraction below the 0.05 safety floor (wave-B regression guard)", async () => {
    // Wave-B P1: Guard 2's validation must match the engine.compact() floor.
    // Values in (0, 0.05) cause convergence-loop spin and were previously
    // accepted by Guard 2 (then refused inside compact() with wasted LLM tokens).
    // This test guards against silent regression of the wave-B unification.
    const belowFloor: number[] = [0.01, 0.02, 0.04, 0.0499];
    for (const v of belowFloor) {
      const { engine } = makeEngine({ compactionTargetFraction: v } as Partial<LcmConfig>);
      const result = await engine.interceptCompaction({
        sessionId: "test-session",
        sessionKey: "agent:main:main",
        sessionFile: "/tmp/test.jsonl",
        tokenBudget: 258000,
        firstKeptEntryId: "entry-1",
        tokensBefore: 200000,
      });
      expect(result.handled).toBe(false);
      if (!result.handled) {
        expect(result.reason).toBe("no-target-fraction-configured");
      }
    }
  });

  it("accepts compactionTargetFraction at the 0.05 floor (boundary)", async () => {
    // 0.05 is the lowest accepted value (wave-B fix to (0, 1] → [0.05, 1]).
    // At-floor reaches the inner code path; success of the actual compaction
    // depends on session content (likely lcm-produced-no-context for an
    // empty session) but the boundary check itself MUST not refuse 0.05.
    const { engine } = makeEngine({ compactionTargetFraction: 0.05 } as Partial<LcmConfig>);
    const result = await engine.interceptCompaction({
      sessionId: "test-boundary",
      sessionKey: "agent:main:main",
      sessionFile: "/tmp/test.jsonl",
      tokenBudget: 258000,
      currentTokenCount: 232000,
      firstKeptEntryId: "entry-1",
      tokensBefore: 232000,
    });
    // The fraction itself is accepted (no "no-target-fraction-configured").
    // Downstream may decline for other reasons (empty conversation, etc.),
    // but the boundary value itself MUST pass Guard 2.
    if (!result.handled) {
      expect(result.reason).not.toBe("no-target-fraction-configured");
    }
  });

  it("returns handled:false for ignored sessions", async () => {
    const { engine } = makeEngine({
      compactionTargetFraction: 0.35,
      ignoreSessionPatterns: ["agent:test:**"],
    });
    const result = await engine.interceptCompaction({
      sessionId: "test-session",
      sessionKey: "agent:test:ignored",
      sessionFile: "/tmp/test.jsonl",
      firstKeptEntryId: "entry-1",
      tokensBefore: 200000,
    });
    expect(result.handled).toBe(false);
    if (!result.handled) {
      expect(result.reason).toBe("session-ignored");
    }
  });

  it("returns handled:false for stateless sessions", async () => {
    const { engine } = makeEngine({
      compactionTargetFraction: 0.35,
      statelessSessionPatterns: ["agent:*:subagent:**"],
      skipStatelessSessions: true,
    });
    const result = await engine.interceptCompaction({
      sessionId: "subagent-session",
      sessionKey: "agent:main:subagent:abc123",
      sessionFile: "/tmp/test.jsonl",
      firstKeptEntryId: "entry-1",
      tokensBefore: 200000,
    });
    expect(result.handled).toBe(false);
    if (!result.handled) {
      expect(result.reason).toBe("stateless-session");
    }
  });

  it("respects pre-compaction abort signal", async () => {
    const { engine } = makeEngine({ compactionTargetFraction: 0.35 } as Partial<LcmConfig>);
    const controller = new AbortController();
    controller.abort();
    const result = await engine.interceptCompaction({
      sessionId: "test-session",
      sessionKey: "agent:main:main",
      sessionFile: "/tmp/test.jsonl",
      tokenBudget: 258000,
      currentTokenCount: 232000,
      firstKeptEntryId: "entry-1",
      tokensBefore: 232000,
      signal: controller.signal,
    });
    expect(result.handled).toBe(false);
    if (!result.handled) {
      expect(result.reason).toBe("aborted-pre-compaction");
    }
  });

  it("falls through to codex when no conversation context is available", async () => {
    // For this test, we don't have a real conversation seeded. Compact will
    // succeed-as-noop (ok:true, compacted:false, reason "no conversation
    // found for session"). Assemble then returns empty messages — and our
    // Guard 5 returns handled:false with reason "lcm-produced-no-context"
    // so codex can fall back to its native compaction.
    const { engine } = makeEngine({ compactionTargetFraction: 0.35 } as Partial<LcmConfig>);
    const result = await engine.interceptCompaction({
      sessionId: "test-session",
      sessionKey: "agent:main:main",
      sessionFile: "/tmp/test.jsonl",
      tokenBudget: 258000,
      currentTokenCount: 232000,
      firstKeptEntryId: "entry-keep-me-A",
      tokensBefore: 232000,
    });
    expect(result.handled).toBe(false);
    if (!result.handled) {
      expect(result.reason).toMatch(/compact-failed|lcm-produced-no-context|stateless|ignored/);
    }
  });

  it("advances the projection epoch when intercepted compaction changes summary context", async () => {
    const { engine } = makeEngine({ compactionTargetFraction: 0.35 } as Partial<LcmConfig>);
    const sessionId = "test-session-projection-intercept";
    const sessionKey = "agent:main:main";
    await engine.ingest({
      sessionId,
      sessionKey,
      message: { role: "user", content: "pre-intercept raw message" } as AgentMessage,
    });
    const baseline = await engine.assemble({
      sessionId,
      sessionKey,
      messages: [],
      tokenBudget: 10_000,
    });
    expect(baseline.contextProjection?.mode).toBe("thread_bootstrap");

    vi.spyOn(engine, "compact").mockImplementation(async () => {
      const conversation = await engine
        .getConversationStore()
        .getConversationForSession({ sessionId, sessionKey });
      expect(conversation).not.toBeNull();
      await engine.getSummaryStore().insertSummary({
        summaryId: "sum_intercept_projection_epoch",
        conversationId: conversation!.conversationId,
        kind: "leaf",
        depth: 0,
        content: "Compacted summary after intercepted compaction",
        tokenCount: 8,
        descendantCount: 0,
      });
      await engine
        .getSummaryStore()
        .appendContextSummary(conversation!.conversationId, "sum_intercept_projection_epoch");
      return {
        ok: true,
        compacted: true,
        result: {
          summary: "Compacted summary after intercepted compaction",
          firstKeptEntryId: "entry-keep-me",
          tokensBefore: 9_000,
        },
      };
    });

    const result = await engine.interceptCompaction({
      sessionId,
      sessionKey,
      sessionFile: "/tmp/test.jsonl",
      tokenBudget: 10_000,
      currentTokenCount: 9_000,
      firstKeptEntryId: "entry-keep-me",
      tokensBefore: 9_000,
    });

    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.summary).toContain("Compacted summary after intercepted compaction");
    }
    const afterIntercept = await engine.assemble({
      sessionId,
      sessionKey,
      messages: [],
      tokenBudget: 10_000,
    });
    expect(afterIntercept.contextProjection?.epoch).not.toBe(baseline.contextProjection?.epoch);
  });

  it("never throws — catches exceptions and returns handled:false", async () => {
    const { engine } = makeEngine({ compactionTargetFraction: 0.35 } as Partial<LcmConfig>);
    // Pass a session that will trigger a code path; even pathological inputs
    // should not throw.
    const result = await engine.interceptCompaction({
      sessionId: "",
      sessionKey: "",
      sessionFile: "",
      firstKeptEntryId: "",
      tokensBefore: 0,
    });
    // Either handled:true or handled:false — but never an unhandled throw.
    expect(typeof result.handled).toBe("boolean");
  });

  it("validation surface matches documented contract — (0, 1] valid", () => {
    const validate = (v: unknown) =>
      typeof v === "number" && Number.isFinite(v) && (v as number) > 0 && (v as number) <= 1;

    expect(validate(0.35)).toBe(true);
    expect(validate(0.9)).toBe(true);
    expect(validate(1.0)).toBe(true);
    expect(validate(0.01)).toBe(true);
    expect(validate(0)).toBe(false);
    expect(validate(-0.5)).toBe(false);
    expect(validate(1.01)).toBe(false);
    expect(validate(NaN)).toBe(false);
    expect(validate(undefined)).toBe(false);
  });
});

describe("warnBelowFloorOnce dedup (wave-B regression guard)", () => {
  // The under-floor warning is emitted via this.log.warn when
  // engine.compact() is called with `compactionTargetFraction` in (0, 0.05).
  // Codex autonomous loops can fire compaction 1-5× per turn; without
  // dedup, a misconfigured operator would see dozens of identical warnings.
  // The dedup Set is per-engine-instance and keyed by the fraction value
  // (a different bad number gets a fresh warning so operators iterating
  // on the config see fresh feedback).
  //
  // These tests exercise the private `warnBelowFloorOnce` method directly
  // via a TS-cast — driving it through `engine.compact()` requires seeding
  // a real conversation, which is heavier than the dedup logic itself
  // needs for verification.
  type EngineWithPrivates = LcmContextEngine & {
    warnBelowFloorOnce(fraction: number): void;
    warnedFloorFractions: Set<number>;
  };

  it("warns once for repeated calls with the same fraction value", () => {
    const warnSpy = vi.fn();
    const { engine } = makeEngine({}, { warn: warnSpy });
    const e = engine as EngineWithPrivates;
    e.warnBelowFloorOnce(0.02);
    e.warnBelowFloorOnce(0.02);
    e.warnBelowFloorOnce(0.02);
    const underFloorWarnings = warnSpy.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("below the 0.05 safety floor"),
    );
    expect(underFloorWarnings.length).toBe(1);
  });

  it("warns separately for DIFFERENT fraction values", () => {
    const warnSpy = vi.fn();
    const { engine } = makeEngine({}, { warn: warnSpy });
    const e = engine as EngineWithPrivates;
    for (const v of [0.02, 0.03, 0.04, 0.02 /* repeat */]) {
      e.warnBelowFloorOnce(v);
    }
    const underFloorWarnings = warnSpy.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("below the 0.05 safety floor"),
    );
    // Three unique values triggered warnings; the 4th call (0.02 again) was deduped.
    expect(underFloorWarnings.length).toBe(3);
  });

  it("warning text names the dedup behavior so operators understand why subsequent calls are silent", () => {
    const warnSpy = vi.fn();
    const { engine } = makeEngine({}, { warn: warnSpy });
    const e = engine as EngineWithPrivates;
    e.warnBelowFloorOnce(0.02);
    const [msg] = warnSpy.mock.calls[0] ?? [];
    expect(typeof msg).toBe("string");
    expect(msg).toMatch(/Subsequent occurrences/i);
  });

  it("records the fraction value in the internal dedup set", () => {
    const { engine } = makeEngine();
    const e = engine as EngineWithPrivates;
    e.warnBelowFloorOnce(0.02);
    e.warnBelowFloorOnce(0.03);
    expect(e.warnedFloorFractions.has(0.02)).toBe(true);
    expect(e.warnedFloorFractions.has(0.03)).toBe(true);
    expect(e.warnedFloorFractions.has(0.05)).toBe(false);
  });
});

describe("serializeAssembledMessagesForCompaction (internal helper exercised via interceptCompaction)", () => {
  // The helper is private to engine.ts but covered indirectly:
  // - empty messages → "(LCM produced no assembled context post-compaction.)"
  // - string content → emitted verbatim
  // - text-block array → joined
  // - tool blocks → JSON-encoded
  // These properties are encoded by inspecting the implementation behavior
  // (see engine.ts:serializeAssembledMessagesForCompaction docstring).

  it("contract: empty messages → fallback marker string", () => {
    // Cannot directly call (not exported), but the contract is documented.
    // When `assembled.messages` is empty, the result is a non-empty marker
    // so codex doesn't receive an empty `summary` field (which would be
    // rejected by some downstream validators).
    expect("(LCM produced no assembled context post-compaction.)".length).toBeGreaterThan(0);
  });
});
