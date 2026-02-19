/**
 * @martian-engineering/openclaw-lcm — Lossless Context Management plugin for OpenClaw
 *
 * DAG-based conversation summarization with incremental compaction,
 * full-text search, and sub-agent expansion.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

/** Resolve common provider API keys from environment. */
function resolveApiKey(provider: string): string | undefined {
  const keyMap: Record<string, string[]> = {
    openai: ["OPENAI_API_KEY"],
    anthropic: ["ANTHROPIC_API_KEY"],
    google: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
    groq: ["GROQ_API_KEY"],
    xai: ["XAI_API_KEY"],
    mistral: ["MISTRAL_API_KEY"],
    together: ["TOGETHER_API_KEY"],
    openrouter: ["OPENROUTER_API_KEY"],
    "github-copilot": ["GITHUB_COPILOT_API_KEY", "GITHUB_TOKEN"],
  };

  const providerKey = provider.trim().toLowerCase();
  const keys = keyMap[providerKey] ?? [];
  const normalizedProviderEnv = `${providerKey.replace(/[^a-z0-9]/g, "_").toUpperCase()}_API_KEY`;
  keys.push(normalizedProviderEnv);

  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

type AuthProfileCredential =
  | { type: "api_key"; provider: string; key?: string; email?: string }
  | { type: "token"; provider: string; token?: string; expires?: number; email?: string }
  | ({
      type: "oauth";
      provider: string;
      access?: string;
      refresh?: string;
      expires?: number;
      email?: string;
    } & Record<string, unknown>);

type AuthProfileStore = {
  profiles: Record<string, AuthProfileCredential>;
  order?: Record<string, string[]>;
};

type PiAiOAuthCredentials = {
  refresh: string;
  access: string;
  expires: number;
  [key: string]: unknown;
};

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
    request: { messages: Array<{ role: string; content: unknown; timestamp?: number }> },
    options: {
      apiKey?: string;
      maxTokens: number;
      temperature?: number;
    },
  ) => Promise<{ content?: Array<{ type: string; text?: string }> }>;
  getModel?: (provider: string, modelId: string) => unknown;
  getModels?: (provider: string) => unknown[];
  getEnvApiKey?: (provider: string) => string | undefined;
  getOAuthApiKey?: (
    providerId: string,
    credentials: Record<string, PiAiOAuthCredentials>,
  ) => Promise<{ apiKey: string; newCredentials: PiAiOAuthCredentials } | null>;
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

