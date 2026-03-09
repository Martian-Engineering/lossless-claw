/**
 * @martian-engineering/lossless-claw — Lossless Context Management plugin for OpenClaw
 *
 * DAG-based conversation summarization with incremental compaction,
 * full-text search, and sub-agent expansion.
 */
import { readFileSync } from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveLcmConfig } from "./src/db/config.js";
import { LcmContextEngine } from "./src/engine.js";
import { createLcmDescribeTool } from "./src/tools/lcm-describe-tool.js";
import { createLcmExpandQueryTool } from "./src/tools/lcm-expand-query-tool.js";
import { createLcmExpandTool } from "./src/tools/lcm-expand-tool.js";
import { createLcmGrepTool } from "./src/tools/lcm-grep-tool.js";
import type { LcmDependencies } from "./src/types.js";

/** Parse `agent:<agentId>:<suffix...>` session keys. */
function parseAgentSessionKey(sessionKey: string): { agentId: string; suffix: string } | null {
  const value = sessionKey.trim();
  if (!value.startsWith("agent:")) {
    return null;
  }
  const parts = value.split(":");
  if (parts.length < 3) {
    return null;
  }
  const agentId = parts[1]?.trim();
  const suffix = parts.slice(2).join(":").trim();
  if (!agentId || !suffix) {
    return null;
  }
  return { agentId, suffix };
}

/** Return a stable normalized agent id. */
function normalizeAgentId(agentId: string | undefined): string {
  const normalized = (agentId ?? "").trim();
  return normalized.length > 0 ? normalized : "main";
}

type PluginEnvSnapshot = {
  lcmSummaryModel: string;
  lcmSummaryProvider: string;
  pluginSummaryModel: string;
  pluginSummaryProvider: string;
  openclawProvider: string;
  openclawDefaultModel: string;
};

type CompleteSimpleOptions = {
  apiKey?: string;
  maxTokens: number;
  temperature?: number;
  reasoning?: string;
};

type RuntimeModelAuthResult = {
  apiKey?: string;
};

type RuntimeModelAuthModel = {
  id: string;
  provider: string;
  api: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  cost?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow?: number;
  maxTokens?: number;
};

type RuntimeModelAuth = {
  getApiKeyForModel: (params: {
    model: RuntimeModelAuthModel;
    cfg?: OpenClawPluginApi["config"];
    profileId?: string;
    preferredProfile?: string;
  }) => Promise<RuntimeModelAuthResult | undefined>;
  resolveApiKeyForProvider: (params: {
    provider: string;
    cfg?: OpenClawPluginApi["config"];
    profileId?: string;
    preferredProfile?: string;
  }) => Promise<RuntimeModelAuthResult | undefined>;
};

/** Capture plugin env values once during initialization. */
function snapshotPluginEnv(env: NodeJS.ProcessEnv = process.env): PluginEnvSnapshot {
  return {
    lcmSummaryModel: env.LCM_SUMMARY_MODEL?.trim() ?? "",
    lcmSummaryProvider: env.LCM_SUMMARY_PROVIDER?.trim() ?? "",
    pluginSummaryModel: "",
    pluginSummaryProvider: "",
    openclawProvider: env.OPENCLAW_PROVIDER?.trim() ?? "",
    openclawDefaultModel: "",
  };
}

/** Read OpenClaw's configured default model from the validated runtime config. */
function readDefaultModelFromConfig(config: unknown): string {
  if (!config || typeof config !== "object") {
    return "";
  }

  const model = (config as { agents?: { defaults?: { model?: unknown } } }).agents?.defaults?.model;
  if (typeof model === "string") {
    return model.trim();
  }

  const primary = (model as { primary?: unknown } | undefined)?.primary;
  return typeof primary === "string" ? primary.trim() : "";
}

type PiAiModule = {
  completeSimple?: (
    model: {
      id: string;
      provider: string;
      api: string;
      name?: string;
      reasoning?: boolean;
      input?: string[];
      cost?: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
      };
      contextWindow?: number;
      maxTokens?: number;
    },
    request: {
      systemPrompt?: string;
      messages: Array<{ role: string; content: unknown; timestamp?: number }>;
    },
    options: {
      apiKey?: string;
      maxTokens: number;
      temperature?: number;
      reasoning?: string;
    },
  ) => Promise<Record<string, unknown> & { content?: Array<{ type: string; text?: string }> }>;
  getModel?: (provider: string, modelId: string) => unknown;
  getModels?: (provider: string) => unknown[];
};

