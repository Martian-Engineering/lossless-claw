import { homedir } from "os";
import { join } from "path";

export type LcmConfig = {
  enabled: boolean;
  databasePath: string;
  contextThreshold: number;
  freshTailCount: number;
  leafMinFanout: number;
  condensedMinFanout: number;
  condensedMinFanoutHard: number;
  incrementalMaxDepth: number;
  leafChunkTokens: number;
  leafTargetTokens: number;
  condensedTargetTokens: number;
  maxExpandTokens: number;
  largeFileTokenThreshold: number;
  /** Provider override for large-file text summarization. */
  largeFileSummaryProvider: string;
  /** Model override for large-file text summarization. */
  largeFileSummaryModel: string;
  autocompactDisabled: boolean;
  /** IANA timezone for timestamps in summaries (from TZ env or system default) */
  timezone: string;
  /** When true, retroactively delete HEARTBEAT_OK turn cycles from LCM storage. */
  pruneHeartbeatOk: boolean;
  /** Enable the scratchpad system (default true). */
  scratchpadEnabled: boolean;
  /** Max tokens for the scratchpad document (default 2000). */
  scratchpadMaxTokens: number;
  /** Enable collapse/expand tools (default true). */
  collapseEnabled: boolean;
  /** Token threshold for middle zone compression (default 50000). */
  middleCompressionThreshold: number;
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
    contextThreshold:
      (env.LCM_CONTEXT_THRESHOLD !== undefined ? parseFloat(env.LCM_CONTEXT_THRESHOLD) : undefined)
        ?? toNumber(pc.contextThreshold) ?? 0.75,
    freshTailCount:
      (env.LCM_FRESH_TAIL_COUNT !== undefined ? parseInt(env.LCM_FRESH_TAIL_COUNT, 10) : undefined)
        ?? toNumber(pc.freshTailCount) ?? 32,
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
        ?? toNumber(pc.incrementalMaxDepth) ?? 0,
    leafChunkTokens:
      (env.LCM_LEAF_CHUNK_TOKENS !== undefined ? parseInt(env.LCM_LEAF_CHUNK_TOKENS, 10) : undefined)
        ?? toNumber(pc.leafChunkTokens) ?? 20000,
    leafTargetTokens:
      (env.LCM_LEAF_TARGET_TOKENS !== undefined ? parseInt(env.LCM_LEAF_TARGET_TOKENS, 10) : undefined)
        ?? toNumber(pc.leafTargetTokens) ?? 1200,
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
    largeFileSummaryProvider:
      env.LCM_LARGE_FILE_SUMMARY_PROVIDER?.trim() ?? toStr(pc.largeFileSummaryProvider) ?? "",
    largeFileSummaryModel:
      env.LCM_LARGE_FILE_SUMMARY_MODEL?.trim() ?? toStr(pc.largeFileSummaryModel) ?? "",
    autocompactDisabled:
      env.LCM_AUTOCOMPACT_DISABLED !== undefined
        ? env.LCM_AUTOCOMPACT_DISABLED === "true"
        : toBool(pc.autocompactDisabled) ?? false,
    timezone: env.TZ ?? toStr(pc.timezone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    pruneHeartbeatOk:
      env.LCM_PRUNE_HEARTBEAT_OK !== undefined
        ? env.LCM_PRUNE_HEARTBEAT_OK === "true"
        : toBool(pc.pruneHeartbeatOk) ?? false,
    scratchpadEnabled:
      env.LCM_SCRATCHPAD_ENABLED !== undefined
        ? env.LCM_SCRATCHPAD_ENABLED !== "false"
        : toBool(pc.scratchpadEnabled) ?? true,
    scratchpadMaxTokens:
      (env.LCM_SCRATCHPAD_MAX_TOKENS !== undefined ? parseInt(env.LCM_SCRATCHPAD_MAX_TOKENS, 10) : undefined)
        ?? toNumber(pc.scratchpadMaxTokens) ?? 2000,
    collapseEnabled:
      env.LCM_COLLAPSE_ENABLED !== undefined
        ? env.LCM_COLLAPSE_ENABLED !== "false"
        : toBool(pc.collapseEnabled) ?? true,
    middleCompressionThreshold:
      (env.LCM_MIDDLE_COMPRESSION_THRESHOLD !== undefined ? parseInt(env.LCM_MIDDLE_COMPRESSION_THRESHOLD, 10) : undefined)
        ?? toNumber(pc.middleCompressionThreshold) ?? 50000,
  };
}
