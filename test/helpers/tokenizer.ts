import type { LcmConfig } from "../src/db/config.js";

/**
 * Helper to create test config with all required fields.
 * Based on test/engine.test.ts and Phase 1 spec.
 */
export function createTestConfig(overrides?: Partial<LcmConfig>): LcmConfig {
  return {
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
    maxExpandTokens: 4000,
    largeFileTokenThreshold: 25_000,
    largeFileSummaryProvider: "",
    largeFileSummaryModel: "",
    autocompactDisabled: false,
    timezone: "UTC",
    pruneHeartbeatOk: false,
    useTokenizer: false,
    ...overrides,
  };
}