/** Narrow unknown values to plain objects. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Normalize provider ids for case-insensitive matching. */
function normalizeProviderId(provider: string): string {
  return provider.trim().toLowerCase();
}

/** Resolve known provider API defaults when model lookup misses. */
function inferApiFromProvider(provider: string): string {
  const normalized = normalizeProviderId(provider);
  const map: Record<string, string> = {
    anthropic: "anthropic-messages",
    openai: "openai-responses",
    "openai-codex": "openai-codex-responses",
    "github-copilot": "openai-codex-responses",
    google: "google-generative-ai",
    "google-gemini-cli": "google-gemini-cli",
    "google-antigravity": "google-gemini-cli",
    "google-vertex": "google-vertex",
    "amazon-bedrock": "bedrock-converse-stream",
  };
  return map[normalized] ?? "openai-responses";
}

/** Codex Responses rejects `temperature`; omit it for that API family. */
export function shouldOmitTemperatureForApi(api: string | undefined): boolean {
  return (api ?? "").trim().toLowerCase() === "openai-codex-responses";
}

/** Build provider-aware options for pi-ai completeSimple. */
export function buildCompleteSimpleOptions(params: {
  api: string | undefined;
  apiKey: string | undefined;
  maxTokens: number;
  temperature: number | undefined;
  reasoning: string | undefined;
}): CompleteSimpleOptions {
  const options: CompleteSimpleOptions = {
    apiKey: params.apiKey,
    maxTokens: params.maxTokens,
  };

  if (
    typeof params.temperature === "number" &&
    Number.isFinite(params.temperature) &&
    !shouldOmitTemperatureForApi(params.api)
  ) {
    options.temperature = params.temperature;
  }

  if (typeof params.reasoning === "string" && params.reasoning.trim()) {
    options.reasoning = params.reasoning.trim();
  }

  return options;
}

/** Select provider-specific config values with case-insensitive provider keys. */
function findProviderConfigValue<T>(
  map: Record<string, T> | undefined,
  provider: string,
): T | undefined {
  if (!map) {
    return undefined;
  }
  if (map[provider] !== undefined) {
    return map[provider];
  }
  const normalizedProvider = normalizeProviderId(provider);
  for (const [key, value] of Object.entries(map)) {
    if (normalizeProviderId(key) === normalizedProvider) {
      return value;
    }
  }
  return undefined;
}

/** Resolve provider API from runtime config if available. */
function resolveProviderApiFromRuntimeConfig(
  runtimeConfig: unknown,
  provider: string,
): string | undefined {
  if (!isRecord(runtimeConfig)) {
    return undefined;
  }
  const providers = (runtimeConfig as { models?: { providers?: Record<string, unknown> } }).models
    ?.providers;
  if (!providers || !isRecord(providers)) {
    return undefined;
  }
  const value = findProviderConfigValue(providers, provider);
  if (!isRecord(value)) {
    return undefined;
  }
  const api = value.api;
  return typeof api === "string" && api.trim() ? api.trim() : undefined;
}

/** Resolve runtime.modelAuth from plugin runtime, even before plugin-sdk typings land locally. */
function getRuntimeModelAuth(api: OpenClawPluginApi): RuntimeModelAuth {
  const runtime = api.runtime as OpenClawPluginApi["runtime"] & {
    modelAuth?: RuntimeModelAuth;
  };
  if (!runtime.modelAuth) {
    throw new Error("OpenClaw runtime.modelAuth is required by lossless-claw.");
  }
  return runtime.modelAuth;
}

/** Build the minimal model shape required by runtime.modelAuth.getApiKeyForModel(). */
function buildModelAuthLookupModel(params: {
  provider: string;
  model: string;
  api?: string;
}): RuntimeModelAuthModel {
  return {
    id: params.model,
    name: params.model,
    provider: params.provider,
    api: params.api?.trim() || inferApiFromProvider(params.provider),
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 200_000,
    maxTokens: 8_000,
  };
}

