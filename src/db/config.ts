import { homedir } from "os";
import { join } from "path";

/**
 * Resolve the active OpenClaw state directory.
 *
 * Precedence:
 *   1. `OPENCLAW_STATE_DIR` environment variable (set by the host gateway for
 *      non-default profiles, e.g. `~/.openclaw-vesper`)
 *   2. `~/.openclaw` (the historic single-profile default)
 *
 * All paths that used to hardcode `~/.openclaw` should call this helper so
 * that multi-profile hosts don't bleed state across profiles.
 */
export function resolveOpenclawStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OPENCLAW_STATE_DIR?.trim();
  return explicit || join(homedir(), ".openclaw");
}

export type CacheAwareCompactionConfig = {
  enabled: boolean;
  maxColdCacheCatchupPasses: number;
  hotCachePressureFactor: number;
  hotCacheBudgetHeadroomRatio: number;
};

export type DynamicLeafChunkTokensConfig = {
  enabled: boolean;
  max: number;
};

export type LcmConfigSource = "env" | "plugin-config" | "default";

export type LcmConfigDiagnostics = {
  ignoreSessionPatternsSource: LcmConfigSource;
  statelessSessionPatternsSource: LcmConfigSource;
  ignoreSessionPatternsEnvOverridesPluginConfig: boolean;
  statelessSessionPatternsEnvOverridesPluginConfig: boolean;
};

export type LcmConfig = {
  enabled: boolean;
  databasePath: string;
  /** Directory for persisting large-file text payloads. */
  largeFilesDir: string;
  /** Glob patterns for session keys to exclude from LCM storage entirely. */
  ignoreSessionPatterns: string[];
  /** Glob patterns for session keys that may read from LCM but never write to it. */
  statelessSessionPatterns: string[];
  /** When true, stateless session pattern matching is enforced. */
  skipStatelessSessions: boolean;
  contextThreshold: number;
  freshTailCount: number;
  newSessionRetainDepth: number;
  leafMinFanout: number;
  condensedMinFanout: number;
  condensedMinFanoutHard: number;
  incrementalMaxDepth: number;
  leafChunkTokens: number;
  /** Maximum raw parent-history tokens imported during first-time bootstrap. */
  bootstrapMaxTokens?: number;
  leafTargetTokens: number;
  condensedTargetTokens: number;
  maxExpandTokens: number;
  largeFileTokenThreshold: number;
  /** Provider override for compaction summarization. */
  summaryProvider: string;
  /** Model override for compaction summarization. */
  summaryModel: string;
  /** Provider override for large-file text summarization. */
  largeFileSummaryProvider: string;
  /** Model override for large-file text summarization. */
  largeFileSummaryModel: string;
  /** Provider override for lcm_expand_query sub-agent. */
  expansionProvider: string;
  /** Model override for lcm_expand_query sub-agent. */
  expansionModel: string;
  /** Max time to wait for delegated lcm_expand_query sub-agent completion. */
  delegationTimeoutMs: number;
  /** Max time to wait for a single model-backed LCM summarizer call. */
  summaryTimeoutMs: number;
  /** IANA timezone for timestamps in summaries (from TZ env or system default) */
  timezone: string;
  /** When true, retroactively delete HEARTBEAT_OK turn cycles from LCM storage. */
  pruneHeartbeatOk: boolean;
  /** When true, maintain() may rewrite transcript entries for transcript GC. */
  transcriptGcEnabled: boolean;
  /** Hard ceiling for assembly token budget — caps runtime-provided and fallback budgets. */
  maxAssemblyTokenBudget?: number;
  /** Maximum allowed overage factor for summaries relative to target tokens (default 3). */
  summaryMaxOverageFactor: number;
  /** Custom instructions injected into all summarization prompts. */
  customInstructions: string;
  /** Consecutive auth failures before the compaction circuit breaker trips (default 5). */
  circuitBreakerThreshold: number;
  /** Cooldown in milliseconds before the circuit breaker auto-resets (default 30 min). */
  circuitBreakerCooldownMs: number;
  /** Explicit fallback provider/model pairs for compaction summarization. */
  fallbackProviders: Array<{ provider: string; model: string }>;
  /** Cache-sensitive policy for incremental leaf compaction. */
  cacheAwareCompaction: CacheAwareCompactionConfig;
  /** Dynamic step-band policy for incremental leaf chunk sizing. */
  dynamicLeafChunkTokens: DynamicLeafChunkTokensConfig;
};

/** Safely coerce an unknown value to a finite number, or return undefined. */
function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Safely parse a finite integer from an environment string, or return undefined.
 *  Unlike raw parseInt(), this returns undefined for NaN so ?? fallback works. */
function parseFiniteInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Safely parse a finite float from an environment string, or return undefined. */
function parseFiniteNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Parse fallback providers from env string (format: "provider/model,provider/model"). */
function parseFallbackProviders(value: string | undefined): Array<{ provider: string; model: string }> | undefined {
  if (!value?.trim()) return undefined;
  const entries: Array<{ provider: string; model: string }> = [];
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const slashIdx = trimmed.indexOf("/");
    if (slashIdx > 0 && slashIdx < trimmed.length - 1) {
      const provider = trimmed.slice(0, slashIdx).trim();
      const model = trimmed.slice(slashIdx + 1).trim();
      if (provider && model) {
        entries.push({ provider, model });
      }
    }
  }
  return entries.length > 0 ? entries : undefined;
}

/** Parse fallback providers from plugin config array (object items only). */
function toFallbackProviderArray(value: unknown): Array<{ provider: string; model: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: Array<{ provider: string; model: string }> = [];
  for (const item of value) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const p = toStr((item as Record<string, unknown>).provider);
      const m = toStr((item as Record<string, unknown>).model);
      if (p && m) entries.push({ provider: p, model: m });
    }
  }
  return entries.length > 0 ? entries : undefined;
}

/** Safely coerce an unknown value to a boolean, or return undefined. */
function toBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/** Safely coerce an unknown value to a trimmed non-empty string, or return undefined. */
function toStr(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

/** Coerce a plugin config value into a trimmed string array when possible. */
function toStrArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const normalized = value
      .map((entry) => toStr(entry))
      .filter((entry): entry is string => typeof entry === "string");
    return normalized.length > 0 ? normalized : [];
  }
  const single = toStr(value);
  if (!single) {
    return undefined;
  }
  return single
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseEnvStrArray(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolvePatternArray(params: {
  envValue: string | undefined;
  pluginValue: unknown;
}): {
  patterns: string[];
  source: LcmConfigSource;
  envOverridesPluginConfig: boolean;
} {
  const pluginPatterns = toStrArray(params.pluginValue);
  const pluginHasPatterns = (pluginPatterns?.length ?? 0) > 0;
  if (params.envValue !== undefined) {
    return {
      patterns: parseEnvStrArray(params.envValue) ?? [],
      source: "env",
      envOverridesPluginConfig: pluginHasPatterns,
    };
  }

  if (pluginPatterns !== undefined) {
    return {
      patterns: pluginPatterns,
      source: "plugin-config",
      envOverridesPluginConfig: false,
    };
  }

  return {
    patterns: [],
    source: "default",
    envOverridesPluginConfig: false,
  };
}

export function describeLcmConfigSource(source: LcmConfigSource): string {
  switch (source) {
    case "env":
      return "env";
    case "plugin-config":
      return "plugin config";
    case "default":
      return "defaults";
  }
}

export function resolveLcmConfigWithDiagnostics(
  env: NodeJS.ProcessEnv = process.env,
  pluginConfig?: Record<string, unknown>,
): { config: LcmConfig; diagnostics: LcmConfigDiagnostics } {
  const pc = pluginConfig ?? {};
  const cacheAwareCompaction = toRecord(pc.cacheAwareCompaction);
  const dynamicLeafChunkTokens = toRecord(pc.dynamicLeafChunkTokens);
  const resolvedLeafChunkTokens =
    parseFiniteInt(env.LCM_LEAF_CHUNK_TOKENS)
      ?? toNumber(pc.leafChunkTokens) ?? 20000;
  const resolvedBootstrapMaxTokens =
    parseFiniteInt(env.LCM_BOOTSTRAP_MAX_TOKENS)
      ?? toNumber(pc.bootstrapMaxTokens)
      ?? Math.max(6000, Math.floor(resolvedLeafChunkTokens * 0.3));
  const envDelegationTimeoutMs =
    env.LCM_DELEGATION_TIMEOUT_MS !== undefined
      ? toNumber(env.LCM_DELEGATION_TIMEOUT_MS)
      : undefined;
  const resolvedDynamicLeafChunkMax = Math.max(
    resolvedLeafChunkTokens,
    parseFiniteInt(env.LCM_DYNAMIC_LEAF_CHUNK_TOKENS_MAX)
      ?? toNumber(dynamicLeafChunkTokens?.max)
      ?? Math.floor(resolvedLeafChunkTokens * 2),
  );
  const resolvedHotCachePressureFactor = Math.max(
    1,
    parseFiniteNumber(env.LCM_HOT_CACHE_PRESSURE_FACTOR)
      ?? toNumber(cacheAwareCompaction?.hotCachePressureFactor)
      ?? 4,
  );
  const resolvedHotCacheBudgetHeadroomRatio = Math.min(
    0.95,
    Math.max(
      0,
      parseFiniteNumber(env.LCM_HOT_CACHE_BUDGET_HEADROOM_RATIO)
        ?? toNumber(cacheAwareCompaction?.hotCacheBudgetHeadroomRatio)
        ?? 0.2,
    ),
  );

  const ignoreSessionPatterns = resolvePatternArray({
    envValue: env.LCM_IGNORE_SESSION_PATTERNS,
    pluginValue: pc.ignoreSessionPatterns,
  });
  const statelessSessionPatterns = resolvePatternArray({
    envValue: env.LCM_STATELESS_SESSION_PATTERNS,
    pluginValue: pc.statelessSessionPatterns,
  });

  return {
    config: {
      enabled:
        env.LCM_ENABLED !== undefined
          ? env.LCM_ENABLED !== "false"
          : toBool(pc.enabled) ?? true,
      databasePath:
        env.LCM_DATABASE_PATH
        ?? toStr(pc.dbPath)
        ?? toStr(pc.databasePath)
        ?? join(resolveOpenclawStateDir(env), "lcm.db"),
      largeFilesDir:
        env.LCM_LARGE_FILES_DIR?.trim()
        ?? toStr(pc.largeFilesDir)
        ?? join(resolveOpenclawStateDir(env), "lcm-files"),
      ignoreSessionPatterns: ignoreSessionPatterns.patterns,
      statelessSessionPatterns: statelessSessionPatterns.patterns,
      skipStatelessSessions:
        env.LCM_SKIP_STATELESS_SESSIONS !== undefined
          ? env.LCM_SKIP_STATELESS_SESSIONS === "true"
          : toBool(pc.skipStatelessSessions) ?? true,
      contextThreshold:
        parseFiniteNumber(env.LCM_CONTEXT_THRESHOLD)
          ?? toNumber(pc.contextThreshold) ?? 0.75,
      freshTailCount:
        parseFiniteInt(env.LCM_FRESH_TAIL_COUNT)
          ?? toNumber(pc.freshTailCount) ?? 64,
      newSessionRetainDepth:
        parseFiniteInt(env.LCM_NEW_SESSION_RETAIN_DEPTH)
          ?? toNumber(pc.newSessionRetainDepth) ?? 2,
      leafMinFanout:
        parseFiniteInt(env.LCM_LEAF_MIN_FANOUT)
          ?? toNumber(pc.leafMinFanout) ?? 8,
      condensedMinFanout:
        parseFiniteInt(env.LCM_CONDENSED_MIN_FANOUT)
          ?? toNumber(pc.condensedMinFanout) ?? 4,
      condensedMinFanoutHard:
        parseFiniteInt(env.LCM_CONDENSED_MIN_FANOUT_HARD)
          ?? toNumber(pc.condensedMinFanoutHard) ?? 2,
      incrementalMaxDepth:
        parseFiniteInt(env.LCM_INCREMENTAL_MAX_DEPTH)
          ?? toNumber(pc.incrementalMaxDepth) ?? 1,
      leafChunkTokens: resolvedLeafChunkTokens,
      bootstrapMaxTokens: resolvedBootstrapMaxTokens,
      leafTargetTokens:
        parseFiniteInt(env.LCM_LEAF_TARGET_TOKENS)
          ?? toNumber(pc.leafTargetTokens) ?? 2400,
      condensedTargetTokens:
        parseFiniteInt(env.LCM_CONDENSED_TARGET_TOKENS)
          ?? toNumber(pc.condensedTargetTokens) ?? 2000,
      maxExpandTokens:
        parseFiniteInt(env.LCM_MAX_EXPAND_TOKENS)
          ?? toNumber(pc.maxExpandTokens) ?? 4000,
      largeFileTokenThreshold:
        parseFiniteInt(env.LCM_LARGE_FILE_TOKEN_THRESHOLD)
          ?? toNumber(pc.largeFileThresholdTokens)
          ?? toNumber(pc.largeFileTokenThreshold)
          ?? 25000,
      summaryProvider:
        env.LCM_SUMMARY_PROVIDER?.trim() ?? toStr(pc.summaryProvider) ?? "",
      summaryModel:
        env.LCM_SUMMARY_MODEL?.trim() ?? toStr(pc.summaryModel) ?? "",
      largeFileSummaryProvider:
        env.LCM_LARGE_FILE_SUMMARY_PROVIDER?.trim() ?? toStr(pc.largeFileSummaryProvider) ?? "",
      largeFileSummaryModel:
        env.LCM_LARGE_FILE_SUMMARY_MODEL?.trim() ?? toStr(pc.largeFileSummaryModel) ?? "",
      expansionProvider:
        env.LCM_EXPANSION_PROVIDER?.trim() ?? toStr(pc.expansionProvider) ?? "",
      expansionModel:
        env.LCM_EXPANSION_MODEL?.trim() ?? toStr(pc.expansionModel) ?? "",
      delegationTimeoutMs: envDelegationTimeoutMs ?? toNumber(pc.delegationTimeoutMs) ?? 120000,
      summaryTimeoutMs:
        parseFiniteInt(env.LCM_SUMMARY_TIMEOUT_MS)
          ?? toNumber(pc.summaryTimeoutMs) ?? 60000,
      timezone: env.TZ ?? toStr(pc.timezone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      pruneHeartbeatOk:
        env.LCM_PRUNE_HEARTBEAT_OK !== undefined
          ? env.LCM_PRUNE_HEARTBEAT_OK === "true"
          : toBool(pc.pruneHeartbeatOk) ?? false,
      transcriptGcEnabled:
        env.LCM_TRANSCRIPT_GC_ENABLED !== undefined
          ? env.LCM_TRANSCRIPT_GC_ENABLED === "true"
          : toBool(pc.transcriptGcEnabled) ?? false,
      maxAssemblyTokenBudget:
        parseFiniteInt(env.LCM_MAX_ASSEMBLY_TOKEN_BUDGET)
          ?? toNumber(pc.maxAssemblyTokenBudget) ?? undefined,
      summaryMaxOverageFactor:
        parseFiniteNumber(env.LCM_SUMMARY_MAX_OVERAGE_FACTOR)
          ?? toNumber(pc.summaryMaxOverageFactor) ?? 3,
      customInstructions:
        env.LCM_CUSTOM_INSTRUCTIONS?.trim() ?? toStr(pc.customInstructions) ?? "",
      circuitBreakerThreshold:
        parseFiniteInt(env.LCM_CIRCUIT_BREAKER_THRESHOLD)
          ?? toNumber(pc.circuitBreakerThreshold) ?? 5,
      circuitBreakerCooldownMs:
        parseFiniteInt(env.LCM_CIRCUIT_BREAKER_COOLDOWN_MS)
          ?? toNumber(pc.circuitBreakerCooldownMs) ?? 1_800_000,
      fallbackProviders:
        parseFallbackProviders(env.LCM_FALLBACK_PROVIDERS)
          ?? toFallbackProviderArray(pc.fallbackProviders) ?? [],
      cacheAwareCompaction: {
        enabled:
          env.LCM_CACHE_AWARE_COMPACTION_ENABLED !== undefined
            ? env.LCM_CACHE_AWARE_COMPACTION_ENABLED !== "false"
            : toBool(cacheAwareCompaction?.enabled) ?? true,
        maxColdCacheCatchupPasses:
          parseFiniteInt(env.LCM_MAX_COLD_CACHE_CATCHUP_PASSES)
            ?? toNumber(cacheAwareCompaction?.maxColdCacheCatchupPasses)
            ?? 2,
        hotCachePressureFactor: resolvedHotCachePressureFactor,
        hotCacheBudgetHeadroomRatio: resolvedHotCacheBudgetHeadroomRatio,
      },
      dynamicLeafChunkTokens: {
        enabled:
          env.LCM_DYNAMIC_LEAF_CHUNK_TOKENS_ENABLED !== undefined
            ? env.LCM_DYNAMIC_LEAF_CHUNK_TOKENS_ENABLED === "true"
            : toBool(dynamicLeafChunkTokens?.enabled) ?? true,
        max: resolvedDynamicLeafChunkMax,
      },
    },
    diagnostics: {
      ignoreSessionPatternsSource: ignoreSessionPatterns.source,
      statelessSessionPatternsSource: statelessSessionPatterns.source,
      ignoreSessionPatternsEnvOverridesPluginConfig: ignoreSessionPatterns.envOverridesPluginConfig,
      statelessSessionPatternsEnvOverridesPluginConfig:
        statelessSessionPatterns.envOverridesPluginConfig,
    },
  };
}

/**
 * Resolve LCM configuration with three-tier precedence:
 *   1. Environment variables (highest — backward compat)
 *   2. Plugin config object (from plugins.entries.lossless-claw.config)
 *   3. Hardcoded defaults (lowest)
 */
export function resolveLcmConfig(
  env: NodeJS.ProcessEnv = process.env,
  pluginConfig?: Record<string, unknown>,
): LcmConfig {
  return resolveLcmConfigWithDiagnostics(env, pluginConfig).config;
}
