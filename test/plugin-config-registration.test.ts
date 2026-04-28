import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../src/openclaw-bridge.js";
import lcmPlugin from "../index.js";
import * as connectionModule from "../src/db/connection.js";
import { closeLcmConnection } from "../src/db/connection.js";
import { clearAllSharedInit } from "../src/plugin/shared-init.js";
import { resetStartupBannerLogsForTests } from "../src/startup-banner-log.js";

type RegisteredEngineFactory = (() => unknown) | undefined;
type HookHandler = (event: unknown, context: unknown) => unknown;
type RegisteredContextEngine = { id: string; factory: () => unknown };

function buildApi(
  pluginConfig: unknown,
  options?: {
    includeModelAuth?: boolean;
    agentDir?: string;
    runtimeConfig?: Record<string, unknown>;
  },
): {
  api: OpenClawPluginApi;
  getFactory: () => RegisteredEngineFactory;
  getHook: (hookName: string) => HookHandler | undefined;
  getRegisteredContextEngines: () => RegisteredContextEngine[];
  infoLog: ReturnType<typeof vi.fn>;
  warnLog: ReturnType<typeof vi.fn>;
  errorLog: ReturnType<typeof vi.fn>;
  debugLog: ReturnType<typeof vi.fn>;
  sessionInfoLog: ReturnType<typeof vi.fn>;
  sessionWarnLog: ReturnType<typeof vi.fn>;
} {
  let factory: RegisteredEngineFactory;
  const registeredContextEngines: RegisteredContextEngine[] = [];
  const hooks = new Map<string, HookHandler[]>();
  const infoLog = vi.fn();
  const warnLog = vi.fn();
  const errorLog = vi.fn();
  const debugLog = vi.fn();
  const sessionInfoLog = vi.fn();
  const sessionWarnLog = vi.fn();
  const agentDir = options?.agentDir ?? "/tmp/fake-agent";

  const api = {
    id: "lossless-claw",
    name: "Lossless Context Management",
    source: "/tmp/lossless-claw",
    config: {},
    pluginConfig,
    runtime: {
      subagent: {
        run: vi.fn(),
        waitForRun: vi.fn(),
        getSession: vi.fn(),
        deleteSession: vi.fn(),
      },
      ...(options?.includeModelAuth === false
        ? {}
        : {
            modelAuth: {
              getApiKeyForModel: vi.fn(async () => undefined),
              resolveApiKeyForProvider: vi.fn(async () => undefined),
            },
          }),
      config: {
        loadConfig: vi.fn(() => options?.runtimeConfig ?? {}),
      },
      logging: {
        getChildLogger: vi.fn(() => ({
          info: infoLog,
          warn: warnLog,
          error: errorLog,
          debug: debugLog,
        })),
      },
      channel: {
        session: {
          resolveStorePath: vi.fn(() => "/tmp/nonexistent-session-store.json"),
        },
      },
    },
    logger: {
      info: sessionInfoLog,
      warn: sessionWarnLog,
      error: vi.fn(),
      debug: vi.fn(),
    },
    registerContextEngine: vi.fn((id: string, nextFactory: () => unknown) => {
      registeredContextEngines.push({ id, factory: nextFactory });
      factory = nextFactory;
    }),
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    registerHttpHandler: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    registerService: vi.fn(),
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    resolvePath: vi.fn(() => agentDir),
    on: vi.fn((hookName: string, handler: HookHandler) => {
      const existing = hooks.get(hookName) ?? [];
      existing.push(handler);
      hooks.set(hookName, existing);
    }),
  } as unknown as OpenClawPluginApi;

  return {
    api,
    getFactory: () => factory,
    getHook: (hookName: string) => hooks.get(hookName)?.[0],
    getRegisteredContextEngines: () => [...registeredContextEngines],
    infoLog,
    warnLog,
    errorLog,
    debugLog,
    sessionInfoLog,
    sessionWarnLog,
  };
}

function defaultModelConfig(model: string): Record<string, unknown> {
  return {
    agents: {
      defaults: {
        model: {
          primary: model,
        },
      },
    },
  };
}

