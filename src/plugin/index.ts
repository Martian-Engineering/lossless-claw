/**
 * @martian-engineering/lossless-claw — Lossless Context Management plugin for OpenClaw
 *
 * DAG-based conversation summarization with incremental compaction,
 * full-text search, and sub-agent expansion.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveLcmConfigWithDiagnostics, resolveOpenclawStateDir } from "../db/config.js";
import { closeLcmConnection, createLcmDatabaseConnection, normalizePath } from "../db/connection.js";
import { LcmContextEngine } from "../engine.js";
import { createLcmLogger, describeLogError } from "../lcm-log.js";
import { logStartupBannerOnce } from "../startup-banner-log.js";
import { getSharedInit, setSharedInit, removeSharedInit } from "./shared-init.js";
import type { SharedLcmInit } from "./shared-init.js";
import { createLcmDescribeTool } from "../tools/lcm-describe-tool.js";
import { createLcmExpandQueryTool } from "../tools/lcm-expand-query-tool.js";
import { createLcmExpandTool } from "../tools/lcm-expand-tool.js";
import { createLcmGrepTool } from "../tools/lcm-grep-tool.js";
import { createLcmCommand } from "./lcm-command.js";
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
  /** Active OpenClaw state directory — respects OPENCLAW_STATE_DIR for multi-profile hosts. */
  stateDir: string;
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
  baseUrl?: string;
  request?: RuntimeModelRequestTransportOverrides;
  expiresAt?: number;
};

type RuntimeModelRequestAuthOverride =
  | {
      mode: "provider-default";
    }
  | {
      mode: "authorization-bearer";
      token: string;
    }
  | {
      mode: "header";
      headerName: string;
      value: string;
      prefix?: string;
    };

type RuntimeModelRequestTransportOverrides = {
  headers?: Record<string, string>;
  auth?: RuntimeModelRequestAuthOverride;
};

type SessionEndLifecycleEvent = {
  sessionId?: string;
  sessionKey?: string;
  reason?: string;
  nextSessionId?: string;
  nextSessionKey?: string;
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
  getRuntimeAuthForModel?: (params: {
    model: RuntimeModelAuthModel;
    cfg?: OpenClawPluginApi["config"];
    profileId?: string;
    preferredProfile?: string;
    workspaceDir?: string;
  }) => Promise<RuntimeModelAuthResult | undefined>;
};

const MODEL_AUTH_PR_URL = "https://github.com/openclaw/openclaw/pull/41090";
const MODEL_AUTH_MERGE_COMMIT = "4790e40";
const MODEL_AUTH_REQUIRED_RELEASE = "the first OpenClaw release after 2026.3.8";
const PROVIDER_API_RESOLUTION_ERROR_PREFIX = "[lcm] unable to resolve API family for provider ";
const AUTH_ERROR_TEXT_PATTERN =
  /\b401\b|unauthorized|unauthorised|invalid[_ -]?token|invalid[_ -]?api[_ -]?key|authentication failed|authorization failed|missing scope|insufficient scope|model\.request\b/i;
const AUTH_ERROR_STATUS_KEYS = ["status", "statusCode", "status_code"] as const;
const AUTH_ERROR_NESTED_KEYS = ["error", "response", "cause", "details", "data", "body"] as const;

type CompletionBridgeErrorInfo = {
  kind: "provider_auth";
  statusCode?: number;
  code?: string;
  message?: string;
};

