export type LcmConfigWarningProblem =
  | "not-a-number" | "not-an-integer" | "trailing-text" | "below-minimum" | "out-of-range"
  | "not-a-boolean" | "unknown-choice" | "clamped" | "deprecated" | "retired";

/** One config value the resolver cannot use as written. Never carries the raw value. */
export type LcmConfigWarning = {
  setting: string;
  source: "env" | "plugin-config";
  /** Env var name or plugin-config path. */
  name: string;
  problem: LcmConfigWarningProblem;
  /** What lossless-claw does instead, in plain words. */
  effect: string;
};

/** How the resolver in config.ts reads a setting. */
export type ConfigWarningKind =
  | "bool-true-only" | "bool-unless-false" | "bool-true-or-1"
  | "int" | `int-min:${number}` | "positive-int-clamp" | "number" | `number-clamp:[${string}]`
  | `enum:${string}` | `deprecated-alias:${string}` | "retired";

export type ConfigWarningSetting = {
  setting: string;
  env?: string;
  path?: string;
  kind: ConfigWarningKind;
  /** Resolver default, shown as "used the default (<fallback>)". */
  fallback?: string;
  /** Enum choices compare case-insensitively. */
  lowercase?: boolean;
  /** An unknown env choice resolves to the default instead of falling through to plugin config. */
  envUnknownUsesDefault?: boolean;
  /** The env value is parsed with Number() rather than parseFloat(). */
  envStrictNumber?: boolean;
};

/** Build a table row whose plugin-config path is the setting name. */
const row = (setting: string, env: string | undefined, kind: ConfigWarningKind, fallback?: string): ConfigWarningSetting =>
  ({ setting, env, path: setting, kind, fallback });

