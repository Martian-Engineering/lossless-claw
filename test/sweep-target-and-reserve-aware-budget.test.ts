/**
 * Tests for the sweep-target / reserve-aware budget alignment work.
 *
 * Two related capabilities ship together:
 *   1. `sweepTargetThreshold` — decouples "where sweep STOPS" from
 *      "where compaction is REQUESTED" (the existing `contextThreshold`).
 *   2. Reserve-aware budget alignment — `runtimeContext.reserveTokens` is
 *      subtracted from the resolved tokenBudget so LCM percentages compute
 *      against the EFFECTIVE prompt budget (the same number the runtime
 *      actually overflows at), not the raw context window.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveLcmConfig } from "../src/db/config.js";
import type { LcmConfig } from "../src/db/config.js";
import { closeLcmConnection, createLcmDatabaseConnection } from "../src/db/connection.js";
import { LcmContextEngine } from "../src/engine.js";
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
 * the production runtime uses) and only overriding the database path.
 * This keeps the test in sync with future LcmConfig additions automatically.
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

function createEngine(): LcmContextEngine {
  const tempDir = mkdtempSync(join(tmpdir(), "lcm-sweep-target-"));
  tempDirs.push(tempDir);
  const config = createMinimalConfig(join(tempDir, "lcm.db"));
  const db = createLcmDatabaseConnection(config.databasePath);
  dbs.push(db);
  return new LcmContextEngine(createMinimalDeps(config), db);
}

/** Variant that also returns the deps (so tests can spy on log.warn etc). */
function createEngineWithDeps(): { engine: LcmContextEngine; deps: LcmDependencies } {
  const tempDir = mkdtempSync(join(tmpdir(), "lcm-sweep-target-"));
  tempDirs.push(tempDir);
  const config = createMinimalConfig(join(tempDir, "lcm.db"));
  const db = createLcmDatabaseConnection(config.databasePath);
  dbs.push(db);
  const deps = createMinimalDeps(config);
  const engine = new LcmContextEngine(deps, db);
  return { engine, deps };
}

describe("sweepTargetThreshold config resolution", () => {
  it("defaults to 0.50 when no env or plugin config provided", () => {
    const config = resolveLcmConfig({}, {});
    expect(config.sweepTargetThreshold).toBe(0.50);
  });

  it("reads sweepTargetThreshold from plugin config", () => {
    const config = resolveLcmConfig({}, { sweepTargetThreshold: 0.40 });
    expect(config.sweepTargetThreshold).toBe(0.40);
  });

  it("LCM_SWEEP_TARGET_THRESHOLD env var overrides plugin config", () => {
    const config = resolveLcmConfig(
      { LCM_SWEEP_TARGET_THRESHOLD: "0.30" } as NodeJS.ProcessEnv,
      { sweepTargetThreshold: 0.45 },
    );
    expect(config.sweepTargetThreshold).toBe(0.30);
  });

  it("clamps out-of-range values to [0, 1]", () => {
    expect(resolveLcmConfig({}, { sweepTargetThreshold: -0.5 }).sweepTargetThreshold).toBe(0);
    expect(resolveLcmConfig({}, { sweepTargetThreshold: 1.5 }).sweepTargetThreshold).toBe(1);
  });

  it("falls back to 0.50 when value is non-finite", () => {
    expect(resolveLcmConfig({}, { sweepTargetThreshold: Number.NaN }).sweepTargetThreshold).toBe(
      0.50,
    );
  });
});

