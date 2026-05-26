import { homedir } from "os";
import { join, dirname, basename } from "path";
import { realpathSync } from "node:fs";
import { normalizePath } from "./connection.js";

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

/**
 * Legacy default for accepted cache-aware config. Automatic compaction no
 * longer consumes this value, but the resolver keeps it stable for existing
 * plugin config and status surfaces.
 */
export const DEFAULT_CRITICAL_BUDGET_PRESSURE_RATIO = 0.90;
export const DEFAULT_AUTO_ROTATE_SESSION_FILE_SIZE_BYTES = 2 * 1024 * 1024;

export type CacheAwareCompactionConfig = {
  enabled: boolean;
  cacheTTLSeconds: number;
  maxColdCacheCatchupPasses: number;
  hotCachePressureFactor: number;
  hotCacheBudgetHeadroomRatio: number;
  coldCacheObservationThreshold: number;
  /** Legacy threshold-pressure bypass value. Accepted but not used automatically. */
  criticalBudgetPressureRatio?: number;
};

export type DynamicLeafChunkTokensConfig = {
  enabled: boolean;
  max: number;
};

export type ProactiveThresholdCompactionMode = "deferred" | "inline";
export type AutoRotateSessionFileMode = "rotate" | "warn" | "off";

export type AutoRotateSessionFilesConfig = {
  enabled: boolean;
  createBackups: boolean;
  sizeBytes: number;
  startup: AutoRotateSessionFileMode;
  runtime: AutoRotateSessionFileMode;
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
  /** Agent-specific database paths. Key: agentId, Value: database path. */
  agentDbPaths: Record<string, string>;
  /** Default database path for agents not in agentDbPaths. */
  defaultAgentDbPath?: string;
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
  /** Optional token cap for the protected fresh tail; newest message is always preserved. */
  freshTailMaxTokens?: number;
  /** When true, budget-constrained assembly may keep older items by prompt relevance instead of pure chronology. */
  promptAwareEviction: boolean;
  /**
   * v4.2 §B — when true, evictable tool-result rows whose `large_content`
   * sidecar is set (a `file_xxx` id from lcm-blob-migrate) are replaced
   * with the v4.1 `[LCM Tool Output: file_xxx | tool=… | N bytes]`
   * reference at assemble time. Fresh tail is never stubbed. Drilldown
   * via `lcm_describe(id="file_xxx")` returns the original content.
   * Default false; flag-flip is reversible at runtime.
   */
  stubLargeToolPayloads: boolean;
  newSessionRetainDepth: number;
  leafMinFanout: number;
  condensedMinFanout: number;
  condensedMinFanoutHard: number;
  /** Preferred source depth for routine full-sweep condensation. */
  sweepMaxDepth: number;
  /** Deprecated alias for `sweepMaxDepth`; kept for config compatibility. */
  incrementalMaxDepth: number;
  leafChunkTokens: number;
  /** Optional target for summarized-prefix tokens after a full sweep. */
  summaryPrefixTargetTokens?: number;
  /** Hard cap on per-pass iterations within a single full sweep (default 12). */
  maxSweepIterations: number;
  /** Wall-clock budget for a single full sweep, in milliseconds (default 120000). */
  sweepDeadlineMs: number;
  /** Wall-clock budget for a whole compactUntilUnder run, in milliseconds (default 300000). */
  compactUntilUnderDeadlineMs: number;
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
  /** Controls whether proactive threshold compaction runs inline or is deferred. */
  proactiveThresholdCompactionMode: ProactiveThresholdCompactionMode;
  /** Automatically rotate LCM-managed session JSONL files that exceed a size ceiling. */
  autoRotateSessionFiles: AutoRotateSessionFilesConfig;
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
  /** Legacy cache-sensitive policy. Accepted but not used for automatic compaction. */
  cacheAwareCompaction: CacheAwareCompactionConfig;
  /** Legacy dynamic step-band policy. Accepted but not used for automatic compaction. */
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

/** Parse agent-specific database paths from plugin config. */
function parseAgentDbPaths(
  value: unknown,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return result;
  }
  const record = value as Record<string, unknown>;
  const stateDir = resolveOpenclawStateDir(env);
  const normalizedStateDir = normalizePath(stateDir);
  
  // P0-C1: Prototype Pollution prevention
  const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  
  for (const [agentId, path] of Object.entries(record)) {
    // P0-C1: Skip prototype pollution keys
    if (FORBIDDEN_KEYS.has(agentId)) {
      continue;
    }
    
    // P2-M1: Validate agentId format (alphanumeric, hyphens, underscores only)
    const trimmedAgentId = agentId.trim();
    if (!trimmedAgentId || !/^[a-zA-Z0-9_-]+$/.test(trimmedAgentId)) {
      continue;
    }
    
    const trimmedPath = typeof path === "string" ? path.trim() : undefined;
    if (!trimmedPath) {
      continue;
    }
    
    let resolvedPath: string;
    let normalizedPath: string;
    
    if (trimmedPath.startsWith("/")) {
      // P0-C2/P0-C3: Absolute path - validate with realpath
      resolvedPath = trimmedPath;
      normalizedPath = normalizePath(resolvedPath);
      
      // P0-C3: Symlink attack prevention - resolve real path
      try {
        // Check if path exists and resolve symlink
        const realPath = realpathSync(resolvedPath);
        normalizedPath = normalizePath(realPath);
      } catch {
        // Path doesn't exist yet - check parent directory
        const parentDir = dirname(resolvedPath);
        try {
          const realParent = realpathSync(parentDir);
          normalizedPath = normalizePath(join(realParent, basename(resolvedPath)));
        } catch {
          // Parent doesn't exist, skip this path
          continue;
        }
      }
      
      // P1-H1: Validate absolute path is within allowed directories
      const ALLOWED_ABSOLUTE_PREFIXES = [normalizedStateDir];
      const isAllowed = ALLOWED_ABSOLUTE_PREFIXES.some(prefix => 
        normalizedPath === prefix || normalizedPath.startsWith(prefix + '/')
      );
      if (!isAllowed) {
        // Absolute path outside allowed directories, skip
        continue;
      }
    } else {
      // Relative path - resolve against stateDir
      const candidate = join(stateDir, trimmedPath);
      normalizedPath = normalizePath(candidate);
      
      // Security: prevent path traversal
      if (normalizedPath.includes('..') || !normalizedPath.startsWith(normalizedStateDir)) {
        continue;
      }
      
      // P0-C3: Symlink prevention for relative paths
      try {
        const realParent = realpathSync(stateDir);
        normalizedPath = normalizePath(join(realParent, trimmedPath));
        if (!normalizedPath.startsWith(normalizePath(realParent))) {
          continue;
        }
      } catch {
        continue;
      }
      
      resolvedPath = normalizedPath;
    }
    
    result[trimmedAgentId] = normalizedPath;
  }
  return result;
}

