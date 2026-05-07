import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { WorkerLoop } from "../src/concurrency/worker-loop.js";

function newDb(): DatabaseSync {
  return new DatabaseSync(":memory:");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("worker-loop — basic lifecycle", () => {
  it("start() returns true on first call, false on already-running", () => {
    const db = newDb();
    const loop = new WorkerLoop(db, {
      jobs: [{ kind: "embedding-backfill", intervalMs: 1000, run: async () => null }],
    });
    expect(loop.start()).toBe(true);
    expect(loop.start()).toBe(false); // already running
    expect(loop.isRunning()).toBe(true);
    return loop.stop();
  });

  it("stop() before start is a no-op (returns true)", async () => {
    const db = newDb();
    const loop = new WorkerLoop(db, {
      jobs: [{ kind: "embedding-backfill", intervalMs: 1000, run: async () => null }],
    });
    expect(await loop.stop()).toBe(true);
  });
});

describe("worker-loop — schedules jobs at their cadence", () => {
  it("invokes job.run() repeatedly at the interval", async () => {
    const db = newDb();
    let count = 0;
    const loop = new WorkerLoop(db, {
      jobs: [
        {
          kind: "embedding-backfill",
          intervalMs: 30,
          run: async () => {
            count++;
            return count;
          },
        },
      ],
    });
    loop.start();
    await sleep(120);
    await loop.stop();
    expect(count).toBeGreaterThanOrEqual(2); // ~3-4 ticks in 120ms
  });

  it("two jobs with different intervals don't interfere", async () => {
    const db = newDb();
    let aCount = 0;
    let bCount = 0;
    const loop = new WorkerLoop(db, {
      jobs: [
        { kind: "embedding-backfill", intervalMs: 30, run: async () => aCount++ },
        { kind: "extraction", intervalMs: 60, run: async () => bCount++ },
      ],
    });
    loop.start();
    await sleep(150);
    await loop.stop();
    expect(aCount).toBeGreaterThanOrEqual(3); // 30ms cadence
    expect(bCount).toBeGreaterThanOrEqual(1); // 60ms cadence
    expect(aCount).toBeGreaterThan(bCount); // a runs more often
  });
});

describe("worker-loop — overlapping ticks are skipped", () => {
  it("if a job's run() takes longer than intervalMs, next tick is skipped (not queued)", async () => {
    const db = newDb();
    let starts = 0;
    let completions = 0;
    const loop = new WorkerLoop(db, {
      jobs: [
        {
          kind: "embedding-backfill",
          intervalMs: 20,
          run: async () => {
            starts++;
            await sleep(80); // exceeds 20ms cadence
            completions++;
          },
        },
      ],
    });
    loop.start();
    await sleep(150);
    await loop.stop({ gracefulTimeoutMs: 200 });
    // We saw maybe 2-3 starts (one running through 80ms each) — never
    // more than 2 simultaneous because dispatcher skips when in-flight.
    expect(starts).toBeLessThanOrEqual(3);
    // If overlap-protection failed, starts >> completions; with it, parity.
    expect(completions).toBeGreaterThanOrEqual(starts - 1);
  });
});

describe("worker-loop — error in job doesn't stop the loop", () => {
  it("thrown error is captured in onJobComplete; subsequent ticks still run", async () => {
    const db = newDb();
    let runs = 0;
    const errors: Array<unknown> = [];
    const loop = new WorkerLoop(db, {
      jobs: [
        {
          kind: "embedding-backfill",
          intervalMs: 20,
          run: async () => {
            runs++;
            if (runs === 1) throw new Error("boom!");
            return runs;
          },
        },
      ],
      onJobComplete: (info) => {
        if (info.error) errors.push(info.error);
      },
    });
    loop.start();
    await sleep(80);
    await loop.stop();
    expect(runs).toBeGreaterThanOrEqual(2); // first errored, second+ ran
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("boom!");
  });
});

describe("worker-loop — graceful stop", () => {
  it("waits for in-flight tick to complete before resolving", async () => {
    const db = newDb();
    let completed = false;
    const loop = new WorkerLoop(db, {
      jobs: [
        {
          kind: "embedding-backfill",
          intervalMs: 10,
          run: async () => {
            await sleep(60);
            completed = true;
          },
        },
      ],
    });
    loop.start();
    await sleep(15); // let one tick start
    expect(loop.inFlightCount()).toBe(1);
    const stopped = await loop.stop({ gracefulTimeoutMs: 200 });
    expect(stopped).toBe(true);
    expect(completed).toBe(true);
  });

  it("returns false on graceful timeout if a tick is too slow", async () => {
    const db = newDb();
    const loop = new WorkerLoop(db, {
      jobs: [
        {
          kind: "embedding-backfill",
          intervalMs: 10,
          run: async () => {
            await sleep(500); // longer than gracefulTimeoutMs
          },
        },
      ],
    });
    loop.start();
    await sleep(15);
    const stopped = await loop.stop({ gracefulTimeoutMs: 50 });
    expect(stopped).toBe(false); // timeout
  });
});

describe("worker-loop — runOnce", () => {
  it("invokes job once outside schedule, returns its result", async () => {
    const db = newDb();
    let count = 0;
    const loop = new WorkerLoop(db, {
      jobs: [
        {
          kind: "embedding-backfill",
          intervalMs: 60_000, // far enough away that scheduled ticks won't fire
          run: async () => ++count,
        },
      ],
    });
    const result = await loop.runOnce("embedding-backfill");
    expect(result).toBe(1);
    expect(count).toBe(1);
  });

  it("runOnce throws if job kind unknown", async () => {
    const db = newDb();
    const loop = new WorkerLoop(db, {
      jobs: [{ kind: "embedding-backfill", intervalMs: 1000, run: async () => null }],
    });
    await expect(loop.runOnce("extraction")).rejects.toThrow(/no job kind/);
  });

  it("runOnce throws if same job is in flight", async () => {
    const db = newDb();
    let resolveBlock: (() => void) | null = null;
    const loop = new WorkerLoop(db, {
      jobs: [
        {
          kind: "embedding-backfill",
          intervalMs: 60_000,
          run: () =>
            new Promise<void>((resolve) => {
              resolveBlock = resolve;
            }),
        },
      ],
    });
    const inflight = loop.runOnce("embedding-backfill");
    // Give the promise time to register in-flight
    await sleep(5);
    await expect(loop.runOnce("embedding-backfill")).rejects.toThrow(/already in flight/);
    resolveBlock?.(); // let the original finish
    await inflight;
  });
});

describe("worker-loop — validates job specs", () => {
  it("rejects duplicate job kinds", () => {
    const db = newDb();
    expect(
      () =>
        new WorkerLoop(db, {
          jobs: [
            { kind: "embedding-backfill", intervalMs: 100, run: async () => null },
            { kind: "embedding-backfill", intervalMs: 200, run: async () => null },
          ],
        }),
    ).toThrow(/duplicate job kind/);
  });

  it("rejects invalid intervalMs", () => {
    const db = newDb();
    expect(
      () =>
        new WorkerLoop(db, {
          jobs: [{ kind: "embedding-backfill", intervalMs: 0, run: async () => null }],
        }),
    ).toThrow(/invalid intervalMs/);
    expect(
      () =>
        new WorkerLoop(db, {
          jobs: [{ kind: "embedding-backfill", intervalMs: -1, run: async () => null }],
        }),
    ).toThrow(/invalid intervalMs/);
  });
});
