/**
 * Regression tests for the transcript-wedge terminal verdict (lossless-claw-30b.4).
 *
 * Incident shape: the host rebuilds prompts from a live transcript the
 * engine cannot shrink. Once stored compaction has no eligible candidates
 * left while host-observed pressure stays over target, retrying can never
 * converge — the failure must be surfaced as an explicit
 * "transcript reset required" verdict (with the exhausted flag clearing
 * deferred debt), not the generic still-over failure that hosts answer
 * with reserve-tuning advice.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { LcmConfig } from "../src/db/config.js";
import { closeLcmConnection, createLcmDatabaseConnection } from "../src/db/connection.js";
import { LcmContextEngine } from "../src/engine.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import type { LcmDependencies } from "../src/types.js";
import { createTestConfig as createSharedTestConfig, createTestDeps as createSharedTestDeps } from "./helpers.js";

const tempDirs: string[] = [];
const engines: LcmContextEngine[] = [];
const dbs: ReturnType<typeof createLcmDatabaseConnection>[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  engines.splice(0);
  for (const db of dbs.splice(0)) {
    try {
      closeLcmConnection(db);
    } catch {
      // best-effort cleanup
    }
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTestConfig(databasePath: string): LcmConfig {
  return createSharedTestConfig(databasePath, { freshTailCount: 4 });
}

function parseAgentSessionKey(sessionKey: string): { agentId: string; suffix: string } | null {
  const trimmed = sessionKey.trim();
  if (!trimmed.startsWith("agent:")) {
    return null;
  }
  const parts = trimmed.split(":");
  if (parts.length < 3) {
    return null;
  }
  return { agentId: parts[1] ?? "main", suffix: parts.slice(2).join(":") };
}

type LogMock = { info: Mock<(msg: string) => void>; warn: Mock<(msg: string) => void>; error: Mock<(msg: string) => void>; debug: Mock<(msg: string) => void> };

function createTestDeps(config: LcmConfig, log: LogMock): LcmDependencies {
  return createSharedTestDeps(config, {
    readLatestAssistantReply: () => undefined,
    resolveAgentDir: () => tmpdir(),
    log,
  });
}

function createEngine(configOverrides?: Partial<LcmConfig>): { engine: LcmContextEngine; log: LogMock } {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-wedge-"));
  tempDirs.push(tempDir);
  const config = { ...createTestConfig(join(tempDir, "lcm.db")), ...configOverrides };
  const db = createLcmDatabaseConnection(config.databasePath);
  dbs.push(db);
  const log: LogMock = {
    info: vi.fn<(msg: string) => void>(),
    warn: vi.fn<(msg: string) => void>(),
    error: vi.fn<(msg: string) => void>(),
    debug: vi.fn<(msg: string) => void>(),
  };
  const engine = new LcmContextEngine(createTestDeps(config, log), db);
  engines.push(engine);
  return { engine, log };
}

function createSessionFile(name: string): string {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-wedge-session-"));
  tempDirs.push(tempDir);
  const file = join(tempDir, `${name}.jsonl`);
  writeFileSync(file, "");
  return file;
}

type PrivateEngine = {
  compaction: {
    evaluate: (...args: unknown[]) => Promise<unknown>;
    compact: (...args: unknown[]) => Promise<unknown>;
    compactUntilUnder: (...args: unknown[]) => Promise<unknown>;
  };
  resolveSessionQueueKey: (sessionId: string, sessionKey?: string) => string;
  compactionGuards: {
    resolveSummarySpendScope: (params: { kind: string; scope: string | undefined }) => string;
    openSummarySpendBackoff: (params: { scopeKey: string; reason: string }) => Date;
    getSummarySpendBackoffUntil: (scopeKey: string) => Date | null;
  };
};

function privateEngine(engine: LcmContextEngine): PrivateEngine {
  return engine as unknown as PrivateEngine;
}

function spendScopeKey(engine: LcmContextEngine, sessionId: string, sessionKey?: string): string {
  const internals = privateEngine(engine);
  return engine.getCompactionGuards().resolveSummarySpendScope({
    kind: "compaction",
    scope: internals.resolveSessionQueueKey(sessionId, sessionKey),
  });
}

async function seedConversation(engine: LcmContextEngine, sessionId: string): Promise<void> {
  await engine.ingest({
    sessionId,
    message: {
      role: "user",
      content: "seed message for compaction tests",
      timestamp: Date.now(),
    } as unknown as AgentMessage,
  });
}

/**
 * Host-observed live tokens (12000) far exceed stored tokens (7000); the
 * sweep finds no eligible candidates (actionTaken=false).
 */