/** Parse and validate defaultAgentDbPath with same security policy. */
function parseDefaultAgentDbPath(
  value: unknown,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmedPath = value.trim();
  if (!trimmedPath) {
    return undefined;
  }
  
  const stateDir = resolveOpenclawStateDir(env);
  const normalizedStateDir = normalizePath(stateDir);
  const ALLOWED_ABSOLUTE_PREFIXES = [normalizedStateDir];
  
  let normalizedPath: string;
  
  if (trimmedPath.startsWith("/")) {
    // Absolute path - validate with realpathSync
    try {
      const realPath = realpathSync(trimmedPath);
      normalizedPath = normalizePath(realPath);
    } catch {
      // Path doesn't exist - check parent
      const parentDir = dirname(trimmedPath);
      try {
        const realParent = realpathSync(parentDir);
        normalizedPath = normalizePath(join(realParent, basename(trimmedPath)));
      } catch {
        // Parent doesn't exist, reject
        return undefined;
      }
    }
    
    // Validate absolute path is within allowed directories
    const isAllowed = ALLOWED_ABSOLUTE_PREFIXES.some(prefix => 
      normalizedPath === prefix || normalizedPath.startsWith(prefix + '/')
    );
    if (!isAllowed) {
      return undefined;
    }
  } else {
    // Relative path - resolve against stateDir
    const candidate = join(stateDir, trimmedPath);
    normalizedPath = normalizePath(candidate);
    
    // Prevent path traversal
    if (normalizedPath.includes('..') || !normalizedPath.startsWith(normalizedStateDir)) {
      return undefined;
    }
    
    // Symlink prevention
    try {
      const realParent = realpathSync(stateDir);
      normalizedPath = normalizePath(join(realParent, trimmedPath));
      if (!normalizedPath.startsWith(normalizePath(realParent))) {
        return undefined;
      }
    } catch {
      return undefined;
    }
  }
  
  return normalizedPath;
}

/**
 * Resolve database path for a given session.
 * Uses agentDbPaths if configured for the session's agent, otherwise falls back.
 * 
 * Session key format: "agent:<agentId>:<sessionType>:<uuid>"
 * 
 * @param sessionKey - The session key to parse
 * @param config - The LCM configuration with agentDbPaths
 * @returns The resolved database path for this session
 */
