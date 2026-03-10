import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import lcmPlugin from "../index.js";
import { closeLcmConnection } from "../src/db/connection.js";

type RegisteredEngineFactory = (() => unknown) | undefined;

function buildApi(
  pluginConfig: Record<string, unknown>,
  options?: { includeModelAuth?: boolean; agentDir?: string },
): {
  api: OpenClawPluginApi;
  getFactory: () => RegisteredEngineFactory;
  infoLog: ReturnType<typeof vi.fn>;
  warnLog: ReturnType<typeof vi.fn>;
} {
  let factory: RegisteredEngineFactory;
  const infoLog = vi.fn();
  const warnLog = vi.fn();
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
        loadConfig: vi.fn(() => ({})),
      },
      channel: {
        session: {
          resolveStorePath: vi.fn(() => "/tmp/nonexistent-session-store.json"),
        },
      },
    },
    logger: {
      info: infoLog,
      warn: warnLog,
      error: vi.fn(),
      debug: vi.fn(),
    },
    registerContextEngine: vi.fn((_id: string, nextFactory: () => unknown) => {
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
    on: vi.fn(),
  } as unknown as OpenClawPluginApi;

  return {
    api,
    getFactory: () => factory,
    infoLog,
    warnLog,
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

describe("lcm plugin registration", () => {
  const dbPaths = new Set<string>();
  const tempDirs = new Set<string>();

  afterEach(() => {
    for (const dbPath of dbPaths) {
      closeLcmConnection(dbPath);
    }
    dbPaths.clear();
    vi.unstubAllEnvs();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  it("uses api.pluginConfig values during register", { timeout: 20000 }, () => {
    const dbPath = join(tmpdir(), `lossless-claw-${Date.now()}-${Math.random().toString(16)}.db`);
    dbPaths.add(dbPath);

    const { api, getFactory, infoLog } = buildApi({
      enabled: true,
      contextThreshold: 0.33,
      incrementalMaxDepth: -1,
      freshTailCount: 7,
      dbPath,
      largeFileThresholdTokens: 12345,
    });

    lcmPlugin.register(api);

    const factory = getFactory();
    expect(factory).toBeTypeOf("function");

    const engine = factory!() as { config: Record<string, unknown> };
    expect(engine.config).toMatchObject({
      enabled: true,
      contextThreshold: 0.33,
      incrementalMaxDepth: -1,
      freshTailCount: 7,
      databasePath: dbPath,
      largeFileTokenThreshold: 12345,
    });
    expect(infoLog).toHaveBeenCalledWith(
      `[lcm] Plugin loaded (enabled=true, db=${dbPath}, threshold=0.33)`,
    );
  });

  it("inherits OpenClaw's default model for summarization when no LCM model override is set", () => {
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
      model: "claude-sonnet-4-6",
    });
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
});