describe("sweepTriggerThreshold + pressureTiers config resolution", () => {
  it("defaults to sweepTriggerThreshold = 0.91", () => {
    expect(resolveLcmConfig({}, {}).sweepTriggerThreshold).toBe(0.91);
  });

  it("env var overrides plugin config for sweepTriggerThreshold", () => {
    const config = resolveLcmConfig(
      { LCM_SWEEP_TRIGGER_THRESHOLD: "0.95" } as NodeJS.ProcessEnv,
      { sweepTriggerThreshold: 0.85 },
    );
    expect(config.sweepTriggerThreshold).toBe(0.95);
  });

  it("clamps sweepTriggerThreshold to [0, 1]", () => {
    expect(resolveLcmConfig({}, { sweepTriggerThreshold: 2 }).sweepTriggerThreshold).toBe(1);
    expect(resolveLcmConfig({}, { sweepTriggerThreshold: -1 }).sweepTriggerThreshold).toBe(0);
  });

  it("defaults pressureTiers to [tier1=0.70/2pass, tier2=0.80/3pass]", () => {
    expect(resolveLcmConfig({}, {}).pressureTiers).toEqual([
      { ratio: 0.70, maxPasses: 2 },
      { ratio: 0.80, maxPasses: 3 },
    ]);
  });

  it("reads pressureTiers from plugin config and sorts ascending by ratio", () => {
    const config = resolveLcmConfig({}, {
      pressureTiers: [
        { ratio: 0.85, maxPasses: 4 }, // out of order
        { ratio: 0.65, maxPasses: 1 },
        { ratio: 0.75, maxPasses: 2 },
      ],
    });
    expect(config.pressureTiers).toEqual([
      { ratio: 0.65, maxPasses: 1 },
      { ratio: 0.75, maxPasses: 2 },
      { ratio: 0.85, maxPasses: 4 },
    ]);
  });

  it("env var overrides plugin pressureTiers (parses JSON array)", () => {
    const config = resolveLcmConfig(
      {
        LCM_PRESSURE_TIERS:
          '[{"ratio":0.65,"maxPasses":2},{"ratio":0.85,"maxPasses":5}]',
      } as NodeJS.ProcessEnv,
      { pressureTiers: [{ ratio: 0.5, maxPasses: 9 }] },
    );
    expect(config.pressureTiers).toEqual([
      { ratio: 0.65, maxPasses: 2 },
      { ratio: 0.85, maxPasses: 5 },
    ]);
  });

  it("falls back to defaults when pressureTiers is malformed or empty", () => {
    expect(
      resolveLcmConfig({}, { pressureTiers: "not-an-array" as unknown as unknown[] })
        .pressureTiers,
    ).toEqual([
      { ratio: 0.70, maxPasses: 2 },
      { ratio: 0.80, maxPasses: 3 },
    ]);
    expect(resolveLcmConfig({}, { pressureTiers: [] }).pressureTiers).toEqual([
      { ratio: 0.70, maxPasses: 2 },
      { ratio: 0.80, maxPasses: 3 },
    ]);
  });

  it("filters out invalid tier entries (ratio out of (0,1) or maxPasses < 1)", () => {
    const config = resolveLcmConfig({}, {
      pressureTiers: [
        { ratio: 0.50, maxPasses: 2 }, // valid
        { ratio: 0, maxPasses: 1 }, // invalid: ratio not strictly > 0
        { ratio: 1, maxPasses: 1 }, // invalid: ratio not strictly < 1
        { ratio: 0.75, maxPasses: 0 }, // invalid: maxPasses < 1
        { ratio: "bad", maxPasses: 2 }, // invalid: ratio not number
      ],
    });
    expect(config.pressureTiers).toEqual([{ ratio: 0.50, maxPasses: 2 }]);
  });
});

