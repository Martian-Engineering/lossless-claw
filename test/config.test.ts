import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import {
  resolveLcmConfig,
  resolveLcmConfigWithDiagnostics,
  resolveOpenclawStateDir,
} from "../src/db/config.js";

describe("resolveLcmConfig", () => {
  it("ships the bundled lossless-claw skill path in the manifest", () => {
    expect(manifest.skills).toEqual(["skills/lossless-claw"]);
  });

  it("uses hardcoded defaults when no env or plugin config", () => {
    const config = resolveLcmConfig({}, {});
    expect(config.enabled).toBe(true);
    expect(config.ignoreSessionPatterns).toEqual([]);
    expect(config.statelessSessionPatterns).toEqual([]);
    expect(config.skipStatelessSessions).toBe(true);
    expect(config.contextThreshold).toBe(0.75);
    expect(config.freshTailCount).toBe(64);
    expect(config.freshTailMaxTokens).toBeUndefined();
    expect(config.newSessionRetainDepth).toBe(2);
    expect(config.incrementalMaxDepth).toBe(1);
    expect(config.leafChunkTokens).toBe(20000);
    expect(config.leafMinFanout).toBe(8);
    expect(config.condensedMinFanout).toBe(4);
    expect(config.condensedMinFanoutHard).toBe(2);
    expect(config.leafTargetTokens).toBe(2400);
    expect(config.summaryProvider).toBe("");
    expect(config.summaryModel).toBe("");
    expect(config.pruneHeartbeatOk).toBe(false);
    expect(config.transcriptGcEnabled).toBe(false);
    expect(config.cacheAwareCompaction).toEqual({
      enabled: true,
      maxColdCacheCatchupPasses: 2,
      hotCachePressureFactor: 4,
      hotCacheBudgetHeadroomRatio: 0.2,
    });
    expect(config.dynamicLeafChunkTokens).toEqual({
      enabled: true,
      max: 40000,
    });
  });

  it("reads values from plugin config", () => {
    const config = resolveLcmConfig({}, {
      contextThreshold: 0.5,
      freshTailCount: 16,
      freshTailMaxTokens: 12000,
      leafChunkTokens: 80000,
      newSessionRetainDepth: 3,
      incrementalMaxDepth: -1,
      ignoreSessionPatterns: ["agent:*:cron:*", "agent:main:subagent:**"],
      statelessSessionPatterns: ["agent:*:ephemeral:**"],
      skipStatelessSessions: false,
      leafMinFanout: 4,
      condensedMinFanout: 2,
      pruneHeartbeatOk: true,
      transcriptGcEnabled: true,
      enabled: false,
      cacheAwareCompaction: {
        enabled: false,
        maxColdCacheCatchupPasses: 3,
        hotCachePressureFactor: 6,
        hotCacheBudgetHeadroomRatio: 0.35,
      },
      dynamicLeafChunkTokens: {
        enabled: true,
        max: 50000,
      },
    });
    expect(config.enabled).toBe(false);
    expect(config.ignoreSessionPatterns).toEqual([
      "agent:*:cron:*",
      "agent:main:subagent:**",
    ]);
    expect(config.statelessSessionPatterns).toEqual(["agent:*:ephemeral:**"]);
    expect(config.skipStatelessSessions).toBe(false);
    expect(config.contextThreshold).toBe(0.5);
    expect(config.freshTailCount).toBe(16);
    expect(config.freshTailMaxTokens).toBe(12000);
    expect(config.newSessionRetainDepth).toBe(3);
    expect(config.leafChunkTokens).toBe(80000);
    expect(config.incrementalMaxDepth).toBe(-1);
    expect(config.leafMinFanout).toBe(4);
    expect(config.condensedMinFanout).toBe(2);
    expect(config.pruneHeartbeatOk).toBe(true);
    expect(config.transcriptGcEnabled).toBe(true);
    expect(config.cacheAwareCompaction).toEqual({
      enabled: false,
      maxColdCacheCatchupPasses: 3,
      hotCachePressureFactor: 6,
      hotCacheBudgetHeadroomRatio: 0.35,
    });
    expect(config.dynamicLeafChunkTokens).toEqual({
      enabled: true,
      max: 80000,
    });
  });

  it("env vars override plugin config", () => {
    const env = {
      LCM_CONTEXT_THRESHOLD: "0.9",
      LCM_FRESH_TAIL_COUNT: "64",
      LCM_FRESH_TAIL_MAX_TOKENS: "32000",
      LCM_NEW_SESSION_RETAIN_DEPTH: "5",
      LCM_INCREMENTAL_MAX_DEPTH: "3",
      LCM_ENABLED: "false",
      LCM_IGNORE_SESSION_PATTERNS: "agent:*:cron:*, agent:main:subagent:**",
      LCM_STATELESS_SESSION_PATTERNS: "agent:*:ephemeral:**, agent:main:preview:*",
      LCM_SKIP_STATELESS_SESSIONS: "false",
      LCM_TRANSCRIPT_GC_ENABLED: "true",
      LCM_CACHE_AWARE_COMPACTION_ENABLED: "false",
      LCM_MAX_COLD_CACHE_CATCHUP_PASSES: "4",
      LCM_HOT_CACHE_PRESSURE_FACTOR: "5.5",
      LCM_HOT_CACHE_BUDGET_HEADROOM_RATIO: "0.25",
      LCM_DYNAMIC_LEAF_CHUNK_TOKENS_ENABLED: "true",
      LCM_DYNAMIC_LEAF_CHUNK_TOKENS_MAX: "60000",
    } as NodeJS.ProcessEnv;
    const pluginConfig = {
      contextThreshold: 0.5,
      freshTailCount: 16,
      freshTailMaxTokens: 12000,
      incrementalMaxDepth: -1,
      ignoreSessionPatterns: ["agent:*:test:*"],
      statelessSessionPatterns: ["agent:*:preview:*"],
      skipStatelessSessions: true,
      transcriptGcEnabled: false,
      enabled: true,
      cacheAwareCompaction: {
        enabled: true,
        maxColdCacheCatchupPasses: 2,
        hotCachePressureFactor: 3,
        hotCacheBudgetHeadroomRatio: 0.1,
      },
      dynamicLeafChunkTokens: {
        enabled: false,
        max: 50000,
      },
    };
    const config = resolveLcmConfig(env, pluginConfig);
    expect(config.enabled).toBe(false); // env wins
    expect(config.ignoreSessionPatterns).toEqual([
      "agent:*:cron:*",
      "agent:main:subagent:**",
    ]);
    expect(config.statelessSessionPatterns).toEqual([
      "agent:*:ephemeral:**",
      "agent:main:preview:*",
    ]);
    expect(config.skipStatelessSessions).toBe(false);
    expect(config.transcriptGcEnabled).toBe(true);
    expect(config.contextThreshold).toBe(0.9); // env wins
    expect(config.freshTailCount).toBe(64); // env wins
    expect(config.freshTailMaxTokens).toBe(32000); // env wins
    expect(config.newSessionRetainDepth).toBe(5); // env wins
    expect(config.incrementalMaxDepth).toBe(3); // env wins
    expect(config.cacheAwareCompaction).toEqual({
      enabled: false,
      maxColdCacheCatchupPasses: 4,
      hotCachePressureFactor: 5.5,
      hotCacheBudgetHeadroomRatio: 0.25,
    });
    expect(config.dynamicLeafChunkTokens).toEqual({
      enabled: true,
      max: 60000,
    });
  });

  it("reports session pattern sources and env override diagnostics", () => {
    const { config, diagnostics } = resolveLcmConfigWithDiagnostics(
      {
        LCM_IGNORE_SESSION_PATTERNS: "agent:*:cron:*, agent:main:subagent:**",
        LCM_STATELESS_SESSION_PATTERNS: "agent:*:ephemeral:**",
      } as NodeJS.ProcessEnv,
      {
        ignoreSessionPatterns: ["agent:*:test:*"],
        statelessSessionPatterns: ["agent:*:preview:*"],
      },
    );

    expect(config.ignoreSessionPatterns).toEqual([
      "agent:*:cron:*",
      "agent:main:subagent:**",
    ]);
    expect(config.statelessSessionPatterns).toEqual(["agent:*:ephemeral:**"]);
    expect(diagnostics).toEqual({
      ignoreSessionPatternsSource: "env",
      statelessSessionPatternsSource: "env",
      ignoreSessionPatternsEnvOverridesPluginConfig: true,
      statelessSessionPatternsEnvOverridesPluginConfig: true,
    });
  });

  it("plugin config fills gaps when env vars are absent", () => {
    const env = {
      LCM_CONTEXT_THRESHOLD: "0.9",
    } as NodeJS.ProcessEnv;
    const pluginConfig = {
      contextThreshold: 0.5, // should be overridden by env
      freshTailCount: 16, // should be used (no env)
      newSessionRetainDepth: 4, // should be used (no env)
      incrementalMaxDepth: -1, // should be used (no env)
    };
    const config = resolveLcmConfig(env, pluginConfig);
    expect(config.contextThreshold).toBe(0.9); // env wins
    expect(config.freshTailCount).toBe(16); // plugin config
    expect(config.newSessionRetainDepth).toBe(4); // plugin config
    expect(config.incrementalMaxDepth).toBe(-1); // plugin config
    expect(config.leafMinFanout).toBe(8); // hardcoded default
  });

  it("handles string values in plugin config (from JSON)", () => {
    const config = resolveLcmConfig({}, {
      contextThreshold: "0.6",
      freshTailCount: "24",
      freshTailMaxTokens: "4800",
      leafChunkTokens: "64000",
      newSessionRetainDepth: "6",
      ignoreSessionPatterns: "agent:*:cron:*, agent:main:subagent:**",
      statelessSessionPatterns: "agent:*:ephemeral:**, agent:main:preview:*",
      skipStatelessSessions: "false",
    });
    expect(config.contextThreshold).toBe(0.6);
    expect(config.freshTailCount).toBe(24);
    expect(config.freshTailMaxTokens).toBe(4800);
    expect(config.newSessionRetainDepth).toBe(6);
    expect(config.leafChunkTokens).toBe(64000);
    expect(config.ignoreSessionPatterns).toEqual([
      "agent:*:cron:*",
      "agent:main:subagent:**",
    ]);
    expect(config.statelessSessionPatterns).toEqual([
      "agent:*:ephemeral:**",
      "agent:main:preview:*",
    ]);
    expect(config.skipStatelessSessions).toBe(false);
  });

  it("ignores invalid plugin config values", () => {
    const config = resolveLcmConfig({}, {
      contextThreshold: "not-a-number",
      freshTailCount: null,
      freshTailMaxTokens: "not-a-number",
      newSessionRetainDepth: "nope",
      enabled: "maybe",
    });
    expect(config.contextThreshold).toBe(0.75); // falls through to default
    expect(config.freshTailCount).toBe(64); // falls through to default
    expect(config.freshTailMaxTokens).toBeUndefined();
    expect(config.newSessionRetainDepth).toBe(2); // falls through to default
    expect(config.enabled).toBe(true); // falls through to default
  });

  it("handles databasePath from plugin config", () => {
    const config = resolveLcmConfig({}, {
      databasePath: "/custom/path/lcm.db",
    });
    expect(config.databasePath).toBe("/custom/path/lcm.db");
  });

  it("accepts manifest dbPath from plugin config", () => {
    const config = resolveLcmConfig({}, {
      dbPath: "/manifest/path/lcm.db",
    });
    expect(config.databasePath).toBe("/manifest/path/lcm.db");
  });

  it("env databasePath overrides plugin config", () => {
    const config = resolveLcmConfig(
      { LCM_DATABASE_PATH: "/env/path/lcm.db" } as NodeJS.ProcessEnv,
      { databasePath: "/plugin/path/lcm.db" },
    );
    expect(config.databasePath).toBe("/env/path/lcm.db");
  });

  it("accepts manifest largeFileThresholdTokens from plugin config", () => {
    const config = resolveLcmConfig({}, {
      largeFileThresholdTokens: 12345,
    });
    expect(config.largeFileTokenThreshold).toBe(12345);
  });

  it("reads expansionModel and expansionProvider from plugin config", () => {
    const config = resolveLcmConfig({}, {
      expansionModel: "anthropic/claude-haiku-4-5",
      expansionProvider: "anthropic",
    });
    expect(config.expansionModel).toBe("anthropic/claude-haiku-4-5");
    expect(config.expansionProvider).toBe("anthropic");
  });

  it("reads delegationTimeoutMs from plugin config", () => {
    const config = resolveLcmConfig({}, {
      delegationTimeoutMs: 300000,
    });
    expect(config.delegationTimeoutMs).toBe(300000);
  });

  it("reads cache-aware compaction settings from plugin config", () => {
    const config = resolveLcmConfig({}, {
      cacheAwareCompaction: {
        enabled: false,
        maxColdCacheCatchupPasses: 3,
        hotCachePressureFactor: 6,
        hotCacheBudgetHeadroomRatio: 0.35,
      },
    });

    expect(config.cacheAwareCompaction).toEqual({
      enabled: false,
      maxColdCacheCatchupPasses: 3,
      hotCachePressureFactor: 6,
      hotCacheBudgetHeadroomRatio: 0.35,
    });
  });

  it("reads dynamic leaf chunk token settings from plugin config", () => {
    const config = resolveLcmConfig({}, {
      leafChunkTokens: 24_000,
      dynamicLeafChunkTokens: {
        enabled: true,
        max: 42_000,
      },
    });

    expect(config.dynamicLeafChunkTokens).toEqual({
      enabled: true,
      max: 42_000,
    });
  });

  it("defaults dynamic leaf chunk token max to 2x the static floor", () => {
    const config = resolveLcmConfig({}, {
      leafChunkTokens: 24_000,
    });

    expect(config.dynamicLeafChunkTokens).toEqual({
      enabled: true,
      max: 48_000,
    });
  });

  it("clamps dynamic leaf chunk token max so it never drops below the static floor", () => {
    const config = resolveLcmConfig({}, {
      leafChunkTokens: 24_000,
      dynamicLeafChunkTokens: {
        enabled: true,
        max: 12_000,
      },
    });

    expect(config.dynamicLeafChunkTokens).toEqual({
      enabled: true,
      max: 24_000,
    });
  });

  it("defaults expansionModel and expansionProvider to empty string", () => {
    const config = resolveLcmConfig({}, {});
    expect(config.expansionModel).toBe("");
    expect(config.expansionProvider).toBe("");
  });

  it("env vars override expansionModel and expansionProvider", () => {
    const config = resolveLcmConfig(
      {
        LCM_EXPANSION_MODEL: "anthropic/claude-sonnet-4-6",
        LCM_EXPANSION_PROVIDER: "openrouter",
      } as NodeJS.ProcessEnv,
      {
        expansionModel: "anthropic/claude-haiku-4-5",
        expansionProvider: "anthropic",
      },
    );
    expect(config.expansionModel).toBe("anthropic/claude-sonnet-4-6");
    expect(config.expansionProvider).toBe("openrouter");
  });

  it("env var overrides delegationTimeoutMs", () => {
    const config = resolveLcmConfig(
      {
        LCM_DELEGATION_TIMEOUT_MS: "180000",
      } as NodeJS.ProcessEnv,
      {
        delegationTimeoutMs: 300000,
      },
    );
    expect(config.delegationTimeoutMs).toBe(180000);
  });

  it("falls back to plugin delegationTimeoutMs when env value is invalid", () => {
    const config = resolveLcmConfig(
      {
        LCM_DELEGATION_TIMEOUT_MS: "not-a-number",
      } as NodeJS.ProcessEnv,
      {
        delegationTimeoutMs: 300000,
      },
    );
    expect(config.delegationTimeoutMs).toBe(300000);
  });

  it("keeps empty ignore session patterns out of resolved config", () => {
    const config = resolveLcmConfig(
      { LCM_IGNORE_SESSION_PATTERNS: " agent:*:cron:* , , " } as NodeJS.ProcessEnv,
      {
        ignoreSessionPatterns: ["agent:*:test:*"],
      },
    );

    expect(config.ignoreSessionPatterns).toEqual(["agent:*:cron:*"]);
  });

  it("keeps empty stateless session patterns out of resolved config", () => {
    const config = resolveLcmConfig(
      { LCM_STATELESS_SESSION_PATTERNS: " agent:*:ephemeral:** , , " } as NodeJS.ProcessEnv,
      {
        statelessSessionPatterns: ["agent:*:preview:*"],
      },
    );

    expect(config.statelessSessionPatterns).toEqual(["agent:*:ephemeral:**"]);
  });

  it("uses summary model overrides from env vars", () => {
    const config = resolveLcmConfig({
      LCM_SUMMARY_PROVIDER: "anthropic",
      LCM_SUMMARY_MODEL: "claude-3-5-haiku",
    } as NodeJS.ProcessEnv, {});

    expect(config.summaryProvider).toBe("anthropic");
    expect(config.summaryModel).toBe("claude-3-5-haiku");
  });

  it("uses summary model overrides from plugin config when env vars are absent", () => {
    const config = resolveLcmConfig({}, {
      summaryProvider: "openai",
      summaryModel: "gpt-5-mini",
    });

    expect(config.summaryProvider).toBe("openai");
    expect(config.summaryModel).toBe("gpt-5-mini");
  });

  it("prefers env summary overrides over plugin config", () => {
    const config = resolveLcmConfig({
      LCM_SUMMARY_PROVIDER: "anthropic",
      LCM_SUMMARY_MODEL: "claude-3-5-haiku",
    } as NodeJS.ProcessEnv, {
      summaryProvider: "openai",
      summaryModel: "gpt-5-mini",
    });

    expect(config.summaryProvider).toBe("anthropic");
    expect(config.summaryModel).toBe("claude-3-5-haiku");
  });

  it("defaults summary overrides to empty strings when unset", () => {
    const config = resolveLcmConfig({}, {
      freshTailCount: 16,
    });

    expect(config.summaryProvider).toBe("");
    expect(config.summaryModel).toBe("");
  });

  it("ships a manifest that accepts unlimited incremental depth", () => {
    expect(manifest.configSchema.properties.incrementalMaxDepth.minimum).toBe(-1);
    expect(manifest.configSchema.properties.newSessionRetainDepth.minimum).toBe(-1);
  });

  it("ships a manifest with expansionModel, expansionProvider, and delegationTimeoutMs in schema", () => {
    expect(manifest.configSchema.properties.expansionModel).toEqual({ type: "string" });
    expect(manifest.configSchema.properties.expansionProvider).toEqual({ type: "string" });
    expect(manifest.configSchema.properties.delegationTimeoutMs).toEqual({
      type: "integer",
      minimum: 1,
    });
  });

  it("ships a manifest with leafChunkTokens in schema", () => {
    expect(manifest.configSchema.properties.leafChunkTokens).toEqual({
      type: "integer",
      minimum: 1,
    });
  });

  it("ships a manifest with dynamicLeafChunkTokens in schema", () => {
    expect(manifest.configSchema.properties.dynamicLeafChunkTokens).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: {
          type: "boolean",
        },
        max: {
          type: "integer",
          minimum: 1,
        },
      },
    });
  });

  it("ships a manifest with transcriptGcEnabled in schema", () => {
    expect(manifest.configSchema.properties.transcriptGcEnabled).toEqual({
      type: "boolean",
    });
  });

  it("ships a manifest with cacheAwareCompaction in schema", () => {
    expect(manifest.configSchema.properties.cacheAwareCompaction).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: {
          type: "boolean",
        },
        maxColdCacheCatchupPasses: {
          type: "integer",
          minimum: 1,
        },
        hotCachePressureFactor: {
          type: "number",
          minimum: 1,
        },
        hotCacheBudgetHeadroomRatio: {
          type: "number",
          minimum: 0,
          maximum: 0.95,
        },
      },
    });
  });

  it("ships a manifest with plugin-config schema entries for runtime token controls", () => {
    expect(manifest.configSchema.properties.leafTargetTokens).toEqual({
      type: "integer",
      minimum: 1,
    });
    expect(manifest.configSchema.properties.condensedTargetTokens).toEqual({
      type: "integer",
      minimum: 1,
    });
    expect(manifest.configSchema.properties.maxExpandTokens).toEqual({
      type: "integer",
      minimum: 1,
    });
  });

  it("ships a manifest with schema entries for runtime-only toggles and model overrides", () => {
    expect(manifest.configSchema.properties.largeFileSummaryModel).toEqual({ type: "string" });
    expect(manifest.configSchema.properties.largeFileSummaryProvider).toEqual({ type: "string" });
    expect(manifest.configSchema.properties.timezone).toEqual({ type: "string" });
    expect(manifest.configSchema.properties.pruneHeartbeatOk).toEqual({ type: "boolean" });
  });

  it("ships a manifest with bootstrapMaxTokens in schema", () => {
    expect(manifest.configSchema.properties.bootstrapMaxTokens).toEqual({
      type: "integer",
      minimum: 1,
    });
  });
  it("defaults summaryMaxOverageFactor to 3 and maxAssemblyTokenBudget to undefined", () => {
    const config = resolveLcmConfig({}, {});
    expect(config.bootstrapMaxTokens).toBe(6000);
    expect(config.delegationTimeoutMs).toBe(120000);
    expect(config.summaryMaxOverageFactor).toBe(3);
    expect(config.maxAssemblyTokenBudget).toBeUndefined();
  });

  it("derives bootstrapMaxTokens from leafChunkTokens and allows override", () => {
    expect(resolveLcmConfig({}, {
      leafChunkTokens: 80_000,
    }).bootstrapMaxTokens).toBe(24_000);

    expect(resolveLcmConfig({}, {
      leafChunkTokens: 80_000,
      bootstrapMaxTokens: 12_345,
    }).bootstrapMaxTokens).toBe(12_345);
  });

  it("env vars override bootstrapMaxTokens", () => {
    const config = resolveLcmConfig({
      LCM_BOOTSTRAP_MAX_TOKENS: "4321",
    } as NodeJS.ProcessEnv, {
      bootstrapMaxTokens: 12_345,
    });
    expect(config.bootstrapMaxTokens).toBe(4321);
  });

  it("falls back cleanly when numeric env vars are invalid", () => {
    const config = resolveLcmConfig({
      LCM_LEAF_CHUNK_TOKENS: "oops",
      LCM_BOOTSTRAP_MAX_TOKENS: "still-nope",
      LCM_CONTEXT_THRESHOLD: "bad",
      LCM_SUMMARY_MAX_OVERAGE_FACTOR: "nah",
    } as NodeJS.ProcessEnv, {
      leafChunkTokens: 80_000,
      contextThreshold: 0.5,
      summaryMaxOverageFactor: 5,
    });

    expect(config.leafChunkTokens).toBe(80_000);
    expect(config.bootstrapMaxTokens).toBe(24_000);
    expect(config.contextThreshold).toBe(0.5);
    expect(config.summaryMaxOverageFactor).toBe(5);
  });

  it("reads summaryMaxOverageFactor and maxAssemblyTokenBudget from plugin config", () => {
    const config = resolveLcmConfig({}, {
      summaryMaxOverageFactor: 5,
      maxAssemblyTokenBudget: 30000,
    });
    expect(config.summaryMaxOverageFactor).toBe(5);
    expect(config.maxAssemblyTokenBudget).toBe(30000);
  });

  it("env vars override summaryMaxOverageFactor and maxAssemblyTokenBudget", () => {
    const config = resolveLcmConfig({
      LCM_SUMMARY_MAX_OVERAGE_FACTOR: "2.5",
      LCM_MAX_ASSEMBLY_TOKEN_BUDGET: "16000",
    } as NodeJS.ProcessEnv, {
      summaryMaxOverageFactor: 5,
      maxAssemblyTokenBudget: 30000,
    });
    expect(config.summaryMaxOverageFactor).toBe(2.5);
    expect(config.maxAssemblyTokenBudget).toBe(16000);
  });
});

