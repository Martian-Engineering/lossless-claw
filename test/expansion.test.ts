import { describe, expect, it, vi } from "vitest";
import type { LcmConfig } from "./db/config.js";
import type { ExpansionOrchestrator } from "./expansion.js";
import { buildExpansionToolDefinition } from "./expansion.js";

const BASE_CONFIG: LcmConfig = {
  enabled: true,
  databasePath: ":memory:",
  contextThreshold: 0.75,
  freshTailCount: 8,
  leafMinFanout: 8,
  condensedMinFanout: 4,
  condensedMinFanoutHard: 2,
  incrementalMaxDepth: 0,
  leafChunkTokens: 20_000,
  leafTargetTokens: 600,
  condensedTargetTokens: 900,
  maxExpandTokens: 250,
  largeFileTokenThreshold: 25_000,
  autocompactDisabled: false,
};

function makeExpansionResult() {
  return {
    expansions: [],
    citedIds: [],
    totalTokens: 0,
    truncated: false,
  };
}

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