describe("resolvePressureDispatchPolicy (engine pressure-tiered dispatch)", () => {
  function getPolicy(engine: LcmContextEngine) {
    return (engine as unknown as {
      resolvePressureDispatchPolicy: (input: {
        currentTokenCount?: number;
        tokenBudget: number;
      }) => { targetRatio: number; maxPasses?: number };
    }).resolvePressureDispatchPolicy.bind(engine);
  }

  it("at <70% pressure: 1 pass max, target = contextThreshold (0.60)", () => {
    const engine = createEngine();
    const policy = getPolicy(engine);
    const result = policy({ currentTokenCount: 130_000, tokenBudget: 200_000 }); // 65%
    expect(result).toEqual({ targetRatio: 0.60, maxPasses: 1 });
  });

  it("at 70-80% (tier 1): 2 passes max, target = contextThreshold", () => {
    const engine = createEngine();
    const policy = getPolicy(engine);
    const result = policy({ currentTokenCount: 150_000, tokenBudget: 200_000 }); // 75%
    expect(result).toEqual({ targetRatio: 0.60, maxPasses: 2 });
  });

  it("at 80-91% (tier 2): 3 passes max, target = contextThreshold", () => {
    const engine = createEngine();
    const policy = getPolicy(engine);
    const result = policy({ currentTokenCount: 170_000, tokenBudget: 200_000 }); // 85%
    expect(result).toEqual({ targetRatio: 0.60, maxPasses: 3 });
  });

  it("at >=91% (sweep mode): no maxPasses, target = sweepTargetThreshold (0.50)", () => {
    const engine = createEngine();
    const policy = getPolicy(engine);
    const result = policy({ currentTokenCount: 184_000, tokenBudget: 200_000 }); // 92%
    expect(result).toEqual({ targetRatio: 0.50 });
  });

  it("at exactly tier-1 boundary (70%): 2 passes (>= comparison)", () => {
    const engine = createEngine();
    const policy = getPolicy(engine);
    const result = policy({ currentTokenCount: 140_000, tokenBudget: 200_000 }); // exactly 70%
    expect(result).toEqual({ targetRatio: 0.60, maxPasses: 2 });
  });

  it("at exactly sweep boundary (91%): sweep mode (>= comparison)", () => {
    const engine = createEngine();
    const policy = getPolicy(engine);
    const result = policy({ currentTokenCount: 182_000, tokenBudget: 200_000 }); // exactly 91%
    expect(result).toEqual({ targetRatio: 0.50 });
  });

  it("falls back to GENTLEST policy when currentTokenCount is unknown (safe default, NOT aggressive sweep)", () => {
    // When pressure is unknown, the dispatcher should NOT silently jump into
    // sweep mode (deep target, no pass cap). That used to be the behavior for
    // "PR #558 backward compat" but it's the opposite of safe defaults —
    // under-instrumented callers should get gentle 1-pass dispatches, not
    // surprise multi-pass sweeps. Adversarial review caught this.
    const engine = createEngine();
    const policy = getPolicy(engine);
    expect(policy({ tokenBudget: 200_000 })).toEqual({
      targetRatio: 0.60,
      maxPasses: 1,
    });
    expect(policy({ currentTokenCount: 0, tokenBudget: 200_000 })).toEqual({
      targetRatio: 0.60,
      maxPasses: 1,
    });
    expect(policy({ currentTokenCount: -5, tokenBudget: 200_000 })).toEqual({
      targetRatio: 0.60,
      maxPasses: 1,
    });
  });

  it("treats engine-side empty pressureTiers array as undefined (falls back to defaults)", () => {
    // Adversarial sweep flagged: the resolver-side fallback for empty
    // arrays has tests, but the engine-side defense (caller constructs
    // LcmConfig literal with `pressureTiers: []` bypassing the resolver)
    // had no direct test. Adding one.
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-sweep-target-empty-"));
    tempDirs.push(tempDir);
    const baseConfig = createMinimalConfig(join(tempDir, "lcm.db"));
    const config: LcmConfig = {
      ...baseConfig,
      pressureTiers: [], // empty — should fall back to default ladder at use-time
    };
    const db = createLcmDatabaseConnection(config.databasePath);
    dbs.push(db);
    const engine = new LcmContextEngine(createMinimalDeps(config), db);
    const policy = (engine as unknown as {
      resolvePressureDispatchPolicy: (input: {
        currentTokenCount?: number;
        tokenBudget: number;
      }) => { targetRatio: number; maxPasses?: number };
    }).resolvePressureDispatchPolicy.bind(engine);

    // 75% pressure should reach default tier-1 (ratio 0.70, maxPasses 2)
    expect(policy({ currentTokenCount: 150_000, tokenBudget: 200_000 })).toEqual({
      targetRatio: 0.60,
      maxPasses: 2,
    });
    // 85% pressure should reach default tier-2 (ratio 0.80, maxPasses 3)
    expect(policy({ currentTokenCount: 170_000, tokenBudget: 200_000 })).toEqual({
      targetRatio: 0.60,
      maxPasses: 3,
    });
  });

  it("defensively floors fractional maxPasses + filters non-finite tier ratios at use-time", () => {
    // Bypasses the resolver to inject malformed tiers directly — covers the
    // defense-in-depth code path inside resolvePressureDispatchPolicy when a
    // future caller constructs LcmConfig literally without going through
    // resolveLcmConfig. Adversarial sweep flagged this code as untested.
    const tempDir = mkdtempSync(join(tmpdir(), "lcm-sweep-target-tier-"));
    tempDirs.push(tempDir);
    const baseConfig = createMinimalConfig(join(tempDir, "lcm.db"));
    const config: LcmConfig = {
      ...baseConfig,
      pressureTiers: [
        { ratio: 0.70, maxPasses: 2.7 },                  // fractional → floors to 2
        { ratio: Number.NaN as unknown as number, maxPasses: 9 }, // non-finite → filtered
        { ratio: 0.80, maxPasses: 3 },
      ],
    };
    const db = createLcmDatabaseConnection(config.databasePath);
    dbs.push(db);
    const engine = new LcmContextEngine(createMinimalDeps(config), db);
    const policy = (engine as unknown as {
      resolvePressureDispatchPolicy: (input: {
        currentTokenCount?: number;
        tokenBudget: number;
      }) => { targetRatio: number; maxPasses?: number };
    }).resolvePressureDispatchPolicy.bind(engine);

    // 75% pressure crosses tier-1 (0.70) but not tier-2 (0.80)
    // → fractional 2.7 floored to 2, NaN tier filtered
    expect(policy({ currentTokenCount: 150_000, tokenBudget: 200_000 })).toEqual({
      targetRatio: 0.60,
      maxPasses: 2,
    });
    // 85% pressure crosses both tier-1 and tier-2 → tier-2 wins (3)
    expect(policy({ currentTokenCount: 170_000, tokenBudget: 200_000 })).toEqual({
      targetRatio: 0.60,
      maxPasses: 3,
    });
  });
});