function compactionAndDefaultModelConfig(params: {
  compactionModel?: string;
  defaultModel?: string;
}): Record<string, unknown> {
  return {
    agents: {
      defaults: {
        ...(params.defaultModel
          ? {
              model: {
                primary: params.defaultModel,
              },
            }
          : {}),
        ...(params.compactionModel
          ? {
              compaction: {
                model: params.compactionModel,
              },
            }
          : {}),
      },
    },
  };
}

describe("lcm plugin registration", () => {
  const dbPaths = new Set<string>();
  const tempDirs = new Set<string>();

  afterEach(() => {
    for (const dbPath of dbPaths) {
      closeLcmConnection(dbPath);
    }
    dbPaths.clear();
    clearAllSharedInit();
    resetStartupBannerLogsForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  it("registers only the lossless-claw context engine id", () => {
    const { api, getRegisteredContextEngines } = buildApi({ enabled: true });

    lcmPlugin.register(api);

    expect(getRegisteredContextEngines()).toEqual([
      expect.objectContaining({ id: "lossless-claw" }),
    ]);
  });

  it("uses api.pluginConfig values during register", { timeout: 20000 }, () => {
    const dbPath = join(tmpdir(), `lossless-claw-${Date.now()}-${Math.random().toString(16)}.db`);
    dbPaths.add(dbPath);

    const { api, getFactory, debugLog, infoLog, sessionInfoLog } = buildApi({
      enabled: true,
      contextThreshold: 0.33,
      incrementalMaxDepth: -1,
      freshTailCount: 7,
      promptAwareEviction: false,
      leafChunkTokens: 80000,
      newSessionRetainDepth: 4,
      dbPath,
      ignoreSessionPatterns: ["agent:*:cron:**", "agent:main:subagent:**"],
      statelessSessionPatterns: ["agent:*:subagent:**"],
      skipStatelessSessions: true,
      transcriptGcEnabled: true,
      proactiveThresholdCompactionMode: "inline",
      largeFileThresholdTokens: 12345,
    });
    lcmPlugin.register(api);
    expect(api.registerCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "lcm",
        nativeNames: expect.objectContaining({
          default: "lossless",
        }),
        nativeProgressMessages: expect.objectContaining({
          telegram: "Lossless Claw is working...",
        }),
      }),
    );

    const factory = getFactory();
    expect(factory).toBeTypeOf("function");

    const engine = factory!() as {
      config: Record<string, unknown>;
      info?: Record<string, unknown>;
    };
    expect(engine.config).toMatchObject({
      enabled: true,
      contextThreshold: 0.33,
      incrementalMaxDepth: -1,
      freshTailCount: 7,
      promptAwareEviction: false,
      newSessionRetainDepth: 4,
      leafChunkTokens: 80000,
      databasePath: dbPath,
      ignoreSessionPatterns: ["agent:*:cron:**", "agent:main:subagent:**"],
      statelessSessionPatterns: ["agent:*:subagent:**"],
      skipStatelessSessions: true,
      transcriptGcEnabled: true,
      proactiveThresholdCompactionMode: "inline",
      largeFileTokenThreshold: 12345,
    });
    expect(engine.info).toMatchObject({
      id: "lossless-claw",
      turnMaintenanceMode: "background",
    });
    expect(infoLog).toHaveBeenCalledWith(
      `[lcm] Plugin loaded (enabled=true, db=${dbPath}, threshold=0.33, proactiveThresholdCompactionMode=inline)`,
    );
    expect(infoLog).toHaveBeenCalledWith("[lcm] Transcript GC enabled (default false)");
    expect(infoLog).toHaveBeenCalledWith(
      "[lcm] Proactive threshold compaction mode: inline (default deferred)",
    );
    expect(infoLog).toHaveBeenCalledWith(
      "[lcm] Ignoring sessions matching 2 pattern(s) from plugin config: agent:*:cron:**, agent:main:subagent:**",
    );
    expect(infoLog).toHaveBeenCalledWith(
      "[lcm] Stateless session patterns from plugin config: 1 pattern(s): agent:*:subagent:**",
    );
    expect(infoLog).toHaveBeenCalledWith(
      "[lcm] Compaction summarization model: (unconfigured)",
    );
    expect(sessionInfoLog).not.toHaveBeenCalled();
    expect(debugLog).toHaveBeenCalledWith(expect.stringContaining("[lcm] Migration successful"));
    expect(api.on).toHaveBeenCalledWith("before_reset", expect.any(Function));
    expect(api.on).toHaveBeenCalledWith("session_end", expect.any(Function));
  });

  it("logs env-backed pattern sources and override warnings during register", () => {
    vi.stubEnv("LCM_IGNORE_SESSION_PATTERNS", "agent:*:cron:*, agent:main:subagent:**");
    vi.stubEnv("LCM_STATELESS_SESSION_PATTERNS", "agent:*:ephemeral:**");

    const { api, infoLog, warnLog } = buildApi({
      enabled: true,
      ignoreSessionPatterns: ["agent:*:test:*"],
      statelessSessionPatterns: ["agent:*:preview:*"],
      skipStatelessSessions: true,
    });

    lcmPlugin.register(api);

    expect(infoLog).toHaveBeenCalledWith(
      "[lcm] Ignoring sessions matching 2 pattern(s) from env: agent:*:cron:*, agent:main:subagent:**",
    );
    expect(infoLog).toHaveBeenCalledWith(
      "[lcm] Stateless session patterns from env: 1 pattern(s): agent:*:ephemeral:**",
    );
    expect(warnLog).toHaveBeenCalledWith(
      "[lcm] LCM_IGNORE_SESSION_PATTERNS from env overrides plugins.entries.lossless-claw.config.ignoreSessionPatterns; plugin config array will be ignored",
    );
    expect(warnLog).toHaveBeenCalledWith(
      "[lcm] LCM_STATELESS_SESSION_PATTERNS from env overrides plugins.entries.lossless-claw.config.statelessSessionPatterns; plugin config array will be ignored",
    );
  });

  it.each([
    ["missing", undefined],
    ["invalid", ["not-a-plugin-config"]],
    ["empty", {}],
  ])(
    "falls back to root plugin config when api.pluginConfig is %s",
    (_label, pluginConfig) => {
      const dbPath = join(tmpdir(), `lossless-claw-${Date.now()}-${Math.random().toString(16)}.db`);
      dbPaths.add(dbPath);

      const { api, getFactory } = buildApi(pluginConfig);
      api.config = {
        plugins: {
          entries: {
            "lossless-claw": {
              config: {
                enabled: true,
                contextThreshold: 0.42,
                freshTailCount: 9,
                dbPath,
              },
            },
          },
        },
      } as OpenClawPluginApi["config"];

      lcmPlugin.register(api);

      const factory = getFactory();
      expect(factory).toBeTypeOf("function");

      const engine = factory!() as { config: Record<string, unknown> };
      expect(engine.config).toMatchObject({
        enabled: true,
        contextThreshold: 0.42,
        freshTailCount: 9,
        databasePath: dbPath,
      });
    },
  );

  it("inherits OpenClaw's default model for summarization when no LCM model override is set", { timeout: 20000 }, () => {
    const { api, getFactory } = buildApi({
      enabled: true,
    });
    api.config = defaultModelConfig("anthropic/claude-sonnet-4-6") as OpenClawPluginApi["config"];

    lcmPlugin.register(api);

    const factory = getFactory();
    expect(factory).toBeTypeOf("function");

    const engine = factory!() as { deps?: { resolveModel: (modelRef?: string, providerHint?: string) => unknown } };
    const resolved = engine.deps?.resolveModel(undefined, undefined) as
      | { provider: string; model: string }
      | undefined;

    expect(resolved).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
  });

  it("stores plugin summary overrides in resolved LCM config", () => {
    const { api, getFactory } = buildApi({
      enabled: true,
      summaryModel: "gpt-5.4",
      summaryProvider: "openai-resp",
    });

    lcmPlugin.register(api);

    const factory = getFactory();
    expect(factory).toBeTypeOf("function");

    const engine = factory!() as { config: Record<string, unknown> };
    expect(engine.config).toMatchObject({
      summaryModel: "gpt-5.4",
      summaryProvider: "openai-resp",
    });
  });

  it("uses plugin config model override when summaryModel is set", () => {
    const { api, getFactory } = buildApi({
      enabled: true,
      summaryModel: "gpt-5.4",
      summaryProvider: "openai-resp",
    });
    api.config = defaultModelConfig("anthropic/claude-sonnet-4-6") as OpenClawPluginApi["config"];

    lcmPlugin.register(api);

    const factory = getFactory();
    expect(factory).toBeTypeOf("function");

    const engine = factory!() as { deps?: { resolveModel: (modelRef?: string, providerHint?: string) => unknown } };
    const resolved = engine.deps?.resolveModel(undefined, undefined) as
      | { provider: string; model: string }
      | undefined;

    expect(resolved).toEqual({
      provider: "openai-resp",
      model: "gpt-5.4",
    });
  });

  it("forwards explicit provider and model fields to runtime subagent runs", async () => {
    const dbPath = join(tmpdir(), `lossless-claw-${Date.now()}-${Math.random().toString(16)}.db`);
    dbPaths.add(dbPath);

    const { api, getFactory } = buildApi({
      enabled: true,
      dbPath,
    });

    lcmPlugin.register(api);

    const factory = getFactory();
    expect(factory).toBeTypeOf("function");

    const engine = factory!() as {
      deps?: {
        callGateway: (params: {
          method: string;
          params?: Record<string, unknown>;
        }) => Promise<unknown>;
      };
      config: { databasePath: string };
    };
    const run = api.runtime.subagent.run as ReturnType<typeof vi.fn>;

    await engine.deps?.callGateway({
      method: "agent",
      params: {
        sessionKey: "agent:main:subagent:test",
        message: "Test delegated run",
        provider: "openrouter",
        model: "anthropic/claude-haiku-4-5",
        deliver: false,
        idempotencyKey: "idem-1",
      },
    });

    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      sessionKey: "agent:main:subagent:test",
      message: "Test delegated run",
      provider: "openrouter",
      model: "anthropic/claude-haiku-4-5",
      deliver: false,
      idempotencyKey: "idem-1",
    }));
  });

  it("prefers env summary overrides over plugin config model overrides", () => {
    vi.stubEnv("LCM_SUMMARY_PROVIDER", "anthropic");
    vi.stubEnv("LCM_SUMMARY_MODEL", "claude-3-5-haiku");
    const { api, getFactory } = buildApi({
      enabled: true,
      summaryModel: "gpt-5.4",
      summaryProvider: "openai-resp",
    });
    api.config = defaultModelConfig("anthropic/claude-sonnet-4-6") as OpenClawPluginApi["config"];

    lcmPlugin.register(api);

    const factory = getFactory();
    expect(factory).toBeTypeOf("function");

    const engine = factory!() as { deps?: { resolveModel: (modelRef?: string, providerHint?: string) => unknown } };
    const resolved = engine.deps?.resolveModel(undefined, undefined) as
      | { provider: string; model: string }
      | undefined;

    expect(resolved).toEqual({
      provider: "anthropic",
      model: "claude-3-5-haiku",
    });
  });
  it("uses plugin config model with provider/model format", () => {
    const { api, getFactory } = buildApi({
      enabled: true,
      summaryModel: "openai-resp/gpt-5.4",
    });
    api.config = defaultModelConfig("anthropic/claude-sonnet-4-6") as OpenClawPluginApi["config"];

    lcmPlugin.register(api);

    const factory = getFactory();
    expect(factory).toBeTypeOf("function");

    const engine = factory!() as { deps?: { resolveModel: (modelRef?: string, providerHint?: string) => unknown } };
    const resolved = engine.deps?.resolveModel(undefined, undefined) as
      | { provider: string; model: string }
      | undefined;

    expect(resolved).toEqual({
      provider: "openai-resp",
      model: "gpt-5.4",
    });
  });

  it("keeps explicit provider hints ahead of plugin summaryProvider", () => {
    const { api, getFactory } = buildApi({
      enabled: true,
      summaryModel: "gpt-5.4",
      summaryProvider: "openai-resp",
    });
    api.config = defaultModelConfig("anthropic/claude-sonnet-4-6") as OpenClawPluginApi["config"];

    lcmPlugin.register(api);

    const factory = getFactory();
    expect(factory).toBeTypeOf("function");

    const engine = factory!() as { deps?: { resolveModel: (modelRef?: string, providerHint?: string) => unknown } };
    const resolved = engine.deps?.resolveModel("claude-sonnet-4-6", "anthropic") as
      | { provider: string; model: string }
      | undefined;

    expect(resolved).toEqual({
      provider: "anthropic",
      model: "gpt-5.4",
    });
  });

  it("logs compaction summarization overrides at startup", () => {
    const { api, infoLog, sessionInfoLog } = buildApi({
      enabled: true,
      summaryModel: "gpt-5.4",
      summaryProvider: "openai-resp",
    });
    api.config = defaultModelConfig("anthropic/claude-sonnet-4-6") as OpenClawPluginApi["config"];

    lcmPlugin.register(api);

    expect(infoLog).toHaveBeenCalledWith(
      "[lcm] Compaction summarization model: openai-resp/gpt-5.4 (override)",
    );
    expect(sessionInfoLog).not.toHaveBeenCalled();
  });

  it("falls back to runtime plugin config for the startup banner when register runs before api.pluginConfig is populated", () => {
    const { api, infoLog } = buildApi(
      {},
      {
        runtimeConfig: {
          plugins: {
            entries: {
              "lossless-claw": {
                enabled: true,
                config: {
                  summaryModel: "openai-codex/gpt-5.4",
                },
              },
            },
          },
        },
      },
    );
    api.config = {} as OpenClawPluginApi["config"];

    lcmPlugin.register(api);

    expect(infoLog).toHaveBeenCalledWith(
      "[lcm] Compaction summarization model: openai-codex/gpt-5.4 (override)",
    );
  });

  it("uses runtime OpenClaw defaults when api.pluginConfig is ready before api.config", () => {
    const { api, getFactory, infoLog } = buildApi(
      {
        enabled: true,
      },
      {
        runtimeConfig: compactionAndDefaultModelConfig({
          defaultModel: "anthropic/claude-sonnet-4-6",
        }),
      },
    );
    api.config = {} as OpenClawPluginApi["config"];

    lcmPlugin.register(api);

    expect(infoLog).toHaveBeenCalledWith(
      "[lcm] Compaction summarization model: anthropic/claude-sonnet-4-6 (default)",
    );

    const factory = getFactory();
    expect(factory).toBeTypeOf("function");

    const engine = factory!() as { deps?: { resolveModel: (modelRef?: string, providerHint?: string) => unknown } };
    const resolved = engine.deps?.resolveModel(undefined, undefined) as
      | { provider: string; model: string }
      | undefined;

    expect(resolved).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
  });

  it("logs the OpenClaw compaction model at startup when no plugin override is set", () => {
    const { api, infoLog } = buildApi({
      enabled: true,
    });
    api.config = compactionAndDefaultModelConfig({
      compactionModel: "anthropic/claude-opus-4-6",
      defaultModel: "openai-codex/gpt-5.4",
    }) as OpenClawPluginApi["config"];
    lcmPlugin.register(api);

    expect(infoLog).toHaveBeenCalledWith(
      "[lcm] Compaction summarization model: anthropic/claude-opus-4-6 (override)",
    );
  });

  it("prefers env summary overrides over the OpenClaw compaction model in the startup banner", () => {
    vi.stubEnv("LCM_SUMMARY_PROVIDER", "openai-codex");
    vi.stubEnv("LCM_SUMMARY_MODEL", "gpt-5.4");
    const { api, infoLog } = buildApi({
      enabled: true,
    });
    api.config = compactionAndDefaultModelConfig({
      compactionModel: "anthropic/claude-opus-4-6",
      defaultModel: "openai-codex/gpt-5.3-codex",
    }) as OpenClawPluginApi["config"];
    lcmPlugin.register(api);

    expect(infoLog).toHaveBeenCalledWith(
      "[lcm] Compaction summarization model: openai-codex/gpt-5.4 (override)",
    );
  });

  it("dedupes startup banner logs across repeated registration and engine construction", () => {
    const dbPath = join(tmpdir(), `lossless-claw-${Date.now()}-${Math.random().toString(16)}.db`);
    dbPaths.add(dbPath);

    const pluginConfig = {
      enabled: true,
      contextThreshold: 0.33,
      dbPath,
      ignoreSessionPatterns: ["agent:*:cron:**", "agent:main:subagent:**"],
      statelessSessionPatterns: ["agent:*:subagent:**"],
      skipStatelessSessions: true,
      proactiveThresholdCompactionMode: "deferred",
    };
    const first = buildApi(pluginConfig);
    const second = buildApi(pluginConfig);
    lcmPlugin.register(first.api);
    lcmPlugin.register(second.api);

    const firstFactory = first.getFactory();
    const secondFactory = second.getFactory();

    expect(firstFactory).toBeTypeOf("function");
    expect(secondFactory).toBeTypeOf("function");

    firstFactory!();
    secondFactory!();

    const firstMessages = first.infoLog.mock.calls.map(([message]) => message);
    const secondMessages = second.infoLog.mock.calls.map(([message]) => message);
    const firstSessionMessages = first.sessionInfoLog.mock.calls.map(([message]) => message);
    const secondSessionMessages = second.sessionInfoLog.mock.calls.map(([message]) => message);
    const debugMessages = first.debugLog.mock.calls.map(([message]) => message);
    const startupBannerMessages = [...firstMessages, ...secondMessages].filter((message) =>
      [
        "[lcm] Plugin loaded (enabled=true, db=",
        "[lcm] Transcript GC ",
        "[lcm] Proactive threshold compaction mode:",
        "[lcm] Compaction summarization model:",
        "[lcm] Ignoring sessions matching ",
        "[lcm] Stateless session patterns",
      ].some((prefix) => message.startsWith(prefix)),
    );

    expect(startupBannerMessages.sort()).toEqual([
      `[lcm] Plugin loaded (enabled=true, db=${dbPath}, threshold=0.33, proactiveThresholdCompactionMode=deferred)`,
      "[lcm] Transcript GC disabled (default false)",
      "[lcm] Proactive threshold compaction mode: deferred (default deferred)",
      "[lcm] Compaction summarization model: (unconfigured)",
      "[lcm] Ignoring sessions matching 2 pattern(s) from plugin config: agent:*:cron:**, agent:main:subagent:**",
      "[lcm] Stateless session patterns from plugin config: 1 pattern(s): agent:*:subagent:**",
    ].sort());
    expect(firstSessionMessages).toEqual([]);
    expect(secondSessionMessages).toEqual([]);
    expect(debugMessages).toEqual(
      expect.arrayContaining([expect.stringContaining("[lcm] Migration successful")]),
    );
    expect(firstMessages).toEqual(
      expect.not.arrayContaining([expect.stringContaining("[lcm] Migration successful")]),
    );
  });
  it("registers without runtime.modelAuth on older OpenClaw runtimes", () => {
    const { api, getFactory, warnLog } = buildApi(
      {
        enabled: true,
      },
      { includeModelAuth: false },
    );
    api.config = defaultModelConfig("anthropic/claude-sonnet-4-6") as OpenClawPluginApi["config"];

    expect(() => lcmPlugin.register(api)).not.toThrow();
    expect(getFactory()).toBeTypeOf("function");
    expect(warnLog).toHaveBeenCalledWith(expect.stringContaining("runtime.modelAuth is unavailable"));
  });

  it("prefers runtime.modelAuth over provider env keys when available", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "env-anthropic-key");

    const { api, getFactory } = buildApi({
      enabled: true,
    });
    api.config = defaultModelConfig("anthropic/claude-sonnet-4-6") as OpenClawPluginApi["config"];
    const modelAuth = (
      api.runtime as OpenClawPluginApi["runtime"] & {
        modelAuth: {
          getApiKeyForModel: ReturnType<typeof vi.fn>;
        };
      }
    ).modelAuth;
    modelAuth.getApiKeyForModel.mockResolvedValue({
      apiKey: "model-auth-key",
    });

    lcmPlugin.register(api);

    const factory = getFactory();
    expect(factory).toBeTypeOf("function");

    const engine = factory!() as {
      deps?: { getApiKey: (provider: string, model: string) => Promise<string | undefined> };
    };
    await expect(engine.deps?.getApiKey("anthropic", "claude-sonnet-4-6")).resolves.toBe(
      "model-auth-key",
    );
  });

  it("can bypass runtime.modelAuth and fall back to env credentials", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "env-anthropic-key");

    const { api, getFactory } = buildApi({
      enabled: true,
    });
    api.config = defaultModelConfig("anthropic/claude-sonnet-4-6") as OpenClawPluginApi["config"];
    const modelAuth = (
      api.runtime as OpenClawPluginApi["runtime"] & {
        modelAuth: {
          getApiKeyForModel: ReturnType<typeof vi.fn>;
        };
      }
    ).modelAuth;
    modelAuth.getApiKeyForModel.mockResolvedValue({
      apiKey: "model-auth-key",
    });

    lcmPlugin.register(api);

    const factory = getFactory();
    expect(factory).toBeTypeOf("function");

    const engine = factory!() as {
      deps?: {
        getApiKey: (
          provider: string,
          model: string,
          options?: { skipModelAuth?: boolean },
        ) => Promise<string | undefined>;
      };
    };
    await expect(
      engine.deps?.getApiKey("anthropic", "claude-sonnet-4-6", { skipModelAuth: true }),
    ).resolves.toBe("env-anthropic-key");
    expect(modelAuth.getApiKeyForModel).not.toHaveBeenCalled();
  });

  it("passes per-call runtimeConfig through to runtime.modelAuth", async () => {
    const { api, getFactory } = buildApi({
      enabled: true,
    });
    api.config = defaultModelConfig("anthropic/claude-sonnet-4-6") as OpenClawPluginApi["config"];
    const modelAuth = (
      api.runtime as OpenClawPluginApi["runtime"] & {
        modelAuth: {
          getApiKeyForModel: ReturnType<typeof vi.fn>;
        };
      }
    ).modelAuth;
    modelAuth.getApiKeyForModel.mockResolvedValue({
      apiKey: "model-auth-key",
    });

    lcmPlugin.register(api);

    const factory = getFactory();
    expect(factory).toBeTypeOf("function");

    const runtimeConfig = {
      auth: {
        order: {
          anthropic: ["anthropic:api-key"],
        },
      },
    };
    const engine = factory!() as {
      deps?: {
        getApiKey: (
          provider: string,
          model: string,
          options?: { runtimeConfig?: unknown },
        ) => Promise<string | undefined>;
      };
    };
    await expect(
      engine.deps?.getApiKey("anthropic", "claude-sonnet-4-6", { runtimeConfig }),
    ).resolves.toBe("model-auth-key");

    expect(modelAuth.getApiKeyForModel).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: runtimeConfig,
      }),
    );
  });

  it("falls back to auth-profiles.json when runtime.modelAuth is unavailable", { timeout: 20000 }, async () => {
    const provider = "lossless-test-provider";
    const agentDir = mkdtempSync(join(tmpdir(), "lossless-claw-auth-"));
    tempDirs.add(agentDir);
    writeFileSync(
      join(agentDir, "auth-profiles.json"),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "lossless-test-provider:test": {
              type: "api_key",
              provider,
              key: "token-from-auth-store",
            },
          },
          order: {
            [provider]: ["lossless-test-provider:test"],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const { api, getFactory } = buildApi(
      {
        enabled: true,
      },
      { includeModelAuth: false, agentDir },
    );
    api.config = defaultModelConfig(`${provider}/claude-sonnet-4-6`) as OpenClawPluginApi["config"];

    lcmPlugin.register(api);

    const factory = getFactory();
    expect(factory).toBeTypeOf("function");

    const engine = factory!() as {
      deps?: { getApiKey: (provider: string, model: string) => Promise<string | undefined> };
    };
    await expect(engine.deps?.getApiKey(provider, "claude-sonnet-4-6")).resolves.toBe(
      "token-from-auth-store",
    );
  });

  it("waits for gateway_start when eager init hits a lock", async () => {
    const dbPath = join(tmpdir(), `lossless-claw-${Date.now()}-${Math.random().toString(16)}.db`);
    dbPaths.add(dbPath);

    const { api, getFactory, getHook } = buildApi({
      enabled: true,
      dbPath,
    });
    const originalCreate = connectionModule.createLcmDatabaseConnection;
    const createSpy = vi.spyOn(connectionModule, "createLcmDatabaseConnection");
    createSpy.mockImplementation((path: string) => {
      if (createSpy.mock.calls.length === 1) {
        throw new Error("database is locked");
      }
      return originalCreate(path);
    });

    lcmPlugin.register(api);

    const factory = getFactory();
    const gatewayStart = getHook("gateway_start");
    expect(factory).toBeTypeOf("function");
    expect(gatewayStart).toBeTypeOf("function");

    let settled = false;
    const enginePromise = Promise.resolve(factory!()).then((engine) => {
      settled = true;
      return engine as { config?: { databasePath?: string } };
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    await gatewayStart?.({ port: 3000 }, { port: 3000 });
    await expect(enginePromise).resolves.toMatchObject({
      config: {
        databasePath: dbPath,
      },
    });
  });

  it("surfaces deferred init failures after gateway_start runs", async () => {
    const dbPath = join(tmpdir(), `lossless-claw-${Date.now()}-${Math.random().toString(16)}.db`);
    dbPaths.add(dbPath);

    const { api, getFactory, getHook } = buildApi({
      enabled: true,
      dbPath,
    });
    const createSpy = vi.spyOn(connectionModule, "createLcmDatabaseConnection");
    createSpy.mockImplementation(() => {
      if (createSpy.mock.calls.length === 1) {
        throw new Error("database is locked");
      }
      throw new Error("deferred init exploded");
    });

    lcmPlugin.register(api);

    const factory = getFactory();
    const gatewayStart = getHook("gateway_start");
    expect(factory).toBeTypeOf("function");
    expect(gatewayStart).toBeTypeOf("function");

    const enginePromise = Promise.resolve(factory!());
    await gatewayStart?.({ port: 3000 }, { port: 3000 });

    await expect(enginePromise).rejects.toThrow("deferred init exploded");
    await expect(Promise.resolve(factory!())).rejects.toThrow("deferred init exploded");
  });

  it("reuses singleton DB and engine when register() is called twice with the same dbPath", () => {
    const dbPath = join(tmpdir(), `lossless-claw-${Date.now()}-${Math.random().toString(16)}.db`);
    dbPaths.add(dbPath);

    const createSpy = vi.spyOn(connectionModule, "createLcmDatabaseConnection");

    const { api: api1 } = buildApi({ enabled: true, dbPath });
    lcmPlugin.register(api1);
    expect(createSpy).toHaveBeenCalledTimes(1);

    const { api: api2 } = buildApi({ enabled: true, dbPath });
    lcmPlugin.register(api2);
    // Second register with same path should NOT open a new connection
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("opens a fresh connection after gateway_stop clears singleton", async () => {
    const dbPath = join(tmpdir(), `lossless-claw-${Date.now()}-${Math.random().toString(16)}.db`);
    dbPaths.add(dbPath);

    const createSpy = vi.spyOn(connectionModule, "createLcmDatabaseConnection");

    const { api: api1, getHook: getHook1 } = buildApi({ enabled: true, dbPath });
    lcmPlugin.register(api1);
    expect(createSpy).toHaveBeenCalledTimes(1);

    // Simulate gateway_stop
    const gatewayStop = getHook1("gateway_stop");
    await gatewayStop?.({}, {});

    // After stop, a new register should open a fresh connection
    const { api: api2 } = buildApi({ enabled: true, dbPath });
    lcmPlugin.register(api2);
    expect(createSpy).toHaveBeenCalledTimes(2);
  });
});