/** Settings checked by collectConfigWarnings, mirroring resolveLcmConfigWithDiagnostics. */
export const CONFIG_WARNING_SETTINGS: readonly ConfigWarningSetting[] = [
  row("enabled", "LCM_ENABLED", "bool-unless-false", "true"),
  { ...row("hostFallbackMode", "LCM_HOST_FALLBACK_MODE", "enum:capture-only|error", "error"), envUnknownUsesDefault: true },
  row("skipStatelessSessions", "LCM_SKIP_STATELESS_SESSIONS", "bool-true-only", "true"),
  row("contextThreshold", "LCM_CONTEXT_THRESHOLD", "number", "0.75"),
  row("freshTailCount", "LCM_FRESH_TAIL_COUNT", "int", "64"),
  row("freshTailMaxTokens", "LCM_FRESH_TAIL_MAX_TOKENS", "int", "none"),
  row("promptAwareEviction", "LCM_PROMPT_AWARE_EVICTION_ENABLED", "bool-true-only", "false"),
  row("stubLargeToolPayloads", "LCM_STUB_LARGE_TOOL_PAYLOADS", "bool-true-only", "false"),
  row("newSessionRetainDepth", "LCM_NEW_SESSION_RETAIN_DEPTH", "int", "2"),
  row("leafMinFanout", "LCM_LEAF_MIN_FANOUT", "int", "8"),
  row("condensedMinFanout", "LCM_CONDENSED_MIN_FANOUT", "int", "4"),
  row("condensedMinFanoutHard", "LCM_CONDENSED_MIN_FANOUT_HARD", "int", "2"),
  row("sweepMaxDepth", "LCM_SWEEP_MAX_DEPTH", "int", "1"),
  row("incrementalMaxDepth", "LCM_INCREMENTAL_MAX_DEPTH", "deprecated-alias:sweepMaxDepth"),
  row("leafChunkTokens", "LCM_LEAF_CHUNK_TOKENS", "int", "20000"),
  row("summaryPrefixTargetTokens", "LCM_SUMMARY_PREFIX_TARGET_TOKENS", "positive-int-clamp", "none"),
  row("maxSweepIterations", "LCM_MAX_SWEEP_ITERATIONS", "positive-int-clamp", "12"),
  row("sweepDeadlineMs", "LCM_SWEEP_DEADLINE_MS", "positive-int-clamp", "120000"),
  row("compactUntilUnderDeadlineMs", "LCM_COMPACT_UNTIL_UNDER_DEADLINE_MS", "positive-int-clamp", "300000"),
  row("bootstrapMaxTokens", "LCM_BOOTSTRAP_MAX_TOKENS", "int", "automatic"),
  row("leafTargetTokens", "LCM_LEAF_TARGET_TOKENS", "int", "2400"),
  row("condensedTargetTokens", "LCM_CONDENSED_TARGET_TOKENS", "int", "2000"),
  row("maxExpandTokens", "LCM_MAX_EXPAND_TOKENS", "int", "4000"),
  // Env only: the plugin value has two alias keys.
  { ...row("largeFileThresholdTokens", "LCM_LARGE_FILE_TOKEN_THRESHOLD", "int", "25000"), path: undefined },
  { ...row("delegationTimeoutMs", "LCM_DELEGATION_TIMEOUT_MS", "number", "120000"), envStrictNumber: true },
  row("summaryTimeoutMs", "LCM_SUMMARY_TIMEOUT_MS", "int", "60000"),
  row("summaryCallWindowMs", "LCM_SUMMARY_CALL_WINDOW_MS", "positive-int-clamp", "600000"),
  row("summaryMaxCallsPerWindow", "LCM_SUMMARY_MAX_CALLS_PER_WINDOW", "positive-int-clamp", "24"),
  row("summarySpendBackoffMs", "LCM_SUMMARY_SPEND_BACKOFF_MS", "positive-int-clamp", "1800000"),
  row("pruneHeartbeatOk", "LCM_PRUNE_HEARTBEAT_OK", "bool-true-only", "false"),
  row("preserveHeartbeatPoll", "LCM_PRESERVE_HEARTBEAT_POLL", "bool-true-or-1", "false"),
  row("enableSummaryThinking", "LCM_ENABLE_SUMMARY_THINKING", "bool-true-only", "true"),
  { ...row("proactiveThresholdCompactionMode", "LCM_PROACTIVE_THRESHOLD_COMPACTION_MODE", "enum:deferred|inline", "deferred"), lowercase: true },
  row("independentLogFile.enabled", "LCM_LOG_FILE_ENABLED", "bool-unless-false", "true"),
  row("independentLogFile.maxFileBytes", "LCM_LOG_MAX_FILE_BYTES", "positive-int-clamp", "104857600"),
  row("maxAssemblyTokenBudget", "LCM_MAX_ASSEMBLY_TOKEN_BUDGET", "int", "none"),
  row("summaryMaxOverageFactor", "LCM_SUMMARY_MAX_OVERAGE_FACTOR", "number", "3"),
  row("fallbackMaxTokens", "LCM_FALLBACK_MAX_TOKENS", "int-min:64", "512"),
  row("circuitBreakerThreshold", "LCM_CIRCUIT_BREAKER_THRESHOLD", "int", "5"),
  row("circuitBreakerCooldownMs", "LCM_CIRCUIT_BREAKER_COOLDOWN_MS", "int", "1800000"),
  row("replayFloodThresholdExternal", "LCM_REPLAY_FLOOD_THRESHOLD_EXTERNAL", "int-min:1", "3"),
  row("replayFloodThresholdInternal", "LCM_REPLAY_FLOOD_THRESHOLD_INTERNAL", "int-min:1", "32"),
  row("cacheAwareCompaction.enabled", "LCM_CACHE_AWARE_COMPACTION_ENABLED", "bool-unless-false", "true"),
  row("cacheAwareCompaction.cacheTTLSeconds", "LCM_CACHE_TTL_SECONDS", "int", "300"),
  row("cacheAwareCompaction.maxColdCacheCatchupPasses", "LCM_MAX_COLD_CACHE_CATCHUP_PASSES", "int", "2"),
  row("cacheAwareCompaction.hotCachePressureFactor", "LCM_HOT_CACHE_PRESSURE_FACTOR", "number-clamp:[1,Infinity]", "4"),
  row("cacheAwareCompaction.hotCacheBudgetHeadroomRatio", "LCM_HOT_CACHE_BUDGET_HEADROOM_RATIO", "number-clamp:[0,0.95]", "0.2"),
  row("cacheAwareCompaction.coldCacheObservationThreshold", "LCM_COLD_CACHE_OBSERVATION_THRESHOLD", "number-clamp:[1,Infinity]", "3"),
  row("cacheAwareCompaction.criticalBudgetPressureRatio", "LCM_CRITICAL_BUDGET_PRESSURE_RATIO", "number-clamp:[0,1]", "0.9"),
  row("dynamicLeafChunkTokens.enabled", "LCM_DYNAMIC_LEAF_CHUNK_TOKENS_ENABLED", "bool-true-only", "true"),
  row("dynamicLeafChunkTokens.max", "LCM_DYNAMIC_LEAF_CHUNK_TOKENS_MAX", "int", "automatic"),
  row("transcriptGcEnabled", undefined, "retired"),
  row("autoRotateSessionFiles", undefined, "retired"),
];