const LOSSLESS_RECALL_POLICY_PROMPT = [
  "## Lossless Recall Policy",
  "",
  "The lossless-claw plugin is active.",
  "",
  "For compacted conversation history, these instructions supersede generic memory-recall guidance. Prefer lossless-claw recall tools first when answering questions about prior conversation content, decisions made in the conversation, or details that may have been compacted.",
  "",
  "**Conflict handling:** If newer evidence conflicts with an older summary or recollection, prefer the newer evidence. Do not trust a stale summary over fresher contradictory information.",
  "",
  "**Contradictions/uncertainty:** If facts seem contradictory or uncertain, verify with lossless-claw recall tools before answering instead of trusting the summary at face value.",
  "",
  "**Tool escalation:**",
  "Recall order for compacted conversation history:",
  "1. `lcm_grep` — search by regex or full-text across messages and summaries",
  "2. `lcm_describe` — inspect a specific summary (cheap, no sub-agent)",
  "3. `lcm_expand_query` — deep recall: spawns bounded sub-agent, expands DAG, and returns answer plus cited summary IDs in tool output for follow-up (~120s, don't ration it)",
  "",
  "**`lcm_grep` routing guidance:**",
  '- Prefer `mode: "full_text"` for keyword or topical recall; keep `mode: "regex"` for literal patterns.',
  '- Full-text queries use FTS5 semantics, and FTS5 defaults to AND matching, so extra terms make matching stricter rather than broader.',
  '- Prefer 1-3 distinctive full-text terms or one quoted phrase. Do not pad queries with synonyms or extra keywords.',
  '- Wrap exact multi-word phrases in quotes, for example `"error handling"`.',
  '- Keep the default `sort: "recency"` for "what just happened?" lookups.',
  '- Use `sort: "relevance"` when hunting for the best older match on a topic.',
  '- Use `sort: "hybrid"` when relevance matters but newer context should still get a boost.',
  "",
  "**`lcm_expand_query` usage** — two patterns (always requires `prompt`):",
  "- With IDs: `lcm_expand_query(summaryIds: [\"sum_xxx\"], prompt: \"What config changes were discussed?\")`",
  "- With search: `lcm_expand_query(query: \"database migration\", prompt: \"What strategy was decided?\")`",
  "- `query` uses the same FTS5 full-text search path as `lcm_grep`, so the same query-construction rules apply.",
  "- `query` is for matching candidate summaries; `prompt` is the natural-language question or task to answer after expansion.",
  "- FTS5 defaults to AND matching, so more query terms narrow results instead of broadening them.",
  "- For `query`, use 1-3 distinctive terms or a quoted phrase. Do not stuff synonyms or extra keywords into it.",
  "**Scope selection rule:**",
  "- Start with the current conversation scope.",
  "- If the in-context summaries already look relevant to the user's question, prefer `lcm_grep` or `lcm_expand_query` without `allConversations`.",
  "- Use `allConversations: true` only when the current summaries do not appear sufficient, the question seems outside the current conversation, or the user is explicitly asking about work across sessions.",
  "- For global discovery, prefer `lcm_grep(..., allConversations: true)` first.",
  "- If global matches are found and the user needs one synthesized answer, use `lcm_expand_query(..., allConversations: true)`; this is bounded synthesis, not exhaustive expansion.",
  "- If you already know the exact target conversation, prefer explicit `conversationId` instead of `allConversations`.",
  "- Optional: `maxTokens` (default 2000), `conversationId`, `allConversations: true`",
  "- Keep raw summary IDs out of normal user-facing prose unless the user explicitly asks for sources or IDs.",
  "",
  "These precedence rules apply only to compacted conversation history. Lossless-claw does not supersede memory tools globally.",
  "",
  "If a summary conflicts with newer evidence, prefer the newer evidence. Do not guess exact commands, SHAs, paths, timestamps, config values, or causal claims from compacted summaries when expansion is needed.",
].join("\n");

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
    stateDir: resolveOpenclawStateDir(env),
  };
}

