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
}));

vi.mock("@mariozechner/pi-ai", () => piAiMock);

type RegisteredEngineFactory = (() => unknown) | undefined;

function buildApi(): {
  api: OpenClawPluginApi;
  getFactory: () => RegisteredEngineFactory;
} {
  let factory: RegisteredEngineFactory;
  const dbPath = join(tmpdir(), `lossless-claw-${Date.now()}-${Math.random().toString(16)}.db`);
  const modelAuth = {
    getApiKeyForModel: vi.fn(async () => ({ apiKey: "model-auth-key" })),
    getRuntimeAuthForModel: vi.fn(async () => ({
      apiKey: "runtime-auth-key",
      baseUrl: "https://runtime-auth.example.test/v1",
      request: {
        headers: {
          "X-Runtime-Header": "enabled",
        },
      },
    })),
    resolveApiKeyForProvider: vi.fn(async () => ({ apiKey: "provider-auth-key" })),
  };

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
        loadConfig: vi.fn(() => ({})),
      },
      channel: {
        session: {
          resolveStorePath: vi.fn(() => "/tmp/nonexistent-session-store.json"),
        },
      },
      modelAuth,
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
  };
}

describe("createLcmDependencies.complete modelAuth lookup order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    piAiMock.completeSimple.mockResolvedValue({
      content: [{ type: "text", text: "summary output" }],
    });
    piAiMock.getModel.mockReturnValue(undefined);
    piAiMock.getModels.mockReturnValue([]);
    piAiMock.getEnvApiKey.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("prefers runtime.modelAuth.getRuntimeAuthForModel when available", async () => {
    const { api, getFactory } = buildApi();
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
          messages: Array<{ role: string; content: string }>;
          maxTokens: number;
        }) => Promise<unknown>;
      };
      config: { databasePath: string };
    };

    try {
      await engine.deps.complete({
        provider: "openai-codex",
        model: "gpt-5.4",
        messages: [{ role: "user", content: "Summarize this." }],
        maxTokens: 256,
      });

      const runtime = api.runtime as typeof api.runtime & {
        modelAuth: {
          getRuntimeAuthForModel: ReturnType<typeof vi.fn>;
          getApiKeyForModel: ReturnType<typeof vi.fn>;
          resolveApiKeyForProvider: ReturnType<typeof vi.fn>;
        };
      };
      expect(runtime.modelAuth.getRuntimeAuthForModel).toHaveBeenCalledTimes(1);
      expect(runtime.modelAuth.getApiKeyForModel).not.toHaveBeenCalled();
      expect(runtime.modelAuth.resolveApiKeyForProvider).not.toHaveBeenCalled();
      expect(piAiMock.completeSimple).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: "https://runtime-auth.example.test/v1",
          headers: expect.objectContaining({
            "X-Runtime-Header": "enabled",
          }),
        }),
        expect.any(Object),
        expect.objectContaining({
          apiKey: "runtime-auth-key",
        }),
      );
    } finally {
      closeLcmConnection(engine.config.databasePath);
    }
  });

  it("falls back to getApiKeyForModel when runtime-ready auth is unavailable", async () => {
    const { api, getFactory } = buildApi();
    const runtime = api.runtime as typeof api.runtime & {
      modelAuth: {
        getRuntimeAuthForModel: ReturnType<typeof vi.fn>;
        getApiKeyForModel: ReturnType<typeof vi.fn>;
        resolveApiKeyForProvider: ReturnType<typeof vi.fn>;
      };
    };
    runtime.modelAuth.getRuntimeAuthForModel.mockResolvedValue(undefined);

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
          messages: Array<{ role: string; content: string }>;
          maxTokens: number;
        }) => Promise<unknown>;
      };
      config: { databasePath: string };
    };

    try {
      await engine.deps.complete({
        provider: "openai-codex",
        model: "gpt-5.4",
        messages: [{ role: "user", content: "Summarize this." }],
        maxTokens: 256,
      });

      expect(runtime.modelAuth.getRuntimeAuthForModel).toHaveBeenCalledTimes(1);
      expect(runtime.modelAuth.getApiKeyForModel).toHaveBeenCalledTimes(1);
      expect(runtime.modelAuth.resolveApiKeyForProvider).not.toHaveBeenCalled();
      expect(piAiMock.completeSimple).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Object),
        expect.objectContaining({
          apiKey: "model-auth-key",
        }),
      );
    } finally {
      closeLcmConnection(engine.config.databasePath);
    }
  });
});