export function resolveDbPathForSession(
  sessionKey: string,
  config: LcmConfig,
): string {
  // Extract agent_id from session_key
  // Session key format: "agent:<agentId>:<sessionType>:<uuid>"
  const value = sessionKey.trim();
  if (!value.startsWith("agent:")) {
    return config.databasePath;
  }
  const parts = value.split(":");
  if (parts.length < 3) {
    return config.databasePath;
  }
  const agentId = parts[1]?.trim();
  if (!agentId) {
    return config.databasePath;
  }
  
  // P2-M1: Validate agentId format
  if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) {
    return config.databasePath;
  }
  
  // P0-C1: Use Object.hasOwn to prevent prototype pollution
  if (Object.hasOwn(config.agentDbPaths, agentId)) {
    return config.agentDbPaths[agentId];
  }
  
  // P1-H2: Validate defaultAgentDbPath before using
  if (config.defaultAgentDbPath) {
    const trimmedDefaultPath = config.defaultAgentDbPath.trim();
    if (trimmedDefaultPath) {
      // Security validation (already done in parseAgentDbPaths-like logic)
      // Here we trust it was validated during config parsing
      return trimmedDefaultPath;
    }
  }
  
  // Fall back to global databasePath
  return config.databasePath;
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

function toProactiveThresholdCompactionMode(
  value: unknown,
): ProactiveThresholdCompactionMode | undefined {
  const normalized = toStr(value)?.toLowerCase();
  if (normalized === "inline" || normalized === "deferred") {
    return normalized;
  }
  return undefined;
}

function toAutoRotateSessionFileMode(value: unknown): AutoRotateSessionFileMode | undefined {
  const normalized = toStr(value)?.toLowerCase();
  if (normalized === "rotate" || normalized === "warn" || normalized === "off") {
    return normalized;
  }
  return undefined;
}

