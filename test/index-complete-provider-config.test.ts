import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import lcmPlugin from "../index.js";
import { closeLcmConnection } from "../src/db/connection.js";

const piAiMock = vi.hoisted(() => ({
  completeSimple: vi.fn(),
  getModel: vi.fn(),
  getModels: vi.fn(),
  getEnvApiKey: vi.fn(),
  getOAuthApiKey: vi.fn(),
}));

vi.mock("@mariozechner/pi-ai", () => piAiMock);

type RegisteredEngineFactory = (() => unknown) | undefined;

function buildApi(loadConfigResult: Record<string, unknown>): {
  api: OpenClawPluginApi;
  getFactory: () => RegisteredEngineFactory;
  loadConfig: ReturnType<typeof vi.fn>;
} {
  let factory: RegisteredEngineFactory;
  const loadConfig = vi.fn(() => loadConfigResult);
  const dbPath = join(tmpdir(), `lossless-claw-${Date.now()}-${Math.random().toString(16)}.db`);

  const api = {
    id: "lossless-claw",
    name: "Lossless Context Management",
    source: "/tmp/lossless-claw",
    config: {},
    pluginConfig: {
      enabled: true,
      dbPath,
    },
    runtime: {
      subagent: {
        run: vi.fn(),
        waitForRun: vi.fn(),
        getSession: vi.fn(),
        deleteSession: vi.fn(),
      },
      config: {
        loadConfig,
      },
      channel: {
        session: {
          resolveStorePath: vi.fn(() => "/tmp/nonexistent-session-store.json"),
        },
      },
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
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
    resolvePath: vi.fn(() => "/tmp/fake-agent"),
    on: vi.fn(),
  } as unknown as OpenClawPluginApi;

  return {
    api,
    getFactory: () => factory,
    loadConfig,
  };
}

async function callComplete(params: {
  loadConfigResult: Record<string, unknown>;
  provider: string;
  model: string;
  runtimeConfig?: unknown;
}) {
  const { api, getFactory, loadConfig } = buildApi(params.loadConfigResult);
  lcmPlugin.register(api);
  const factory = getFactory();
  if (!factory) {
    throw new Error("Expected LCM engine factory to be registered.");
  }

  const engine = factory() as {
    deps: {
      complete: (input: {
        provider: string;
        model: string;
        runtimeConfig?: unknown;
        messages: Array<{ role: string; content: string }>;
        maxTokens: number;
      }) => Promise<unknown>;
    };
    config: { databasePath: string };
  };

  try {
    const result = await engine.deps.complete({
      provider: params.provider,
      model: params.model,
      runtimeConfig: params.runtimeConfig,
      messages: [{ role: "user", content: "Summarize this." }],
      maxTokens: 256,
    });
    return { loadConfig, result };
  } finally {
    closeLcmConnection(engine.config.databasePath);
  }
}

describe("createLcmDependencies.complete provider config resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    piAiMock.completeSimple.mockResolvedValue({
      content: [{ type: "text", text: "summary output" }],
    });
    piAiMock.getModel.mockReturnValue(undefined);
    piAiMock.getModels.mockReturnValue([]);
    piAiMock.getEnvApiKey.mockReturnValue(undefined);
    piAiMock.getOAuthApiKey.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("falls back to api.runtime.config.loadConfig() and resolves provider config fields", async () => {
    const { loadConfig } = await callComplete({
      loadConfigResult: {
        models: {
          providers: {
            "Unit-Proxy": {
              api: "openai-completions",
              baseUrl: "https://proxy.example.test/v1",
              headers: {
                "X-Test-Header": "yes",
              },
              apiKey: "provider-level-key",
            },
          },
        },
      },
      provider: "unit-proxy",
      model: "unit-model",
    });

    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(piAiMock.completeSimple).toHaveBeenCalledTimes(1);
    expect(piAiMock.completeSimple).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "unit-model",
        provider: "unit-proxy",
        api: "openai-completions",
        baseUrl: "https://proxy.example.test/v1",
        headers: {
          "X-Test-Header": "yes",
        },
      }),
      expect.any(Object),
      expect.objectContaining({
        apiKey: "provider-level-key",
        maxTokens: 256,
      }),
    );
  });

  it("merges provider-level baseUrl and headers into known models", async () => {
    piAiMock.getModel.mockReturnValue({
      id: "known-model",
      provider: "unit-proxy",
      api: "openai-completions",
      name: "Known Model",
    });

    await callComplete({
      loadConfigResult: {
        models: {
          providers: {
            "unit-proxy": {
              baseUrl: "https://known-proxy.example.test/v1",
              headers: {
                Authorization: "Bearer test",
              },
            },
          },
        },
      },
      provider: "unit-proxy",
      model: "known-model",
      runtimeConfig: {
        models: {
          providers: {
            "unit-proxy": {
              baseUrl: "https://known-proxy.example.test/v1",
              headers: {
                Authorization: "Bearer test",
              },
            },
          },
        },
      },
    });

    expect(piAiMock.completeSimple).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "known-model",
        provider: "unit-proxy",
        api: "openai-completions",
        baseUrl: "https://known-proxy.example.test/v1",
        headers: {
          Authorization: "Bearer test",
        },
      }),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("always passes baseUrl as a string for known models", async () => {
    piAiMock.getModel.mockReturnValue({
      id: "known-model",
      provider: "unit-proxy",
      api: "openai-completions",
      name: "Known Model",
    });

    await callComplete({
      loadConfigResult: {
        models: {
          providers: {
            "unit-proxy": {
              apiKey: "provider-level-key",
            },
          },
        },
      },
      provider: "unit-proxy",
      model: "known-model",
      runtimeConfig: {},
    });

    expect(piAiMock.completeSimple).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "",
      }),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("preserves provider auth error metadata when completeSimple throws a 401 scope error", async () => {
    piAiMock.completeSimple.mockRejectedValue({
      statusCode: 401,
      error: {
        code: "insufficient_scope",
        message: "Missing required scope: model.request",
      },
    });

    const { result } = await callComplete({
      loadConfigResult: {},
      provider: "openai-codex",
      model: "gpt-5.4",
      runtimeConfig: {},
    });

    expect(result).toMatchObject({
      content: [],
      error: {
        kind: "provider_auth",
        statusCode: 401,
        code: "insufficient_scope",
      },
    });
  });
});
