/**
 * Regression tests for summary spend guard policy (lossless-claw-30b.3).
 *
 * Incident: a threshold sweep made real progress (395k -> 288k stored
 * tokens) but hit its per-sweep wall-clock deadline, recorded "compacted
 * but still over target", and opened a 30-minute spend backoff that then
 * blocked emergency drains AND a user-initiated /compact (silent no-op).
 *
 * Policy under test:
 *  - progress-making attempts never open the spend backoff;
 *  - sweeps chain within the operation deadline instead of failing early;
 *  - manual compaction clears an open backoff instead of no-opping.
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
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-spend-"));
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
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-spend-session-"));
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

const thresholdEvaluation = {
  shouldCompact: true,
  reason: "over threshold",
  currentTokens: 5_000,
  storedTokens: 5_000,
  threshold: 3_000,
};

describe("summary spend guard policy", () => {
  it("manual compaction clears an open spend backoff and proceeds", async () => {
    const { engine, log } = createEngine();
    const sessionId = "spend-manual-bypass";
    await seedConversation(engine, sessionId);

    const internals = privateEngine(engine);
    const scopeKey = spendScopeKey(engine, sessionId);
    engine.getCompactionGuards().openSummarySpendBackoff({ scopeKey, reason: "earlier automatic failure" });
    expect(engine.getCompactionGuards().getSummarySpendBackoffUntil(scopeKey)).not.toBeNull();

    vi.spyOn(internals.compaction, "evaluate").mockResolvedValue(thresholdEvaluation);
    const compactSpy = vi.spyOn(internals.compaction, "compact").mockResolvedValue({
      actionTaken: true,
      tokensBefore: 5_000,
      tokensAfter: 1_000,
    });

    const result = await engine.compact({
      sessionId,
      sessionFile: createSessionFile("spend-manual-bypass"),
      tokenBudget: 4_096,
      runtimeContext: { manualCompaction: true },
    });

    expect(result.reason).not.toBe("summary spend backoff open");
    expect(result.compacted).toBe(true);
    expect(compactSpy).toHaveBeenCalled();
    expect(engine.getCompactionGuards().getSummarySpendBackoffUntil(scopeKey)).toBeNull();
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("manual request cleared summary spend backoff"),
    );
  });

  it("does not open the spend backoff when a deadline-bounded sweep is still progressing", async () => {
    // Tiny chain deadline: the first sweep "runs out of time" while making
    // real progress, exactly like the production deadline-partial.
    const { engine, log } = createEngine({ compactUntilUnderDeadlineMs: 1 });
    const sessionId = "spend-progressing-no-backoff";
    await seedConversation(engine, sessionId);

    const internals = privateEngine(engine);
    vi.spyOn(internals.compaction, "evaluate").mockResolvedValue(thresholdEvaluation);
    vi.spyOn(internals.compaction, "compact").mockImplementation(async () => {
      // Outlast the 1ms chain deadline so the loop deterministically stops
      // after this progress-making round.
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        actionTaken: true,
        tokensBefore: 5_000,
        tokensAfter: 4_200,
      };
    });

    const result = await engine.compact({
      sessionId,
      sessionFile: createSessionFile("spend-progressing"),
      tokenBudget: 4_096,
      currentTokenCount: 5_000,
      compactionTarget: "threshold",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("compacted but still over target");
    expect(engine.getCompactionGuards().getSummarySpendBackoffUntil(spendScopeKey(engine, sessionId))).toBeNull();
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("spend backoff skipped"),
    );
  });

  it("opens the spend backoff when the sweep chain stalls without progress", async () => {
    const { engine } = createEngine();
    const sessionId = "spend-stalled-backoff";
    await seedConversation(engine, sessionId);

    const internals = privateEngine(engine);
    vi.spyOn(internals.compaction, "evaluate").mockResolvedValue(thresholdEvaluation);
    vi.spyOn(internals.compaction, "compact")
      .mockResolvedValueOnce({ actionTaken: true, tokensBefore: 5_000, tokensAfter: 4_500 })
      .mockResolvedValue({ actionTaken: true, tokensBefore: 4_500, tokensAfter: 4_500 });

    const result = await engine.compact({
      sessionId,
      sessionFile: createSessionFile("spend-stalled"),
      tokenBudget: 4_096,
      currentTokenCount: 5_000,
      compactionTarget: "threshold",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("compacted but still over target");
    expect(engine.getCompactionGuards().getSummarySpendBackoffUntil(spendScopeKey(engine, sessionId))).not.toBeNull();
  });

  it("chains threshold sweeps until the target is reached", async () => {
    const { engine } = createEngine();
    const sessionId = "spend-chained-success";
    await seedConversation(engine, sessionId);

    const internals = privateEngine(engine);
    vi.spyOn(internals.compaction, "evaluate").mockResolvedValue(thresholdEvaluation);
    const compactSpy = vi
      .spyOn(internals.compaction, "compact")
      .mockResolvedValueOnce({ actionTaken: true, tokensBefore: 5_000, tokensAfter: 4_500 })
      .mockResolvedValueOnce({ actionTaken: true, tokensBefore: 4_500, tokensAfter: 3_600 })
      .mockResolvedValueOnce({ actionTaken: true, tokensBefore: 3_600, tokensAfter: 2_800 });

    const result = await engine.compact({
      sessionId,
      sessionFile: createSessionFile("spend-chained"),
      tokenBudget: 4_096,
      currentTokenCount: 5_000,
      compactionTarget: "threshold",
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("compacted");
    expect(compactSpy).toHaveBeenCalledTimes(3);
    expect(result.result?.details?.rounds).toBe(3);
    expect(engine.getCompactionGuards().getSummarySpendBackoffUntil(spendScopeKey(engine, sessionId))).toBeNull();
  });

});