/** Coerce a byte threshold to a positive integer. */
function toPositiveInteger(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
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
  const autoRotateSessionFiles = toRecord(pc.autoRotateSessionFiles);
  const proactiveThresholdCompactionMode = toProactiveThresholdCompactionMode(
    env.LCM_PROACTIVE_THRESHOLD_COMPACTION_MODE,
  ) ?? toProactiveThresholdCompactionMode(pc.proactiveThresholdCompactionMode) ?? "deferred";
  const autoRotateSessionFileSizeBytes =
    toPositiveInteger(parseFiniteInt(env.LCM_AUTO_ROTATE_SESSION_FILES_SIZE_BYTES))
      ?? toPositiveInteger(toNumber(autoRotateSessionFiles?.sizeBytes))
      ?? DEFAULT_AUTO_ROTATE_SESSION_FILE_SIZE_BYTES;
  const resolvedLeafChunkTokens =
    parseFiniteInt(env.LCM_LEAF_CHUNK_TOKENS)
      ?? toNumber(pc.leafChunkTokens) ?? 20000;
  const resolvedBootstrapMaxTokens =
    parseFiniteInt(env.LCM_BOOTSTRAP_MAX_TOKENS)
      ?? toNumber(pc.bootstrapMaxTokens)
      ?? Math.max(6000, Math.floor(resolvedLeafChunkTokens * 0.3));
  const resolvedSweepMaxDepth =
    parseFiniteInt(env.LCM_SWEEP_MAX_DEPTH)
      ?? parseFiniteInt(env.LCM_INCREMENTAL_MAX_DEPTH)
      ?? toNumber(pc.sweepMaxDepth)
      ?? toNumber(pc.incrementalMaxDepth)
      ?? 1;
  const resolvedSummaryPrefixTargetTokens = toPositiveInteger(
    parseFiniteInt(env.LCM_SUMMARY_PREFIX_TARGET_TOKENS)
      ?? toNumber(pc.summaryPrefixTargetTokens),
  );
  const resolvedMaxSweepIterations =
    toPositiveInteger(
      parseFiniteInt(env.LCM_MAX_SWEEP_ITERATIONS)
        ?? toNumber(pc.maxSweepIterations),
    ) ?? 12;
  const resolvedSweepDeadlineMs =
    toPositiveInteger(
      parseFiniteInt(env.LCM_SWEEP_DEADLINE_MS)
        ?? toNumber(pc.sweepDeadlineMs),
    ) ?? 120_000;
  const resolvedCompactUntilUnderDeadlineMs =
    toPositiveInteger(
      parseFiniteInt(env.LCM_COMPACT_UNTIL_UNDER_DEADLINE_MS)
        ?? toNumber(pc.compactUntilUnderDeadlineMs),
    ) ?? 300_000;
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
  const resolvedColdCacheObservationThreshold = Math.max(
    1,
    Math.floor(
      parseFiniteNumber(env.LCM_COLD_CACHE_OBSERVATION_THRESHOLD)
        ?? toNumber(cacheAwareCompaction?.coldCacheObservationThreshold)
        ?? 3,
    ),
  );
  // parseFiniteNumber and toNumber both filter out non-finite values, so the
  // `?? DEFAULT_CRITICAL_BUDGET_PRESSURE_RATIO` fallback always yields a
  // finite number. Just clamp to [0, 1].
  const resolvedCriticalBudgetPressureRatio = Math.min(
    1,
    Math.max(
      0,
      parseFiniteNumber(env.LCM_CRITICAL_BUDGET_PRESSURE_RATIO)
        ?? toNumber(cacheAwareCompaction?.criticalBudgetPressureRatio)
        ?? DEFAULT_CRITICAL_BUDGET_PRESSURE_RATIO,
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
      agentDbPaths: parseAgentDbPaths(pc.agentDbPaths, env),
      defaultAgentDbPath: parseDefaultAgentDbPath(pc.defaultAgentDbPath, env),
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
      freshTailMaxTokens:
        parseFiniteInt(env.LCM_FRESH_TAIL_MAX_TOKENS)
          ?? toNumber(pc.freshTailMaxTokens) ?? undefined,
      promptAwareEviction:
        env.LCM_PROMPT_AWARE_EVICTION_ENABLED !== undefined
          ? env.LCM_PROMPT_AWARE_EVICTION_ENABLED === "true"
          : toBool(pc.promptAwareEviction) ?? false,
      // v4.2 §B — config + env-var propagation for the stub-tier flag.
      // Default false. Mirror the env-takes-precedence-over-config
      // pattern used by every other boolean LCM flag.
      stubLargeToolPayloads:
        env.LCM_STUB_LARGE_TOOL_PAYLOADS !== undefined
          ? env.LCM_STUB_LARGE_TOOL_PAYLOADS === "true"
          : toBool(pc.stubLargeToolPayloads) ?? false,
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
      sweepMaxDepth: resolvedSweepMaxDepth,
      incrementalMaxDepth: resolvedSweepMaxDepth,
      leafChunkTokens: resolvedLeafChunkTokens,
      summaryPrefixTargetTokens: resolvedSummaryPrefixTargetTokens,
      maxSweepIterations: resolvedMaxSweepIterations,
      sweepDeadlineMs: resolvedSweepDeadlineMs,
      compactUntilUnderDeadlineMs: resolvedCompactUntilUnderDeadlineMs,
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
      proactiveThresholdCompactionMode,
      autoRotateSessionFiles: {
        enabled:
          env.LCM_AUTO_ROTATE_SESSION_FILES_ENABLED !== undefined
            ? env.LCM_AUTO_ROTATE_SESSION_FILES_ENABLED !== "false"
            : toBool(autoRotateSessionFiles?.enabled) ?? true,
        createBackups:
          env.LCM_AUTO_ROTATE_SESSION_FILES_CREATE_BACKUPS !== undefined
            ? env.LCM_AUTO_ROTATE_SESSION_FILES_CREATE_BACKUPS === "true"
            : toBool(autoRotateSessionFiles?.createBackups) ?? false,
        sizeBytes: autoRotateSessionFileSizeBytes,
        startup:
          toAutoRotateSessionFileMode(env.LCM_AUTO_ROTATE_SESSION_FILES_STARTUP)
            ?? toAutoRotateSessionFileMode(autoRotateSessionFiles?.startup)
            ?? "rotate",
        runtime:
          toAutoRotateSessionFileMode(env.LCM_AUTO_ROTATE_SESSION_FILES_RUNTIME)
            ?? toAutoRotateSessionFileMode(autoRotateSessionFiles?.runtime)
            ?? "rotate",
      },
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
        cacheTTLSeconds:
          parseFiniteInt(env.LCM_CACHE_TTL_SECONDS)
            ?? toNumber(cacheAwareCompaction?.cacheTTLSeconds)
            ?? 300,
        maxColdCacheCatchupPasses:
          parseFiniteInt(env.LCM_MAX_COLD_CACHE_CATCHUP_PASSES)
            ?? toNumber(cacheAwareCompaction?.maxColdCacheCatchupPasses)
            ?? 2,
        hotCachePressureFactor: resolvedHotCachePressureFactor,
        hotCacheBudgetHeadroomRatio: resolvedHotCacheBudgetHeadroomRatio,
        coldCacheObservationThreshold: resolvedColdCacheObservationThreshold,
        criticalBudgetPressureRatio: resolvedCriticalBudgetPressureRatio,
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