describe("resolveOpenclawStateDir", () => {
  it("falls back to ~/.openclaw when OPENCLAW_STATE_DIR is unset", () => {
    const result = resolveOpenclawStateDir({});
    expect(result).toBe(join(homedir(), ".openclaw"));
  });

  it("returns OPENCLAW_STATE_DIR when set", () => {
    const result = resolveOpenclawStateDir({ OPENCLAW_STATE_DIR: "/custom/state" });
    expect(result).toBe("/custom/state");
  });

  it("trims whitespace from OPENCLAW_STATE_DIR", () => {
    const result = resolveOpenclawStateDir({ OPENCLAW_STATE_DIR: "  /custom/state  " });
    expect(result).toBe("/custom/state");
  });

  it("falls back to ~/.openclaw when OPENCLAW_STATE_DIR is an empty string", () => {
    const result = resolveOpenclawStateDir({ OPENCLAW_STATE_DIR: "" });
    expect(result).toBe(join(homedir(), ".openclaw"));
  });

  it("falls back to ~/.openclaw when OPENCLAW_STATE_DIR is whitespace only", () => {
    const result = resolveOpenclawStateDir({ OPENCLAW_STATE_DIR: "   " });
    expect(result).toBe(join(homedir(), ".openclaw"));
  });
});

