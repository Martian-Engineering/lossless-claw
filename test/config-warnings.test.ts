import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveLcmConfig, resolveLcmConfigWithDiagnostics } from "../src/db/config.js";
import {
  CONFIG_WARNING_NOT_CHECKED,
  CONFIG_WARNING_SETTINGS,
  collectConfigWarnings,
  type LcmConfigWarning,
} from "../src/db/config-warnings.js";

/** Fixed host values so the resolved paths and timezone do not depend on the machine. */
const BASE_ENV = { OPENCLAW_STATE_DIR: "/identity-state", TZ: "UTC" };

type IdentityCase = [label: string, env: Record<string, string>, pluginConfig: Record<string, unknown>];

const ENV_IDENTITY_VALUES: Array<[string, string[]]> = [
  ["LCM_ENABLED", ["false", "true", "tru", ""]],
  ["LCM_HOST_FALLBACK_MODE", ["capture-only", "error", "bogus", "  ", "Capture-Only"]],
  ["LCM_SKIP_STATELESS_SESSIONS", ["true", "false", "tru"]],
  ["LCM_PROMPT_AWARE_EVICTION_ENABLED", ["true", "tru"]],
  ["LCM_STUB_LARGE_TOOL_PAYLOADS", ["yes"]],
  ["LCM_PRUNE_HEARTBEAT_OK", ["1", "true"]],
  ["LCM_PRESERVE_HEARTBEAT_POLL", ["1", "0", "yes"]],
  ["LCM_ENABLE_SUMMARY_THINKING", ["false", "nope"]],
  ["LCM_DYNAMIC_LEAF_CHUNK_TOKENS_ENABLED", ["tru"]],
  ["LCM_LOG_FILE_ENABLED", ["false", "fals"]],
  ["LCM_CACHE_AWARE_COMPACTION_ENABLED", ["off"]],
  ["LCM_CONTEXT_THRESHOLD", ["0.6", "x", "0.6abc"]],
  ["LCM_FRESH_TAIL_COUNT", ["32", "20abc", "1.5", "abc", "-5", "2.0"]],
  ["LCM_FRESH_TAIL_MAX_TOKENS", ["1000", "x"]],
  ["LCM_LEAF_CHUNK_TOKENS", ["30000", "1e3", "0x10"]],
  ["LCM_BOOTSTRAP_MAX_TOKENS", ["abc"]],
  ["LCM_SWEEP_MAX_DEPTH", ["2", "abc"]],
  ["LCM_INCREMENTAL_MAX_DEPTH", ["3"]],
  ["LCM_MAX_SWEEP_ITERATIONS", ["5", "0", "-4", "abc"]],
  ["LCM_SWEEP_DEADLINE_MS", ["0.5"]],
  ["LCM_SUMMARY_PREFIX_TARGET_TOKENS", ["0"]],
  ["LCM_LOG_MAX_FILE_BYTES", ["0", "abc"]],
  ["LCM_FALLBACK_MAX_TOKENS", ["64", "10", "abc", "100.5"]],
  ["LCM_REPLAY_FLOOD_THRESHOLD_EXTERNAL", ["5", "0", "1.5", "abc"]],
  ["LCM_REPLAY_FLOOD_THRESHOLD_INTERNAL", ["-1"]],
  ["LCM_PROACTIVE_THRESHOLD_COMPACTION_MODE", ["inline", "INLINE", "sideways", ""]],
  ["LCM_HOT_CACHE_PRESSURE_FACTOR", ["0.5", "x"]],
  ["LCM_HOT_CACHE_BUDGET_HEADROOM_RATIO", ["2"]],
  ["LCM_COLD_CACHE_OBSERVATION_THRESHOLD", ["0", "2.5"]],
  ["LCM_CRITICAL_BUDGET_PRESSURE_RATIO", ["-1"]],
  ["LCM_DELEGATION_TIMEOUT_MS", ["5000", "abc"]],
  ["LCM_SUMMARY_MAX_OVERAGE_FACTOR", ["x"]],
  ["LCM_CIRCUIT_BREAKER_THRESHOLD", ["x"]],
  ["LCM_DYNAMIC_LEAF_CHUNK_TOKENS_MAX", ["10"]],
];