describe("reserve-aware budget alignment (resolveTokenBudget)", () => {
  it("subtracts runtimeContext.reserveTokens from the resolved budget", () => {
    const engine = createEngine();
    const resolve = (engine as unknown as {
      resolveTokenBudget: (params: {
        tokenBudget?: number;
        runtimeContext?: Record<string, unknown>;
        legacyParams?: Record<string, unknown>;
      }) => number | undefined;
    }).resolveTokenBudget.bind(engine);

    expect(
      resolve({ tokenBudget: 258_000, runtimeContext: { reserveTokens: 50_000 } }),
    ).toBe(208_000);
  });

  it("also accepts legacy reserveTokensFloor key from openclaw runtime", () => {
    const engine = createEngine();
    const resolve = (engine as unknown as {
      resolveTokenBudget: (params: {
        tokenBudget?: number;
        runtimeContext?: Record<string, unknown>;
        legacyParams?: Record<string, unknown>;
      }) => number | undefined;
    }).resolveTokenBudget.bind(engine);

    expect(
      resolve({ tokenBudget: 258_000, runtimeContext: { reserveTokensFloor: 20_000 } }),
    ).toBe(238_000);
  });

  it("preserves legacy behavior when no reserve is supplied", () => {
    const engine = createEngine();
    const resolve = (engine as unknown as {
      resolveTokenBudget: (params: {
        tokenBudget?: number;
        runtimeContext?: Record<string, unknown>;
        legacyParams?: Record<string, unknown>;
      }) => number | undefined;
    }).resolveTokenBudget.bind(engine);

    expect(resolve({ tokenBudget: 258_000, runtimeContext: {} })).toBe(258_000);
    expect(resolve({ tokenBudget: 258_000 })).toBe(258_000);
  });

  it("ignores invalid or zero reserve values", () => {
    const engine = createEngine();
    const resolve = (engine as unknown as {
      resolveTokenBudget: (params: {
        tokenBudget?: number;
        runtimeContext?: Record<string, unknown>;
        legacyParams?: Record<string, unknown>;
      }) => number | undefined;
    }).resolveTokenBudget.bind(engine);

    expect(resolve({ tokenBudget: 258_000, runtimeContext: { reserveTokens: 0 } })).toBe(258_000);
    expect(resolve({ tokenBudget: 258_000, runtimeContext: { reserveTokens: -100 } })).toBe(
      258_000,
    );
    expect(resolve({ tokenBudget: 258_000, runtimeContext: { reserveTokens: "not a number" } }))
      .toBe(258_000);
  });

  it("ignores reserve and logs a warn when reserve >= raw budget (misconfig safety)", () => {
    // Previous behavior: silently floored to 1 → propagated degenerate budget
    // through compactFullSweep causing pathological 0-target loops. New
    // behavior: ignore the reserve, log a warning, return the raw budget.
    // Adversarial review caught this; the followup adversarial sweep flagged
    // that the test wasn't actually asserting the warn was called.
    const { engine, deps } = createEngineWithDeps();
    const resolve = (engine as unknown as {
      resolveTokenBudget: (params: {
        tokenBudget?: number;
        runtimeContext?: Record<string, unknown>;
        legacyParams?: Record<string, unknown>;
      }) => number | undefined;
    }).resolveTokenBudget.bind(engine);

    // Reserve > budget → ignore reserve, return raw budget
    expect(
      resolve({ tokenBudget: 100_000, runtimeContext: { reserveTokens: 200_000 } }),
    ).toBe(100_000);
    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("misconfigured reserve"),
    );

    // Reserve == budget → also ignored
    (deps.log.warn as ReturnType<typeof vi.fn>).mockClear();
    expect(
      resolve({ tokenBudget: 100_000, runtimeContext: { reserveTokens: 100_000 } }),
    ).toBe(100_000);
    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("misconfigured reserve"),
    );
  });

  it("prefers reserveTokens over reserveTokensFloor when both are present", () => {
    const engine = createEngine();
    const resolve = (engine as unknown as {
      resolveTokenBudget: (params: {
        tokenBudget?: number;
        runtimeContext?: Record<string, unknown>;
        legacyParams?: Record<string, unknown>;
      }) => number | undefined;
    }).resolveTokenBudget.bind(engine);

    expect(
      resolve({
        tokenBudget: 258_000,
        runtimeContext: { reserveTokens: 30_000, reserveTokensFloor: 50_000 },
      }),
    ).toBe(228_000);
  });

  it("does NOT double-subtract reserve when alreadyReserveAdjusted=true (deferred-compaction drain path)", () => {
    // Scenario:
    //   1. afterTurn calls resolveTokenBudget(258K, {reserveTokens:20K}) → 238K (adjusted)
    //   2. 238K is recorded in maintenance debt
    //   3. maintain() drains debt: calls executeCompactionCore({tokenBudget:238K, runtimeContext:{reserveTokens:20K}})
    //   4. executeCompactionCore calls resolveTokenBudget with alreadyReserveAdjusted=true
    //   5. Without the flag, 238K - 20K = 218K (BUG — pressure ratios computed against 218K instead of 238K)
    //   6. With the flag, 238K is preserved
    const engine = createEngine();
    const resolve = (engine as unknown as {
      resolveTokenBudget: (params: {
        tokenBudget?: number;
        runtimeContext?: Record<string, unknown>;
        legacyParams?: Record<string, unknown>;
        alreadyReserveAdjusted?: boolean;
      }) => number | undefined;
    }).resolveTokenBudget.bind(engine);

    // Without the flag (public entry path) — subtracts reserve as expected
    expect(
      resolve({ tokenBudget: 258_000, runtimeContext: { reserveTokens: 20_000 } }),
    ).toBe(238_000);

    // With the flag (internal pass-through path) — preserves the already-adjusted value
    expect(
      resolve({
        tokenBudget: 238_000,
        runtimeContext: { reserveTokens: 20_000 },
        alreadyReserveAdjusted: true,
      }),
    ).toBe(238_000);
  });

  it("alreadyReserveAdjusted only skips when tokenBudget is explicit (runtimeContext fallback still applies reserve)", () => {
    // The flag's contract: "the explicit tokenBudget is already adjusted".
    // It MUST NOT short-circuit the runtimeContext fallback path, where the
    // runtime is providing a raw value that needs adjustment.
    const engine = createEngine();
    const resolve = (engine as unknown as {
      resolveTokenBudget: (params: {
        tokenBudget?: number;
        runtimeContext?: Record<string, unknown>;
        legacyParams?: Record<string, unknown>;
        alreadyReserveAdjusted?: boolean;
      }) => number | undefined;
    }).resolveTokenBudget.bind(engine);

    // No explicit tokenBudget, falls back to runtimeContext.tokenBudget — reserve applies
    expect(
      resolve({
        tokenBudget: undefined,
        runtimeContext: { tokenBudget: 258_000, reserveTokens: 20_000 },
        alreadyReserveAdjusted: true,
      }),
    ).toBe(238_000);
  });
});
