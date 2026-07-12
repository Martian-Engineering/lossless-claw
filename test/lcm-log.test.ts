import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLcmLogger } from "../src/lcm-log.js";
import type { LcmConfig } from "../src/db/config.js";

vi.mock("openclaw/plugin-sdk/logging-core", () => ({
  redactSensitiveText: (text: string, options?: { patterns?: string[] }) => {
    let next = text;
    for (const rawPattern of options?.patterns ?? []) {
      const match = rawPattern.match(/^\/(.+)\/([gimsuy]*)$/);
      const pattern = match
        ? new RegExp(match[1], match[2].includes("g") ? match[2] : `${match[2]}g`)
        : new RegExp(rawPattern, "gi");
      next = next.replace(pattern, "[REDACTED]");
    }
    return next;
  },
}));

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lcm-log-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function baseConfig(file: string, independentLogFileEnabled = true): LcmConfig {
  return {
    enabled: true,
    databasePath: path.join(tempDir, "lcm.db"),
    largeFilesDir: path.join(tempDir, "lcm-files"),
    ignoreSessionPatterns: [],
    statelessSessionPatterns: [],
    skipStatelessSessions: true,
    unsupportedHostMode: "error",
    contextThreshold: 0.75,
    freshTailCount: 64,
    promptAwareEviction: false,
    stubLargeToolPayloads: false,
    newSessionRetainDepth: 2,
    leafMinFanout: 8,
    condensedMinFanout: 4,
    condensedMinFanoutHard: 2,
    sweepMaxDepth: 1,
    incrementalMaxDepth: 1,
    maxSweepIterations: 12,
    sweepDeadlineMs: 120000,
    compactUntilUnderDeadlineMs: 300000,
    leafChunkTokens: 20000,
    leafTargetTokens: 2400,
    condensedTargetTokens: 2000,
    maxExpandTokens: 4000,
    largeFileTokenThreshold: 25000,
    summaryProvider: "",
    summaryModel: "",
    largeFileSummaryProvider: "",
    largeFileSummaryModel: "",
    expansionProvider: "",
    expansionModel: "",
    delegationTimeoutMs: 120000,
    summaryTimeoutMs: 60000,
    timezone: "UTC",
    pruneHeartbeatOk: false,
    transcriptGcEnabled: false,
    enableSummaryThinking: true,
    proactiveThresholdCompactionMode: "deferred",
    autoRotateSessionFiles: {
      enabled: true,
      createBackups: false,
      sizeBytes: 2097152,
      startup: "rotate",
      runtime: "rotate",
    },
    independentLogFile: {
      enabled: independentLogFileEnabled,
      file,
      maxFileBytes: 1024 * 1024,
    },
    summaryMaxOverageFactor: 3,
    customInstructions: "",
    circuitBreakerThreshold: 5,
    circuitBreakerCooldownMs: 1800000,
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
      criticalBudgetPressureRatio: 0.9,
    },
    dynamicLeafChunkTokens: {
      enabled: true,
      max: 40000,
    },
    stripInjectedContextTags: [],
  };
}

describe("createLcmLogger", () => {
  function createRuntimeLogger(
    file: string,
    options: { shouldLogVerbose?: boolean; runtimeConfig?: Record<string, unknown> } = {},
  ) {
    const runtimeLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const logger = createLcmLogger({
      runtime: {
        config: {
          current: vi.fn(() => options.runtimeConfig ?? {}),
        },
        logging: {
          shouldLogVerbose: vi.fn(() => options.shouldLogVerbose ?? false),
          getChildLogger: vi.fn(() => runtimeLogger),
        },
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    } as never, baseConfig(file));

    return { logger, runtimeLogger };
  }

  it("routes routine info lines to the independent log file only", () => {
    const file = path.join(tempDir, "lossless-claw-test.log");
    const { logger, runtimeLogger } = createRuntimeLogger(file);

    logger.info("[lcm] routine detail");

    expect(runtimeLogger.info).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, "utf8")).toContain("[lcm] routine detail");
  });

  it("keeps warning and error lines visible in OpenClaw logs", () => {
    const file = path.join(tempDir, "lossless-claw-test.log");
    const { logger, runtimeLogger } = createRuntimeLogger(file);

    logger.warn("[lcm] warning");
    logger.error("[lcm] failure");

    expect(runtimeLogger.warn).toHaveBeenCalledWith("[lcm] warning");
    expect(runtimeLogger.error).toHaveBeenCalledWith("[lcm] failure");
    const logText = fs.readFileSync(file, "utf8");
    expect(logText).toContain("[lcm] warning");
    expect(logText).toContain("[lcm] failure");
  });

  it("allows startup info lines to remain visible in OpenClaw logs", () => {
    const file = path.join(tempDir, "lossless-claw-test.log");
    const { logger, runtimeLogger } = createRuntimeLogger(file);

    logger.hostInfo?.("[lcm] Plugin loaded");

    expect(runtimeLogger.info).toHaveBeenCalledWith("[lcm] Plugin loaded");
    expect(fs.readFileSync(file, "utf8")).toContain("[lcm] Plugin loaded");
  });

  it("does not persist debug lines when OpenClaw verbose logging is disabled", () => {
    const file = path.join(tempDir, "lossless-claw-test.log");
    const { logger, runtimeLogger } = createRuntimeLogger(file, { shouldLogVerbose: false });

    logger.debug("[lcm] hidden debug detail");

    expect(runtimeLogger.debug).not.toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("persists debug lines when OpenClaw verbose logging is enabled", () => {
    const file = path.join(tempDir, "lossless-claw-test.log");
    const { logger, runtimeLogger } = createRuntimeLogger(file, { shouldLogVerbose: true });

    logger.debug("[lcm] visible debug detail");

    expect(runtimeLogger.debug).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, "utf8")).toContain("[lcm] visible debug detail");
  });

  it("applies OpenClaw custom redaction patterns to independent logs", () => {
    const file = path.join(tempDir, "lossless-claw-test.log");
    const customSecret = "tenant-secret-12345";
    const { logger } = createRuntimeLogger(file, {
      runtimeConfig: {
        logging: {
          redactPatterns: ["/tenant-secret-[0-9]+/g"],
        },
      },
    });

    logger.info(`[lcm] saw ${customSecret}`);

    const logText = fs.readFileSync(file, "utf8");
    expect(logText).toContain("[REDACTED]");
    expect(logText).not.toContain(customSecret);
  });

  it("falls back to OpenClaw logging when the independent file target is invalid", () => {
    const directoryTarget = path.join(tempDir, "not-a-file");
    fs.mkdirSync(directoryTarget);
    const { logger, runtimeLogger } = createRuntimeLogger(directoryTarget);

    logger.info("[lcm] routine fallback for invalid file target");

    expect(runtimeLogger.info).toHaveBeenCalledWith("[lcm] routine fallback for invalid file target");
  });

  it("falls back to OpenClaw logging when independent logging is disabled", () => {
    const file = path.join(tempDir, "lossless-claw-test.log");
    const runtimeLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const logger = createLcmLogger({
      runtime: {
        logging: {
          getChildLogger: vi.fn(() => runtimeLogger),
        },
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    } as never, baseConfig(file, false));

    logger.info("[lcm] routine fallback");

    expect(runtimeLogger.info).toHaveBeenCalledWith("[lcm] routine fallback");
    expect(fs.existsSync(file)).toBe(false);
  });
});
