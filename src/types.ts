/**
 * Core type definitions for the LCM plugin.
 *
 * These types define the contracts between LCM and OpenClaw core,
 * abstracting away direct imports from core internals.
 */

import type { LcmConfig } from "./db/config.js";

/**
 * Minimal LLM completion interface needed by LCM for summarization.
 * Matches the signature of completeSimple from @mariozechner/pi-ai.
 */
export type CompleteFn = (params: {
  provider?: string;
  model: string;
  apiKey: string;
  messages: Array<{ role: string; content: unknown }>;
  system?: string;
  maxTokens: number;
  temperature?: number;
  reasoning?: string;
}) => Promise<{ content: Array<{ type: string; text?: string }> }>;

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
 */
export type ResolveModelFn = (modelRef?: string) => {
  provider: string;
  model: string;
};

/**
 * API key resolution function.
 */
export type GetApiKeyFn = (provider: string, model: string) => string | undefined;
export type RequireApiKeyFn = (provider: string, model: string) => string;

/**
 * Session key utilities.
 */
export type ParseAgentSessionKeyFn = (sessionKey: string) => {
  agentId: string;
  suffix: string;
} | null;

export type IsSubagentSessionKeyFn = (sessionKey: string) => boolean;

/**
 * Dependencies injected into the LCM engine at registration time.
 * These replace all direct imports from OpenClaw core.
 */
export interface LcmDependencies {
  /** LCM configuration (from env vars + plugin config) */
  config: LcmConfig;

  /** LLM completion function for summarization */
  complete: CompleteFn;

  /** Gateway RPC call function (for subagent spawning, session ops) */
  callGateway: CallGatewayFn;

  /** Resolve model alias to provider/model pair */
  resolveModel: ResolveModelFn;

  /** Get API key for a provider/model pair */
  getApiKey: GetApiKeyFn;

  /** Require API key (throws if missing) */
  requireApiKey: RequireApiKeyFn;

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

  /** Agent lane constant for subagents */
  agentLaneSubagent: string;

  /** Logger */
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug: (msg: string) => void;
  };
}
