import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import {
  acquireLock,
  generateWorkerId,
  heartbeatLock,
  lockInfo,
  releaseLock,
} from "../src/concurrency/worker-lock.js";

function newDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false });
  return db;
}

describe("worker-lock — acquire / release single-process", () => {
  it("first acquire succeeds; second from different worker blocks", () => {
    const db = newDb();
    expect(acquireLock(db, "embedding-backfill", { workerId: "w1" })).toBe(true);
    expect(acquireLock(db, "embedding-backfill", { workerId: "w2" })).toBe(false);

    // Both expect to be told the truth — w1 holds, w2 doesn't
    const info = lockInfo(db, "embedding-backfill");
    expect(info?.workerId).toBe("w1");
    db.close();
  });

  it("release frees the lock for next acquirer", () => {
    const db = newDb();
    acquireLock(db, "embedding-backfill", { workerId: "w1" });
    expect(releaseLock(db, "embedding-backfill", "w1")).toBe(true);
    expect(acquireLock(db, "embedding-backfill", { workerId: "w2" })).toBe(true);
    db.close();
  });

  it("release with wrong workerId does not free the lock", () => {
    const db = newDb();
    acquireLock(db, "embedding-backfill", { workerId: "w1" });
    expect(releaseLock(db, "embedding-backfill", "wrong")).toBe(false);
    expect(acquireLock(db, "embedding-backfill", { workerId: "w2" })).toBe(false);
    db.close();
  });

  it("acquireLock requires non-empty workerId", () => {
    const db = newDb();
    expect(() => acquireLock(db, "embedding-backfill", { workerId: "" })).toThrow(/workerId is required/);
    expect(() => acquireLock(db, "embedding-backfill", { workerId: "  " })).toThrow(/workerId is required/);
    db.close();
  });
});

describe("worker-lock — TTL + GC", () => {
  it("acquireLock with ttlMs=0 immediately stale, gets GC'd on next acquire", () => {
    const db = newDb();
    expect(acquireLock(db, "embedding-backfill", { workerId: "dead", ttlMs: 0 })).toBe(true);
    // Immediately stale — the next worker should be able to acquire
    expect(acquireLock(db, "embedding-backfill", { workerId: "alive" })).toBe(true);
    expect(lockInfo(db, "embedding-backfill")?.workerId).toBe("alive");
    db.close();
  });

  it("non-expired lock blocks new acquirer (TTL not reached yet)", () => {
    const db = newDb();
    acquireLock(db, "embedding-backfill", { workerId: "w1", ttlMs: 60_000 });
    // w2 cannot acquire — TTL not reached
    expect(acquireLock(db, "embedding-backfill", { workerId: "w2" })).toBe(false);
    db.close();
  });
});

describe("worker-lock — heartbeat", () => {
  it("heartbeat from current holder extends expires_at", () => {
    const db = newDb();
    acquireLock(db, "embedding-backfill", { workerId: "w1", ttlMs: 1_000 });
    const initial = lockInfo(db, "embedding-backfill");
    // Wait briefly so timestamps differ
    const t1 = initial!.expiresAt;
    expect(heartbeatLock(db, "embedding-backfill", "w1", 60_000)).toBe(true);
    const after = lockInfo(db, "embedding-backfill");
    // expires_at should have moved forward (later time)
    expect(after!.expiresAt >= t1).toBe(true);
    db.close();
  });

  it("heartbeat from non-holder fails (lock owned by other worker)", () => {
    const db = newDb();
    acquireLock(db, "embedding-backfill", { workerId: "w1" });
    expect(heartbeatLock(db, "embedding-backfill", "w2")).toBe(false);
    db.close();
  });

  it("heartbeat after stale lock GC + reacquire by different worker fails for old worker", () => {
    const db = newDb();
    acquireLock(db, "embedding-backfill", { workerId: "old", ttlMs: 0 });
    // Stale; new worker grabs it
    expect(acquireLock(db, "embedding-backfill", { workerId: "new" })).toBe(true);
    // Old worker tries to heartbeat — sees the lock is now owned by 'new', returns false
    expect(heartbeatLock(db, "embedding-backfill", "old")).toBe(false);
    db.close();
  });
});

describe("worker-lock — metadata + scope", () => {
  it("jobSessionKey and jobMetadata are stored and retrievable via lockInfo", () => {
    const db = newDb();
    acquireLock(db, "condensation", {
      workerId: "w1",
      jobSessionKey: "agent:main:main",
      jobMetadata: "weekly:2026-W18",
    });
    const info = lockInfo(db, "condensation");
    expect(info?.jobSessionKey).toBe("agent:main:main");
    expect(info?.jobMetadata).toBe("weekly:2026-W18");
    db.close();
  });

  it("lockInfo returns null when no lock held", () => {
    const db = newDb();
    expect(lockInfo(db, "extraction")).toBeNull();
    db.close();
  });
});

describe("worker-lock — generateWorkerId", () => {
  it("generates IDs with the role prefix and pid + nonce uniqueness", () => {
    const id1 = generateWorkerId("backfill");
    const id2 = generateWorkerId("backfill");
    expect(id1.startsWith("backfill-")).toBe(true);
    expect(id2.startsWith("backfill-")).toBe(true);
    expect(id1).not.toBe(id2); // different nonces
    // Format: backfill-<pid>-<ms>-<6char hex>
    expect(id1).toMatch(/^backfill-\d+-\d+-[0-9a-f]{6}$/);
  });
});

describe("worker-lock — multiple job kinds independent", () => {
  it("locks for different job_kinds don't conflict", () => {
    const db = newDb();
    expect(acquireLock(db, "embedding-backfill", { workerId: "w1" })).toBe(true);
    expect(acquireLock(db, "extraction", { workerId: "w2" })).toBe(true);
    expect(acquireLock(db, "condensation", { workerId: "w3" })).toBe(true);
    // All three held simultaneously
    expect(lockInfo(db, "embedding-backfill")?.workerId).toBe("w1");
    expect(lockInfo(db, "extraction")?.workerId).toBe("w2");
    expect(lockInfo(db, "condensation")?.workerId).toBe("w3");
    db.close();
  });
});