/** Parse auth-profiles JSON into a minimal store shape. */
function parseAuthProfileStore(raw: string): AuthProfileStore | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.profiles)) {
      return undefined;
    }

    const profiles: Record<string, AuthProfileCredential> = {};
    for (const [profileId, value] of Object.entries(parsed.profiles)) {
      if (!isRecord(value)) {
        continue;
      }
      const type = value.type;
      const provider = typeof value.provider === "string" ? value.provider.trim() : "";
      if (!provider || (type !== "api_key" && type !== "token" && type !== "oauth")) {
        continue;
      }
      profiles[profileId] = value as AuthProfileCredential;
    }

    const rawOrder = isRecord(parsed.order) ? parsed.order : undefined;
    const order: Record<string, string[]> | undefined = rawOrder
      ? Object.entries(rawOrder).reduce<Record<string, string[]>>((acc, [provider, value]) => {
          if (!Array.isArray(value)) {
            return acc;
          }
          const ids = value
            .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
            .filter(Boolean);
          if (ids.length > 0) {
            acc[provider] = ids;
          }
          return acc;
        }, {})
      : undefined;

    return {
      profiles,
      ...(order && Object.keys(order).length > 0 ? { order } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Merge auth stores, letting later stores override earlier profiles/order. */
function mergeAuthProfileStores(stores: AuthProfileStore[]): AuthProfileStore | undefined {
  if (stores.length === 0) {
    return undefined;
  }
  const merged: AuthProfileStore = { profiles: {} };
  for (const store of stores) {
    merged.profiles = { ...merged.profiles, ...store.profiles };
    if (store.order) {
      merged.order = { ...(merged.order ?? {}), ...store.order };
    }
  }
  return merged;
}

/** Determine candidate auth store paths ordered by precedence. */
function resolveAuthStorePaths(agentDir?: string): string[] {
  const paths: string[] = [];
  const directAgentDir = agentDir?.trim();
  if (directAgentDir) {
    paths.push(join(directAgentDir, "auth-profiles.json"));
  }

  const envAgentDir = process.env.OPENCLAW_AGENT_DIR?.trim() || process.env.PI_CODING_AGENT_DIR?.trim();
  if (envAgentDir) {
    paths.push(join(envAgentDir, "auth-profiles.json"));
  }

  const home = process.env.HOME?.trim();
  if (home) {
    paths.push(join(home, ".openclaw", "agents", "main", "agent", "auth-profiles.json"));
  }

  return [...new Set(paths)];
}

/** Build profile selection order for provider auth lookup. */
function resolveAuthProfileCandidates(params: {
  provider: string;
  store: AuthProfileStore;
  authProfileId?: string;
  runtimeConfig?: unknown;
}): string[] {
  const candidates: string[] = [];
  const normalizedProvider = normalizeProviderId(params.provider);
  const push = (value: string | undefined) => {
    const profileId = value?.trim();
    if (!profileId) {
      return;
    }
    if (!candidates.includes(profileId)) {
      candidates.push(profileId);
    }
  };

  push(params.authProfileId);

  const storeOrder = findProviderConfigValue(params.store.order, params.provider);
  for (const profileId of storeOrder ?? []) {
    push(profileId);
  }

  if (isRecord(params.runtimeConfig)) {
    const auth = params.runtimeConfig.auth;
    if (isRecord(auth)) {
      const order = findProviderConfigValue(
        isRecord(auth.order) ? (auth.order as Record<string, unknown>) : undefined,
        params.provider,
      );
      if (Array.isArray(order)) {
        for (const profileId of order) {
          if (typeof profileId === "string") {
            push(profileId);
          }
        }
      }
    }
  }

  for (const [profileId, credential] of Object.entries(params.store.profiles)) {
    if (normalizeProviderId(credential.provider) === normalizedProvider) {
      push(profileId);
    }
  }

  return candidates;
}

/** Resolve OAuth/api-key/token credentials from auth-profiles store. */
async function resolveApiKeyFromAuthProfiles(params: {
  provider: string;
  authProfileId?: string;
  agentDir?: string;
  runtimeConfig?: unknown;
  piAiModule: PiAiModule;
}): Promise<string | undefined> {
  const storesWithPaths = resolveAuthStorePaths(params.agentDir)
    .map((path) => {
      try {
        const parsed = parseAuthProfileStore(readFileSync(path, "utf8"));
        return parsed ? { path, store: parsed } : undefined;
      } catch {
        return undefined;
      }
    })
    .filter((entry): entry is { path: string; store: AuthProfileStore } => !!entry);
  if (storesWithPaths.length === 0) {
    return undefined;
  }

  const mergedStore = mergeAuthProfileStores(storesWithPaths.map((entry) => entry.store));
  if (!mergedStore) {
    return undefined;
  }

  const candidates = resolveAuthProfileCandidates({
    provider: params.provider,
    store: mergedStore,
    authProfileId: params.authProfileId,
    runtimeConfig: params.runtimeConfig,
  });
  if (candidates.length === 0) {
    return undefined;
  }

  const persistPath =
    params.agentDir?.trim() ? join(params.agentDir.trim(), "auth-profiles.json") : storesWithPaths[0]?.path;

  for (const profileId of candidates) {
    const credential = mergedStore.profiles[profileId];
    if (!credential) {
      continue;
    }
    if (normalizeProviderId(credential.provider) !== normalizeProviderId(params.provider)) {
      continue;
    }

    if (credential.type === "api_key") {
      const key = credential.key?.trim();
      if (key) {
        return key;
      }
      continue;
    }

    if (credential.type === "token") {
      const token = credential.token?.trim();
      if (!token) {
        continue;
      }
      const expires = credential.expires;
      if (typeof expires === "number" && Number.isFinite(expires) && expires > 0 && Date.now() >= expires) {
        continue;
      }
      return token;
    }

    const access = credential.access?.trim();
    const expires = credential.expires;
    const isExpired =
      typeof expires === "number" && Number.isFinite(expires) && expires > 0 && Date.now() >= expires;

    if (!isExpired && access) {
      if (
        (credential.provider === "google-gemini-cli" || credential.provider === "google-antigravity") &&
        typeof credential.projectId === "string" &&
        credential.projectId.trim()
      ) {
        return JSON.stringify({
          token: access,
          projectId: credential.projectId.trim(),
        });
      }
      return access;
    }

    if (typeof params.piAiModule.getOAuthApiKey !== "function") {
      continue;
    }

    try {
      const oauthCredential = {
        access: credential.access ?? "",
        refresh: credential.refresh ?? "",
        expires: typeof credential.expires === "number" ? credential.expires : 0,
        ...(typeof credential.projectId === "string" ? { projectId: credential.projectId } : {}),
        ...(typeof credential.accountId === "string" ? { accountId: credential.accountId } : {}),
      };
      const refreshed = await params.piAiModule.getOAuthApiKey(params.provider, {
        [params.provider]: oauthCredential,
      });
      if (!refreshed?.apiKey) {
        continue;
      }
      mergedStore.profiles[profileId] = {
        ...credential,
        ...refreshed.newCredentials,
        type: "oauth",
      };
      if (persistPath) {
        try {
          writeFileSync(
            persistPath,
            JSON.stringify(
              {
                version: 1,
                profiles: mergedStore.profiles,
                ...(mergedStore.order ? { order: mergedStore.order } : {}),
              },
              null,
              2,
            ),
            "utf8",
          );
        } catch {
          // Ignore persistence errors: refreshed credentials remain usable in-memory for this run.
        }
      }
      return refreshed.apiKey;
    } catch {
      if (access) {
        return access;
      }
    }
  }

  return undefined;
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
  const config = resolveLcmConfig(process.env);

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
      maxTokens,
      temperature,
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

        let resolvedApiKey = apiKey?.trim() || resolveApiKey(providerId);
        if (!resolvedApiKey && typeof mod.getEnvApiKey === "function") {
          resolvedApiKey = mod.getEnvApiKey(providerId)?.trim();
        }
        if (!resolvedApiKey) {
          resolvedApiKey = await resolveApiKeyFromAuthProfiles({
            provider: providerId,
            authProfileId,
            agentDir,
            runtimeConfig,
            piAiModule: mod,
          });
        }

        const result = await mod.completeSimple(
          resolvedModel,
          {
            messages: messages.map((message) => ({
              role: message.role,
              content: message.content,
              timestamp: Date.now(),
            })),
          },
          {
            apiKey: resolvedApiKey,
            maxTokens,
            temperature,
          },
        );

        return {
          content: Array.isArray(result?.content) ? result.content : [],
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
    resolveModel: (modelRef) => {
      const raw = (modelRef ?? process.env.LCM_SUMMARY_MODEL ?? "").trim();
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

      const provider = (process.env.LCM_SUMMARY_PROVIDER ?? process.env.OPENCLAW_PROVIDER ?? "openai").trim();
      return { provider, model: raw };
    },
    getApiKey: (provider) => resolveApiKey(provider),
    requireApiKey: (provider) => {
      const key = resolveApiKey(provider);
      if (!key) {
        throw new Error(`Missing API key for provider '${provider}'.`);
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
  id: "openclaw-lcm",
  name: "Lossless Context Management",
  description:
    "DAG-based conversation summarization with incremental compaction, full-text search, and sub-agent expansion",

  configSchema: {
    parse(value: unknown) {
      // Merge plugin config with env vars — env vars take precedence for backward compat
      const raw =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      const enabled = typeof raw.enabled === "boolean" ? raw.enabled : undefined;
      const config = resolveLcmConfig(process.env);
      if (enabled !== undefined) {
        config.enabled = enabled;
      }
      return config;
    },
  },

  register(api: OpenClawPluginApi) {
    const deps = createLcmDependencies(api);
    const lcm = new LcmContextEngine(deps);

    api.registerContextEngine("openclaw-lcm", () => lcm);
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
