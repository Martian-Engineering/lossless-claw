/**
 * @martian-engineering/open-lcm — Lossless Context Management plugin for OpenClaw
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
    complete: async ({ provider, model, apiKey, messages, maxTokens, temperature }) => {
      try {
        const piAiModuleId = "@mariozechner/pi-ai";
        const mod = (await import(piAiModuleId)) as {
          completeSimple?: (
            modelRef: { provider: string; model: string },
            request: { messages: Array<{ role: string; content: unknown; timestamp?: number }> },
            options: {
              apiKey?: string;
              maxTokens: number;
              temperature?: number;
            },
          ) => Promise<{ content?: Array<{ type: string; text?: string }> }>;
        };

        if (typeof mod.completeSimple !== "function") {
          return { content: [] };
        }

        const result = await mod.completeSimple(
          { provider: provider ?? "", model },
          {
            messages: messages.map((message) => ({
              role: message.role,
              content: message.content,
              timestamp: Date.now(),
            })),
          },
          {
            apiKey,
            maxTokens,
            temperature,
          },
        );

        return {
          content: Array.isArray(result?.content) ? result.content : [],
        };
      } catch {
        return { content: [] };
      }
    },
    callGateway: async (params) => {
      const runtimeGateway = (api.runtime as unknown as {
        gateway?: {
          call?: (input: {
            method: string;
            params?: Record<string, unknown>;
            timeoutMs?: number;
          }) => Promise<unknown>;
        };
      }).gateway;

      if (runtimeGateway?.call) {
        return runtimeGateway.call(params);
      }

      throw new Error("Gateway calls are unavailable in this runtime.");
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
    sanitizeToolUseResultPairing: (messages) => messages,
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
  id: "lcm",
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

    api.registerContextEngine("lcm", () => lcm);
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
