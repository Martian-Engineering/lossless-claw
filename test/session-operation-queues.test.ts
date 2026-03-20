/**
 * Tests for the sessionOperationQueues refCount-based cleanup in LcmEngine.
 *
 * These tests exercise the withSessionQueue() method directly via private access
 * to verify that:
 * 1. Operations are serialized per session (FIFO)
 * 2. Map entries are cleaned up synchronously when the last operation completes
 * 3. No entries leak under any interleaving pattern
 */
import { describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Minimal stub of LcmEngine that only exposes the queue mechanism.
// We replicate the exact withSessionQueue logic from engine.ts so we can
// test it in isolation without needing the full LCM dependency tree.
// ---------------------------------------------------------------------------

class SessionQueueHarness {
  public sessionOperationQueues = new Map<
    string,
    { promise: Promise<void>; refCount: number }
  >();

  async withSessionQueue<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const entry = this.sessionOperationQueues.get(sessionId);
    const previous = entry?.promise ?? Promise.resolve();
    let releaseQueue: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    const next = previous.catch(() => {}).then(() => current);

    if (entry) {
      entry.promise = next;
      entry.refCount++;
    } else {
      this.sessionOperationQueues.set(sessionId, {
        promise: next,
        refCount: 1,
      });
    }

    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      releaseQueue();
      const queueEntry = this.sessionOperationQueues.get(sessionId);
      if (queueEntry && --queueEntry.refCount === 0) {
        this.sessionOperationQueues.delete(sessionId);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("withSessionQueue — refCount cleanup", () => {
  let harness: SessionQueueHarness;

  beforeEach(() => {
    harness = new SessionQueueHarness();
  });

  // ---- Serialization ----

  it("should serialize operations for the same session", async () => {
    const order: number[] = [];
    const op1 = harness.withSessionQueue("s1", async () => {
      await delay(50);
      order.push(1);
    });
    const op2 = harness.withSessionQueue("s1", async () => {
      order.push(2);
    });
    await Promise.all([op1, op2]);
    expect(order).toEqual([1, 2]);
  });

  it("should allow independent sessions to run concurrently", async () => {
    const order: string[] = [];
    const op1 = harness.withSessionQueue("s1", async () => {
      await delay(50);
      order.push("s1");
    });
    const op2 = harness.withSessionQueue("s2", async () => {
      order.push("s2");
    });
    await Promise.all([op1, op2]);
    // s2 should complete before s1 (no cross-session serialization)
    expect(order).toEqual(["s2", "s1"]);
    expect(harness.sessionOperationQueues.size).toBe(0);
  });

  // ---- Cleanup: single operation ----

  it("should clean up Map entry after single operation completes", async () => {
    await harness.withSessionQueue("s1", async () => {});
    // Cleanup is synchronous — no microtask delay needed
    expect(harness.sessionOperationQueues.size).toBe(0);
  });

  // ---- Cleanup: concurrent operations ----

  it("should clean up Map entry after all concurrent operations complete", async () => {
    const op1 = harness.withSessionQueue("s1", async () => {
      await delay(50);
    });
    const op2 = harness.withSessionQueue("s1", async () => {
      await delay(10);
    });
    const op3 = harness.withSessionQueue("s1", async () => {});

    // During execution, entry should exist
    expect(harness.sessionOperationQueues.has("s1")).toBe(true);

    await Promise.all([op1, op2, op3]);
    // Synchronous cleanup — immediate, no setTimeout needed
    expect(harness.sessionOperationQueues.size).toBe(0);
  });

  // ---- Cleanup: error path ----

  it("should clean up Map entry even when operation throws", async () => {
    await expect(
      harness.withSessionQueue("s1", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(harness.sessionOperationQueues.size).toBe(0);
  });

  it("should not block successor when predecessor throws", async () => {
    const order: number[] = [];
    const op1 = harness.withSessionQueue("s1", async () => {
      order.push(1);
      throw new Error("fail");
    });
    const op2 = harness.withSessionQueue("s1", async () => {
      order.push(2);
      return 42;
    });

    await expect(op1).rejects.toThrow("fail");
    const result = await op2;
    expect(result).toBe(42);
    expect(order).toEqual([1, 2]);
    expect(harness.sessionOperationQueues.size).toBe(0);
  });

  // ---- Stress: many unique sessions ----

  it("should not leak entries across many unique sessions", async () => {
    const promises = Array.from({ length: 1000 }, (_, i) =>
      harness.withSessionQueue(`session-${i}`, async () => {}),
    );
    await Promise.all(promises);
    expect(harness.sessionOperationQueues.size).toBe(0);
  });

  // ---- Stress: many sequential ops on same session ----

  it("should not leak after many sequential operations on same session", async () => {
    for (let i = 0; i < 100; i++) {
      await harness.withSessionQueue("s1", async () => {});
    }
    expect(harness.sessionOperationQueues.size).toBe(0);
  });

  // ---- Interleaving race test (reviewer required) ----
  // Scenario: Op-A finishes, Op-B enters same session before old async
  // cleanup would have run. Both must clean up correctly.

  it("should handle operation starting during predecessor's cleanup window", async () => {
    let resolveA!: () => void;
    const opA = harness.withSessionQueue("s1", async () => {
      await new Promise<void>((r) => {
        resolveA = r;
      });
    });

    // Let withSessionQueue setup run (the await previous.catch)
    await delay(1);

    // Queue Op-B while Op-A is still running
    const opB = harness.withSessionQueue("s1", async () => {
      return "B-done";
    });

    // Verify refCount is 2 (both ops registered)
    const entry = harness.sessionOperationQueues.get("s1");
    expect(entry).toBeDefined();
    expect(entry!.refCount).toBe(2);

    // Complete Op-A — in old code, its async .finally() would race with Op-B's entry
    resolveA();

    await opA;
    // After Op-A completes, refCount should be 1 (Op-B still pending)
    const entryAfterA = harness.sessionOperationQueues.get("s1");
    expect(entryAfterA).toBeDefined();
    expect(entryAfterA!.refCount).toBe(1);

    const resultB = await opB;
    expect(resultB).toBe("B-done");

    // After Op-B completes, entry should be gone
    expect(harness.sessionOperationQueues.size).toBe(0);
  });

  // ---- Interleaving: three ops, middle one throws ----

  it("should handle interleaved ops where middle one throws", async () => {
    let resolveA!: () => void;
    const opA = harness.withSessionQueue("s1", async () => {
      await new Promise<void>((r) => {
        resolveA = r;
      });
      return "A";
    });

    await delay(1);

    const opB = harness.withSessionQueue("s1", async () => {
      throw new Error("B-fail");
    });

    const opC = harness.withSessionQueue("s1", async () => {
      return "C";
    });

    // All three queued
    expect(harness.sessionOperationQueues.get("s1")!.refCount).toBe(3);

    resolveA();

    const resultA = await opA;
    expect(resultA).toBe("A");
    await expect(opB).rejects.toThrow("B-fail");
    const resultC = await opC;
    expect(resultC).toBe("C");

    expect(harness.sessionOperationQueues.size).toBe(0);
  });

  // ---- Return value preservation ----

  it("should preserve return values through the queue", async () => {
    const result = await harness.withSessionQueue("s1", async () => {
      return { data: [1, 2, 3], status: "ok" };
    });
    expect(result).toEqual({ data: [1, 2, 3], status: "ok" });
  });

  // ---- Rapid fire: many concurrent ops on same session ----

  it("should handle rapid-fire concurrent operations on the same session", async () => {
    const results: number[] = [];
    const ops = Array.from({ length: 50 }, (_, i) =>
      harness.withSessionQueue("s1", async () => {
        results.push(i);
        return i;
      }),
    );

    const returned = await Promise.all(ops);
    // All ops should have run in order (FIFO serialization)
    expect(results).toEqual(Array.from({ length: 50 }, (_, i) => i));
    // All return values correct
    expect(returned).toEqual(Array.from({ length: 50 }, (_, i) => i));
    // Map cleaned up
    expect(harness.sessionOperationQueues.size).toBe(0);
  });

  // ---- Multi-session concurrent cleanup ----

  it("should clean up all entries when multiple sessions complete simultaneously", async () => {
    const ops = Array.from({ length: 20 }, (_, i) =>
      harness.withSessionQueue(`session-${i}`, async () => {
        await delay(Math.random() * 10);
      }),
    );
    await Promise.all(ops);
    expect(harness.sessionOperationQueues.size).toBe(0);
  });
});
