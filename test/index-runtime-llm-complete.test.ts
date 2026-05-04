import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../src/openclaw-bridge.js";
import lcmPlugin from "../index.js";
import { closeLcmConnection } from "../src/db/connection.js";

type RegisteredEngineFactory = (() => unknown) | undefined;
type RuntimeLlmComplete = ReturnType<typeof vi.fn>;

function buildApi(params?: {
  runtimeLlmComplete?: RuntimeLlmComplete;
}): {
  api: OpenClawPluginApi;
  getFactory: () => RegisteredEngineFactory;
  dbPath: string;
} {
  let factory: RegisteredEngineFactory;
  const dbPath = join(tmpdir(), `lossless-claw-${Date.now()}-${Math.random().toString(16)}.db`);
  const runtime: Record<string, unknown> = {
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
  };
  if (params?.runtimeLlmComplete) {
    runtime.llm = {
      complete: params.runtimeLlmComplete,
    };
  }

  const api = {
    id: "lossless-claw",
    name: "Lossless Context Management",
    source: "/tmp/lossless-claw",
    config: {},
    pluginConfig: {
      enabled: true,
      dbPath,
    },
    runtime,
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
    dbPath,
  };
}

function getRegisteredEngine(api: OpenClawPluginApi, getFactory: () => RegisteredEngineFactory) {
  lcmPlugin.register(api);
  const factory = getFactory();
  if (!factory) {
    throw new Error("Expected LCM engine factory to be registered.");
  }
  return factory() as {
    deps: {
      complete: (input: {
        provider?: string;
        model: string;
        runtimeModelOverride?: {
          configField: string;
          configPath: string;
          modelRef: string;
        };
        agentId?: string;
        system?: string;
        messages: Array<{ role: string; content: unknown }>;
        maxTokens: number;
        temperature?: number;
        reasoningIfSupported?: string;
      }) => Promise<Record<string, unknown>>;
      getApiKey: () => Promise<string | undefined>;
    };
    config: { databasePath: string };
  };
}

describe("createLcmDependencies.complete runtime.llm bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("delegates model dispatch and auth to api.runtime.llm.complete", async () => {
    const runtimeLlmComplete = vi.fn(async () => ({
      text: "summary output",
      provider: "openai-codex",
      model: "gpt-5.4",
      agentId: "research-agent",
      usage: { totalTokens: 42 },
      audit: { caller: { kind: "plugin", id: "lossless-claw" } },
    }));
    const { api, getFactory, dbPath } = buildApi({ runtimeLlmComplete });
    const engine = getRegisteredEngine(api, getFactory);

    try {
      const result = await engine.deps.complete({
        provider: "openai-codex",
        model: "gpt-5.4",
        runtimeModelOverride: {
          configField: "summaryModel",
          configPath: "plugins.entries.lossless-claw.config.summaryModel",
          modelRef: "openai-codex/gpt-5.4",
        },
        agentId: "research-agent",
        system: "System summary policy.",
        messages: [{ role: "user", content: "Summarize this." }],
        maxTokens: 256,
        temperature: 0.2,
        reasoningIfSupported: "low",
      });

      expect(runtimeLlmComplete).toHaveBeenCalledTimes(1);
      expect(runtimeLlmComplete).toHaveBeenCalledWith({
        messages: [{ role: "user", content: "Summarize this." }],
        model: "openai-codex/gpt-5.4",
        maxTokens: 256,
        temperature: 0.2,
        systemPrompt: "System summary policy.",
        purpose: "lossless-claw compaction summarization",
        agentId: "research-agent",
      });
      expect(result).toMatchObject({
        content: [{ type: "text", text: "summary output" }],
        provider: "openai-codex",
        model: "gpt-5.4",
        agentId: "research-agent",
        request_api: "runtime.llm",
      });
    } finally {
      closeLcmConnection(dbPath);
    }
  });

  it("does not request a runtime model override for session/default candidates", async () => {
    const runtimeLlmComplete = vi.fn(async () => ({
      text: "summary output",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      agentId: "main",
    }));
    const { api, getFactory, dbPath } = buildApi({ runtimeLlmComplete });
    const engine = getRegisteredEngine(api, getFactory);

    try {
      await engine.deps.complete({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "Summarize this." }],
        maxTokens: 256,
      });

      expect(runtimeLlmComplete).toHaveBeenCalledWith(
        expect.not.objectContaining({
          model: expect.any(String),
        }),
      );
    } finally {
      closeLcmConnection(dbPath);
    }
  });

  it("returns an actionable Lossless error when runtime LLM denies a model override", async () => {
    const runtimeLlmComplete = vi.fn(async () => {
      throw new Error(
        'Plugin LLM completion model override "openai-codex/gpt-5.5" is not allowlisted for plugin "lossless-claw".',
      );
    });
    const { api, getFactory, dbPath } = buildApi({ runtimeLlmComplete });
    const engine = getRegisteredEngine(api, getFactory);

    try {
      const result = await engine.deps.complete({
        provider: "openai-codex",
        model: "gpt-5.5",
        runtimeModelOverride: {
          configField: "summaryModel",
          configPath: "plugins.entries.lossless-claw.config.summaryModel",
          modelRef: "openai-codex/gpt-5.5",
        },
        messages: [{ role: "user", content: "Summarize this." }],
        maxTokens: 256,
      });

      expect(result).toMatchObject({
        content: [],
        error: {
          kind: "runtime_llm_policy",
          code: "runtime_llm_model_override_denied",
          configField: "summaryModel",
          configPath: "plugins.entries.lossless-claw.config.summaryModel",
          modelRef: "openai-codex/gpt-5.5",
          message: expect.stringContaining("openclaw doctor --fix"),
        },
      });
      expect(String(result.error?.message)).toContain('"allowedModels": [');
      expect(String(result.error?.message)).toContain('"openai-codex/gpt-5.5"');
    } finally {
      closeLcmConnection(dbPath);
    }
  });

  it("fails clearly when runtime.llm is unavailable", async () => {
    const { api, getFactory, dbPath } = buildApi();
    const engine = getRegisteredEngine(api, getFactory);

    try {
      const result = await engine.deps.complete({
        provider: "openai-codex",
        model: "gpt-5.4",
        messages: [{ role: "user", content: "Summarize this." }],
        maxTokens: 256,
      });

      expect(result).toMatchObject({
        content: [],
        error: {
          kind: "provider_error",
          message: expect.stringContaining("runtime.llm.complete is unavailable"),
        },
      });
      await expect(engine.deps.getApiKey()).resolves.toBeUndefined();
    } finally {
      closeLcmConnection(dbPath);
    }
  });
});