/** Normalize an auth result down to the API key that pi-ai expects. */
function resolveApiKeyFromAuthResult(auth: RuntimeModelAuthResult | undefined): string | undefined {
  const apiKey = auth?.apiKey?.trim();
  return apiKey ? apiKey : undefined;
}

/** Build a minimal but useful sub-agent prompt. */
function buildSubagentSystemPrompt(params: {
  depth: number;
  maxDepth: number;
  taskSummary?: string;
}): string {
  const task = params.taskSummary?.trim() || "Perform delegated LCM expansion work.";
  return [
    "You are a delegated sub-agent for LCM expansion.",
    `Depth: ${params.depth}/${params.maxDepth}`,
    "Return concise, factual results only.",
    task,
  ].join("\n");
}

/** Extract latest assistant text from session message snapshots. */
function readLatestAssistantReply(messages: unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const item = messages[i];
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as { role?: unknown; content?: unknown };
    if (record.role !== "assistant") {
      continue;
    }

    if (typeof record.content === "string") {
      const trimmed = record.content.trim();
      if (trimmed) {
        return trimmed;
      }
      continue;
    }

    if (!Array.isArray(record.content)) {
      continue;
    }

    const text = record.content
      .filter((entry): entry is { type?: unknown; text?: unknown } => {
        return !!entry && typeof entry === "object";
      })
      .map((entry) => (entry.type === "text" && typeof entry.text === "string" ? entry.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();

    if (text) {
      return text;
    }
  }

  return undefined;
}

/** Construct LCM dependencies from plugin API/runtime surfaces. */
function createLcmDependencies(api: OpenClawPluginApi): LcmDependencies {
  const envSnapshot = snapshotPluginEnv();
  envSnapshot.openclawDefaultModel = readDefaultModelFromConfig(api.config);
  const modelAuth = getRuntimeModelAuth(api);
  const pluginConfig =
    api.pluginConfig && typeof api.pluginConfig === "object" && !Array.isArray(api.pluginConfig)
      ? api.pluginConfig
      : undefined;
  const config = resolveLcmConfig(process.env, pluginConfig);

  // Read model overrides from plugin config
  if (pluginConfig) {
    const summaryModel = pluginConfig.summaryModel;
    const summaryProvider = pluginConfig.summaryProvider;
    if (typeof summaryModel === "string") {
      envSnapshot.pluginSummaryModel = summaryModel.trim();
    }
    if (typeof summaryProvider === "string") {
      envSnapshot.pluginSummaryProvider = summaryProvider.trim();
    }
  }

  return {
    config,
    complete: async ({
      provider,
      model,
      apiKey,
      providerApi,
      authProfileId,
      agentDir,
      runtimeConfig,
      messages,
      system,
      maxTokens,
      temperature,
      reasoning,
    }) => {
      try {
        const piAiModuleId = "@mariozechner/pi-ai";
        const mod = (await import(piAiModuleId)) as PiAiModule;

        if (typeof mod.completeSimple !== "function") {
          return { content: [] };
        }

        const providerId = (provider ?? "").trim();
        const modelId = model.trim();
        if (!providerId || !modelId) {
          return { content: [] };
        }

        const knownModel =
          typeof mod.getModel === "function" ? mod.getModel(providerId, modelId) : undefined;
        const fallbackApi =
          providerApi?.trim() ||
          resolveProviderApiFromRuntimeConfig(runtimeConfig, providerId) ||
          (() => {
            if (typeof mod.getModels !== "function") {
              return undefined;
            }
            const models = mod.getModels(providerId);
            const first = Array.isArray(models) ? models[0] : undefined;
            if (!isRecord(first) || typeof first.api !== "string" || !first.api.trim()) {
              return undefined;
            }
            return first.api.trim();
          })() ||
          inferApiFromProvider(providerId);

        const resolvedModel =
          isRecord(knownModel) &&
          typeof knownModel.api === "string" &&
          typeof knownModel.provider === "string" &&
          typeof knownModel.id === "string"
            ? {
                ...knownModel,
                id: knownModel.id,
                provider: knownModel.provider,
                api: knownModel.api,
              }
            : {
                id: modelId,
                name: modelId,
                provider: providerId,
                api: fallbackApi,
                reasoning: false,
                input: ["text"],
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                contextWindow: 200_000,
                maxTokens: 8_000,
              };

        let resolvedApiKey = apiKey?.trim();
        if (!resolvedApiKey) {
          try {
            resolvedApiKey = resolveApiKeyFromAuthResult(
              await modelAuth.resolveApiKeyForProvider({
                provider: providerId,
                cfg: api.config,
                ...(authProfileId ? { profileId: authProfileId } : {}),
              }),
            );
          } catch (err) {
            console.error(
              `[lcm] modelAuth.resolveApiKeyForProvider FAILED:`,
              err instanceof Error ? err.message : err,
            );
          }
        }

        const completeOptions = buildCompleteSimpleOptions({
          api: resolvedModel.api,
          apiKey: resolvedApiKey,
          maxTokens,
          temperature,
          reasoning,
        });

        const result = await mod.completeSimple(
          resolvedModel,
          {
            ...(typeof system === "string" && system.trim()
              ? { systemPrompt: system.trim() }
              : {}),
            messages: messages.map((message) => ({
              role: message.role,
              content: message.content,
              timestamp: Date.now(),
            })),
          },
          completeOptions,
        );

        if (!isRecord(result)) {
          return {
            content: [],
            request_provider: providerId,
            request_model: modelId,
            request_api: resolvedModel.api,
            request_reasoning:
              typeof reasoning === "string" && reasoning.trim() ? reasoning.trim() : "(none)",
            request_has_system:
              typeof system === "string" && system.trim().length > 0 ? "true" : "false",
            request_temperature:
              typeof completeOptions.temperature === "number"
                ? String(completeOptions.temperature)
                : "(omitted)",
            request_temperature_sent:
              typeof completeOptions.temperature === "number" ? "true" : "false",
          };
        }

        return {
          ...result,
          content: Array.isArray(result.content) ? result.content : [],
          request_provider: providerId,
          request_model: modelId,
          request_api: resolvedModel.api,
          request_reasoning:
            typeof reasoning === "string" && reasoning.trim() ? reasoning.trim() : "(none)",
          request_has_system: typeof system === "string" && system.trim().length > 0 ? "true" : "false",
          request_temperature:
            typeof completeOptions.temperature === "number"
              ? String(completeOptions.temperature)
              : "(omitted)",
          request_temperature_sent: typeof completeOptions.temperature === "number" ? "true" : "false",
        };
      } catch (err) {
        console.error(`[lcm] completeSimple error:`, err instanceof Error ? err.message : err);
        return { content: [] };
      }
    },
    callGateway: async (params) => {
      const sub = api.runtime.subagent;
      switch (params.method) {
        case "agent":
          return sub.run({
            sessionKey: String(params.params?.sessionKey ?? ""),
            message: String(params.params?.message ?? ""),
            extraSystemPrompt: params.params?.extraSystemPrompt as string | undefined,
            lane: params.params?.lane as string | undefined,
            deliver: (params.params?.deliver as boolean) ?? false,
            idempotencyKey: params.params?.idempotencyKey as string | undefined,
          });
        case "agent.wait":
          return sub.waitForRun({
            runId: String(params.params?.runId ?? ""),
            timeoutMs: (params.params?.timeoutMs as number) ?? params.timeoutMs,
          });
        case "sessions.get":
          return sub.getSession({
            sessionKey: String(params.params?.key ?? ""),
            limit: params.params?.limit as number | undefined,
          });
        case "sessions.delete":
          await sub.deleteSession({
            sessionKey: String(params.params?.key ?? ""),
            deleteTranscript: (params.params?.deleteTranscript as boolean) ?? true,
          });
          return {};
        default:
          throw new Error(`Unsupported gateway method in LCM plugin: ${params.method}`);
      }
    },
    resolveModel: (modelRef, providerHint) => {
      const raw =
        (modelRef?.trim() ||
         envSnapshot.pluginSummaryModel ||
         envSnapshot.lcmSummaryModel ||
         envSnapshot.openclawDefaultModel).trim();
      if (!raw) {
        throw new Error("No model configured for LCM summarization.");
      }

      if (raw.includes("/")) {
        const [provider, ...rest] = raw.split("/");
        const model = rest.join("/").trim();
        if (provider && model) {
          return { provider: provider.trim(), model };
        }
      }

      const provider = (
        providerHint?.trim() ||
        envSnapshot.pluginSummaryProvider ||
        envSnapshot.lcmSummaryProvider ||
        envSnapshot.openclawProvider ||
        "openai"
      ).trim();
      return { provider, model: raw };
    },
    getApiKey: async (provider, model, options) => {
      try {
        return resolveApiKeyFromAuthResult(
          await modelAuth.getApiKeyForModel({
            model: buildModelAuthLookupModel({ provider, model }),
            cfg: api.config,
            ...(options?.profileId ? { profileId: options.profileId } : {}),
            ...(options?.preferredProfile ? { preferredProfile: options.preferredProfile } : {}),
          }),
        );
      } catch {
        return undefined;
      }
    },
    requireApiKey: async (provider, model, options) => {
      const key = await resolveApiKeyFromAuthResult(
        await modelAuth.getApiKeyForModel({
          model: buildModelAuthLookupModel({ provider, model }),
          cfg: api.config,
          ...(options?.profileId ? { profileId: options.profileId } : {}),
          ...(options?.preferredProfile ? { preferredProfile: options.preferredProfile } : {}),
        }),
      );
      if (!key) {
        throw new Error(`Missing API key for provider '${provider}' (model '${model}').`);
      }
      return key;
    },
    parseAgentSessionKey,
    isSubagentSessionKey: (sessionKey) => {
      const parsed = parseAgentSessionKey(sessionKey);
      return !!parsed && parsed.suffix.startsWith("subagent:");
    },
    normalizeAgentId,
    buildSubagentSystemPrompt,
    readLatestAssistantReply,
    resolveAgentDir: () => api.resolvePath("."),
    resolveSessionIdFromSessionKey: async (sessionKey) => {
      const key = sessionKey.trim();
      if (!key) {
        return undefined;
      }

      try {
        const cfg = api.runtime.config.loadConfig();
        const parsed = parseAgentSessionKey(key);
        const agentId = normalizeAgentId(parsed?.agentId);
        const storePath = api.runtime.channel.session.resolveStorePath(cfg.session?.store, {
          agentId,
        });
        const raw = readFileSync(storePath, "utf8");
        const store = JSON.parse(raw) as Record<string, { sessionId?: string } | undefined>;
        const sessionId = store[key]?.sessionId;
        return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : undefined;
      } catch {
        return undefined;
      }
    },
    agentLaneSubagent: "subagent",
    log: {
      info: (msg) => api.logger.info(msg),
      warn: (msg) => api.logger.warn(msg),
      error: (msg) => api.logger.error(msg),
      debug: (msg) => api.logger.debug?.(msg),
    },
  };
}

const lcmPlugin = {
  id: "lossless-claw",
  name: "Lossless Context Management",
  description:
    "DAG-based conversation summarization with incremental compaction, full-text search, and sub-agent expansion",

  configSchema: {
    parse(value: unknown) {
      const raw =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      return resolveLcmConfig(process.env, raw);
    },
  },

  register(api: OpenClawPluginApi) {
    const deps = createLcmDependencies(api);
    const lcm = new LcmContextEngine(deps);

    api.registerContextEngine("lossless-claw", () => lcm);
    api.registerTool((ctx) =>
      createLcmGrepTool({
        deps,
        lcm,
        sessionKey: ctx.sessionKey,
      }),
    );
    api.registerTool((ctx) =>
      createLcmDescribeTool({
        deps,
        lcm,
        sessionKey: ctx.sessionKey,
      }),
    );
    api.registerTool((ctx) =>
      createLcmExpandTool({
        deps,
        lcm,
        sessionKey: ctx.sessionKey,
      }),
    );
    api.registerTool((ctx) =>
      createLcmExpandQueryTool({
        deps,
        lcm,
        sessionKey: ctx.sessionKey,
        requesterSessionKey: ctx.sessionKey,
      }),
    );

    api.logger.info(
      `[lcm] Plugin loaded (enabled=${deps.config.enabled}, db=${deps.config.databasePath}, threshold=${deps.config.contextThreshold})`,
    );
  },
};

export default lcmPlugin;
