/**
 * Tests for the sessionOperationQueues refCount-based cleanup in LcmContextEngine.
 *
 * These tests exercise the production queue implementation via private access
 * so regressions in src/engine.ts are caught directly.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LcmConfig } from "../src/db/config.js";
import { closeLcmConnection, createLcmDatabaseConnection } from "../src/db/connection.js";
import { LcmContextEngine } from "../src/engine.js";
import type { LcmDependencies } from "../src/types.js";

type SessionQueueEntry = { promise: Promise<void>; refCount: number };
type QueueTestEngine = LcmContextEngine & {
  sessionOperationQueues: Map<string, SessionQueueEntry>;
  withSessionQueue<T>(queueKey: string, operation: () => Promise<T>): Promise<T>;
};

const tempDirs: string[] = [];
const dbs: ReturnType<typeof createLcmDatabaseConnection>[] = [];

function createTestConfig(databasePath: string): LcmConfig {
  return {
    enabled: true,
    databasePath,
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
    maxExpandTokens: 4000,
    largeFileTokenThreshold: 25_000,
    summaryProvider: "",
    summaryModel: "",
    largeFileSummaryProvider: "",
    largeFileSummaryModel: "",
    autocompactDisabled: false,
    timezone: "UTC",
    pruneHeartbeatOk: false,
    summaryMaxOverageFactor: 3,
  };
}

function createTestDeps(config: LcmConfig): LcmDependencies {
  return {
    config,
    complete: vi.fn(async () => ({
      content: [{ type: "text", text: "summary output" }],
    })),
    callGateway: vi.fn(async () => ({})),
    resolveModel: vi.fn(() => ({ provider: "anthropic", model: "claude-opus-4-5" })),
    getApiKey: vi.fn(async () => process.env.ANTHROPIC_API_KEY),
    requireApiKey: vi.fn(async () => process.env.ANTHROPIC_API_KEY ?? "test-api-key"),
    parseAgentSessionKey: () => null,
    isSubagentSessionKey: () => false,
    normalizeAgentId: (id?: string) => (id?.trim() ? id : "main"),
    buildSubagentSystemPrompt: () => "subagent prompt",
    readLatestAssistantReply: () => undefined,
    resolveAgentDir: () => process.env.HOME ?? tmpdir(),
    resolveSessionIdFromSessionKey: async () => undefined,
    agentLaneSubagent: "subagent",
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

function createQueueTestEngine(): QueueTestEngine {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-session-queue-"));
  tempDirs.push(tempDir);
  const config = createTestConfig(join(tempDir, "lcm.db"));
  const db = createLcmDatabaseConnection(config.databasePath);
  dbs.push(db);
  return new LcmContextEngine(createTestDeps(config), db) as QueueTestEngine;
}

afterEach(() => {
  for (const db of dbs.splice(0)) {
    closeLcmConnection(db);
  }
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("withSessionQueue — refCount cleanup", () => {
  let engine: QueueTestEngine;

  beforeEach(() => {
    engine = createQueueTestEngine();
  });

  it("should serialize operations for the same session", async () => {
    const order: number[] = [];
    const op1 = engine.withSessionQueue("s1", async () => {
      await delay(50);
      order.push(1);
    });
    const op2 = engine.withSessionQueue("s1", async () => {
      order.push(2);
    });
    await Promise.all([op1, op2]);
    expect(order).toEqual([1, 2]);
  });

  it("should allow independent sessions to run concurrently", async () => {
    const order: string[] = [];
    const op1 = engine.withSessionQueue("s1", async () => {
      await delay(50);
      order.push("s1");
    });
    const op2 = engine.withSessionQueue("s2", async () => {
      order.push("s2");
    });
    await Promise.all([op1, op2]);
    expect(order).toEqual(["s2", "s1"]);
    expect(engine.sessionOperationQueues.size).toBe(0);
  });

  it("should clean up Map entry after single operation completes", async () => {
    await engine.withSessionQueue("s1", async () => {});
    expect(engine.sessionOperationQueues.size).toBe(0);
  });

  it("should clean up Map entry after all concurrent operations complete", async () => {
    const op1 = engine.withSessionQueue("s1", async () => {
      await delay(50);
    });
    const op2 = engine.withSessionQueue("s1", async () => {
      await delay(10);
    });
    const op3 = engine.withSessionQueue("s1", async () => {});

    expect(engine.sessionOperationQueues.has("s1")).toBe(true);

    await Promise.all([op1, op2, op3]);
    expect(engine.sessionOperationQueues.size).toBe(0);
  });

  it("should clean up Map entry even when operation throws", async () => {
    await expect(
      engine.withSessionQueue("s1", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(engine.sessionOperationQueues.size).toBe(0);
  });

  it("should not block successor when predecessor throws", async () => {
    const order: number[] = [];
    const op1 = engine.withSessionQueue("s1", async () => {
      order.push(1);
      throw new Error("fail");
    });
    const op2 = engine.withSessionQueue("s1", async () => {
      order.push(2);
      return 42;
    });

    await expect(op1).rejects.toThrow("fail");
    const result = await op2;
    expect(result).toBe(42);
    expect(order).toEqual([1, 2]);
    expect(engine.sessionOperationQueues.size).toBe(0);
  });

  it("should not leak entries across many unique sessions", async () => {
    const promises = Array.from({ length: 1000 }, (_, i) =>
      engine.withSessionQueue(`session-${i}`, async () => {}),
    );
    await Promise.all(promises);
    expect(engine.sessionOperationQueues.size).toBe(0);
  });

  it("should not leak after many sequential operations on same session", async () => {
    for (let i = 0; i < 100; i++) {
      await engine.withSessionQueue("s1", async () => {});
    }
    expect(engine.sessionOperationQueues.size).toBe(0);
  });

  it("should handle operation starting during predecessor's cleanup window", async () => {
    let resolveA!: () => void;
    const opA = engine.withSessionQueue("s1", async () => {
      await new Promise<void>((r) => {
        resolveA = r;
      });
    });

    await delay(1);

    const opB = engine.withSessionQueue("s1", async () => {
      return "B-done";
    });

    const entry = engine.sessionOperationQueues.get("s1");
    expect(entry).toBeDefined();
    expect(entry!.refCount).toBe(2);

    resolveA();

    await opA;
    const entryAfterA = engine.sessionOperationQueues.get("s1");
    expect(entryAfterA).toBeDefined();
    expect(entryAfterA!.refCount).toBe(1);

    const resultB = await opB;
    expect(resultB).toBe("B-done");

    expect(engine.sessionOperationQueues.size).toBe(0);
  });

  it("should handle interleaved ops where middle one throws", async () => {
    let resolveA!: () => void;
    const opA = engine.withSessionQueue("s1", async () => {
      await new Promise<void>((r) => {
        resolveA = r;
      });
      return "A";
    });

    await delay(1);

    const opB = engine.withSessionQueue("s1", async () => {
      throw new Error("B-fail");
    });

    const opC = engine.withSessionQueue("s1", async () => {
      return "C";
    });

    expect(engine.sessionOperationQueues.get("s1")!.refCount).toBe(3);

    resolveA();

    const resultA = await opA;
    expect(resultA).toBe("A");
    await expect(opB).rejects.toThrow("B-fail");
    const resultC = await opC;
    expect(resultC).toBe("C");

    expect(engine.sessionOperationQueues.size).toBe(0);
  });

  it("should preserve return values through the queue", async () => {
    const result = await engine.withSessionQueue("s1", async () => {
      return { data: [1, 2, 3], status: "ok" };
    });
    expect(result).toEqual({ data: [1, 2, 3], status: "ok" });
  });

  it("should handle rapid-fire concurrent operations on the same session", async () => {
    const results: number[] = [];
    const ops = Array.from({ length: 50 }, (_, i) =>
      engine.withSessionQueue("s1", async () => {
        results.push(i);
        return i;
      }),
    );

    const returned = await Promise.all(ops);
    expect(results).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(returned).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(engine.sessionOperationQueues.size).toBe(0);
  });

  it("should clean up all entries when multiple sessions complete simultaneously", async () => {
    const ops = Array.from({ length: 20 }, (_, i) =>
      engine.withSessionQueue(`session-${i}`, async () => {
        await delay(Math.random() * 10);
      }),
    );
    await Promise.all(ops);
    expect(engine.sessionOperationQueues.size).toBe(0);
  });
});
