/**
 * Compatibility bridge for plugin-sdk context-engine symbols.
 *
 * This module intentionally keeps the context-engine contract local because
 * older OpenClaw SDK packages do not publish these newer type symbols yet.
 */

export type AnyAgentTool = {
  name: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  execute: (toolCallId: string, params: Record<string, unknown>) => any | Promise<any>;
  [key: string]: any;
};

export type PluginLifecycleContext = {
  sessionId?: string;
  sessionKey?: string;
  [key: string]: any;
};

export type PluginLifecycleEvent = {
  reason?: string;
  sessionId?: string;
  sessionKey?: string;
  [key: string]: any;
};

export type ContextEngineProjection = {
  mode: "per_turn" | "thread_bootstrap";
  epoch?: string;
  fingerprint?: string;
};

export type AssembleResult = {
  messages: AgentMessage[];
  estimatedTokens: number;
  systemPromptAddition?: string;
  contextProjection?: ContextEngineProjection;
};

export type BootstrapResult = {
  bootstrapped: boolean;
  importedMessages: number;
  reason?: string;
};

export type CompactResult = {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  summaryId?: string;
  error?: string;
  result?: any;
};

export type IngestResult = {
  ingested: boolean;
};

export type IngestBatchResult = {
  ingestedCount: number;
};

export type SubagentSpawnPreparation = {
  systemPromptAddition?: string;
  rollback?: () => void;
};

export type SubagentEndReason = string;

export type ContextEngineInfo = {
  id: string;
  name: string;
  version: string;
  ownsCompaction?: boolean;
  turnMaintenanceMode?: "background" | "inline" | string;
  hostRequirements?: Partial<Record<ContextEngineOperation, ContextEngineHostRequirements>>;
};

export type ContextEngineOperation = "agent-run" | "manual-compact" | "subagent-spawn";

export type ContextEngineHostCapability =
  | "bootstrap"
  | "assemble-before-prompt"
  | "after-turn"
  | "maintain"
  | "compact"
  | "runtime-llm-complete"
  | "thread-bootstrap-projection";

export type ContextEngineHostRequirements = {
  requiredCapabilities: ContextEngineHostCapability[];
  unsupportedMessage?: string;
};

export type PluginCommandContext = {
  [key: string]: any;
};

export type OpenClawPluginCommandDefinition = {
  name?: string;
  description?: string;
  handler: (ctx: PluginCommandContext) => any | Promise<any>;
  [key: string]: any;
};

export type ContextEngineFactory = () => ContextEngine | Promise<ContextEngine>;

export type OpenClawPluginApi = {
  config?: any;
  runtime?: any;
  logger?: any;
  log?: any;
  registerCommand: (definition: OpenClawPluginCommandDefinition) => void;
  registerContextEngine?: (id: string, factory: ContextEngineFactory) => void;
  registerTool?: (
    factory: (ctx: PluginLifecycleContext) => AnyAgentTool | Promise<AnyAgentTool>,
    options?: { name?: string; [key: string]: any },
  ) => void;
  on: (
    eventName: string,
    handler: (event: PluginLifecycleEvent, ctx: PluginLifecycleContext) => unknown | Promise<unknown>,
  ) => void;
  [key: string]: any;
};

export type AgentMessage = {
  role: string;
  content?: any;
  timestamp?: number;
  toolCallId?: string;
  toolUseId?: string;
  toolName?: string;
  details?: any;
  isError?: boolean;
  stopReason?: string;
  command?: string;
  output?: unknown;
};

export type ContextEngine = {
  info: ContextEngineInfo;
  bootstrap(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile?: string;
    messages?: AgentMessage[];
  }): Promise<BootstrapResult>;
  ingest(params: {
    sessionId: string;
    sessionKey?: string;
    message: AgentMessage;
  }): Promise<IngestResult>;
  ingestBatch?(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    isHeartbeat?: boolean;
  }): Promise<IngestBatchResult>;
  assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    tokenBudget?: number;
    prompt?: string;
  }): Promise<AssembleResult>;
  compact(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile?: string;
    tokenBudget?: number;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    runtimeContext?: Record<string, unknown>;
    legacyParams?: Record<string, unknown>;
    force?: boolean;
  }): Promise<CompactResult>;
  prepareSubagentSpawn?(params: {
    parentSessionId?: string;
    parentSessionKey?: string;
    parentSessionFile?: string;
    childSessionId?: string;
    childSessionKey: string;
    childSessionFile?: string;
    contextMode?: "isolated" | "fork";
  }): Promise<SubagentSpawnPreparation | undefined>;
  onSubagentEnded?(params: {
    childSessionId?: string;
    childSessionKey: string;
    reason?: SubagentEndReason;
  }): Promise<void>;
};