const PLUGIN_IDENTITY_VALUES: Array<Record<string, unknown>> = [
  { enabled: "yes" },
  { enabled: "false" },
  { skipStatelessSessions: 1 },
  { promptAwareEviction: "true" },
  { independentLogFile: { enabled: "no" } },
  { cacheAwareCompaction: { enabled: 0 } },
  { dynamicLeafChunkTokens: { enabled: "x" } },
  { fallbackMaxTokens: 10 },
  { fallbackMaxTokens: 100.5 },
  { fallbackMaxTokens: "abc" },
  { replayFloodThresholdExternal: 0 },
  { replayFloodThresholdInternal: 2.5 },
  { proactiveThresholdCompactionMode: "sideways" },
  { proactiveThresholdCompactionMode: "Inline" },
  { hostFallbackMode: "bogus" },
  { hostFallbackMode: "capture-only" },
  { incrementalMaxDepth: 3 },
  { sweepMaxDepth: 2, incrementalMaxDepth: 3 },
  { transcriptGcEnabled: true },
  { autoRotateSessionFiles: { enabled: true } },
  { freshTailCount: "abc" },
  { maxSweepIterations: 0 },
  { maxSweepIterations: 2.7 },
  { cacheAwareCompaction: { hotCacheBudgetHeadroomRatio: 2 } },
];

const MIXED_IDENTITY_CASES: IdentityCase[] = [
  ["env invalid int, plugin valid", { LCM_FRESH_TAIL_COUNT: "abc" }, { freshTailCount: 10 }],
  ["env below minimum, plugin valid", { LCM_FALLBACK_MAX_TOKENS: "10" }, { fallbackMaxTokens: 256 }],
  ["env boolean typo, plugin false", { LCM_ENABLED: "tru" }, { enabled: false }],
  ["env enum typo, plugin valid", { LCM_PROACTIVE_THRESHOLD_COMPACTION_MODE: "sideways" }, { proactiveThresholdCompactionMode: "inline" }],
  ["env host typo, plugin capture-only", { LCM_HOST_FALLBACK_MODE: "bogus" }, { hostFallbackMode: "capture-only" }],
  ["env replay invalid, plugin invalid", { LCM_REPLAY_FLOOD_THRESHOLD_EXTERNAL: "0" }, { replayFloodThresholdExternal: -2 }],
];

/** Every identity input pair: env-only values, plugin-only values, then mixed pairs. */
const IDENTITY_CASES: IdentityCase[] = [
  ["defaults", {}, {}],
  ...ENV_IDENTITY_VALUES.flatMap(([name, values]) =>
    values.map((value): IdentityCase => [`env ${name}=${JSON.stringify(value)}`, { [name]: value }, {}]),
  ),
  ...PLUGIN_IDENTITY_VALUES.map((pluginConfig): IdentityCase => [
    `plugin ${JSON.stringify(pluginConfig)}`,
    {},
    pluginConfig,
  ]),
  ...MIXED_IDENTITY_CASES,
];

/** Return only the top-level keys whose resolved value differs from the defaults. */
function diffFromDefaults(
  config: Record<string, unknown>,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const diff: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(config), ...Object.keys(defaults)])) {
    if (JSON.stringify(config[key]) !== JSON.stringify(defaults[key])) {
      diff[key] = config[key] === undefined ? "<undefined>" : config[key];
    }
  }
  return diff;
}

describe("config resolution identity", () => {
  it("covers at least 40 input pairs", () => {
    expect(IDENTITY_CASES.length).toBeGreaterThanOrEqual(40);
  });

  it("resolves every input exactly as the pre-warnings resolver did", () => {
    const defaults = resolveLcmConfig({ ...BASE_ENV }, {}) as unknown as Record<string, unknown>;
    const resolved = Object.fromEntries(
      IDENTITY_CASES.map(([label, env, pluginConfig]) => [
        label,
        diffFromDefaults(
          resolveLcmConfig({ ...BASE_ENV, ...env }, pluginConfig) as unknown as Record<string, unknown>,
          defaults,
        ),
      ]),
    );
    // The snapshot was recorded on the base commit, before config warnings existed.
    expect({ defaults, resolved }).toMatchSnapshot();
  });
});

