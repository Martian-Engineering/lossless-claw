/**
 * Compatibility bridge for the subset of OpenClaw types that lossless-claw
 * actually consumes.
 *
 * The npm-published `openclaw/plugin-sdk` surface in older releases does not
 * re-export context-engine symbols even though the runtime supports them. We
 * keep the plugin's internal contracts here so source builds do not depend on
 * that packaging detail.
 */

import type { OpenClawPluginApi as BaseOpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AgentMessage as PiAgentMessage } from "@mariozechner/pi-agent-core";

type StringToolResultMessage = {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  isError: boolean;
  timestamp: number;
  content: string;
  details?: unknown;
};

export type AgentMessage = PiAgentMessage | StringToolResultMessage;

export type ContextEngineInfo = {
  id: string;
  name: string;
  version: string;
  ownsCompaction?: boolean;
};

export type AssembleResult = {
  messages: AgentMessage[];
  estimatedTokens: number;
  systemPromptAddition?: string;
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
  result?: {
    tokensBefore?: number;
    tokensAfter?: number;
    details?: Record<string, unknown>;
  };
};

export type IngestResult = {
  ingested: boolean;
};

export type IngestBatchResult = {
  ingestedCount: number;
};

export type SubagentSpawnPreparation = {
  rollback: () => void | Promise<void>;
};

export type SubagentEndReason = "deleted" | "completed" | "released" | "swept";

export interface ContextEngine {
  info: ContextEngineInfo;
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
  assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
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
  prepareSubagentSpawn?(params: {
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

export type ContextEngineFactory = () => ContextEngine;

export type SubagentRuntimeCompat = {
  run: (params: {
    sessionKey: string;
    message: string;
    extraSystemPrompt?: string;
    lane?: string;
    deliver?: boolean;
    idempotencyKey?: string;
  }) => Promise<unknown>;
  waitForRun: (params: {
    runId: string;
    timeoutMs?: number;
  }) => Promise<unknown>;
  getSession: (params: {
    sessionKey: string;
    limit?: number;
  }) => Promise<unknown>;
  deleteSession: (params: {
    sessionKey: string;
    deleteTranscript?: boolean;
  }) => Promise<unknown>;
};

export type OpenClawPluginApi = BaseOpenClawPluginApi & {
  registerContextEngine: (id: string, factory: ContextEngineFactory) => void;
  runtime: BaseOpenClawPluginApi["runtime"] & {
    subagent: SubagentRuntimeCompat;
  };
};
