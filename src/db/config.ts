import { homedir } from "os";
import { join } from "path";

export type LcmConfig = {
  enabled: boolean;
  databasePath: string;
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
  /** Model override for conversation summarization. */
  summaryModel: string;
  /** Provider override for conversation summarization. */
  summaryProvider: string;
  /** Provider override for lcm_expand_query sub-agent. */
  expansionProvider: string;
  /** Model override for lcm_expand_query sub-agent. */
  expansionModel: string;
  /** Max time to wait for delegated lcm_expand_query sub-agent completion. */
  delegationTimeoutMs: number;
  /** IANA timezone for timestamps in summaries (from TZ env or system default) */
  timezone: string;
  /** When true, retroactively delete HEARTBEAT_OK turn cycles from LCM storage. */
  pruneHeartbeatOk: boolean;
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
  const pc = pluginConfig ?? {};
  const envDelegationTimeoutMs =
    env.LCM_DELEGATION_TIMEOUT_MS !== undefined
      ? toNumber(env.LCM_DELEGATION_TIMEOUT_MS)
      : undefined;

  return {
    enabled:
      env.LCM_ENABLED !== undefined
        ? env.LCM_ENABLED !== "false"
        : toBool(pc.enabled) ?? true,
    databasePath:
      env.LCM_DATABASE_PATH
      ?? toStr(pc.dbPath)
      ?? toStr(pc.databasePath)
      ?? join(homedir(), ".openclaw", "lcm.db"),
    ignoreSessionPatterns:
      env.LCM_IGNORE_SESSION_PATTERNS !== undefined
        ? env.LCM_IGNORE_SESSION_PATTERNS
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
        : toStrArray(pc.ignoreSessionPatterns) ?? [],
    statelessSessionPatterns:
      env.LCM_STATELESS_SESSION_PATTERNS !== undefined
        ? env.LCM_STATELESS_SESSION_PATTERNS
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
        : toStrArray(pc.statelessSessionPatterns) ?? [],
    skipStatelessSessions:
      env.LCM_SKIP_STATELESS_SESSIONS !== undefined
        ? env.LCM_SKIP_STATELESS_SESSIONS === "true"
        : toBool(pc.skipStatelessSessions) ?? true,
    contextThreshold:
      (env.LCM_CONTEXT_THRESHOLD !== undefined ? parseFloat(env.LCM_CONTEXT_THRESHOLD) : undefined)
        ?? toNumber(pc.contextThreshold) ?? 0.75,
    freshTailCount:
      (env.LCM_FRESH_TAIL_COUNT !== undefined ? parseInt(env.LCM_FRESH_TAIL_COUNT, 10) : undefined)
        ?? toNumber(pc.freshTailCount) ?? 64,
    newSessionRetainDepth:
      (env.LCM_NEW_SESSION_RETAIN_DEPTH !== undefined
        ? parseInt(env.LCM_NEW_SESSION_RETAIN_DEPTH, 10)
        : undefined)
        ?? toNumber(pc.newSessionRetainDepth) ?? 2,
    leafMinFanout:
      (env.LCM_LEAF_MIN_FANOUT !== undefined ? parseInt(env.LCM_LEAF_MIN_FANOUT, 10) : undefined)
        ?? toNumber(pc.leafMinFanout) ?? 8,
    condensedMinFanout:
      (env.LCM_CONDENSED_MIN_FANOUT !== undefined ? parseInt(env.LCM_CONDENSED_MIN_FANOUT, 10) : undefined)
        ?? toNumber(pc.condensedMinFanout) ?? 4,
    condensedMinFanoutHard:
      (env.LCM_CONDENSED_MIN_FANOUT_HARD !== undefined ? parseInt(env.LCM_CONDENSED_MIN_FANOUT_HARD, 10) : undefined)
        ?? toNumber(pc.condensedMinFanoutHard) ?? 2,
    incrementalMaxDepth:
      (env.LCM_INCREMENTAL_MAX_DEPTH !== undefined ? parseInt(env.LCM_INCREMENTAL_MAX_DEPTH, 10) : undefined)
        ?? toNumber(pc.incrementalMaxDepth) ?? 1,
    leafChunkTokens:
      (env.LCM_LEAF_CHUNK_TOKENS !== undefined ? parseInt(env.LCM_LEAF_CHUNK_TOKENS, 10) : undefined)
        ?? toNumber(pc.leafChunkTokens) ?? 20000,
    leafTargetTokens:
      (env.LCM_LEAF_TARGET_TOKENS !== undefined ? parseInt(env.LCM_LEAF_TARGET_TOKENS, 10) : undefined)
        ?? toNumber(pc.leafTargetTokens) ?? 2400,
    condensedTargetTokens:
      (env.LCM_CONDENSED_TARGET_TOKENS !== undefined ? parseInt(env.LCM_CONDENSED_TARGET_TOKENS, 10) : undefined)
        ?? toNumber(pc.condensedTargetTokens) ?? 2000,
    maxExpandTokens:
      (env.LCM_MAX_EXPAND_TOKENS !== undefined ? parseInt(env.LCM_MAX_EXPAND_TOKENS, 10) : undefined)
        ?? toNumber(pc.maxExpandTokens) ?? 4000,
    largeFileTokenThreshold:
      (env.LCM_LARGE_FILE_TOKEN_THRESHOLD !== undefined ? parseInt(env.LCM_LARGE_FILE_TOKEN_THRESHOLD, 10) : undefined)
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
    timezone: env.TZ ?? toStr(pc.timezone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    pruneHeartbeatOk:
      env.LCM_PRUNE_HEARTBEAT_OK !== undefined
        ? env.LCM_PRUNE_HEARTBEAT_OK === "true"
        : toBool(pc.pruneHeartbeatOk) ?? false,
    maxAssemblyTokenBudget:
      (env.LCM_MAX_ASSEMBLY_TOKEN_BUDGET !== undefined ? parseInt(env.LCM_MAX_ASSEMBLY_TOKEN_BUDGET, 10) : undefined)
        ?? toNumber(pc.maxAssemblyTokenBudget) ?? undefined,
    summaryMaxOverageFactor:
      (env.LCM_SUMMARY_MAX_OVERAGE_FACTOR !== undefined ? parseFloat(env.LCM_SUMMARY_MAX_OVERAGE_FACTOR) : undefined)
        ?? toNumber(pc.summaryMaxOverageFactor) ?? 3,
    customInstructions:
      env.LCM_CUSTOM_INSTRUCTIONS?.trim() ?? toStr(pc.customInstructions) ?? "",
    circuitBreakerThreshold:
      (env.LCM_CIRCUIT_BREAKER_THRESHOLD !== undefined ? parseInt(env.LCM_CIRCUIT_BREAKER_THRESHOLD, 10) : undefined)
        ?? toNumber(pc.circuitBreakerThreshold) ?? 5,
    circuitBreakerCooldownMs:
      (env.LCM_CIRCUIT_BREAKER_COOLDOWN_MS !== undefined ? parseInt(env.LCM_CIRCUIT_BREAKER_COOLDOWN_MS, 10) : undefined)
        ?? toNumber(pc.circuitBreakerCooldownMs) ?? 1_800_000,
  };
}