/** Coerce a plugin-config-like value into a plain object when possible. */
function toPluginConfig(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Resolve plugin config from direct runtime injection or the root OpenClaw config fallback. */
function resolvePluginConfig(api: OpenClawPluginApi): Record<string, unknown> | undefined {
  const directPluginConfig = toPluginConfig(api.pluginConfig);
  if (directPluginConfig && Object.keys(directPluginConfig).length > 0) {
    return directPluginConfig;
  }

  const rootConfig = toPluginConfig(api.config);
  const plugins = toPluginConfig(rootConfig?.plugins);
  const entries = toPluginConfig(plugins?.entries);
  const pluginEntry = toPluginConfig(entries?.["lossless-claw"]);
  return toPluginConfig(pluginEntry?.config);
}

function truncateErrorMessage(message: string, maxChars = 240): string {
  return message.length <= maxChars ? message : `${message.slice(0, maxChars)}...`;
}

function collectErrorText(value: unknown, out: string[], depth = 0): void {
  if (depth >= 4) {
    return;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) {
      out.push(trimmed);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 8)) {
      collectErrorText(entry, out, depth + 1);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  for (const entry of Object.values(value).slice(0, 12)) {
    collectErrorText(entry, out, depth + 1);
  }
}

function extractErrorStatusCode(value: unknown, depth = 0): number | undefined {
  if (depth >= 4 || !isRecord(value)) {
    return undefined;
  }

  for (const key of AUTH_ERROR_STATUS_KEYS) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return Math.trunc(candidate);
    }
    if (typeof candidate === "string") {
      const parsed = Number.parseInt(candidate, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  for (const key of AUTH_ERROR_NESTED_KEYS) {
    const nested = value[key];
    const statusCode = extractErrorStatusCode(nested, depth + 1);
    if (statusCode !== undefined) {
      return statusCode;
    }
  }

  return undefined;
}

function detectProviderAuthError(error: unknown): CompletionBridgeErrorInfo | undefined {
  const statusCode = extractErrorStatusCode(error);
  const textParts: string[] = [];
  collectErrorText(error, textParts);
  const normalizedMessage = textParts.join(" ").replace(/\s+/g, " ").trim();

  if (statusCode !== 401 && !AUTH_ERROR_TEXT_PATTERN.test(normalizedMessage)) {
    return undefined;
  }

  const directCode =
    isRecord(error) && typeof error.code === "string" && error.code.trim()
      ? error.code.trim()
      : isRecord(error) &&
          isRecord(error.error) &&
          typeof error.error.code === "string" &&
          error.error.code.trim()
        ? error.error.code.trim()
        : undefined;

  return {
    kind: "provider_auth",
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(directCode ? { code: directCode } : {}),
    ...(normalizedMessage ? { message: truncateErrorMessage(normalizedMessage) } : {}),
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

/** Load the best available validated OpenClaw config during plugin registration. */
function loadEffectiveOpenClawConfig(api: OpenClawPluginApi): unknown {
  try {
    const runtimeConfig = api.runtime.config.loadConfig();
    if (runtimeConfig !== undefined) {
      if (isRecord(runtimeConfig) && Object.keys(runtimeConfig).length > 0) {
        return runtimeConfig;
      }
      if (!isRecord(api.config) || Object.keys(api.config).length === 0) {
        return runtimeConfig;
      }
    }
  } catch {
    // Older runtimes or early startup can leave loadConfig unavailable.
  }
  return api.config;
}

/** Read this plugin's config from the validated OpenClaw runtime config. */
function readPluginConfigFromOpenClawConfig(
  openClawConfig: unknown,
  pluginId: string,
): Record<string, unknown> | undefined {
  if (!isRecord(openClawConfig)) {
    return undefined;
  }

  const plugins = openClawConfig.plugins;
  if (!isRecord(plugins)) {
    return undefined;
  }

  const entries = plugins.entries;
  if (!isRecord(entries)) {
    return undefined;
  }

  const entry = entries[pluginId];
  if (!isRecord(entry) || !isRecord(entry.config)) {
    return undefined;
  }

  return entry.config;
}

/** Resolve the config surfaces that should drive registration-time behavior. */
function resolveRegistrationConfig(api: OpenClawPluginApi): {
  openClawConfig: unknown;
  pluginConfig?: Record<string, unknown>;
} {
  const openClawConfig = loadEffectiveOpenClawConfig(api);
  const apiPluginConfig =
    api.pluginConfig && typeof api.pluginConfig === "object" && !Array.isArray(api.pluginConfig)
      ? api.pluginConfig
      : undefined;

  if (apiPluginConfig && Object.keys(apiPluginConfig).length > 0) {
    return { openClawConfig, pluginConfig: apiPluginConfig };
  }

  return {
    openClawConfig,
    pluginConfig: readPluginConfigFromOpenClawConfig(openClawConfig, api.id),
  };
}

/** Read OpenClaw's configured compaction model from the validated runtime config. */
function readCompactionModelFromConfig(config: unknown): string {
  if (!config || typeof config !== "object") {
    return "";
  }

  const compaction = (config as {
    agents?: {
      defaults?: {
        compaction?: {
          model?: unknown;
        };
      };
    };
  }).agents?.defaults?.compaction;
  const model = compaction?.model;
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
  openClawConfig: unknown;
  defaultProvider: string;
}): string {
  const envSummaryModel = process.env.LCM_SUMMARY_MODEL?.trim() ?? "";
  const envSummaryProvider = process.env.LCM_SUMMARY_PROVIDER?.trim() ?? "";
  const pluginSummaryModel = params.config.summaryModel.trim();
  const pluginSummaryProvider = params.config.summaryProvider.trim();
  const compactionModelRef = readCompactionModelFromConfig(params.openClawConfig);
  const defaultModelRef = readDefaultModelFromConfig(params.openClawConfig);
  const selected =
    envSummaryModel
      ? { raw: envSummaryModel, source: "override" as const }
      : pluginSummaryModel
        ? { raw: pluginSummaryModel, source: "override" as const }
        : compactionModelRef
          ? { raw: compactionModelRef, source: "override" as const }
          : defaultModelRef
            ? { raw: defaultModelRef, source: "default" as const }
            : undefined;
  const usingOverride =
    selected?.source === "override" || Boolean(envSummaryProvider || pluginSummaryProvider);
  const raw = selected?.raw.trim() ?? "";
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

  const provider = (
    envSummaryProvider ||
    pluginSummaryProvider ||
    params.defaultProvider ||
    "openai"
  ).trim();
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
function inferApiFromProvider(provider: string): string | undefined {
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
    ollama: "openai-completions",
  };
  return map[normalized];
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

/**
 * Prefer an explicit reasoning setting, otherwise apply a caller-provided
 * default only when the resolved model advertises reasoning support.
 */
export function resolveEffectiveReasoning(params: {
  reasoning: string | undefined;
  reasoningIfSupported: string | undefined;
  modelSupportsReasoning: boolean | undefined;
}): string | undefined {
  if (typeof params.reasoning === "string" && params.reasoning.trim()) {
    return params.reasoning.trim();
  }

  if (
    params.modelSupportsReasoning === true &&
    typeof params.reasoningIfSupported === "string" &&
    params.reasoningIfSupported.trim()
  ) {
    return params.reasoningIfSupported.trim();
  }

  return undefined;
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
  contextWindow?: number;
}): RuntimeModelAuthModel {
  const contextWindow =
    typeof params.contextWindow === "number" && Number.isFinite(params.contextWindow) && params.contextWindow > 0
      ? params.contextWindow
      : 1_000_000;

  return {
    id: params.model,
    name: params.model,
    provider: params.provider,
    api: params.api?.trim() || inferApiFromProvider(params.provider) || "",
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow,
    maxTokens: 8_000,
  };
}

/** Normalize an auth result down to the API key that pi-ai expects. */
function resolveApiKeyFromAuthResult(auth: RuntimeModelAuthResult | undefined): string | undefined {
  const apiKey = auth?.apiKey?.trim();
  return apiKey ? apiKey : undefined;
}

/** Normalize a runtime auth override base URL when present. */
function resolveBaseUrlFromAuthResult(auth: RuntimeModelAuthResult | undefined): string | undefined {
  const baseUrl = auth?.baseUrl?.trim();
  return baseUrl ? baseUrl : undefined;
}

/** Normalize raw runtime auth headers into plain string headers. */
function resolveRuntimeAuthHeaders(
  request: RuntimeModelRequestTransportOverrides | undefined,
): Record<string, string> | undefined {
  if (!request) {
    return undefined;
  }

  const headers: Record<string, string> = {};
  if (isRecord(request.headers)) {
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value !== "string") {
        continue;
      }
      const headerName = key.trim();
      const headerValue = value.trim();
      if (headerName && headerValue) {
        headers[headerName] = headerValue;
      }
    }
  }

  const auth = request.auth;
  if (auth?.mode === "authorization-bearer") {
    const token = auth.token.trim();
    if (token) {
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === "authorization") {
          delete headers[key];
        }
      }
      headers.Authorization = `Bearer ${token}`;
    }
  } else if (auth?.mode === "header") {
    const headerName = auth.headerName.trim();
    const value = auth.value.trim();
    if (headerName && value) {
      const normalizedHeader = headerName.toLowerCase();
      for (const key of Object.keys(headers)) {
        if (
          key.toLowerCase() === normalizedHeader ||
          (normalizedHeader !== "authorization" && key.toLowerCase() === "authorization")
        ) {
          delete headers[key];
        }
      }
      headers[headerName] = `${auth.prefix?.trim() ?? ""}${value}`;
    }
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

/** Attach OpenClaw transport overrides to a model for runtimes that inspect the shared symbol. */
function attachRuntimeAuthRequestTransport<TModel extends object>(
  model: TModel,
  request: RuntimeModelRequestTransportOverrides | undefined,
): TModel {
  if (!request) {
    return model;
  }
  const next = { ...model } as TModel & Record<symbol, unknown>;
  next[Symbol.for("openclaw.modelProviderRequestTransport")] = request;
  return next;
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

  const stateDir = params.envSnapshot.stateDir;
  if (stateDir) {
    paths.push(join(stateDir, "agents", "main", "agent", "auth-profiles.json"));
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
  stateDir: string;
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

  // Legacy file fallback (source: "file" or unset) — read from secrets.json in the active state dir
  try {
    const secretsPath = join(params.stateDir, "secrets.json");
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
          stateDir: params.envSnapshot.stateDir,
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
          stateDir: params.envSnapshot.stateDir,
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
    const shouldPreferOAuthHelper =
      typeof params.piAiModule.getOAuthApiKey === "function" &&
      normalizeProviderId(params.provider) === "openai-codex";

    if (shouldPreferOAuthHelper) {
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
        if (refreshed?.apiKey) {
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
        }
      } catch {
        // Fall back to the cached access token below when helper resolution fails.
      }
    }

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
function createLcmDependencies(
  api: OpenClawPluginApi,
  registrationConfig = resolveRegistrationConfig(api),
): LcmDependencies {
  const envSnapshot = snapshotPluginEnv();
  envSnapshot.openclawDefaultModel = readDefaultModelFromConfig(registrationConfig.openClawConfig);
  const modelAuth = getRuntimeModelAuth(api);
  const readEnv: ReadEnvFn = (key) => process.env[key];
  const pluginConfig = registrationConfig.pluginConfig;
  const log = createLcmLogger(api);
  const { config, diagnostics } = resolveLcmConfigWithDiagnostics(process.env, pluginConfig);

  if (diagnostics.ignoreSessionPatternsEnvOverridesPluginConfig) {
    logStartupBannerOnce({
      key: "ignore-session-patterns-env-override",
      log: (message) => log.warn(message),
      message:
        "[lcm] LCM_IGNORE_SESSION_PATTERNS from env overrides plugins.entries.lossless-claw.config.ignoreSessionPatterns; plugin config array will be ignored",
    });
  }
  if (diagnostics.statelessSessionPatternsEnvOverridesPluginConfig) {
    logStartupBannerOnce({
      key: "stateless-session-patterns-env-override",
      log: (message) => log.warn(message),
      message:
        "[lcm] LCM_STATELESS_SESSION_PATTERNS from env overrides plugins.entries.lossless-claw.config.statelessSessionPatterns; plugin config array will be ignored",
    });
  }

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
    log.warn(buildLegacyAuthFallbackWarning());
  }

  logStartupBannerOnce({
    key: "transcript-gc-enabled",
    log: (message) => log.info(message),
    message: `[lcm] Transcript GC ${config.transcriptGcEnabled ? "enabled" : "disabled"} (default false)`,
  });
  logStartupBannerOnce({
    key: "proactive-threshold-compaction-mode",
    log: (message) => log.info(message),
    message: `[lcm] Proactive threshold compaction mode: ${config.proactiveThresholdCompactionMode} (default deferred)`,
  });

  /** Resolve the best config object to hand to runtime.modelAuth for this lookup. */
  const resolveModelAuthConfig = (runtimeConfig: unknown): OpenClawPluginApi["config"] => {
    if (runtimeConfig && typeof runtimeConfig === "object") {
      return runtimeConfig as OpenClawPluginApi["config"];
    }
    return api.config;
  };

  /** Resolve an API key without throwing so summarizer auth fallback can retry safely. */
  const lookupApiKey = async (
    provider: string,
    model: string,
    options?: {
      profileId?: string;
      preferredProfile?: string;
      agentDir?: string;
      runtimeConfig?: unknown;
      skipModelAuth?: boolean;
    },
  ): Promise<string | undefined> => {
    const modelAuthConfig = resolveModelAuthConfig(options?.runtimeConfig);

    if (modelAuth && options?.skipModelAuth !== true) {
      try {
        const modelAuthKey = resolveApiKeyFromAuthResult(
          await modelAuth.getApiKeyForModel({
            model: buildModelAuthLookupModel({ provider, model, contextWindow: 1_000_000 }),
            cfg: modelAuthConfig,
            ...(options?.profileId ? { profileId: options.profileId } : {}),
            ...(options?.preferredProfile ? { preferredProfile: options.preferredProfile } : {}),
          }),
        );
        if (modelAuthKey) {
          return modelAuthKey;
        }
      } catch {
        // Fall through to env/auth-profile lookup for older or scope-limited runtimes.
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
      agentDir: options?.agentDir ?? api.resolvePath("."),
      runtimeConfig: options?.runtimeConfig,
      appConfig: api.config,
      piAiModule: mod,
      envSnapshot,
    });
  };

  return {
    config,
    configDiagnostics: diagnostics,
    isRuntimeManagedAuthProvider: (provider: string, providerApi?: string) => {
      const normalizedProvider = normalizeProviderId(provider);
      if (normalizedProvider === "openai-codex" || normalizedProvider === "github-copilot") {
        return true;
      }
      return shouldOmitTemperatureForApi(providerApi);
    },
    complete: async ({
      provider,
      model,
      apiKey,
      providerApi,
      authProfileId,
      agentDir,
      runtimeConfig,
      skipModelAuth,
      messages,
      system,
      maxTokens,
      temperature,
      reasoning,
      reasoningIfSupported,
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
        const workspaceDir = agentDir?.trim() || api.resolvePath(".");

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
          (isRecord(knownModel) && typeof knownModel.api === "string" && knownModel.api.trim()
            ? knownModel.api.trim()
            : undefined) ||
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
        if (!fallbackApi) {
          throw new Error(
            `[lcm] unable to resolve API family for provider ${providerId}; set models.providers.${providerId}.api explicitly instead of falling back implicitly.`,
          );
        }
        const modelAuthConfig = resolveModelAuthConfig(effectiveRuntimeConfig);

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

        let resolvedModel =
          isRecord(knownModel) &&
          typeof knownModel.api === "string" &&
          typeof knownModel.provider === "string" &&
          typeof knownModel.id === "string"
            ? {
                ...knownModel,
                id: knownModel.id,
                provider: knownModel.provider,
                api:
                  typeof providerLevelConfig.api === "string" && providerLevelConfig.api.trim()
                    ? providerLevelConfig.api.trim()
                    : knownModel.api,
                // Provider config must be able to override built-in transport defaults.
                // Otherwise built-in providers like `openai` keep their catalog baseUrl
                // (`https://api.openai.com/v1`) even when OpenClaw runtime config points
                // that provider id at a custom proxy.
                // Always set baseUrl to a string — pi-ai's detectCompat() crashes when
                // baseUrl is undefined.
                baseUrl:
                  typeof providerLevelConfig.baseUrl === "string"
                    ? providerLevelConfig.baseUrl
                    : typeof knownModel.baseUrl === "string"
                      ? knownModel.baseUrl
                      : "",
                ...(isRecord(providerLevelConfig.headers)
                  ? {
                      headers: {
                        ...(isRecord(knownModel.headers) ? knownModel.headers : {}),
                        ...providerLevelConfig.headers,
                      },
                    }
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
                contextWindow: 1_000_000,
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

        let runtimeAuth: RuntimeModelAuthResult | undefined;
        if (modelAuth && skipModelAuth !== true && typeof modelAuth.getRuntimeAuthForModel === "function") {
          try {
            runtimeAuth = await modelAuth.getRuntimeAuthForModel({
              model: buildModelAuthLookupModel({
                provider: providerId,
                model: modelId,
                api: resolvedModel.api,
                contextWindow: resolvedModel.contextWindow,
              }),
              cfg: modelAuthConfig,
              ...(authProfileId ? { profileId: authProfileId } : {}),
              workspaceDir,
            });
          } catch (err) {
            console.error(
              `[lcm] modelAuth.getRuntimeAuthForModel FAILED:`,
              err instanceof Error ? err.message : err,
            );
          }
        }

        const runtimeAuthBaseUrl = resolveBaseUrlFromAuthResult(runtimeAuth);
        const runtimeAuthHeaders = resolveRuntimeAuthHeaders(runtimeAuth?.request);
        resolvedModel = attachRuntimeAuthRequestTransport(
          {
            ...resolvedModel,
            ...(runtimeAuthBaseUrl ? { baseUrl: runtimeAuthBaseUrl } : {}),
            ...(runtimeAuthHeaders
              ? {
                  headers: {
                    ...(isRecord(resolvedModel.headers) ? resolvedModel.headers : {}),
                    ...runtimeAuthHeaders,
                  },
                }
              : {}),
          },
          runtimeAuth?.request,
        );

        let resolvedApiKey = apiKey?.trim();
        if (!resolvedApiKey) {
          resolvedApiKey = resolveApiKeyFromAuthResult(runtimeAuth);
        }
        if (!resolvedApiKey && modelAuth && skipModelAuth !== true) {
          try {
            resolvedApiKey = resolveApiKeyFromAuthResult(
              await modelAuth.getApiKeyForModel({
                model: buildModelAuthLookupModel({
                  provider: providerId,
                  model: modelId,
                  api: resolvedModel.api,
                  contextWindow: resolvedModel.contextWindow,
                }),
                cfg: modelAuthConfig,
                ...(authProfileId ? { profileId: authProfileId } : {}),
              }),
            );
          } catch (err) {
            log.warn(`[lcm] modelAuth.getApiKeyForModel FAILED: ${describeLogError(err)}`);
          }
        }
        if (!resolvedApiKey && modelAuth && skipModelAuth !== true) {
          try {
            resolvedApiKey = resolveApiKeyFromAuthResult(
              await modelAuth.resolveApiKeyForProvider({
                provider: providerId,
                cfg: modelAuthConfig,
                ...(authProfileId ? { profileId: authProfileId } : {}),
              }),
            );
          } catch (err) {
            log.warn(`[lcm] modelAuth.resolveApiKeyForProvider FAILED: ${describeLogError(err)}`);
          }
        }
        if (!resolvedApiKey) {
          resolvedApiKey = resolveApiKey(providerId, readEnv);
        }
        if (!resolvedApiKey && typeof mod.getEnvApiKey === "function") {
          resolvedApiKey = mod.getEnvApiKey(providerId)?.trim();
        }
        if (!resolvedApiKey) {
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

        const effectiveReasoning = resolveEffectiveReasoning({
          reasoning,
          reasoningIfSupported,
          modelSupportsReasoning: resolvedModel.reasoning,
        });

        const completeOptions = buildCompleteSimpleOptions({
          api: resolvedModel.api,
          apiKey: resolvedApiKey,
          maxTokens,
          temperature,
          reasoning: effectiveReasoning,
        });
        const requestMetadata = {
          request_provider: providerId,
          request_model: modelId,
          request_api: resolvedModel.api,
          request_reasoning: effectiveReasoning ?? "(none)",
          request_has_system: typeof system === "string" && system.trim().length > 0 ? "true" : "false",
          request_temperature:
            typeof completeOptions.temperature === "number"
              ? String(completeOptions.temperature)
              : "(omitted)",
          request_temperature_sent: typeof completeOptions.temperature === "number" ? "true" : "false",
        };

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
            ...requestMetadata,
          };
        }

        return {
          ...result,
          content: Array.isArray(result.content) ? result.content : [],
          ...requestMetadata,
        };
      } catch (err) {
        log.error(`[lcm] completeSimple error: ${describeLogError(err)}`);
        const authError = detectProviderAuthError(err);
        const configError =
          !authError &&
          err instanceof Error &&
          err.message.startsWith(PROVIDER_API_RESOLUTION_ERROR_PREFIX)
            ? {
                kind: "provider_config",
                message: err.message,
              }
            : undefined;
        return {
          content: [],
          ...(authError ? { error: authError } : {}),
          ...(configError ? { error: configError } : {}),
        };
      }
    },
    callGateway: async (params) => {
      const sub = api.runtime.subagent;
      switch (params.method) {
        case "agent":
          return sub.run({
            sessionKey: String(params.params?.sessionKey ?? ""),
            message: String(params.params?.message ?? ""),
            provider: params.params?.provider as string | undefined,
            model: params.params?.model as string | undefined,
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
      return lookupApiKey(provider, model, options);
    },
    requireApiKey: async (provider, model, options) => {
      const key = await lookupApiKey(provider, model, options);
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
        const storePath = api.runtime.agent.session.resolveStorePath(cfg.session?.store, {
          agentId,
        });
        const store = api.runtime.agent.session.loadSessionStore(storePath) as Record<
          string,
          { sessionId?: string } | undefined
        >;
        const sessionId = store[key]?.sessionId;
        return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : undefined;
      } catch {
        return undefined;
      }
    },
    resolveSessionTranscriptFile: async ({ sessionId, sessionKey }) => {
      const normalizedSessionId = sessionId.trim();
      if (!normalizedSessionId) {
        return undefined;
      }

      try {
        const cfg = api.runtime.config.loadConfig();
        const normalizedSessionKey = sessionKey?.trim();
        const parsed = normalizedSessionKey ? parseAgentSessionKey(normalizedSessionKey) : null;
        const agentId = normalizeAgentId(parsed?.agentId);
        const storePath = api.runtime.agent.session.resolveStorePath(cfg.session?.store, {
          agentId,
        });
        const store = api.runtime.agent.session.loadSessionStore(storePath) as Record<
          string,
          { sessionId?: string; sessionFile?: string } | undefined
        >;
        const entry =
          (normalizedSessionKey ? store[normalizedSessionKey] : undefined)
          ?? Object.values(store).find((candidate) => candidate?.sessionId === normalizedSessionId);
        const transcriptPath = api.runtime.agent.session.resolveSessionFilePath(
          normalizedSessionId,
          entry,
          {
            agentId,
            storePath,
          },
        );
        return transcriptPath.trim() || undefined;
      } catch {
        return undefined;
      }
    },
    agentLaneSubagent: "subagent",
    log,
  };
}

/**
 * Wire event handlers, context engines, tools, and commands to the
 * OpenClaw plugin API using shared init closures.
 */
function wirePluginHandlers(
  api: OpenClawPluginApi,
  deps: LcmDependencies,
  shared: SharedLcmInit,
): void {
  api.on("before_reset", async (event, ctx) => {
    await (await shared.waitForEngine()).handleBeforeReset({
      reason: event.reason,
      sessionId: ctx.sessionId,
      sessionKey: ctx.sessionKey,
    });
  });
  api.on("before_prompt_build", () => ({
    prependSystemContext: LOSSLESS_RECALL_POLICY_PROMPT,
  }));
  api.on("session_end", async (event) => {
    const lifecycleEvent = event as SessionEndLifecycleEvent;
    await (await shared.waitForEngine()).handleSessionEnd({
      reason: lifecycleEvent.reason,
      sessionId: lifecycleEvent.sessionId,
      sessionKey: lifecycleEvent.sessionKey,
      nextSessionId: lifecycleEvent.nextSessionId,
      nextSessionKey: lifecycleEvent.nextSessionKey,
    });
  });

  api.registerContextEngine("lossless-claw", () => shared.getCachedEngine() ?? shared.waitForEngine());
  api.registerContextEngine("default", () => shared.getCachedEngine() ?? shared.waitForEngine());

  api.registerTool((ctx) =>
    createLcmGrepTool({ deps, getLcm: shared.waitForEngine, sessionKey: ctx.sessionKey }),
  );
  api.registerTool((ctx) =>
    createLcmDescribeTool({ deps, getLcm: shared.waitForEngine, sessionKey: ctx.sessionKey }),
  );
  api.registerTool((ctx) =>
    createLcmExpandTool({ deps, getLcm: shared.waitForEngine, sessionKey: ctx.sessionKey }),
  );
  api.registerTool((ctx) =>
    createLcmExpandQueryTool({
      deps,
      getLcm: shared.waitForEngine,
      sessionKey: ctx.sessionKey,
      requesterSessionKey: ctx.sessionKey,
    }),
  );

  api.registerCommand(
    createLcmCommand({
      db: shared.waitForDatabase,
      config: deps.config,
      deps,
      getLcm: shared.waitForEngine,
    }),
  );
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
      return resolveLcmConfigWithDiagnostics(process.env, raw).config;
    },
  },

  register(api: OpenClawPluginApi) {
    const registrationConfig = resolveRegistrationConfig(api);
    const deps = createLcmDependencies(api, registrationConfig);
    const dbPath = deps.config.databasePath;
    const normalizedDbPath = normalizePath(dbPath);

    // ── Singleton check ─────────────────────────────────────────────
    // OpenClaw v2026.4.5+ calls register() per-agent-context (main,
    // subagents, cron lanes). Reuse the existing connection and engine
    // when the same DB path is already initialized.
    const existingInit = getSharedInit(normalizedDbPath);
    if (existingInit && !existingInit.stopped) {
      deps.log.info(`[lcm] Reusing shared engine init for db=${normalizedDbPath}`);
      wirePluginHandlers(api, deps, existingInit);
      return;
    }

    // ── Eager-first DB init with deferred fallback on lock ──────────
    let database: DatabaseSync | null = null;
    let lcm: LcmContextEngine | null = null;
    let initPromise: Promise<LcmContextEngine> | null = null;
    let initError: Error | null = null;
    let resolveDeferredInit: ((engine: LcmContextEngine) => void) | null = null;
    let rejectDeferredInit: ((error: Error) => void) | null = null;
    let stopped = false;

    /** Normalize unknown failures into stable Error instances. */
    function toInitError(error: unknown): Error {
      return error instanceof Error ? error : new Error(String(error));
    }

    /** Build a live DB+engine pair and roll back the DB handle if engine init fails. */
    function initializeEngine(): LcmContextEngine {
      const startedAt = Date.now();
      const nextDatabase = createLcmDatabaseConnection(dbPath);
      try {
        const nextEngine = new LcmContextEngine(deps, nextDatabase);
        database = nextDatabase;
        lcm = nextEngine;
        initError = null;
        deps.log.info(
          `[lcm] Engine initialized for db=${normalizedDbPath} duration=${Date.now() - startedAt}ms`,
        );
        return nextEngine;
      } catch (error) {
        closeLcmConnection(nextDatabase);
        deps.log.info(
          `[lcm] Engine init failed for db=${normalizedDbPath} duration=${Date.now() - startedAt}ms error=${toInitError(error).message}`,
        );
        throw error;
      }
    }

    /** Keep one shared deferred init promise so early callers all await the same retry. */
    function ensureDeferredInitPromise(): Promise<LcmContextEngine> {
      if (initPromise) {
        return initPromise;
      }

      initPromise = new Promise<LcmContextEngine>((resolve, reject) => {
        resolveDeferredInit = resolve;
        rejectDeferredInit = reject;
      });
      initPromise.catch(() => {});
      return initPromise;
    }

    /** Resolve the shared deferred init promise exactly once. */
    function resolveDeferredEngine(nextEngine: LcmContextEngine): void {
      const resolve = resolveDeferredInit;
      resolveDeferredInit = null;
      rejectDeferredInit = null;
      resolve?.(nextEngine);
    }

    /** Reject the shared deferred init promise exactly once and retain the root cause. */
    function rejectDeferredEngine(error: Error): void {
      initError = error;
      const reject = rejectDeferredInit;
      resolveDeferredInit = null;
      rejectDeferredInit = null;
      reject?.(error);
    }

    /** Return the initialized engine, waiting for deferred startup when the DB is lock-contended. */
    async function waitForEngine(): Promise<LcmContextEngine> {
      if (stopped) {
        throw new Error("[lcm] Database connection closed after gateway_stop");
      }
      if (initError) {
        throw initError;
      }
      if (lcm) {
        return lcm;
      }
      if (initPromise) {
        return initPromise;
      }

      try {
        const nextEngine = initializeEngine();
        initPromise = Promise.resolve(nextEngine);
        return nextEngine;
      } catch (error) {
        const normalized = toInitError(error);
        if (!/database is locked/i.test(normalized.message)) {
          initError = normalized;
          throw normalized;
        }

        deps.log.warn("[lcm] DB locked during eager init, deferring to gateway_start");
        return ensureDeferredInitPromise();
      }
    }

    /** Return the initialized DB handle, sharing the same wait/error semantics as the engine. */
    async function waitForDatabase(): Promise<DatabaseSync> {
      await waitForEngine();
      if (!database) {
        throw initError ?? new Error("[lcm] Database initialization finished without a handle");
      }
      return database;
    }

    try {
      const nextEngine = initializeEngine();
      initPromise = Promise.resolve(nextEngine);
    } catch (error) {
      const normalized = toInitError(error);
      if (!/database is locked/i.test(normalized.message)) {
        initError = normalized;
        throw normalized;
      }

      deps.log.warn("[lcm] DB locked during eager init, deferring to gateway_start");
      ensureDeferredInitPromise();
      api.on("gateway_start", async () => {
        if (stopped || lcm || initError) {
          return;
        }
        try {
          const nextEngine = initializeEngine();
          initPromise = Promise.resolve(nextEngine);
          resolveDeferredEngine(nextEngine);
        } catch (retryError) {
          const normalizedRetryError = toInitError(retryError);
          rejectDeferredEngine(normalizedRetryError);
          deps.log.error(`[lcm] Deferred DB init failed: ${normalizedRetryError.message}`);
        }
      });
    }

    const shared: SharedLcmInit = {
      stopped: false,
      getCachedEngine: () => lcm,
      waitForEngine,
      waitForDatabase,
    };
    setSharedInit(normalizedDbPath, shared);

    api.on("gateway_stop", async () => {
      stopped = true;
      shared.stopped = true;
      if (!lcm && !database) {
        rejectDeferredEngine(new Error("[lcm] Database connection closed after gateway_stop"));
      }
      if (database) {
        closeLcmConnection(database);
        database = null;
      }
      lcm = null;
      removeSharedInit(normalizedDbPath);
    });

    wirePluginHandlers(api, deps, shared);

    logStartupBannerOnce({
      key: "plugin-loaded",
      log: (message) => deps.log.info(message),
      message: `[lcm] Plugin loaded (enabled=${deps.config.enabled}, db=${deps.config.databasePath}, threshold=${deps.config.contextThreshold}, proactiveThresholdCompactionMode=${deps.config.proactiveThresholdCompactionMode})`,
    });
    logStartupBannerOnce({
      key: "state-dir",
      log: (message) => deps.log.info(message),
      message: `[lcm] State dir: ${resolveOpenclawStateDir(process.env)}`,
    });
    logStartupBannerOnce({
      key: "compaction-model",
      log: (message) => deps.log.info(message),
      message: buildCompactionModelLog({
        config: deps.config,
        openClawConfig: registrationConfig.openClawConfig,
        defaultProvider: process.env.OPENCLAW_PROVIDER?.trim() ?? "",
      }),
    });
    if (deps.config.fallbackProviders.length > 0) {
      logStartupBannerOnce({
        key: "fallback-providers",
        log: (message) => deps.log.info(message),
        message: `[lcm] Fallback providers: ${deps.config.fallbackProviders.map((fp) => `${fp.provider}/${fp.model}`).join(", ")}`,
      });
    }
  },
};

export default lcmPlugin;
