/**
 * @martian-engineering/lossless-claw — Lossless Context Management plugin for OpenClaw
 *
 * DAG-based conversation summarization with incremental compaction,
 * full-text search, and sub-agent expansion.
 */
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { OpenClawPluginApi } from "../openclaw-bridge.js";
import { resolveLcmConfigWithDiagnostics, resolveOpenclawStateDir } from "../db/config.js";
import type { LcmConfig } from "../db/config.js";
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
import type {
  LcmDependencies,
  RuntimeLlmModelOverride,
  StartupSessionFileCandidate,
} from "../types.js";

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

type RuntimeSessionStoreEntry = {
  sessionId?: unknown;
  sessionFile?: unknown;
};

type RuntimeAgentSessionApi = {
  resolveStorePath: (store?: string, opts?: { agentId?: string }) => string;
  loadSessionStore: (storePath: string) => Record<string, RuntimeSessionStoreEntry | undefined>;
  resolveSessionFilePath: (
    sessionId: string,
    entry?: RuntimeSessionStoreEntry,
    opts?: { agentId?: string; storePath?: string },
  ) => string;
};
type RuntimeAgentSessionApiCandidate = Partial<RuntimeAgentSessionApi>;

/** Return the runtime session registry API when the host exposes it. */
function getRuntimeAgentSessionApi(api: OpenClawPluginApi): RuntimeAgentSessionApi | undefined {
  const runtime = api.runtime as unknown as {
    agent?: { session?: RuntimeAgentSessionApiCandidate };
    channel?: { session?: RuntimeAgentSessionApiCandidate };
  };
  const sessionApi = runtime.agent?.session ?? runtime.channel?.session;
  if (!sessionApi) {
    return undefined;
  }
  if (
    typeof sessionApi.resolveStorePath !== "function" ||
    typeof sessionApi.loadSessionStore !== "function" ||
    typeof sessionApi.resolveSessionFilePath !== "function"
  ) {
    return undefined;
  }
  return sessionApi as RuntimeAgentSessionApi;
}

/** List configured OpenClaw agent ids whose session stores can be active at startup. */
function listConfiguredAgentIds(config: unknown): string[] {
  const agents = isRecord(config) ? config.agents : undefined;
  const list = isRecord(agents) && Array.isArray(agents.list) ? agents.list : [];
  const seen = new Set<string>();
  const ids: string[] = [];

  for (const entry of list) {
    if (!isRecord(entry) || entry.enabled === false || typeof entry.id !== "string") {
      continue;
    }
    const agentId = normalizeAgentId(entry.id);
    if (seen.has(agentId)) {
      continue;
    }
    seen.add(agentId);
    ids.push(agentId);
  }

  return ids.length > 0 ? ids : ["main"];
}

/** Read a string value from an unknown object field. */
function getStringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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

type RuntimeLlmCompleteMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type RuntimeLlmCompleteParams = {
  messages: RuntimeLlmCompleteMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  purpose?: string;
  agentId?: string;
};

type RuntimeLlmCompleteResult = {
  text: string;
  provider: string;
  model: string;
  agentId: string;
  usage?: Record<string, unknown>;
  audit?: Record<string, unknown>;
};

type RuntimeLlm = {
  complete: (params: RuntimeLlmCompleteParams) => Promise<RuntimeLlmCompleteResult>;
};

type SessionEndLifecycleEvent = {
  sessionId?: string;
  sessionKey?: string;
  reason?: string;
  nextSessionId?: string;
  nextSessionKey?: string;
};

const RUNTIME_LLM_PR_URL = "https://github.com/openclaw/openclaw/pull/64294";
const AUTH_ERROR_TEXT_PATTERN =
  /\b401\b|unauthorized|unauthorised|invalid[_ -]?token|invalid[_ -]?api[_ -]?key|authentication failed|authorization failed|missing scope|insufficient scope|model\.request\b/i;
const AUTH_ERROR_STATUS_KEYS = ["status", "statusCode", "status_code"] as const;
const AUTH_ERROR_NESTED_KEYS = ["error", "response", "cause", "details", "data", "body"] as const;