const wedgeEvaluation = {
  shouldCompact: true,
  reason: "threshold",
  storedTokens: 7_000,
  observedTokens: 12_000,
  currentTokens: 12_000,
  threshold: 8_200,
};

const WEDGE_REASON =
  "stored compaction exhausted but live context still exceeds target; transcript reset required";

describe("transcript wedge terminal verdict", () => {
  it("reports transcript reset required when exhaustion has a host-observed count", async () => {
    const { engine, log } = createEngine();
    const sessionId = "wedge-verdict-observed";
    await seedConversation(engine, sessionId);

    const internals = privateEngine(engine);
    vi.spyOn(internals.compaction, "evaluate").mockResolvedValue(wedgeEvaluation);
    const compactSpy = vi.spyOn(internals.compaction, "compact").mockResolvedValue({
      actionTaken: false,
      tokensBefore: 7_000,
      tokensAfter: 7_000,
    });

    const result = await engine.compact({
      sessionId,
      sessionFile: createSessionFile("wedge-verdict-observed"),
      tokenBudget: 10_000,
      currentTokenCount: 12_000,
      compactionTarget: "threshold",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe(WEDGE_REASON);
    expect((result as { exhausted?: boolean }).exhausted).toBe(true);
    expect(compactSpy).toHaveBeenCalledTimes(1);
    // Terminal verdict: no spend backoff — throttling a non-retryable state
    // only blocks a later manual repair attempt.
    expect(engine.getCompactionGuards().getSummarySpendBackoffUntil(spendScopeKey(engine, sessionId))).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("transcript wedge detected"),
    );
  });

  it("keeps the generic failure when the sweep merely stopped at its budget", async () => {
    const { engine, log } = createEngine();
    const sessionId = "wedge-verdict-budget-stop";
    await seedConversation(engine, sessionId);

    const internals = privateEngine(engine);
    vi.spyOn(internals.compaction, "evaluate").mockResolvedValue(wedgeEvaluation);
    vi.spyOn(internals.compaction, "compact").mockResolvedValue({
      actionTaken: false,
      tokensBefore: 7_000,
      tokensAfter: 7_000,
      stoppedAtBudget: true,
    });

    const result = await engine.compact({
      sessionId,
      sessionFile: createSessionFile("wedge-verdict-budget-stop"),
      tokenBudget: 10_000,
      currentTokenCount: 12_000,
      compactionTarget: "threshold",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("live context still exceeds target");
    expect((result as { exhausted?: boolean }).exhausted).toBeUndefined();
    expect(log.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("transcript wedge detected"),
    );
  });

  it("clears deferred debt when the drain hits the wedge verdict", async () => {
    const { engine, log } = createEngine();
    const sessionId = "wedge-verdict-drain";
    await seedConversation(engine, sessionId);
    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(sessionId);
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation!.conversationId,
      reason: "threshold",
      tokenBudget: 10_000,
      currentTokenCount: 12_000,
    });

    const internals = privateEngine(engine);
    vi.spyOn(internals.compaction, "evaluate").mockResolvedValue(wedgeEvaluation);
    vi.spyOn(internals.compaction, "compact").mockResolvedValue({
      actionTaken: false,
      tokensBefore: 7_000,
      tokensAfter: 7_000,
    });

    const result = await engine.maintain({
      sessionId,
      sessionFile: createSessionFile("wedge-verdict-drain"),
      runtimeContext: {
        allowDeferredCompactionExecution: true,
        tokenBudget: 10_000,
        currentTokenCount: 12_000,
      },
    });

    expect(result.reason).toBe(WEDGE_REASON);
    expect((result as { exhausted?: boolean }).exhausted).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("transcript wedge detected"),
    );

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation!.conversationId);
    expect(maintenance?.pending).toBe(false);
    expect(maintenance?.running).toBe(false);
  });
});