describe("resolveLcmConfig largeFilesDir", () => {
  it("defaults largeFilesDir to ~/.openclaw/lcm-files when OPENCLAW_STATE_DIR is unset", () => {
    const config = resolveLcmConfig({}, {});
    expect(config.largeFilesDir).toBe(join(homedir(), ".openclaw", "lcm-files"));
  });

  it("uses OPENCLAW_STATE_DIR for largeFilesDir when set", () => {
    const config = resolveLcmConfig(
      { OPENCLAW_STATE_DIR: "/custom/state" } as NodeJS.ProcessEnv,
      {},
    );
    expect(config.largeFilesDir).toBe("/custom/state/lcm-files");
  });

  it("LCM_LARGE_FILES_DIR env var overrides OPENCLAW_STATE_DIR for largeFilesDir", () => {
    const config = resolveLcmConfig(
      {
        OPENCLAW_STATE_DIR: "/custom/state",
        LCM_LARGE_FILES_DIR: "/explicit/files",
      } as NodeJS.ProcessEnv,
      {},
    );
    expect(config.largeFilesDir).toBe("/explicit/files");
  });

  it("largeFilesDir plugin config overrides OPENCLAW_STATE_DIR", () => {
    const config = resolveLcmConfig(
      { OPENCLAW_STATE_DIR: "/custom/state" } as NodeJS.ProcessEnv,
      { largeFilesDir: "/plugin/files" },
    );
    expect(config.largeFilesDir).toBe("/plugin/files");
  });

  it("LCM_LARGE_FILES_DIR env var overrides largeFilesDir plugin config", () => {
    const config = resolveLcmConfig(
      { LCM_LARGE_FILES_DIR: "/env/files" } as NodeJS.ProcessEnv,
      { largeFilesDir: "/plugin/files" },
    );
    expect(config.largeFilesDir).toBe("/env/files");
  });
});

describe("resolveLcmConfig databasePath uses OPENCLAW_STATE_DIR", () => {
  it("uses OPENCLAW_STATE_DIR for default databasePath", () => {
    const config = resolveLcmConfig(
      { OPENCLAW_STATE_DIR: "/custom/state" } as NodeJS.ProcessEnv,
      {},
    );
    expect(config.databasePath).toBe("/custom/state/lcm.db");
  });

  it("LCM_DATABASE_PATH still overrides OPENCLAW_STATE_DIR", () => {
    const config = resolveLcmConfig(
      {
        OPENCLAW_STATE_DIR: "/custom/state",
        LCM_DATABASE_PATH: "/explicit/db.sqlite",
      } as NodeJS.ProcessEnv,
      {},
    );
    expect(config.databasePath).toBe("/explicit/db.sqlite");
  });
});