type CompletionBridgeErrorInfo = {
  kind: "provider_auth" | "provider_error" | "runtime_llm_policy";
  statusCode?: number;
  code?: string;
  message?: string;
  configField?: string;
  configPath?: string;
  modelRef?: string;
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
  "## Compacted Conversation Context",
  "",
  "If compacted summaries appear above, treat them as compressed recall cues rather than proof of exact wording or exact values.",
  "",
  "If a summary includes an \"Expand for details about:\" footer, use it as a cue to expand before asserting specifics.",
  "",
  "For exact commands, SHAs, paths, timestamps, config values, or causal chains, expand for details before answering.",
  "",
  "State uncertainty instead of guessing from compacted summaries.",
  "",
  "**Precision flow:**",
  "1. `lcm_grep` to find the relevant summaries or messages",
  "2. `lcm_expand_query` when you need exact evidence before answering",
  "3. Answer from the retrieved evidence instead of summary paraphrase",
  "",
  "**Uncertainty checklist:**",
  "- Am I making an exact factual claim from compacted context?",
  "- Could compaction have omitted a crucial detail?",
  "- Would I need an expansion step if the user asks for proof or exact text?",
  "",
  "If yes to any item, expand first or explicitly say that you need to expand.",
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

/** Narrow unknown values to plain object records. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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

function detectProviderBridgeError(error: unknown): CompletionBridgeErrorInfo {
  const statusCode = extractErrorStatusCode(error);
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
    kind: "provider_error",
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(directCode ? { code: directCode } : {}),
    message: truncateErrorMessage(describeLogError(error)),
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

/** Return OpenClaw's host-owned runtime LLM surface when this runtime supports it. */
function getRuntimeLlm(api: OpenClawPluginApi): RuntimeLlm | undefined {
  const runtime = api.runtime as unknown as { llm?: Partial<RuntimeLlm> };
  return typeof runtime.llm?.complete === "function"
    ? (runtime.llm as RuntimeLlm)
    : undefined;
}

/** Build the clear failure returned on OpenClaw runtimes older than PR #64294. */
function buildRuntimeLlmUnavailableError(): CompletionBridgeErrorInfo {
  return {
    kind: "provider_error",
    message:
      `[lcm] OpenClaw runtime.llm.complete is unavailable. ` +
      `Install an OpenClaw build with Plugin SDK runtime LLM support (${RUNTIME_LLM_PR_URL}).`,
  };
}

/** Convert internal completion messages to the string-only runtime LLM contract. */
function toRuntimeLlmMessages(
  messages: Array<{ role: string; content: unknown }>,
): RuntimeLlmCompleteMessage[] {
  return messages
    .filter(
      (message) =>
        message.role === "system" || message.role === "user" || message.role === "assistant",
    )
    .map((message) => ({
      role: message.role as RuntimeLlmCompleteMessage["role"],
      content: stringifyRuntimeLlmContent(message.content),
    }));
}

/** Normalize arbitrary internal message content into a runtime LLM text payload. */
function stringifyRuntimeLlmContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (content === null || content === undefined) {
    return "";
  }
  if (typeof content === "number" || typeof content === "boolean" || typeof content === "bigint") {
    return String(content);
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/** Build the optional provider/model override ref accepted by runtime.llm.complete. */
function buildRuntimeModelRef(provider: string | undefined, model: string): string | undefined {
  const modelId = model.trim();
  if (!modelId) {
    return undefined;
  }
  const providerId = provider?.trim();
  return providerId ? `${providerId}/${modelId}` : modelId;
}

type RuntimeLlmPolicyRequirement = RuntimeLlmModelOverride;

type RuntimeLlmPolicyCheck = {
  required: RuntimeLlmPolicyRequirement[];
  unresolved: Array<{ configField: string; configPath: string; reason: string }>;
  missingAllowModelOverride: boolean;
  missingAllowedModels: RuntimeLlmPolicyRequirement[];
  policyAvailable: boolean;
};

/** Build the copy-paste config block for an explicitly requested model override. */
function buildRuntimeLlmPolicySnippet(modelRef: string): string {
  return JSON.stringify(
    {
      plugins: {
        entries: {
          "lossless-claw": {
            llm: {
              allowModelOverride: true,
              allowedModels: [modelRef],
            },
          },
        },
      },
    },
    null,
    2,
  );
}

/** Return true when OpenClaw denied a plugin runtime LLM model override. */
function isRuntimeLlmModelPolicyDenial(error: unknown): boolean {
  const text = describeLogError(error);
  return /Plugin LLM completion (cannot override the target model|model override .*not allowlisted|model override allowlist|model override allowlist requires)/i.test(
    text,
  );
}

/** Build Lossless-specific guidance for runtime LLM model override policy errors. */
function buildRuntimeLlmPolicyError(
  override: RuntimeLlmModelOverride,
  error: unknown,
): CompletionBridgeErrorInfo {
  const detail = truncateErrorMessage(describeLogError(error), 200);
  return {
    kind: "runtime_llm_policy",
    code: "runtime_llm_model_override_denied",
    configField: override.configField,
    configPath: override.configPath,
    modelRef: override.modelRef,
    message:
      `[lcm] OpenClaw denied the Lossless runtime LLM model override from ${override.configPath} (${override.configField}). ` +
      `Requested model: ${override.modelRef}. ` +
      `Configure plugins.entries.lossless-claw.llm.allowModelOverride and plugins.entries.lossless-claw.llm.allowedModels, or run "openclaw doctor --fix". ` +
      `Minimal config:\n${buildRuntimeLlmPolicySnippet(override.modelRef)}\n` +
      `Host error: ${detail}`,
  };
}

/** Convert plugin config model/provider fields to canonical provider/model refs when possible. */
function buildConfiguredModelRequirement(params: {
  configField: string;
  configPath: string;
  provider?: unknown;
  model?: unknown;
}): RuntimeLlmPolicyRequirement | { unresolved: RuntimeLlmPolicyCheck["unresolved"][number] } | undefined {
  const modelId = typeof params.model === "string" ? params.model.trim() : "";
  if (!modelId) {
    return undefined;
  }
  const modelRef = buildRuntimeModelRef(
    typeof params.provider === "string" ? params.provider.trim() : undefined,
    modelId,
  );
  if (!modelRef?.includes("/")) {
    return {
      unresolved: {
        configField: params.configField,
        configPath: params.configPath,
        reason:
          `${params.configPath} is a bare model without a provider. ` +
          `Use provider/model or set the matching provider field so openclaw doctor --fix can update plugins.entries.lossless-claw.llm.allowedModels.`,
      },
    };
  }
  return {
    configField: params.configField,
    configPath: params.configPath,
    modelRef,
  };
}

/** Collect Lossless summary model overrides that require OpenClaw runtime LLM policy. */
function collectRuntimeLlmPolicyRequirements(config: LcmDependencies["config"]): {
  required: RuntimeLlmPolicyRequirement[];
  unresolved: RuntimeLlmPolicyCheck["unresolved"];
} {
  const required: RuntimeLlmPolicyRequirement[] = [];
  const unresolved: RuntimeLlmPolicyCheck["unresolved"] = [];
  const add = (
    candidate:
      | RuntimeLlmPolicyRequirement
      | { unresolved: RuntimeLlmPolicyCheck["unresolved"][number] }
      | undefined,
  ) => {
    if (!candidate) {
      return;
    }
    if ("unresolved" in candidate) {
      unresolved.push(candidate.unresolved);
      return;
    }
    required.push(candidate);
  };

  add(buildConfiguredModelRequirement({
    configField: "summaryModel",
    configPath: "plugins.entries.lossless-claw.config.summaryModel",
    provider: config.summaryProvider,
    model: config.summaryModel,
  }));
  add(buildConfiguredModelRequirement({
    configField: "largeFileSummaryModel",
    configPath: "plugins.entries.lossless-claw.config.largeFileSummaryModel",
    provider: config.largeFileSummaryProvider,
    model: config.largeFileSummaryModel,
  }));
  for (const [index, fallback] of config.fallbackProviders.entries()) {
    add(buildConfiguredModelRequirement({
      configField: "fallbackProviders",
      configPath: `plugins.entries.lossless-claw.config.fallbackProviders[${index}]`,
      provider: fallback.provider,
      model: fallback.model,
    }));
  }

  const seen = new Set<string>();
  return {
    required: required.filter((entry) => {
      const key = `${entry.configField}\u0000${entry.modelRef}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    }),
    unresolved,
  };
}

/** Read the host policy currently visible to the plugin registration context. */
function readRuntimeLlmPolicy(openClawConfig: unknown): {
  allowModelOverride: boolean;
  allowedModels: Set<string>;
  allowAnyModel: boolean;
  available: boolean;
} {
  const plugins = isRecord(openClawConfig) ? openClawConfig.plugins : undefined;
  const entries = isRecord(plugins) ? plugins.entries : undefined;
  const entry = isRecord(entries) ? entries["lossless-claw"] : undefined;
  const llm = isRecord(entry) ? entry.llm : undefined;
  if (!isRecord(llm)) {
    return {
      allowModelOverride: false,
      allowedModels: new Set(),
      allowAnyModel: false,
      available: false,
    };
  }
  const allowed = Array.isArray(llm.allowedModels)
    ? llm.allowedModels.filter((model): model is string => typeof model === "string")
    : [];
  return {
    allowModelOverride: llm.allowModelOverride === true,
    allowedModels: new Set(allowed),
    allowAnyModel: allowed.includes("*"),
    available: true,
  };
}

/** Compare configured Lossless model overrides against host runtime LLM policy. */
function checkRuntimeLlmPolicyRequirements(params: {
  config: LcmDependencies["config"];
  openClawConfig: unknown;
}): RuntimeLlmPolicyCheck {
  const { required, unresolved } = collectRuntimeLlmPolicyRequirements(params.config);
  const policy = readRuntimeLlmPolicy(params.openClawConfig);
  return {
    required,
    unresolved,
    missingAllowModelOverride: required.length > 0 && policy.allowModelOverride !== true,
    missingAllowedModels: policy.allowAnyModel
      ? []
      : required.filter((entry) => !policy.allowedModels.has(entry.modelRef)),
    policyAvailable: policy.available,
  };
}

/** Format a one-time startup warning for incomplete runtime LLM model policy. */
function formatRuntimeLlmPolicyStartupWarning(check: RuntimeLlmPolicyCheck): string | undefined {
  if (
    check.required.length === 0 &&
    check.unresolved.length === 0
  ) {
    return undefined;
  }
  if (
    check.policyAvailable &&
    !check.missingAllowModelOverride &&
    check.missingAllowedModels.length === 0 &&
    check.unresolved.length === 0
  ) {
    return undefined;
  }

  const parts = [
    "[lcm] Runtime LLM model override policy may block configured Lossless summary models.",
    "Run \"openclaw doctor --fix\" to repair plugins.entries.lossless-claw.llm.",
    "Required config path: plugins.entries.lossless-claw.llm.allowModelOverride and plugins.entries.lossless-claw.llm.allowedModels.",
  ];
  if (!check.policyAvailable) {
    parts.push("Host policy was not visible in the plugin registration config; using best-effort validation.");
  }
  if (check.missingAllowModelOverride) {
    parts.push("Missing: plugins.entries.lossless-claw.llm.allowModelOverride = true.");
  }
  if (check.missingAllowedModels.length > 0) {
    parts.push(
      `Missing allowedModels entries: ${check.missingAllowedModels.map((entry) => `${entry.configField}=${entry.modelRef}`).join(", ")}.`,
    );
  }
  if (check.unresolved.length > 0) {
    parts.push(
      `Unresolved model refs: ${check.unresolved.map((entry) => `${entry.configPath} (${entry.reason})`).join("; ")}.`,
    );
  }
  return parts.join(" ");
}

/** Construct LCM dependencies from plugin API/runtime surfaces. */
function createLcmDependencies(
  api: OpenClawPluginApi,
  registrationConfig = resolveRegistrationConfig(api),
): LcmDependencies {
  const envSnapshot = snapshotPluginEnv();
  envSnapshot.openclawDefaultModel = readDefaultModelFromConfig(registrationConfig.openClawConfig);
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

  const runtimeLlmUnavailableError = buildRuntimeLlmUnavailableError();
  if (!getRuntimeLlm(api)) {
    logStartupBannerOnce({
      key: "runtime-llm-unavailable",
      log: (message) => log.warn(message),
      message: runtimeLlmUnavailableError.message ?? "[lcm] OpenClaw runtime.llm.complete is unavailable.",
    });
  }

  const runtimeLlmPolicyWarning = formatRuntimeLlmPolicyStartupWarning(
    checkRuntimeLlmPolicyRequirements({
      config,
      openClawConfig: registrationConfig.openClawConfig,
    }),
  );
  if (runtimeLlmPolicyWarning) {
    logStartupBannerOnce({
      key: "runtime-llm-policy-summary-models",
      log: (message) => log.warn(message),
      message: runtimeLlmPolicyWarning,
    });
  }

  const directCredentialLookupError =
    "[lcm] direct provider credential lookup has been removed; OpenClaw runtime.llm.complete owns model auth.";

  return {
    config,
    configDiagnostics: diagnostics,
    isRuntimeManagedAuthProvider: () => true,
    complete: async ({
      provider,
      model,
      runtimeModelOverride,
      agentId,
      messages,
      system,
      maxTokens,
      temperature,
      reasoning,
      reasoningIfSupported,
    }) => {
      const providerId = provider?.trim();
      const modelId = model.trim();
      const modelRef = runtimeModelOverride?.modelRef.trim();
      const runtimeLlm = getRuntimeLlm(api);
      const requestMetadata = {
        request_provider: providerId ?? "(runtime)",
        request_model: modelId || "(runtime)",
        request_api: "runtime.llm",
        request_reasoning: reasoning?.trim() || reasoningIfSupported?.trim() || "(host-managed)",
        request_has_system: typeof system === "string" && system.trim().length > 0 ? "true" : "false",
        request_temperature:
          typeof temperature === "number" && Number.isFinite(temperature)
            ? String(temperature)
            : "(omitted)",
        request_temperature_sent:
          typeof temperature === "number" && Number.isFinite(temperature) ? "true" : "false",
      };

      if (!runtimeLlm) {
        return {
          content: [],
          error: runtimeLlmUnavailableError,
          ...requestMetadata,
        };
      }

      try {
        const result = await runtimeLlm.complete({
          messages: toRuntimeLlmMessages(messages),
          ...(modelRef ? { model: modelRef } : {}),
          ...(typeof maxTokens === "number" && Number.isFinite(maxTokens) ? { maxTokens } : {}),
          ...(typeof temperature === "number" && Number.isFinite(temperature)
            ? { temperature }
            : {}),
          ...(typeof system === "string" && system.trim() ? { systemPrompt: system.trim() } : {}),
          purpose: "lossless-claw compaction summarization",
          ...(agentId?.trim() ? { agentId: agentId.trim() } : {}),
        });
        const text = typeof result.text === "string" ? result.text : "";
        return {
          content: text ? [{ type: "text", text }] : [],
          provider: result.provider,
          model: result.model,
          agentId: result.agentId,
          usage: result.usage,
          audit: result.audit,
          ...requestMetadata,
        };
      } catch (err) {
        log.error(`[lcm] runtime.llm.complete error: ${describeLogError(err)}`);
        if (runtimeModelOverride && isRuntimeLlmModelPolicyDenial(err)) {
          return {
            content: [],
            error: buildRuntimeLlmPolicyError(runtimeModelOverride, err),
            ...requestMetadata,
          };
        }
        const authError = detectProviderAuthError(err);
        return {
          content: [],
          error: authError ?? detectProviderBridgeError(err),
          ...requestMetadata,
        };
      }
    },
    getApiKey: async () => {
      log.warn(directCredentialLookupError);
      return undefined;
    },
    requireApiKey: async () => {
      throw new Error(directCredentialLookupError);
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
        const sessionApi = getRuntimeAgentSessionApi(api);
        if (!sessionApi) {
          return undefined;
        }
        const cfg = api.runtime.config.loadConfig();
        const parsed = parseAgentSessionKey(key);
        const agentId = normalizeAgentId(parsed?.agentId);
        const storePath = sessionApi.resolveStorePath(cfg.session?.store, {
          agentId,
        });
        const store = sessionApi.loadSessionStore(storePath) as Record<
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
        const sessionApi = getRuntimeAgentSessionApi(api);
        if (!sessionApi) {
          return undefined;
        }
        const cfg = api.runtime.config.loadConfig();
        const normalizedSessionKey = sessionKey?.trim();
        const parsed = normalizedSessionKey ? parseAgentSessionKey(normalizedSessionKey) : null;
        const agentId = normalizeAgentId(parsed?.agentId);
        const storePath = sessionApi.resolveStorePath(cfg.session?.store, {
          agentId,
        });
        const store = sessionApi.loadSessionStore(storePath) as Record<
          string,
          { sessionId?: string; sessionFile?: string } | undefined
        >;
        const entry =
          (normalizedSessionKey ? store[normalizedSessionKey] : undefined)
          ?? Object.values(store).find((candidate) => candidate?.sessionId === normalizedSessionId);
        const transcriptPath = sessionApi.resolveSessionFilePath(
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
    listStartupSessionFileCandidates: async () => {
      const sessionApi = getRuntimeAgentSessionApi(api);
      if (!sessionApi) {
        return [];
      }

      let cfg: unknown = registrationConfig.openClawConfig;
      try {
        cfg = api.runtime.config.loadConfig();
      } catch {
        // Fall back to the registration config snapshot when live config is unavailable.
      }

      const sessionConfig = isRecord(cfg) && isRecord(cfg.session) ? cfg.session : undefined;
      const storeConfig = getStringField(sessionConfig, "store");
      const candidates: StartupSessionFileCandidate[] = [];
      const seen = new Set<string>();

      for (const agentId of listConfiguredAgentIds(cfg)) {
        let storePath: string;
        let store: Record<string, RuntimeSessionStoreEntry | undefined>;
        try {
          storePath = sessionApi.resolveStorePath(storeConfig, { agentId });
          store = sessionApi.loadSessionStore(storePath);
        } catch {
          continue;
        }

        for (const [rawSessionKey, rawEntry] of Object.entries(store)) {
          const sessionKey = rawSessionKey.trim();
          if (!sessionKey || !isRecord(rawEntry)) {
            continue;
          }
          const parsed = parseAgentSessionKey(sessionKey);
          if (parsed?.agentId && normalizeAgentId(parsed.agentId) !== agentId) {
            continue;
          }
          const sessionId = getStringField(rawEntry, "sessionId");
          if (!sessionId) {
            continue;
          }

          let sessionFile: string;
          try {
            sessionFile = sessionApi.resolveSessionFilePath(sessionId, rawEntry, {
              agentId,
              storePath,
            }).trim();
          } catch {
            continue;
          }
          if (!sessionFile) {
            continue;
          }

          const dedupeKey = `${sessionId}\0${sessionKey}\0${sessionFile}`;
          if (seen.has(dedupeKey)) {
            continue;
          }
          seen.add(dedupeKey);
          candidates.push({
            sessionId,
            sessionKey,
            sessionFile,
            agentId,
            storePath,
          });
        }
      }

      return candidates;
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

    /** Start the non-blocking startup scan for oversized LCM-managed transcripts. */
    function scheduleStartupAutoRotate(nextEngine: LcmContextEngine): void {
      void nextEngine.autoRotateManagedSessionFilesAtStartup().catch((error) => {
        deps.log.warn(
          `[lcm] auto-rotate: phase=startup action=warn durationMs=0 reason=startup-scan-failed error=${describeLogError(error).replace(/\s+/g, "_")}`,
        );
      });
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
        scheduleStartupAutoRotate(nextEngine);
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