/** Env vars config.ts reads that take any string as written, so there is nothing to check. */
export const CONFIG_WARNING_NOT_CHECKED: Record<string, string> = {
  LCM_DATABASE_PATH: "path; used as written",
  LCM_LARGE_FILES_DIR: "path; used as written",
  LCM_LOG_FILE: "path; used as written",
  LCM_IGNORE_SESSION_PATTERNS: "pattern list; used as written",
  LCM_STATELESS_SESSION_PATTERNS: "pattern list; used as written",
  LCM_STRIP_INJECTED_CONTEXT_TAGS: "tag list; used as written",
  LCM_FALLBACK_PROVIDERS: "provider/model list; checking its entries is out of scope",
  LCM_SUMMARY_PROVIDER: "free-form name; used as written",
  LCM_SUMMARY_MODEL: "free-form name; used as written",
  LCM_LARGE_FILE_SUMMARY_PROVIDER: "free-form name; used as written",
  LCM_LARGE_FILE_SUMMARY_MODEL: "free-form name; used as written",
  LCM_EXPANSION_PROVIDER: "free-form name; used as written",
  LCM_EXPANSION_MODEL: "free-form name; used as written",
  LCM_CUSTOM_INSTRUCTIONS: "free-form text; used as written",
};

const PROBLEM_TEXT: Record<LcmConfigWarningProblem, string> = {
  "not-a-number": "not a number", "not-an-integer": "not a whole number",
  "trailing-text": "has text after the number", "below-minimum": "below the minimum",
  "out-of-range": "out of range", "not-a-boolean": "not true or false", "unknown-choice": "not a known choice",
  clamped: "clamped", deprecated: "deprecated alias", retired: "retired setting",
};

type Finding = { problem?: LcmConfigWarningProblem; effect?: string; usable: boolean };