/** Shorthand for one expected warning. */
function warning(
  setting: string,
  source: LcmConfigWarning["source"],
  name: string,
  problem: LcmConfigWarning["problem"],
  effect: string,
): LcmConfigWarning {
  return { setting, source, name, problem, effect };
}

describe("collectConfigWarnings", () => {
  it.each<[string, Record<string, string>, Record<string, unknown>, LcmConfigWarning]>([
    ["int with trailing text", { LCM_FRESH_TAIL_COUNT: "20abc" }, {},
      warning("freshTailCount", "env", "LCM_FRESH_TAIL_COUNT", "trailing-text", "read only the leading number")],
    ["int with a fraction", { LCM_FRESH_TAIL_COUNT: "1.5" }, {},
      warning("freshTailCount", "env", "LCM_FRESH_TAIL_COUNT", "not-an-integer", "used the whole-number part")],
    ["int that is not a number", { LCM_FRESH_TAIL_COUNT: "abc" }, {},
      warning("freshTailCount", "env", "LCM_FRESH_TAIL_COUNT", "not-a-number", "used the default (64)")],
    ["int that falls back to plugin config", { LCM_FRESH_TAIL_COUNT: "abc" }, { freshTailCount: 10 },
      warning("freshTailCount", "env", "LCM_FRESH_TAIL_COUNT", "not-a-number", "used the plugin config value")],
    ["number that is not a number", { LCM_CONTEXT_THRESHOLD: "x" }, {},
      warning("contextThreshold", "env", "LCM_CONTEXT_THRESHOLD", "not-a-number", "used the default (0.75)")],
    ["positive int clamped from zero", { LCM_MAX_SWEEP_ITERATIONS: "0" }, {},
      warning("maxSweepIterations", "env", "LCM_MAX_SWEEP_ITERATIONS", "clamped", "raised to 1")],
    ["true-only boolean typo", { LCM_SKIP_STATELESS_SESSIONS: "tru" }, {},
      warning("skipStatelessSessions", "env", "LCM_SKIP_STATELESS_SESSIONS", "not-a-boolean", "read as false")],
    ["unless-false boolean typo", { LCM_ENABLED: "tru" }, {},
      warning("enabled", "env", "LCM_ENABLED", "not-a-boolean", "read as true")],
    ["unknown host fallback mode", { LCM_HOST_FALLBACK_MODE: "bogus" }, { hostFallbackMode: "capture-only" },
      warning("hostFallbackMode", "env", "LCM_HOST_FALLBACK_MODE", "unknown-choice", "used the default (error)")],
    ["unknown proactive mode", { LCM_PROACTIVE_THRESHOLD_COMPACTION_MODE: "sideways" }, { proactiveThresholdCompactionMode: "inline" },
      warning("proactiveThresholdCompactionMode", "env", "LCM_PROACTIVE_THRESHOLD_COMPACTION_MODE", "unknown-choice", "used the plugin config value")],
    ["fallback tokens below the minimum", { LCM_FALLBACK_MAX_TOKENS: "10" }, {},
      warning("fallbackMaxTokens", "env", "LCM_FALLBACK_MAX_TOKENS", "below-minimum", "used the default (512)")],
    ["ratio out of range", { LCM_HOT_CACHE_BUDGET_HEADROOM_RATIO: "2" }, {},
      warning("cacheAwareCompaction.hotCacheBudgetHeadroomRatio", "env", "LCM_HOT_CACHE_BUDGET_HEADROOM_RATIO", "out-of-range", "clamped to 0.95")],
    ["deprecated env alias", { LCM_INCREMENTAL_MAX_DEPTH: "3" }, {},
      warning("incrementalMaxDepth", "env", "LCM_INCREMENTAL_MAX_DEPTH", "deprecated", "read as sweepMaxDepth")],
    ["deprecated plugin alias", {}, { incrementalMaxDepth: 3 },
      warning("incrementalMaxDepth", "plugin-config", "incrementalMaxDepth", "deprecated", "read as sweepMaxDepth")],
    ["retired plugin key", {}, { transcriptGcEnabled: true },
      warning("transcriptGcEnabled", "plugin-config", "transcriptGcEnabled", "retired", "ignored")],
    ["plugin below the minimum", {}, { fallbackMaxTokens: 10 },
      warning("fallbackMaxTokens", "plugin-config", "fallbackMaxTokens", "below-minimum", "used the default (512)")],
    ["plugin strict integer with a fraction", {}, { replayFloodThresholdInternal: 2.5 },
      warning("replayFloodThresholdInternal", "plugin-config", "replayFloodThresholdInternal", "not-an-integer", "used the default (32)")],
    ["plugin boolean that is not a boolean", {}, { cacheAwareCompaction: { enabled: "no" } },
      warning("cacheAwareCompaction.enabled", "plugin-config", "cacheAwareCompaction.enabled", "not-a-boolean", "used the default (true)")],
    ["plugin unknown choice", {}, { proactiveThresholdCompactionMode: "sideways" },
      warning("proactiveThresholdCompactionMode", "plugin-config", "proactiveThresholdCompactionMode", "unknown-choice", "used the default (deferred)")],
  ])("reports %s", (_label, env, pluginConfig, expected) => {
    expect(collectConfigWarnings(env, pluginConfig)).toEqual([expected]);
  });

  it("reports nothing for defaults and unset inputs", () => {
    expect(collectConfigWarnings({}, {})).toEqual([]);
    expect(collectConfigWarnings({}, undefined)).toEqual([]);
    expect(collectConfigWarnings({ LCM_FRESH_TAIL_COUNT: "" }, {})).toEqual([]);
  });

  it("reports nothing for valid env and plugin values", () => {
    const env = {
      LCM_ENABLED: "false",
      LCM_HOST_FALLBACK_MODE: "capture-only",
      LCM_SKIP_STATELESS_SESSIONS: "true",
      LCM_PRESERVE_HEARTBEAT_POLL: "1",
      LCM_CONTEXT_THRESHOLD: "0.6",
      LCM_FRESH_TAIL_COUNT: "32",
      LCM_MAX_SWEEP_ITERATIONS: "5",
      LCM_FALLBACK_MAX_TOKENS: "64",
      LCM_REPLAY_FLOOD_THRESHOLD_EXTERNAL: "5",
      LCM_PROACTIVE_THRESHOLD_COMPACTION_MODE: "INLINE",
      LCM_HOT_CACHE_BUDGET_HEADROOM_RATIO: "0.5",
      LCM_DELEGATION_TIMEOUT_MS: "5000",
    };
    const pluginConfig = {
      enabled: "true",
      promptAwareEviction: true,
      fallbackMaxTokens: 256,
      replayFloodThresholdInternal: 8,
      proactiveThresholdCompactionMode: "deferred",
      hostFallbackMode: "error",
      sweepMaxDepth: 2,
      independentLogFile: { enabled: false, maxFileBytes: 4096 },
      cacheAwareCompaction: { enabled: true, criticalBudgetPressureRatio: 0.8 },
    };
    expect(collectConfigWarnings(env, {})).toEqual([]);
    expect(collectConfigWarnings({}, pluginConfig)).toEqual([]);
  });

  it("does not report a plugin value that a valid env value overrides", () => {
    expect(collectConfigWarnings({ LCM_FALLBACK_MAX_TOKENS: "256" }, { fallbackMaxTokens: 10 })).toEqual([]);
    expect(collectConfigWarnings({ LCM_ENABLED: "true" }, { enabled: "yes" })).toEqual([]);
  });

  it("never includes the raw value in a warning", () => {
    const sentinel = "SENTINEL-9f3";
    const pluginConfig: Record<string, unknown> = {};
    const env: Record<string, string> = {};
    for (const entry of CONFIG_WARNING_SETTINGS) {
      if (entry.env) env[entry.env] = sentinel;
      if (entry.path) {
        const [head, tail] = entry.path.split(".");
        if (tail) pluginConfig[head] = { ...(pluginConfig[head] as object), [tail]: sentinel };
        else pluginConfig[head] = sentinel;
      }
    }
    for (const warnings of [collectConfigWarnings(env, {}), collectConfigWarnings({}, pluginConfig)]) {
      expect(warnings.length).toBeGreaterThan(10);
      expect(JSON.stringify(warnings)).not.toContain("SENTINEL");
      expect(JSON.stringify(warnings)).not.toContain("9f3");
    }
  });

  it("is returned in the resolver diagnostics without changing the config", () => {
    const env = { ...BASE_ENV, LCM_FRESH_TAIL_COUNT: "abc" };
    const { config, diagnostics } = resolveLcmConfigWithDiagnostics(env, {});
    expect(diagnostics.warnings).toEqual(collectConfigWarnings(env, {}));
    expect(diagnostics.warnings).toHaveLength(1);
    expect(config).toEqual(resolveLcmConfig(env, {}));
  });

  it("checks or explicitly skips every env var the resolver reads", () => {
    const source = readFileSync(new URL("../src/db/config.ts", import.meta.url), "utf8");
    const read = new Set(source.match(/LCM_[A-Z0-9_]+/g));
    const checked = new Set(CONFIG_WARNING_SETTINGS.flatMap((entry) => (entry.env ? [entry.env] : [])));
    const skipped = Object.keys(CONFIG_WARNING_NOT_CHECKED);
    for (const name of read) {
      expect(checked.has(name) || skipped.includes(name), name).toBe(true);
    }
    for (const name of skipped) {
      expect(checked.has(name), `${name} is both checked and skipped`).toBe(false);
      expect(read.has(name), `${name} is no longer read`).toBe(true);
    }
  });
});

