import { describe, it, expect } from "vitest";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import { resolveLcmConfig } from "../src/db/config.js";

describe("resolveLcmConfig", () => {
  it("uses hardcoded defaults when no env or plugin config", () => {
    const config = resolveLcmConfig({}, {});
    expect(config.enabled).toBe(true);
    expect(config.ignoreSessionPatterns).toEqual([]);
    expect(config.statelessSessionPatterns).toEqual([]);
    expect(config.skipStatelessSessions).toBe(true);
    expect(config.contextThreshold).toBe(0.75);
    expect(config.freshTailCount).toBe(32);
    expect(config.incrementalMaxDepth).toBe(0);
    expect(config.leafMinFanout).toBe(8);
    expect(config.condensedMinFanout).toBe(4);
    expect(config.condensedMinFanoutHard).toBe(2);
    expect(config.summaryProvider).toBe("");
    expect(config.summaryModel).toBe("");
    expect(config.autocompactDisabled).toBe(false);
    expect(config.pruneHeartbeatOk).toBe(false);
  });

  it("reads values from plugin config", () => {
    const config = resolveLcmConfig({}, {
      contextThreshold: 0.5,
      freshTailCount: 16,
      incrementalMaxDepth: -1,
      ignoreSessionPatterns: ["agent:*:cron:*", "agent:main:subagent:**"],
      statelessSessionPatterns: ["agent:*:ephemeral:**"],
      skipStatelessSessions: false,
      leafMinFanout: 4,
      condensedMinFanout: 2,
      autocompactDisabled: true,
      pruneHeartbeatOk: true,
      enabled: false,
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
    expect(config.incrementalMaxDepth).toBe(-1);
    expect(config.leafMinFanout).toBe(4);
    expect(config.condensedMinFanout).toBe(2);
    expect(config.autocompactDisabled).toBe(true);
    expect(config.pruneHeartbeatOk).toBe(true);
  });

  it("env vars override plugin config", () => {
    const env = {
      LCM_CONTEXT_THRESHOLD: "0.9",
      LCM_FRESH_TAIL_COUNT: "64",
      LCM_INCREMENTAL_MAX_DEPTH: "3",
      LCM_ENABLED: "false",
      LCM_AUTOCOMPACT_DISABLED: "true",
      LCM_IGNORE_SESSION_PATTERNS: "agent:*:cron:*, agent:main:subagent:**",
      LCM_STATELESS_SESSION_PATTERNS: "agent:*:ephemeral:**, agent:main:preview:*",
      LCM_SKIP_STATELESS_SESSIONS: "false",
    } as NodeJS.ProcessEnv;
    const pluginConfig = {
      contextThreshold: 0.5,
      freshTailCount: 16,
      incrementalMaxDepth: -1,
      ignoreSessionPatterns: ["agent:*:test:*"],
      statelessSessionPatterns: ["agent:*:preview:*"],
      skipStatelessSessions: true,
      enabled: true,
      autocompactDisabled: false,
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
    expect(config.contextThreshold).toBe(0.9); // env wins
    expect(config.freshTailCount).toBe(64); // env wins
    expect(config.incrementalMaxDepth).toBe(3); // env wins
    expect(config.autocompactDisabled).toBe(true); // env wins
  });

  it("plugin config fills gaps when env vars are absent", () => {
    const env = {
      LCM_CONTEXT_THRESHOLD: "0.9",
    } as NodeJS.ProcessEnv;
    const pluginConfig = {
      contextThreshold: 0.5, // should be overridden by env
      freshTailCount: 16, // should be used (no env)
      incrementalMaxDepth: -1, // should be used (no env)
    };
    const config = resolveLcmConfig(env, pluginConfig);
    expect(config.contextThreshold).toBe(0.9); // env wins
    expect(config.freshTailCount).toBe(16); // plugin config
    expect(config.incrementalMaxDepth).toBe(-1); // plugin config
    expect(config.leafMinFanout).toBe(8); // hardcoded default
  });

  it("handles string values in plugin config (from JSON)", () => {
    const config = resolveLcmConfig({}, {
      contextThreshold: "0.6",
      freshTailCount: "24",
      ignoreSessionPatterns: "agent:*:cron:*, agent:main:subagent:**",
      statelessSessionPatterns: "agent:*:ephemeral:**, agent:main:preview:*",
      skipStatelessSessions: "false",
    });
    expect(config.contextThreshold).toBe(0.6);
    expect(config.freshTailCount).toBe(24);
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
      enabled: "maybe",
    });
    expect(config.contextThreshold).toBe(0.75); // falls through to default
    expect(config.freshTailCount).toBe(32); // falls through to default
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
  });

  it("ships a manifest with expansionModel and expansionProvider in schema", () => {
    expect(manifest.configSchema.properties.expansionModel).toEqual({ type: "string" });
    expect(manifest.configSchema.properties.expansionProvider).toEqual({ type: "string" });
  });

  it("defaults summaryMaxOverageFactor to 3 and maxAssemblyTokenBudget to undefined", () => {
    const config = resolveLcmConfig({}, {});
    expect(config.summaryMaxOverageFactor).toBe(3);
    expect(config.maxAssemblyTokenBudget).toBeUndefined();
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