/** Check one raw value the way the resolver reads it; `usable` means the resolver keeps it. */
function check(entry: ConfigWarningSetting, raw: unknown, fromEnv: boolean, pluginUsable: boolean): Finding {
  const fallback = fromEnv && pluginUsable ? "used the plugin config value"
    : fromEnv && !entry.path ? `used the plugin config value or the default (${entry.fallback})`
    : `used the default (${entry.fallback})`;
  const [kind, arg = ""] = entry.kind.split(/:(.*)/s);
  if (kind === "retired") return { problem: "retired", effect: "ignored", usable: false };
  if (kind === "deprecated-alias") return { problem: "deprecated", effect: `read as ${arg}`, usable: true };
  if (kind.startsWith("bool")) {
    const valid = kind === "bool-true-or-1" ? ["true", "false", "1", "0"] : ["true", "false"];
    if (fromEnv) {
      return valid.includes(raw as string) ? { usable: true }
        : { problem: "not-a-boolean", effect: `read as ${kind === "bool-unless-false"}`, usable: true };
    }
    return typeof raw === "boolean" || raw === "true" || raw === "false" ? { usable: true }
      : { problem: "not-a-boolean", effect: fallback, usable: false };
  }
  const text = typeof raw === "string" ? raw.trim() : "";
  if (kind === "enum") {
    if (fromEnv && text === "") return { usable: false };
    const choice = entry.lowercase ? text.toLowerCase() : text;
    if (arg.split("|").includes(choice)) return { usable: true };
    const strict = fromEnv && entry.envUnknownUsesDefault === true;
    return { problem: "unknown-choice", effect: strict ? `used the default (${entry.fallback})` : fallback, usable: strict };
  }
  // Numeric kinds. An empty env value reads as unset.
  if (fromEnv && text === "") return { usable: false };
  const exact = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  const integerParse = kind.startsWith("int") || kind === "positive-int-clamp";
  const value = !fromEnv || entry.envStrictNumber ? exact : integerParse ? parseInt(text, 10) : parseFloat(text);
  if (!Number.isFinite(value)) return { problem: "not-a-number", effect: fallback, usable: false };
  let shape: Finding = { usable: true };
  if (value !== exact) {
    shape = Number.isFinite(exact) && !Number.isInteger(exact)
      ? { problem: "not-an-integer", effect: "used the whole-number part", usable: true }
      : { problem: "trailing-text", effect: "read only the leading number", usable: true };
  }
  if (kind === "int-min" && (!Number.isInteger(value) || value < Number(arg))) {
    return { problem: Number.isInteger(value) ? "below-minimum" : "not-an-integer", effect: fallback, usable: false };
  }
  if (kind === "positive-int-clamp" && value < 1) return { problem: "clamped", effect: "raised to 1", usable: true };
  if (kind === "positive-int-clamp" && !Number.isInteger(value)) {
    return { problem: "clamped", effect: "rounded down to a whole number", usable: true };
  }
  if (kind === "number-clamp") {
    const [lo, hi] = arg.slice(1, -1).split(",").map(Number);
    if (value < lo) return { problem: "out-of-range", effect: `clamped to ${lo}`, usable: true };
    if (value > hi) return { problem: "out-of-range", effect: `clamped to ${hi}`, usable: true };
  }
  return shape;
}

/** Read a dotted plugin-config path through plain objects only. */
function readPath(pluginConfig: Record<string, unknown>, path: string): unknown {
  let value: unknown = pluginConfig;
  for (const part of path.split(".")) {
    value = value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)[part]
      : undefined;
  }
  return value;
}

/**
 * List config values that resolveLcmConfigWithDiagnostics cannot use as written.
 * Pure: reads the raw inputs only and never changes how the config resolves.
 */
export function collectConfigWarnings(
  env: NodeJS.ProcessEnv,
  pluginConfig?: Record<string, unknown>,
): LcmConfigWarning[] {
  const pc = pluginConfig ?? {};
  const warnings: LcmConfigWarning[] = [];
  for (const entry of CONFIG_WARNING_SETTINGS) {
    const pluginValue = !entry.path ? undefined
      : entry.kind === "retired" ? (Object.hasOwn(pc, entry.path) ? true : undefined)
      : readPath(pc, entry.path);
    const plugin = pluginValue === undefined ? { usable: false } : check(entry, pluginValue, false, false);
    const envValue = entry.env ? env[entry.env] : undefined;
    const fromEnv = envValue === undefined ? { usable: false } : check(entry, envValue, true, plugin.usable);
    if (entry.env && fromEnv.problem && fromEnv.effect) {
      warnings.push({ setting: entry.setting, source: "env", name: entry.env, problem: fromEnv.problem, effect: fromEnv.effect });
    }
    const shadowed = fromEnv.usable && !entry.kind.startsWith("deprecated-alias");
    if (entry.path && plugin.problem && plugin.effect && !shadowed) {
      warnings.push({ setting: entry.setting, source: "plugin-config", name: entry.path, problem: plugin.problem, effect: plugin.effect });
    }
  }
  return warnings;
}

/** Label a warning by where the value came from, e.g. "env LCM_FRESH_TAIL_COUNT". */
export function configWarningLabel(warning: LcmConfigWarning): string {
  return `${warning.source === "env" ? "env" : "plugin config"} ${warning.name}`;
}

/** Describe a warning's problem and effect, e.g. "not a number; used the default (64)". */
export function describeConfigWarning(warning: LcmConfigWarning): string {
  return `${PROBLEM_TEXT[warning.problem]}; ${warning.effect}`;
}