describe("collectConfigWarnings effect text", () => {
  it.each<[string, Record<string, string>, Record<string, unknown>, keyof ReturnType<typeof resolveLcmConfig>, unknown, LcmConfigWarning[]]>([
    ["invalid setting env, alias env used", { LCM_SWEEP_MAX_DEPTH: "abc", LCM_INCREMENTAL_MAX_DEPTH: "3" }, {}, "sweepMaxDepth", 3, [
      warning("sweepMaxDepth", "env", "LCM_SWEEP_MAX_DEPTH", "not-a-number", "used env LCM_INCREMENTAL_MAX_DEPTH"),
      warning("incrementalMaxDepth", "env", "LCM_INCREMENTAL_MAX_DEPTH", "deprecated", "read as sweepMaxDepth"),
    ]],
    ["invalid setting env, alias plugin value used", { LCM_SWEEP_MAX_DEPTH: "abc" }, { incrementalMaxDepth: 3 }, "sweepMaxDepth", 3, [
      warning("sweepMaxDepth", "env", "LCM_SWEEP_MAX_DEPTH", "not-a-number", "used plugin config incrementalMaxDepth"),
      warning("incrementalMaxDepth", "plugin-config", "incrementalMaxDepth", "deprecated", "read as sweepMaxDepth"),
    ]],
    ["invalid setting plugin value, alias plugin value used", {}, { sweepMaxDepth: "abc", incrementalMaxDepth: 3 }, "sweepMaxDepth", 3, [
      warning("sweepMaxDepth", "plugin-config", "sweepMaxDepth", "not-a-number", "used plugin config incrementalMaxDepth"),
      warning("incrementalMaxDepth", "plugin-config", "incrementalMaxDepth", "deprecated", "read as sweepMaxDepth"),
    ]],
    ["invalid alias env", { LCM_INCREMENTAL_MAX_DEPTH: "abc" }, {}, "sweepMaxDepth", 1, [
      warning("incrementalMaxDepth", "env", "LCM_INCREMENTAL_MAX_DEPTH", "not-a-number", "used the default (1)"),
    ]],
    ["alias plugin value under a valid setting env", { LCM_SWEEP_MAX_DEPTH: "2" }, { incrementalMaxDepth: 3 }, "sweepMaxDepth", 2, [
      warning("incrementalMaxDepth", "plugin-config", "incrementalMaxDepth", "deprecated", "ignored (env LCM_SWEEP_MAX_DEPTH is used)"),
    ]],
    ["alias env under a valid setting env", { LCM_SWEEP_MAX_DEPTH: "2", LCM_INCREMENTAL_MAX_DEPTH: "3" }, {}, "sweepMaxDepth", 2, [
      warning("incrementalMaxDepth", "env", "LCM_INCREMENTAL_MAX_DEPTH", "deprecated", "ignored (env LCM_SWEEP_MAX_DEPTH is used)"),
    ]],
    ["alias plugin value under a valid setting plugin value", {}, { sweepMaxDepth: 2, incrementalMaxDepth: 3 }, "sweepMaxDepth", 2, [
      warning("incrementalMaxDepth", "plugin-config", "incrementalMaxDepth", "deprecated", "ignored (plugin config sweepMaxDepth is used)"),
    ]],
    ["blank alias plugin value", {}, { incrementalMaxDepth: "" }, "sweepMaxDepth", 0, [
      warning("incrementalMaxDepth", "plugin-config", "incrementalMaxDepth", "deprecated", "read as sweepMaxDepth (read as 0)"),
    ]],
    ["alias env with trailing text", { LCM_INCREMENTAL_MAX_DEPTH: "3abc" }, {}, "sweepMaxDepth", 3, [
      warning("incrementalMaxDepth", "env", "LCM_INCREMENTAL_MAX_DEPTH", "deprecated", "read as sweepMaxDepth (read only the leading number)"),
    ]],
    ["blank strict-number env", { LCM_DELEGATION_TIMEOUT_MS: "" }, {}, "delegationTimeoutMs", 0, [
      warning("delegationTimeoutMs", "env", "LCM_DELEGATION_TIMEOUT_MS", "not-a-number", "read as 0"),
    ]],
    ["blank strict-number env over an invalid plugin value", { LCM_DELEGATION_TIMEOUT_MS: "  " }, { delegationTimeoutMs: "zz" }, "delegationTimeoutMs", 0, [
      warning("delegationTimeoutMs", "env", "LCM_DELEGATION_TIMEOUT_MS", "not-a-number", "read as 0"),
    ]],
    ["blank plugin number", {}, { contextThreshold: "" }, "contextThreshold", 0, [
      warning("contextThreshold", "plugin-config", "contextThreshold", "not-a-number", "read as 0"),
    ]],
    ["blank plugin positive integer", {}, { maxSweepIterations: "" }, "maxSweepIterations", 1, [
      warning("maxSweepIterations", "plugin-config", "maxSweepIterations", "clamped", "raised to 1"),
    ]],
    ["blank plugin value with a minimum", {}, { fallbackMaxTokens: "" }, "fallbackMaxTokens", 512, [
      warning("fallbackMaxTokens", "plugin-config", "fallbackMaxTokens", "below-minimum", "used the default (512)"),
    ]],
  ])("matches the resolved value: %s", (_label, env, pluginConfig, key, resolved, expected) => {
    expect(resolveLcmConfig({ ...BASE_ENV, ...env }, pluginConfig)[key]).toBe(resolved);
    expect(collectConfigWarnings(env, pluginConfig)).toEqual(expected);
  });

  it("does not claim a blank value that the resolver raises reads as 0", () => {
    const pluginConfig = { dynamicLeafChunkTokens: { max: "" } };
    expect(resolveLcmConfig({ ...BASE_ENV }, pluginConfig).dynamicLeafChunkTokens.max).toBe(20000);
    expect(collectConfigWarnings({}, pluginConfig)).toEqual([]);
  });
});
