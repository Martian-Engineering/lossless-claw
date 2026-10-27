import { describe, expect, it, vi } from "vitest";
import type { LcmConfig } from "../src/db/config.js";
import { ExpansionOrchestrator, buildExpansionToolDefinition, distillForSubagent } from "../src/expansion.js";
import type { RetrievalEngine } from "../src/retrieval.js";

const BASE_CONFIG: LcmConfig = {
  enabled: true,
  hostFallbackMode: "error",
  databasePath: ":memory:",
  largeFilesDir: "/tmp/lcm-files",
  ignoreSessionPatterns: [],
  statelessSessionPatterns: [],
  skipStatelessSessions: true,
  contextThreshold: 0.75,
  freshTailCount: 8,
  promptAwareEviction: false,
  stubLargeToolPayloads: false,
  newSessionRetainDepth: 2,
  leafMinFanout: 8,
  condensedMinFanout: 4,
  condensedMinFanoutHard: 2,
  sweepMaxDepth: 1,
  incrementalMaxDepth: 0,
  maxSweepIterations: 12,
  sweepDeadlineMs: 120_000,
  compactUntilUnderDeadlineMs: 300_000,
  leafChunkTokens: 20_000,
  leafTargetTokens: 600,
  condensedTargetTokens: 900,
  maxExpandTokens: 250,
  largeFileTokenThreshold: 25_000,
  summaryProvider: "",
  summaryModel: "",
  largeFileSummaryProvider: "",
  largeFileSummaryModel: "",
  delegationTimeoutMs: 120_000,
  summaryTimeoutMs: 60_000,
  timezone: "UTC",
  pruneHeartbeatOk: false,
  preserveHeartbeatPoll: false,
  enableSummaryThinking: true,
  proactiveThresholdCompactionMode: "deferred",
  independentLogFile: {
    enabled: false,
    maxFileBytes: 100 * 1024 * 1024,
  },
  summaryMaxOverageFactor: 3,
  expansionProvider: "",
  expansionModel: "",
  customInstructions: "",
  circuitBreakerThreshold: 5,
  circuitBreakerCooldownMs: 1_800_000,
  replayFloodThresholdExternal: 3,
  replayFloodThresholdInternal: 32,
  fallbackProviders: [],
  cacheAwareCompaction: {
    enabled: true,
    cacheTTLSeconds: 300,
    maxColdCacheCatchupPasses: 2,
    hotCachePressureFactor: 4,
    hotCacheBudgetHeadroomRatio: 0.2,
    coldCacheObservationThreshold: 3,
    criticalBudgetPressureRatio: 0.90,
  },
  dynamicLeafChunkTokens: {
    enabled: true,
    max: 40_000,
  },
  stripInjectedContextTags: [],
};

function makeExpansionResult() {
  return {
    expansions: [],
    citedIds: [],
    totalTokens: 0,
    truncated: false,
  };
}

describe("source message expansion", () => {
  it("preserves full selected bodies separately from display snippets", async () => {
    const content = `${"Background detail. ".repeat(20)}\nExact reference: ORBIT-739.\n  Keep indentation.\n`;
    const retrieval = {
      expand: vi.fn().mockResolvedValue({
        children: [],
        messages: [{ messageId: 17, role: "user", content, tokenCount: 120 }],
        estimatedTokens: 120,
        truncated: false,
      }),
    };
    const orchestrator = new ExpansionOrchestrator(retrieval as unknown as RetrievalEngine);

    const result = await orchestrator.expand({
      summaryIds: ["sum_source"],
      conversationId: 1,
      includeMessages: true,
      tokenCap: 120,
    });

    expect(result.expansions[0].messages[0]).toMatchObject({
      content,
      snippet: `${content.slice(0, 200)}...`,
    });
    expect(distillForSubagent(result)).toContain(content);
    expect(distillForSubagent(result)).toContain("msg#17 (user, 120 tokens)");
    expect(result.totalTokens).toBe(120);
    expect(result.truncated).toBe(false);
  });
});

describe("buildExpansionToolDefinition tokenCap bounds", () => {
  it("defaults omitted tokenCap for summary expansion to config.maxExpandTokens", async () => {
    const orchestrator = {
      expand: vi.fn().mockResolvedValue(makeExpansionResult()),
      describeAndExpand: vi.fn().mockResolvedValue(makeExpansionResult()),
    };

    const tool = buildExpansionToolDefinition({
      orchestrator: orchestrator as unknown as ExpansionOrchestrator,
      config: BASE_CONFIG,
      conversationId: 12,
    });

    await tool.execute("call-1", {
      summaryIds: ["sum_a"],
    });

    expect(orchestrator.expand).toHaveBeenCalledWith(
      expect.objectContaining({
        summaryIds: ["sum_a"],
        tokenCap: 250,
      }),
    );
  });

  it("clamps oversized tokenCap for query expansion to config.maxExpandTokens", async () => {
    const orchestrator = {
      expand: vi.fn().mockResolvedValue(makeExpansionResult()),
      describeAndExpand: vi.fn().mockResolvedValue(makeExpansionResult()),
    };

    const tool = buildExpansionToolDefinition({
      orchestrator: orchestrator as unknown as ExpansionOrchestrator,
      config: BASE_CONFIG,
      conversationId: 99,
    });

    await tool.execute("call-2", {
      query: "keyword",
      tokenCap: 5_000,
    });

    expect(orchestrator.describeAndExpand).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "keyword",
        tokenCap: 250,
      }),
    );
  });
});
