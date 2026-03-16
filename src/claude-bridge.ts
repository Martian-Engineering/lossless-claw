/**
 * Claude Code plugin SDK type definitions.
 *
 * Locally-defined types for the Claude Code plugin/hook system,
 * replacing the former openclaw/plugin-sdk dependency.
 */

// ── Agent message types ──────────────────────────────────────────────────────

/** Content block inside an agent message. */
export type AgentMessageContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content?: string | Array<{ type: "text"; text: string }> }
  | { type: "reasoning"; text?: string; [key: string]: unknown }
  | Record<string, unknown>;

/** A single message in an agent conversation. */
export interface AgentMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | AgentMessageContentBlock[];
  [key: string]: unknown;
}

// ── Context engine types ─────────────────────────────────────────────────────

/** Metadata returned by a context engine. */
export interface ContextEngineInfo {
  id: string;
  name: string;
  version: string;
  ownsCompaction: boolean;
}

/** Result of a context assembly pass. */
export interface AssembleResult {
  messages: AgentMessage[];
  estimatedTokens: number;
  systemPromptAddition?: string;
}

/** Result of a bootstrap operation. */
export interface BootstrapResult {
  bootstrapped: boolean;
  importedMessages: number;
  reason: string;
}

/** Result of a compaction operation. */
export interface CompactResult {
  ok: boolean;
  compacted: boolean;
  reason: string;
  result?: {
    tokensBefore: number;
    tokensAfter: number;
    details: Record<string, unknown>;
  };
}

/** Result of ingesting a single message. */
export interface IngestResult {
  ingested: boolean;
}

/** Result of ingesting a batch of messages. */
export interface IngestBatchResult {
  ingestedCount: number;
}

/** Preparation handle returned when spawning a sub-agent. */
export interface SubagentSpawnPreparation {
  rollback: () => void;
}

/** Reason a sub-agent session ended. */
export type SubagentEndReason = "deleted" | "completed" | "released" | "swept";

/** Context engine interface — the contract a plugin context engine must satisfy. */
export interface ContextEngine {
  readonly info: ContextEngineInfo;
  bootstrap(params: { sessionId: string; sessionFile: string }): Promise<BootstrapResult>;
  ingest(params: {
    sessionId: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult>;
  ingestBatch(params: {
    sessionId: string;
    messages: AgentMessage[];
    isHeartbeat?: boolean;
  }): Promise<IngestBatchResult>;
  afterTurn(params: {
    sessionId: string;
    sessionFile: string;
    messages: AgentMessage[];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    isHeartbeat?: boolean;
    tokenBudget?: number;
    legacyCompactionParams?: Record<string, unknown>;
  }): Promise<void>;
  assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
    legacyParams?: Record<string, unknown>;
  }): Promise<AssembleResult>;
  compact(params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    legacyParams?: Record<string, unknown>;
    force?: boolean;
  }): Promise<CompactResult>;
  spanSubagent?(params: {
    parentSessionKey: string;
    childSessionKey: string;
    ttlMs?: number;
  }): Promise<SubagentSpawnPreparation | undefined>;
  onSubagentEnded?(params: {
    childSessionKey: string;
    reason: SubagentEndReason;
  }): Promise<void>;
  dispose?(): Promise<void>;
}

// ── Context engine factory ───────────────────────────────────────────────────

/** Factory function that creates a context engine instance. */
export type ContextEngineFactory = () => ContextEngine;

// ── Agent tool type ──────────────────────────────────────────────────────────

/** Schema for an agent tool (compatible with TypeBox TObject). */
export interface AnyAgentTool {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: unknown;
  }>;
}

// ── Plugin API ───────────────────────────────────────────────────────────────

/** Logger interface exposed to plugins. */
export interface PluginLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug?(msg: string): void;
}

/** Plugin API — the host interface available to a Claude Code plugin. */
export interface ClaudePluginApi {
  id: string;
  name: string;
  source: string;
  config: Record<string, unknown>;
  pluginConfig: Record<string, unknown>;
  runtime: {
    subagent: {
      run: (...args: unknown[]) => unknown;
      waitForRun: (...args: unknown[]) => unknown;
      getSession: (...args: unknown[]) => unknown;
      deleteSession: (...args: unknown[]) => unknown;
    };
    config: {
      loadConfig: () => Record<string, unknown>;
    };
    channel: {
      session: {
        resolveStorePath: (...args: unknown[]) => string;
      };
    };
    modelAuth?: {
      getApiKeyForModel: (params: Record<string, unknown>) => Promise<{ apiKey?: string } | undefined>;
      resolveApiKeyForProvider: (params: Record<string, unknown>) => Promise<{ apiKey?: string } | undefined>;
    };
    [key: string]: unknown;
  };
  logger: PluginLogger;
  registerContextEngine(id: string, factory: ContextEngineFactory): void;
  registerTool(
    factory: (ctx: { sessionKey: string }) => AnyAgentTool,
    options?: { name?: string },
  ): void;
  resolvePath(relativePath: string): string;
}
