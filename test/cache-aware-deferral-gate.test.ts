import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveLcmConfig } from "../src/db/config.js";
import type { LcmConfig } from "../src/db/config.js";
import { closeLcmConnection, createLcmDatabaseConnection } from "../src/db/connection.js";
import { LcmContextEngine } from "../src/engine.js";
import type { ConversationCompactionTelemetryRecord } from "../src/store/compaction-telemetry-store.js";
import type { LcmDependencies } from "../src/types.js";

const tempDirs: string[] = [];
const dbs: ReturnType<typeof createLcmDatabaseConnection>[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      closeLcmConnection(db);
    } catch {
      // ignore
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
});

/**
 * Build a test config by deriving from `resolveLcmConfig` (the same code
 * the production runtime uses) and only overriding the fields the gate tests
 * actually care about. This keeps the test in sync with future LcmConfig
 * additions automatically — no `as LcmConfig` cast that would silently drop
 * required fields if the type evolves.
 */
function createMinimalConfig(databasePath: string): LcmConfig {
  const base = resolveLcmConfig({}, {});
  return {
    ...base,
    databasePath,
    largeFilesDir: join(databasePath, "..", "large-files"),
    timezone: "UTC",
  };
}

function createMinimalDeps(config: LcmConfig): LcmDependencies {
  return {
    config,
    complete: vi.fn(),
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
  } as unknown as LcmDependencies;
}

function createEngine(configOverrides?: Partial<LcmConfig>): LcmContextEngine {
  const tempDir = mkdtempSync(join(tmpdir(), "lcm-cache-gate-"));
  tempDirs.push(tempDir);
  const baseConfig = createMinimalConfig(join(tempDir, "lcm.db"));
  const config = configOverrides
    ? {
        ...baseConfig,
        ...configOverrides,
        cacheAwareCompaction: {
          ...baseConfig.cacheAwareCompaction,
          ...(configOverrides.cacheAwareCompaction ?? {}),
        },
      }
    : baseConfig;
  const db = createLcmDatabaseConnection(config.databasePath);
  dbs.push(db);
  return new LcmContextEngine(createMinimalDeps(config), db);
}

function makeHotCodexTelemetry(
  overrides?: Partial<ConversationCompactionTelemetryRecord>,
): ConversationCompactionTelemetryRecord {
  return {
    conversationId: 1,
    lastObservedCacheRead: 100_000,
    lastObservedCacheWrite: 0,
    lastObservedCacheHitAt: new Date(Date.now() - 30_000),
    lastObservedCacheBreakAt: null,
    cacheState: "hot",
    retention: null,
    lastLeafCompactionAt: new Date(Date.now() - 60_000),
    turnsSinceLeafCompaction: 1,
    tokensAccumulatedSinceLeafCompaction: 50_000,
    lastActivityBand: "high",
    consecutiveColdObservations: 0,
    lastApiCallAt: new Date(Date.now() - 30_000),
    lastCacheTouchAt: new Date(Date.now() - 30_000),
    provider: "openai-codex",
    model: "gpt-5.5",
    lastObservedPromptTokenCount: 100_000,
    updatedAt: new Date(),
    ...overrides,
  } as ConversationCompactionTelemetryRecord;
}

