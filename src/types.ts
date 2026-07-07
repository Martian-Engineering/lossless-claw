/**
 * Core type definitions for the LCM plugin.
 *
 * These types define the contracts between LCM and OpenClaw core,
 * abstracting away direct imports from core internals.
 */

import type { LcmConfig } from "./db/config.js";
import type { LcmConfigDiagnostics } from "./db/config.js";
import type { CompactResult } from "./openclaw-bridge.js";

/**
 * Minimal LLM completion interface needed by LCM for summarization.
 *
 * The production implementation delegates model prep, auth, and dispatch to
 * OpenClaw's host-owned runtime LLM API. Provider/model fields are retained as
 * summary-model selection hints and diagnostics, not as direct auth inputs.
 */
export type CompletionContentBlock = {
  type: string;
  text?: string;
  [key: string]: unknown;
};

export type CompletionErrorInfo = {
  kind?: string;
  message?: string;
  code?: string;
  statusCode?: number;
  [key: string]: unknown;
};

export type CompletionResult = {
  content: CompletionContentBlock[];
  error?: CompletionErrorInfo;
  [key: string]: unknown;
};

export type RuntimeLlmModelOverride = {
  configField: string;
  configPath: string;
  modelRef: string;
};

export type RuntimeLlmCompleteFn = (params: {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  purpose?: string;
  agentId?: string;
  reasoning?: string;
  authProfileId?: string;
}) => Promise<{
  text: string;
  provider: string;
  model: string;
  agentId: string;
  usage?: Record<string, unknown>;
  audit?: Record<string, unknown>;
}>;

export type CompleteFn = (params: {
  provider?: string;
  model: string;
  runtimeModelOverride?: RuntimeLlmModelOverride;
  runtimeLlmComplete?: RuntimeLlmCompleteFn;
  agentId?: string;
  authProfileId?: string;
  messages: Array<{ role: string; content: unknown }>;
  system?: string;
  maxTokens: number;
  temperature?: number;
  reasoning?: string;
  reasoningIfSupported?: string;
}) => Promise<CompletionResult>;

/** Optional bridge to OpenClaw's built-in runtime compaction path. */
export type RuntimeCompactionDelegateFn = (params: {
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  tokenBudget?: number;
  currentTokenCount?: number;
  compactionTarget?: "budget" | "threshold";
  customInstructions?: string;
  runtimeContext?: Record<string, unknown>;
  legacyParams?: Record<string, unknown>;
  force?: boolean;
}) => Promise<CompactResult>;

/**
 * Gateway RPC call interface.
 */
export type CallGatewayFn = (params: {
  method: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
}) => Promise<unknown>;

/**
 * Model resolution function — resolves model aliases and defaults.
 * When providerHint is supplied, it takes precedence over env/defaults.
 */
export type ResolveModelFn = (modelRef?: string, providerHint?: string) => {
  provider: string;
  model: string;
};

/**
 * Session key utilities.
 */
export type ParseAgentSessionKeyFn = (sessionKey: string) => {
  agentId: string;
  suffix: string;
} | null;

export type IsSubagentSessionKeyFn = (sessionKey: string) => boolean;

export type StartupSessionFileCandidate = {
  sessionId: string;
  sessionKey: string;
  sessionFile: string;
  agentId?: string;
  storePath?: string;
};

/**
 * Dependencies injected into the LCM engine at registration time.
 * These replace all direct imports from OpenClaw core.
 */
export interface LcmDependencies {
  /** LCM configuration (from env vars + plugin config) */
  config: LcmConfig;

  /** Optional config resolution metadata for startup diagnostics. */
  configDiagnostics?: LcmConfigDiagnostics;

  /** LLM completion function for summarization */
  complete: CompleteFn;

  /** Optional OpenClaw runtime compaction delegate for sessions LCM intentionally ignores */
  delegateCompactionToRuntime?: RuntimeCompactionDelegateFn;

  /** Gateway RPC call function (for subagent spawning, session ops) */
  callGateway: CallGatewayFn;

  /** Resolve model alias to provider/model pair */
  resolveModel: ResolveModelFn;

  /** Parse agent session key into components */
  parseAgentSessionKey: ParseAgentSessionKeyFn;

  /** Check if a session key is a subagent key */
  isSubagentSessionKey: IsSubagentSessionKeyFn;

  /** Normalize an agent ID */
  normalizeAgentId: (id?: string) => string;

  /** Build system prompt for subagent sessions */
  buildSubagentSystemPrompt: (params: {
    depth: number;
    maxDepth: number;
    taskSummary?: string;
  }) => string;

  /** Read the latest assistant reply from a session's messages */
  readLatestAssistantReply: (messages: unknown[]) => string | undefined;

  /** Sanitize tool use/result pairing in message arrays */
  // sanitizeToolUseResultPairing removed — now imported directly in assembler from transcript-repair.ts

  /** Resolve the OpenClaw agent directory */
  resolveAgentDir: () => string;

  /** Resolve runtime session id from an agent session key */
  resolveSessionIdFromSessionKey: (sessionKey: string) => Promise<string | undefined>;

  /** Resolve the current transcript file path for a session identity */
  resolveSessionTranscriptFile: (params: {
    agentId?: string;
    sessionId: string;
    sessionKey?: string;
  }) => Promise<string | undefined>;

  /** List OpenClaw-indexed session files that startup recovery may enumerate. */
  listStartupSessionFileCandidates?: () => Promise<StartupSessionFileCandidate[]>;

  /** Agent lane constant for subagents */
  agentLaneSubagent: string;

  /** Logger */
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug: (msg: string) => void;
    hostInfo?: (msg: string) => void;
    hostWarn?: (msg: string) => void;
  };
}
