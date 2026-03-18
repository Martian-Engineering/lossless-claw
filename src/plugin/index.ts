/**
 * @martian-engineering/lossless-claw — Lossless Context Management plugin for OpenClaw
 *
 * DAG-based conversation summarization with incremental compaction,
 * full-text search, and sub-agent expansion.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveLcmConfig } from "../db/config.js";
import { createLcmDatabaseConnection } from "../db/connection.js";
import { LcmContextEngine } from "../engine.js";
import { createLcmDescribeTool } from "../tools/lcm-describe-tool.js";
import { createLcmExpandQueryTool } from "../tools/lcm-expand-query-tool.js";
import { createLcmExpandTool } from "../tools/lcm-expand-tool.js";
import { createLcmGrepTool } from "../tools/lcm-grep-tool.js";
import type { LcmDependencies } from "../types.js";

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
  agentDir: string;
  home: string;
};

type ReadEnvFn = (key: string) => string | undefined;

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

const MODEL_AUTH_PR_URL = "https://github.com/openclaw/openclaw/pull/41090";
const MODEL_AUTH_MERGE_COMMIT = "4790e40";
const MODEL_AUTH_REQUIRED_RELEASE = "the first OpenClaw release after 2026.3.8";

/** Capture plugin env values once during initialization. */
function snapshotPluginEnv(env: NodeJS.ProcessEnv = process.env): PluginEnvSnapshot {
  return {
    lcmSummaryModel: env.LCM_SUMMARY_MODEL?.trim() ?? "",
    lcmSummaryProvider: env.LCM_SUMMARY_PROVIDER?.trim() ?? "",
    pluginSummaryModel: "",
    pluginSummaryProvider: "",
    openclawProvider: env.OPENCLAW_PROVIDER?.trim() ?? "",
    openclawDefaultModel: "",
    agentDir: env.OPENCLAW_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim() || "",
    home: env.HOME?.trim() ?? "",
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

/** Format a provider/model pair for logs. */
function formatProviderModel(params: { provider: string; model: string }): string {
  return `${params.provider}/${params.model}`;
}

/** Build a startup log showing which compaction model LCM will use. */
function buildCompactionModelLog(params: {
  config: LcmConfig;
  defaultModelRef: string;
  defaultProvider: string;
}): string {
  const usingOverride = Boolean(params.config.summaryModel || params.config.summaryProvider);
  const raw = (params.config.summaryModel || params.defaultModelRef).trim();
  if (!raw) {
    return "[lcm] Compaction summarization model: (unconfigured)";
  }

  if (raw.includes("/")) {
    const [provider, ...rest] = raw.split("/");
    const model = rest.join("/").trim();
    if (provider && model) {
      return `[lcm] Compaction summarization model: ${formatProviderModel({
        provider: provider.trim(),
        model,
      })} (${usingOverride ? "override" : "default"})`;
    }
  }

  const provider = (params.config.summaryProvider || params.defaultProvider || "openai").trim();
  return `[lcm] Compaction summarization model: ${formatProviderModel({
    provider,
    model: raw,
  })} (${usingOverride ? "override" : "default"})`;
}

/** Resolve common provider API keys from environment. */
function resolveApiKey(provider: string, readEnv: ReadEnvFn): string | undefined {
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
    const value = readEnv(key)?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

/** A SecretRef pointing to a value inside secrets.json via a nested path. */
type SecretRef = {
  source?: string;
  provider?: string;
  id: string;
};

type SecretProviderConfig = {
  source?: string;
  path?: string;
  mode?: string;
};

type AuthProfileCredential =
  | { type: "api_key"; provider: string; key?: string; keyRef?: SecretRef; email?: string }
  | { type: "token"; provider: string; token?: string; tokenRef?: SecretRef; expires?: number; email?: string }
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

/** Resolve runtime.modelAuth from plugin runtime when available. */
function getRuntimeModelAuth(api: OpenClawPluginApi): RuntimeModelAuth | undefined {
  const runtime = api.runtime as OpenClawPluginApi["runtime"] & {
    modelAuth?: RuntimeModelAuth;
  };
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

function buildLegacyAuthFallbackWarning(): string {
  return [
    "[lcm] OpenClaw runtime.modelAuth is unavailable; using legacy auth-profiles fallback.",
    `Stock lossless-claw 0.2.7 expects OpenClaw plugin runtime support from PR #41090 (${MODEL_AUTH_PR_URL}).`,
    `OpenClaw 2026.3.8 and 2026.3.8-beta.1 do not include merge commit ${MODEL_AUTH_MERGE_COMMIT};`,
    `${MODEL_AUTH_REQUIRED_RELEASE} is required for stock lossless-claw 0.2.7 without this fallback patch.`,
  ].join(" ");
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
function resolveAuthStorePaths(params: { agentDir?: string; envSnapshot: PluginEnvSnapshot }): string[] {
  const paths: string[] = [];
  const directAgentDir = params.agentDir?.trim();
  if (directAgentDir) {
    paths.push(join(directAgentDir, "auth-profiles.json"));
  }

  const envAgentDir = params.envSnapshot.agentDir;
  if (envAgentDir) {
    paths.push(join(envAgentDir, "auth-profiles.json"));
  }

  const home = params.envSnapshot.home;
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

/**
 * Resolve a SecretRef (tokenRef/keyRef) to a credential string.
 *
 * OpenClaw's auth-profiles support a level of indirection: instead of storing
 * the raw API key or token inline, a credential can reference it via a
 * SecretRef. Two resolution strategies are supported:
 *
 * 1. `source: "env"` — read the value from an environment variable whose
 *    name is `ref.id` (e.g. `{ source: "env", id: "ANTHROPIC_API_KEY" }`).
 *
 * 2. File-based — resolve against a configured `secrets.providers.<provider>`
 *    file provider when available. JSON-mode providers walk slash-delimited
 *    paths, while singleValue providers use the sentinel id `value`.
 *
 * 3. Legacy fallback — when no file provider config is available, fall back to
 *    `~/.openclaw/secrets.json` for backward compatibility.
 */
function resolveSecretRef(params: {
  ref: SecretRef | undefined;
  home: string;
  config?: unknown;
}): string | undefined {
  const ref = params.ref;
  if (!ref?.id) return undefined;

  // source: env — read directly from environment variable
  if (ref.source === "env") {
    const val = process.env[ref.id]?.trim();
    return val || undefined;
  }

  // File-based provider config — use configured file provider when present.
  try {
    const providers = isRecord(params.config)
      ? (params.config as { secrets?: { providers?: Record<string, unknown> } }).secrets?.providers
      : undefined;
    const providerName = ref.provider?.trim() || "default";
    const provider =
      providers && isRecord(providers)
        ? providers[providerName]
        : undefined;
    if (isRecord(provider) && provider.source === "file" && typeof provider.path === "string") {
      const configuredPath = provider.path.trim();
      const filePath =
        configuredPath.startsWith("~/") && params.home
          ? join(params.home, configuredPath.slice(2))
          : configuredPath;
      if (!filePath) {
        return undefined;
      }
      const raw = readFileSync(filePath, "utf8");
      if (provider.mode === "singleValue") {
        if (ref.id.trim() !== "value") {
          return undefined;
        }
        const value = raw.trim();
        return value || undefined;
      }

      const secrets = JSON.parse(raw) as Record<string, unknown>;
      const parts = ref.id.replace(/^\//, "").split("/");
      let current: unknown = secrets;
      for (const part of parts) {
        if (!current || typeof current !== "object") return undefined;
        current = (current as Record<string, unknown>)[part];
      }
      return typeof current === "string" && current.trim() ? current.trim() : undefined;
    }
  } catch {
    // Fall through to the legacy secrets.json lookup below.
  }

  // Legacy file fallback (source: "file" or unset) — read from ~/.openclaw/secrets.json
  try {
    const secretsPath = join(params.home, ".openclaw", "secrets.json");
    const raw = readFileSync(secretsPath, "utf8");
    const secrets = JSON.parse(raw) as Record<string, unknown>;
    const parts = ref.id.replace(/^\//, "").split("/");
    let current: unknown = secrets;
    for (const part of parts) {
      if (!current || typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return typeof current === "string" && current.trim() ? current.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve OAuth/api-key/token credentials from auth-profiles store. */
async function resolveApiKeyFromAuthProfiles(params: {
  provider: string;
  authProfileId?: string;
  agentDir?: string;
  runtimeConfig?: unknown;
  appConfig?: unknown;
  piAiModule: PiAiModule;
  envSnapshot: PluginEnvSnapshot;
}): Promise<string | undefined> {
  const storesWithPaths = resolveAuthStorePaths({
    agentDir: params.agentDir,
    envSnapshot: params.envSnapshot,
  })
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
  const secretConfig = (() => {
    if (isRecord(params.runtimeConfig)) {
      const runtimeProviders = (params.runtimeConfig as {
        secrets?: { providers?: Record<string, unknown> };
      }).secrets?.providers;
      if (isRecord(runtimeProviders) && Object.keys(runtimeProviders).length > 0) {
        return params.runtimeConfig;
      }
    }
    return params.appConfig ?? params.runtimeConfig;
  })();

  for (const profileId of candidates) {
    const credential = mergedStore.profiles[profileId];
    if (!credential) {
      continue;
    }
    if (normalizeProviderId(credential.provider) !== normalizeProviderId(params.provider)) {
      continue;
    }

    if (credential.type === "api_key") {
      const key =
        credential.key?.trim() ||
        resolveSecretRef({
          ref: credential.keyRef,
          home: params.envSnapshot.home,
          config: secretConfig,
        });
      if (key) {
        return key;
      }
      continue;
    }

    if (credential.type === "token") {
      const token =
        credential.token?.trim() ||
        resolveSecretRef({
          ref: credential.tokenRef,
          home: params.envSnapshot.home,
          config: secretConfig,
        });
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
  const envSnapshot = snapshotPluginEnv();
  envSnapshot.openclawDefaultModel = readDefaultModelFromConfig(api.config);
  const modelAuth = getRuntimeModelAuth(api);
  const readEnv: ReadEnvFn = (key) => process.env[key];
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

  if (!modelAuth) {
    api.logger.warn(buildLegacyAuthFallbackWarning());
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

        // When runtimeConfig is undefined (e.g. resolveLargeFileTextSummarizer
        // passes legacyParams without config), fall back to the plugin API so
        // provider-level baseUrl/headers/apiKey are always resolvable.
        let effectiveRuntimeConfig = runtimeConfig;
        if (!isRecord(effectiveRuntimeConfig)) {
          try {
            effectiveRuntimeConfig = api.runtime.config.loadConfig();
          } catch {
            // loadConfig may not be available in all contexts; leave undefined.
          }
        }

        const knownModel =
          typeof mod.getModel === "function" ? mod.getModel(providerId, modelId) : undefined;
        const fallbackApi =
          providerApi?.trim() ||
          resolveProviderApiFromRuntimeConfig(effectiveRuntimeConfig, providerId) ||
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

        // Resolve provider-level config (baseUrl, headers, etc.) from runtime config.
        // Custom/proxy providers (e.g. bailian, local proxies) store their baseUrl and
        // apiKey under models.providers.<provider> in openclaw.json.  Without this
        // lookup the resolved model object lacks baseUrl, which crashes pi-ai's
        // detectCompat() ("Cannot read properties of undefined (reading 'includes')"),
        // and the apiKey is unresolvable, causing 401 errors.  See #19.
        const providerLevelConfig: Record<string, unknown> = (() => {
          if (!isRecord(effectiveRuntimeConfig)) return {};
          const providers = (effectiveRuntimeConfig as { models?: { providers?: Record<string, unknown> } })
            .models?.providers;
          if (!providers) return {};
          const cfg = findProviderConfigValue(providers, providerId);
          return isRecord(cfg) ? cfg : {};
        })();

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
                // Merge baseUrl/headers from provider config if not already on the model.
                // Always set baseUrl to a string — pi-ai's detectCompat() crashes when
                // baseUrl is undefined.
                baseUrl:
                  typeof knownModel.baseUrl === "string"
                    ? knownModel.baseUrl
                    : typeof providerLevelConfig.baseUrl === "string"
                      ? providerLevelConfig.baseUrl
                      : "",
                ...(knownModel.headers == null && isRecord(providerLevelConfig.headers)
                  ? { headers: providerLevelConfig.headers }
                  : {}),
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
                // Always set baseUrl to a string — pi-ai's detectCompat() crashes when
                // baseUrl is undefined.
                baseUrl: typeof providerLevelConfig.baseUrl === "string"
                  ? providerLevelConfig.baseUrl
                  : "",
                ...(isRecord(providerLevelConfig.headers)
                  ? { headers: providerLevelConfig.headers }
                  : {}),
              };

        let resolvedApiKey = apiKey?.trim();
        if (!resolvedApiKey && modelAuth) {
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
        if (!resolvedApiKey && !modelAuth) {
          resolvedApiKey = resolveApiKey(providerId, readEnv);
        }
        if (!resolvedApiKey && !modelAuth && typeof mod.getEnvApiKey === "function") {
          resolvedApiKey = mod.getEnvApiKey(providerId)?.trim();
        }
        if (!resolvedApiKey && !modelAuth) {
          resolvedApiKey = await resolveApiKeyFromAuthProfiles({
            provider: providerId,
            authProfileId,
            agentDir,
            appConfig: api.config,
            runtimeConfig: effectiveRuntimeConfig,
            piAiModule: mod,
            envSnapshot,
          });
        }
        // Fallback: read apiKey from models.providers config (e.g. proxy providers
        // with keys like "not-needed-for-cli-proxy").
        if (!resolvedApiKey && isRecord(effectiveRuntimeConfig)) {
          const providers = (effectiveRuntimeConfig as { models?: { providers?: Record<string, unknown> } })
            .models?.providers;
          if (providers) {
            const providerCfg = findProviderConfigValue(providers, providerId);
            if (isRecord(providerCfg) && typeof providerCfg.apiKey === "string") {
              const cfgKey = providerCfg.apiKey.trim();
              if (cfgKey) {
                resolvedApiKey = cfgKey;
              }
            }
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
        (envSnapshot.lcmSummaryModel ||
         config.summaryModel ||
         modelRef?.trim() ||
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
        envSnapshot.lcmSummaryProvider ||
        config.summaryProvider ||
        envSnapshot.openclawProvider ||
        "openai"
      ).trim();
      return { provider, model: raw };
    },
    getApiKey: async (provider, model, options) => {
      if (modelAuth) {
        try {
          const modelAuthKey = resolveApiKeyFromAuthResult(
            await modelAuth.getApiKeyForModel({
              model: buildModelAuthLookupModel({ provider, model }),
              cfg: api.config,
              ...(options?.profileId ? { profileId: options.profileId } : {}),
              ...(options?.preferredProfile ? { preferredProfile: options.preferredProfile } : {}),
            }),
          );
          if (modelAuthKey) {
            return modelAuthKey;
          }
        } catch {
          // Fall through to auth-profile lookup for older OpenClaw runtimes.
        }
      }

      const envKey = resolveApiKey(provider, readEnv);
      if (envKey) {
        return envKey;
      }

      const piAiModuleId = "@mariozechner/pi-ai";
      const mod = (await import(piAiModuleId)) as PiAiModule;
      return resolveApiKeyFromAuthProfiles({
        provider,
        authProfileId: options?.profileId,
        agentDir: api.resolvePath("."),
        runtimeConfig: api.config,
        piAiModule: mod,
        envSnapshot,
      });
    },
    requireApiKey: async (provider, model, options) => {
      const key = await (async () => {
        if (modelAuth) {
          try {
            const modelAuthKey = resolveApiKeyFromAuthResult(
              await modelAuth.getApiKeyForModel({
                model: buildModelAuthLookupModel({ provider, model }),
                cfg: api.config,
                ...(options?.profileId ? { profileId: options.profileId } : {}),
                ...(options?.preferredProfile ? { preferredProfile: options.preferredProfile } : {}),
              }),
            );
            if (modelAuthKey) {
              return modelAuthKey;
            }
          } catch {
            // Fall through to auth-profile lookup for older OpenClaw runtimes.
          }
        }

        const envKey = resolveApiKey(provider, readEnv);
        if (envKey) {
          return envKey;
        }

        const piAiModuleId = "@mariozechner/pi-ai";
        const mod = (await import(piAiModuleId)) as PiAiModule;
        return resolveApiKeyFromAuthProfiles({
          provider,
          authProfileId: options?.profileId,
          agentDir: api.resolvePath("."),
          runtimeConfig: api.config,
          piAiModule: mod,
          envSnapshot,
        });
      })();
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
    const database = createLcmDatabaseConnection(deps.config.databasePath);
    const lcm = new LcmContextEngine(deps, database);

    api.registerContextEngine("lossless-claw", () => lcm);
    api.registerContextEngine("default", () => lcm);
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
    api.logger.info(
      buildCompactionModelLog({
        config: deps.config,
        defaultModelRef: readDefaultModelFromConfig(api.config),
        defaultProvider: process.env.OPENCLAW_PROVIDER?.trim() ?? "",
      }),
    );
  },
};

export default lcmPlugin;