describe("shouldDelayPromptMutatingDeferredCompaction (cache-aware deferral gate)", () => {
  it("defers when cache-aware is enabled, provider is mutation-sensitive, cache is hot, and budget pressure is low", () => {
    const engine = createEngine();
    const gate = (engine as unknown as {
      shouldDelayPromptMutatingDeferredCompaction: (
        telemetry: ConversationCompactionTelemetryRecord | null,
        now?: Date,
        currentTokenCount?: number,
        tokenBudget?: number,
      ) => boolean;
    }).shouldDelayPromptMutatingDeferredCompaction.bind(engine);

    expect(gate(makeHotCodexTelemetry(), new Date(), 100_000, 200_000)).toBe(true);
  });

  it("does NOT defer when cacheAwareCompaction.enabled is false (operator opt-out)", () => {
    const engine = createEngine({
      cacheAwareCompaction: {
        enabled: false,
      } as LcmConfig["cacheAwareCompaction"],
    });
    const gate = (engine as unknown as {
      shouldDelayPromptMutatingDeferredCompaction: (
        telemetry: ConversationCompactionTelemetryRecord | null,
        now?: Date,
        currentTokenCount?: number,
        tokenBudget?: number,
      ) => boolean;
    }).shouldDelayPromptMutatingDeferredCompaction.bind(engine);

    expect(gate(makeHotCodexTelemetry(), new Date(), 100_000, 200_000)).toBe(false);
  });

  it("does NOT silently disable when enabled is undefined or null (must be explicit === false)", () => {
    // Adversarial review caught this: `if (!enabled)` is falsy, so undefined
    // or null would also disable — inconsistent with the rest of the codebase
    // which uses `enabled === true`. Fix uses `enabled === false` explicitly.
    for (const value of [undefined, null]) {
      const engine = createEngine({
        cacheAwareCompaction: {
          enabled: value as unknown as boolean,
        } as LcmConfig["cacheAwareCompaction"],
      });
      const gate = (engine as unknown as {
        shouldDelayPromptMutatingDeferredCompaction: (
          telemetry: ConversationCompactionTelemetryRecord | null,
          now?: Date,
          currentTokenCount?: number,
          tokenBudget?: number,
        ) => boolean;
      }).shouldDelayPromptMutatingDeferredCompaction.bind(engine);

      // With hot codex telemetry + low pressure, undefined/null should NOT
      // short-circuit to false. The gate should fall through to cache logic.
      expect(gate(makeHotCodexTelemetry(), new Date(), 100_000, 200_000))
        .toBe(true); // cache-hot defers
    }
  });

  it("does NOT defer when prompt is at or above the critical pressure ratio (0.70 default)", () => {
    const engine = createEngine();
    const gate = (engine as unknown as {
      shouldDelayPromptMutatingDeferredCompaction: (
        telemetry: ConversationCompactionTelemetryRecord | null,
        now?: Date,
        currentTokenCount?: number,
        tokenBudget?: number,
      ) => boolean;
    }).shouldDelayPromptMutatingDeferredCompaction.bind(engine);

    // 140,001 / 200,000 = 0.700005 — above the 0.70 ratio
    expect(gate(makeHotCodexTelemetry(), new Date(), 140_001, 200_000)).toBe(false);
    // 140,000 / 200,000 = 0.70 exactly — at the ratio (>= comparison)
    expect(gate(makeHotCodexTelemetry(), new Date(), 140_000, 200_000)).toBe(false);
    // 139,999 / 200,000 = 0.699995 — below the ratio
    expect(gate(makeHotCodexTelemetry(), new Date(), 139_999, 200_000)).toBe(true);
  });

  it("respects a custom criticalBudgetPressureRatio override", () => {
    const engine = createEngine({
      cacheAwareCompaction: {
        criticalBudgetPressureRatio: 0.5,
      } as LcmConfig["cacheAwareCompaction"],
    });
    const gate = (engine as unknown as {
      shouldDelayPromptMutatingDeferredCompaction: (
        telemetry: ConversationCompactionTelemetryRecord | null,
        now?: Date,
        currentTokenCount?: number,
        tokenBudget?: number,
      ) => boolean;
    }).shouldDelayPromptMutatingDeferredCompaction.bind(engine);

    // 100,001 / 200,000 = 0.5005 — above 0.5
    expect(gate(makeHotCodexTelemetry(), new Date(), 100_001, 200_000)).toBe(false);
    // 99,999 / 200,000 = 0.499995 — below 0.5
    expect(gate(makeHotCodexTelemetry(), new Date(), 99_999, 200_000)).toBe(true);
  });

  it("setting criticalBudgetPressureRatio >= 1 truly disables the bypass (matches docs)", () => {
    const engine = createEngine({
      cacheAwareCompaction: {
        criticalBudgetPressureRatio: 1,
      } as LcmConfig["cacheAwareCompaction"],
    });
    const gate = (engine as unknown as {
      shouldDelayPromptMutatingDeferredCompaction: (
        telemetry: ConversationCompactionTelemetryRecord | null,
        now?: Date,
        currentTokenCount?: number,
        tokenBudget?: number,
      ) => boolean;
    }).shouldDelayPromptMutatingDeferredCompaction.bind(engine);

    // Even when prompt is at the budget, cache delay still applies — the
    // documented "set to 1 to disable the override" semantics must hold.
    expect(gate(makeHotCodexTelemetry(), new Date(), 200_000, 200_000)).toBe(true);
    // Even at 200% over budget, the cache delay still applies.
    expect(gate(makeHotCodexTelemetry(), new Date(), 400_000, 200_000)).toBe(true);
  });

  it("ignores invalid currentTokenCount or tokenBudget for the pressure check (falls through to cache logic)", () => {
    const engine = createEngine();
    const gate = (engine as unknown as {
      shouldDelayPromptMutatingDeferredCompaction: (
        telemetry: ConversationCompactionTelemetryRecord | null,
        now?: Date,
        currentTokenCount?: number,
        tokenBudget?: number,
      ) => boolean;
    }).shouldDelayPromptMutatingDeferredCompaction.bind(engine);

    // Missing args — pressure check defers, so cache logic decides → hot codex returns true
    expect(gate(makeHotCodexTelemetry())).toBe(true);
    // Negative budget — pressure check ignores, cache logic decides → true
    expect(gate(makeHotCodexTelemetry(), new Date(), 100_000, -1)).toBe(true);
    // Zero budget — pressure check ignores, cache logic decides → true
    expect(gate(makeHotCodexTelemetry(), new Date(), 100_000, 0)).toBe(true);
  });

  it("does not defer when provider is not mutation-sensitive (e.g. plain openai)", () => {
    const engine = createEngine();
    const gate = (engine as unknown as {
      shouldDelayPromptMutatingDeferredCompaction: (
        telemetry: ConversationCompactionTelemetryRecord | null,
        now?: Date,
        currentTokenCount?: number,
        tokenBudget?: number,
      ) => boolean;
    }).shouldDelayPromptMutatingDeferredCompaction.bind(engine);

    expect(
      gate(
        makeHotCodexTelemetry({ provider: "openai", model: "gpt-4o" }),
        new Date(),
        100_000,
        200_000,
      ),
    ).toBe(false);
  });
});
