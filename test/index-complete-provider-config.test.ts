import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../src/openclaw-bridge.js";
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
  providerApi?: string;
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
        providerApi?: string;
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
      providerApi: params.providerApi,
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

    expect(loadConfig).toHaveBeenCalled();
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

  it("prefers model-level runtime api over known model and provider api", async () => {
    piAiMock.getModel.mockReturnValue({
      id: "gpt-5.4-mini",
      provider: "openai-codex",
      api: "openai-codex-responses",
      name: "GPT-5.4 Mini",
      baseUrl: "https://chatgpt.com/backend-api/v1",
    });

    const runtimeConfig = {
      models: {
        providers: {
          "openai-codex": {
            api: "openai-codex-responses",
            baseUrl: "https://api.openai.com/v1",
            models: [{ id: "gpt-5.4-mini", api: "openai-completions" }],
          },
        },
      },
    };

    await callComplete({
      loadConfigResult: runtimeConfig,
      provider: "openai-codex",
      model: "gpt-5.4-mini",
      providerApi: "openai-codex-responses",
      runtimeConfig,
    });

    expect(piAiMock.completeSimple).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "gpt-5.4-mini",
        provider: "openai-codex",
        api: "openai-completions",
        baseUrl: "https://api.openai.com/v1",
      }),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("prefers model-level runtime api over provider api when model is custom", async () => {
    await callComplete({
      loadConfigResult: {},
      provider: "openai-codex",
      model: "custom-mini",
      providerApi: "openai-codex-responses",
      runtimeConfig: {
        models: {
          providers: {
            "openai-codex": {
              models: [{ id: "custom-mini", api: "openai-completions" }],
            },
          },
        },
      },
    });

    expect(piAiMock.completeSimple).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "custom-mini",
        provider: "openai-codex",
        api: "openai-completions",
      }),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("overrides built-in transport defaults for known providers with runtime provider config", async () => {
    piAiMock.getModel.mockReturnValue({
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      name: "GPT-5.4",
      baseUrl: "https://api.openai.com/v1",
      headers: {
        "X-Builtin": "1",
      },
    });

    await callComplete({
      loadConfigResult: {
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              baseUrl: "http://proxy.example.test/v1",
              headers: {
                "X-Proxy": "yes",
              },
            },
          },
        },
      },
      provider: "openai",
      model: "gpt-5.4",
      runtimeConfig: {
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              baseUrl: "http://proxy.example.test/v1",
              headers: {
                "X-Proxy": "yes",
              },
            },
          },
        },
      },
    });

    expect(piAiMock.completeSimple).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "gpt-5.4",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "http://proxy.example.test/v1",
        headers: {
          "X-Builtin": "1",
          "X-Proxy": "yes",
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
              api: "openai-completions",
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

  it("returns a clear error when a custom provider has no resolvable api family", async () => {
    const { result } = await callComplete({
      loadConfigResult: {
        models: {
          providers: {
            "codex-gateway": {
              baseUrl: "http://proxy.example.test/v1",
            },
          },
        },
      },
      provider: "codex-gateway",
      model: "gpt-5.4",
      runtimeConfig: {
        models: {
          providers: {
            "codex-gateway": {
              baseUrl: "http://proxy.example.test/v1",
            },
          },
        },
      },
    });

    expect(result).toMatchObject({
      content: [],
      error: {
        kind: "provider_config",
        message: expect.stringMatching(/unable to resolve API family for provider codex-gateway/i),
      },
    });
    expect(piAiMock.completeSimple).not.toHaveBeenCalled();
  });

  it("falls back to openai-completions for ollama when no api family is configured", async () => {
    await callComplete({
      loadConfigResult: {},
      provider: "ollama",
      model: "kimi-k2.5:cloud",
      runtimeConfig: {},
    });

    expect(piAiMock.completeSimple).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "kimi-k2.5:cloud",
        provider: "ollama",
        api: "openai-completions",
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

  it("does not mislabel non-config provider errors as provider_config", async () => {
    piAiMock.completeSimple.mockRejectedValue(new Error("gateway timed out"));

    const { result } = await callComplete({
      loadConfigResult: {
        models: {
          providers: {
            "unit-proxy": {
              api: "openai-completions",
            },
          },
        },
      },
      provider: "unit-proxy",
      model: "unit-model",
      runtimeConfig: {
        models: {
          providers: {
            "unit-proxy": {
              api: "openai-completions",
            },
          },
        },
      },
    });

    expect(result).toMatchObject({
      content: [],
    });
    expect(result).not.toHaveProperty("error");
  });
});
