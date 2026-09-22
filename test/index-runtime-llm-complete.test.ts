import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../src/openclaw-bridge.js";
import type { LcmContextEngine } from "../src/engine.js";
import { seedBacklogContext } from "./helpers.js";
import { MAX_PENDING_NODE_RETRIES } from "../src/store/pending-summary-store.js";
import lcmPlugin from "../index.js";
import { closeLcmConnection } from "../src/db/connection.js";
import type { CompletionResult, RuntimeCompactionDelegateFn } from "../src/types.js";

type RegisteredEngineFactory = (() => unknown) | undefined;
type RuntimeLlmComplete = ReturnType<typeof vi.fn>;

function buildApi(params?: {
  runtimeLlmComplete?: RuntimeLlmComplete;
  pluginConfig?: Record<string, unknown>;
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
      getSessionMessages: vi.fn(),
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
      ...(params?.pluginConfig ?? {}),
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
      delegateCompactionToRuntime?: RuntimeCompactionDelegateFn;
      complete: (input: {
        provider?: string;
        model: string;
        runtimeModelOverride?: {
          configField: string;
          configPath: string;
          modelRef: string;
        };
        runtimeLlmComplete?: RuntimeLlmComplete;
        agentId?: string;
        authProfileId?: string;
        system?: string;
        messages: Array<{ role: string; content: unknown }>;
        maxTokens: number;
        temperature?: number;
        reasoningIfSupported?: string;
      }) => Promise<CompletionResult>;
      resolveModel: (modelRef?: string, providerHint?: string) => {
        provider: string;
        model: string;
      };
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

  it("delegates model dispatch and auth to api.runtime.llm.complete without target-agent override", async () => {
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
        authProfileId: "openai-codex:work",
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
        authProfileId: "openai-codex:work",
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

  it("keeps ignored-session compaction safe when the host SDK delegate is unavailable", async () => {
    const { api, getFactory, dbPath } = buildApi();
    const engine = getRegisteredEngine(api, getFactory);

    try {
      const result = await engine.deps.delegateCompactionToRuntime?.({
        sessionId: "runtime-ignored-session",
        sessionKey: "agent:main:cron:nightly",
        sessionFile: "/tmp/ignored.jsonl",
        tokenBudget: 4096,
      });

      expect(result).toEqual({
        ok: true,
        compacted: false,
        reason: "session excluded",
      });
    } finally {
      closeLcmConnection(dbPath);
    }
  });

  it("resolves configured fallback provider candidates instead of the primary summary model", async () => {
    const { api, getFactory, dbPath } = buildApi({
      pluginConfig: {
        summaryModel: "openai/gpt-5.5",
        fallbackProviders: [{ provider: "minimax", model: "MiniMax-M2.7" }],
      },
    });
    const engine = getRegisteredEngine(api, getFactory);

    try {
      expect(engine.deps.resolveModel("openai/gpt-5.5", "openai")).toEqual({
        provider: "openai",
        model: "gpt-5.5",
      });
      expect(engine.deps.resolveModel("minimax/MiniMax-M2.7", "minimax")).toEqual({
        provider: "minimax",
        model: "MiniMax-M2.7",
      });
    } finally {
      closeLcmConnection(dbPath);
    }
  });

  it("omits agentId for plugin-wide runtime llm even when deps.complete receives one", async () => {
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
        agentId: "research-agent",
        messages: [{ role: "user", content: "Summarize this." }],
        maxTokens: 256,
      });

      expect(runtimeLlmComplete).toHaveBeenCalledWith(
        expect.not.objectContaining({ agentId: expect.any(String) }),
      );
    } finally {
      closeLcmConnection(dbPath);
    }
  });

  it("prefers a context-engine runtime llm capability when supplied", async () => {
    const pluginRuntimeLlmComplete = vi.fn(async () => ({
      text: "plugin summary",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      agentId: "main",
    }));
    const boundRuntimeLlmComplete = vi.fn(async () => ({
      text: "bound summary",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      agentId: "research",
    }));
    const { api, getFactory, dbPath } = buildApi({ runtimeLlmComplete: pluginRuntimeLlmComplete });
    const engine = getRegisteredEngine(api, getFactory);

    try {
      const result = await engine.deps.complete({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        runtimeLlmComplete: boundRuntimeLlmComplete,
        agentId: "research",
        messages: [{ role: "user", content: "Summarize this." }],
        maxTokens: 256,
      });

      expect(boundRuntimeLlmComplete).toHaveBeenCalledTimes(1);
      expect(pluginRuntimeLlmComplete).not.toHaveBeenCalled();
      expect(boundRuntimeLlmComplete).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "research" }),
      );
      expect(result).toMatchObject({
        content: [{ type: "text", text: "bound summary" }],
        agentId: "research",
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

  it.each([
    "Async work scope is closed",
    "Plugin inventory has retired; begin a new plugin operation.",
  ])("classifies host lifecycle rejection separately from provider failures: %s", async (message) => {
    const runtimeLlmComplete = vi.fn().mockRejectedValue(new Error(message));
    const { api, getFactory, dbPath } = buildApi({ runtimeLlmComplete });
    try {
      const engine = getRegisteredEngine(api, getFactory);
      const result = await engine.deps.complete({ model: "test", messages: [], maxTokens: 100 });
      expect(result.error).toEqual({ kind: "runtime_lifecycle", message });
    } finally {
      closeLcmConnection(dbPath);
    }
  });

  it.each([
    { partial: false, tokenBudget: 10_000 },
    { partial: true, tokenBudget: 10_000 },
    { partial: false, tokenBudget: 300 },
    { partial: true, tokenBudget: 300 },
  ])("resumes retired-inventory work with fresh maintenance capabilities ($partial, $tokenBudget)", async ({ partial, tokenBudget }) => {
    const message = "Plugin inventory has retired; begin a new plugin operation.";
    const retired = vi.fn().mockRejectedValue(new Error(message));
    if (partial) retired.mockResolvedValueOnce({ text: "prepared before retirement" });
    const pluginComplete = vi.fn(async () => { throw new Error("must use call-bound capability"); });
    const { api, getFactory, dbPath } = buildApi({
      runtimeLlmComplete: pluginComplete,
      pluginConfig: {
        freshTailCount: 1, leafChunkTokens: 120, maxSweepIterations: 8,
        summaryProvider: "anthropic", summaryModel: "claude-opus-4-5",
      },
    });
    const engine = getRegisteredEngine(api, getFactory) as unknown as Pick<
      LcmContextEngine, "maintain" | "getConversationStore" | "getSummaryStore"
    > & { inner: LcmContextEngine };
    try {
      const sessionId = `retirement-${partial}`;
      const sessionFile = "/tmp/retirement-unused.jsonl";
      await seedBacklogContext(engine.inner, sessionId, [120, 120, 120, 120]);
      const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
      const conversationId = conversation!.conversationId;
      const sources = await engine.getConversationStore().getMessages(conversationId);
      const context = await engine.getSummaryStore().getContextItems(conversationId);
      const maintenanceStore = engine.inner.getCompactionMaintenanceStore();
      if (tokenBudget === 300) {
        await maintenanceStore.requestProactiveCompactionDebt({
          conversationId, reason: "threshold", tokenBudget, currentTokenCount: 480,
        });
      }
      vi.useFakeTimers({ toFake: ["Date"] });
      const maintain = (complete: RuntimeLlmComplete) => engine.maintain({
        sessionId, sessionFile,
        runtimeContext: { allowDeferredCompactionExecution: true, tokenBudget, llm: { complete } },
      });
      for (let attempt = 0; attempt <= MAX_PENDING_NODE_RETRIES; attempt++) {
        const debt = await maintenanceStore.getConversationCompactionMaintenance(conversationId);
        if (debt?.nextAttemptAfter) vi.setSystemTime(debt.nextAttemptAfter.getTime() + 1);
        const callsBefore = retired.mock.calls.length;
        const result = await maintain(retired);
        expect(result.reason).toContain(message);
        expect(retired.mock.calls.length - callsBefore).toBe(partial && attempt === 0 ? 2 : 1);
        const batch = await engine.inner.getPendingSummaryStore().getActiveBatchForConversation(conversationId);
        expect(batch).not.toBeNull();
        const nodes = await engine.inner.getPendingSummaryStore().getNodesByBatch(batch!.batchId);
        expect(nodes.filter(node => node.status === "ready")).toHaveLength(partial ? 1 : 0);
        expect(nodes.every(node => node.retryCount === 0 && node.leaseOwner === null)).toBe(true);
        expect(nodes.filter(node => node.status === "planned").length).toBeGreaterThan(0);
        expect(nodes.every(node => !node.content?.includes("LCM fallback summary"))).toBe(true);
      }
      expect(await engine.getSummaryStore().getSummariesByConversation(conversationId)).toEqual([]);
      expect(await engine.getSummaryStore().getContextItems(conversationId)).toEqual(context);
      expect(await engine.getConversationStore().getMessages(conversationId)).toEqual(sources);
      const debt = await maintenanceStore.getConversationCompactionMaintenance(conversationId);
      if (tokenBudget === 300) expect(debt?.pending).toBe(true);
      if (debt?.nextAttemptAfter) vi.setSystemTime(debt.nextAttemptAfter.getTime() + 1);
      const callsBeforeRecovery = retired.mock.calls.length;
      const fresh = vi.fn().mockResolvedValue({ text: "proper fresh summary" });
      await maintain(fresh);
      expect(fresh).toHaveBeenCalled();
      expect(retired).toHaveBeenCalledTimes(callsBeforeRecovery);
      expect(pluginComplete).not.toHaveBeenCalled();
      const summaries = await engine.getSummaryStore().getSummariesByConversation(conversationId);
      if (tokenBudget === 300) {
        expect(summaries.length).toBeGreaterThan(0);
        expect(summaries.every(summary => !summary.content.includes("LCM fallback summary"))).toBe(true);
        expect(summaries.map(summary => summary.content)).toContain("proper fresh summary");
      } else {
        const batch = await engine.inner.getPendingSummaryStore().getActiveBatchForConversation(conversationId);
        const nodes = await engine.inner.getPendingSummaryStore().getNodesByBatch(batch!.batchId);
        expect(nodes.every(node => node.status === "ready")).toBe(true);
        expect(nodes.map(node => node.content)).toContain("proper fresh summary");
        if (partial) expect(nodes.map(node => node.content)).toContain("prepared before retirement");
      }
      expect(await engine.getConversationStore().getMessages(conversationId)).toEqual(sources);
      const logs = [api.logger.warn, api.logger.error].flatMap(log => vi.mocked(log).mock.calls).flat().join(" ");
      expect(logs).not.toContain("ALL PROVIDERS EXHAUSTED");
      expect(logs).not.toContain("Check provider keys and quotas");
    } finally {
      vi.useRealTimers();
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
      expect(engine.deps).not.toHaveProperty("getApiKey");
    } finally {
      closeLcmConnection(dbPath);
    }
  });
});
