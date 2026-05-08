/**
 * Test-only harness that wires up the agent tools against a fixture DB.
 *
 * The unit tests scattered across `test/lcm-*-tool.test.ts` each
 * reconstruct the full `LcmDependencies` + `LcmContextEngine` mock from
 * scratch, with subtle drift across files. This module centralizes the
 * mock construction so scenario tests against the synthetic fixture
 * can run all 8 agent tools through one consistent harness.
 *
 * Mocks DO matter: real Voyage / LLM calls aren't reachable from this
 * harness — semantic + synthesis paths return graceful-degraded errors.
 * That matches what `scripts/v41-qa-runner.mjs` does in offline mode.
 *
 * Caveat: this is NOT a substitute for hot-path integration tests. It's
 * a tool-surface invariant test layer: "given a known DB, the agent
 * tools return the expected shapes for the 25 scenarios."
 */

import type { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";
import type { LcmContextEngine } from "../../src/engine.js";
import type { LcmDependencies } from "../../src/types.js";
import { ConversationStore } from "../../src/store/conversation-store.js";
import { SummaryStore } from "../../src/store/summary-store.js";
import { RetrievalEngine } from "../../src/retrieval.js";

function parseAgentSessionKey(
  sessionKey: string,
): { agentId: string; suffix: string } | null {
  const trimmed = sessionKey.trim();
  if (!trimmed.startsWith("agent:")) return null;
  const parts = trimmed.split(":");
  if (parts.length < 3) return null;
  return { agentId: parts[1] ?? "main", suffix: parts.slice(2).join(":") };
}

export function makeTestDeps(
  overrides?: Partial<LcmDependencies>,
): LcmDependencies {
  return {
    config: {
      enabled: true,
      databasePath: ":memory:",
      ignoreSessionPatterns: [],
      statelessSessionPatterns: [],
      skipStatelessSessions: true,
      contextThreshold: 0.75,
      freshTailCount: 8,
      newSessionRetainDepth: 2,
      leafMinFanout: 8,
      condensedMinFanout: 4,
      condensedMinFanoutHard: 2,
      incrementalMaxDepth: 0,
      leafChunkTokens: 20_000,
      leafTargetTokens: 600,
      condensedTargetTokens: 900,
      maxExpandTokens: 120,
      largeFileTokenThreshold: 25_000,
      summaryProvider: "",
      summaryModel: "",
      largeFileSummaryProvider: "",
      largeFileSummaryModel: "",
      timezone: "UTC",
      pruneHeartbeatOk: false,
      transcriptGcEnabled: false,
      proactiveThresholdCompactionMode: "deferred",
      autoRotateSessionFiles: {
        enabled: true,
        sizeBytes: 2 * 1024 * 1024,
        startup: "rotate",
        runtime: "rotate",
      },
      summaryMaxOverageFactor: 3,
    },
    complete: vi.fn(async () => {
      throw new Error("LLM not configured in test harness");
    }),
    callGateway: vi.fn(async () => ({})),
    resolveModel: () => ({ provider: "anthropic", model: "claude-opus-4-5" }),
    getApiKey: async () => undefined,
    requireApiKey: async () => "",
    parseAgentSessionKey,
    isSubagentSessionKey: (sessionKey: string) =>
      sessionKey.includes(":subagent:"),
    normalizeAgentId: (id?: string) => (id?.trim() ? id : "main"),
    buildSubagentSystemPrompt: () => "subagent prompt",
    readLatestAssistantReply: () => undefined,
    // Wave-12: tools that resolve session_id-from-session_key (via the
    // conversation-scope helper) need this in deps. Mock returns the
    // sessionKey itself (acceptable for tests where session_id resolution
    // doesn't matter).
    resolveSessionIdFromSessionKey: async (sessionKey: string) => sessionKey,
    ...overrides,
  } as LcmDependencies;
}

/**
 * Build a minimal LcmContextEngine that satisfies the AgentTool factory
 * surface. Cast through `unknown` because the tests don't exercise the
 * full 100+-method LcmContextEngine surface — only the slices the tools
 * touch.
 */
export function makeTestEngine(
  db: DatabaseSync,
  opts?: {
    timezone?: string;
    /** Test-only override for the gate-state method (lcm_compact tool). */
    agentCompactionGateState?: (params: {
      sessionId: string;
      sessionKey?: string;
      currentTokenCount?: number;
      tokenBudget?: number;
      reserveFraction?: number;
    }) => Promise<{
      ownsCompaction: boolean;
      belowFloor: boolean;
      shouldRefuse: boolean;
      refusalReason?: "engine-unhealthy" | "below-floor";
      refusalNote?: string;
      contextRatio?: number;
    }>;
    /** Test-only override for compact() (lcm_compact tool). */
    compactImpl?: (params: unknown) => Promise<{ ok: boolean; compacted?: boolean; reason?: string }>;
  },
): LcmContextEngine {
  const fts5Available = true;
  const conversationStore = new ConversationStore(db, { fts5Available });
  const summaryStore = new SummaryStore(db, { fts5Available });
  const retrieval = new RetrievalEngine(conversationStore, summaryStore);
  // Default gate-state impl: fast in-process that mimics the real engine's
  // floor + cacheHot logic without needing the full telemetry plumbing.
  const defaultGateState = async (params: {
    sessionId: string;
    sessionKey?: string;
    currentTokenCount?: number;
    tokenBudget?: number;
    reserveFraction?: number;
  }) => {
    const reserveFraction = (() => {
      const r = params.reserveFraction;
      if (typeof r !== "number" || !Number.isFinite(r)) return 0.5;
      return Math.max(0.5, Math.min(1.0, r));
    })();
    const haveBudget =
      typeof params.tokenBudget === "number"
      && Number.isFinite(params.tokenBudget)
      && params.tokenBudget > 0;
    const haveCurrent =
      typeof params.currentTokenCount === "number"
      && Number.isFinite(params.currentTokenCount)
      && params.currentTokenCount >= 0;
    const contextRatio = haveBudget && haveCurrent
      ? params.currentTokenCount! / params.tokenBudget!
      : undefined;
    const belowFloor = contextRatio !== undefined && contextRatio < reserveFraction;
    if (belowFloor) {
      return {
        ownsCompaction: true,
        belowFloor: true,
        shouldRefuse: true,
        refusalReason: "below-floor" as const,
        refusalNote: `Context is at ${(contextRatio! * 100).toFixed(1)}% of budget — below the ${(reserveFraction * 100).toFixed(0)}% floor. No need to compact yet; chained tool calls have headroom.`,
        contextRatio,
      };
    }
    return {
      ownsCompaction: true,
      belowFloor: false,
      shouldRefuse: false,
      contextRatio,
    };
  };
  return {
    info: { id: "lcm", name: "LCM", version: "0.0.0-test", ownsCompaction: true },
    timezone: opts?.timezone ?? "UTC",
    getDb: () => db,
    getRetrieval: () => retrieval,
    getConversationStore: () => conversationStore,
    getSummaryStore: () => summaryStore,
    getAgentCompactionGateState: opts?.agentCompactionGateState ?? defaultGateState,
    compact:
      opts?.compactImpl
      ?? (async () => ({ ok: true, compacted: false, reason: "no conversation found" })),
  } as unknown as LcmContextEngine;
}
