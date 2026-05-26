import { existsSync } from "node:fs";
import { arch, platform } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import {
  acquireLock,
  generateWorkerId,
} from "../src/concurrency/worker-lock.js";
import {
  forceReleaseLock,
  getWorkerStatusSnapshot,
  heartbeatAllHeldLocks,
  tickExtraction,
} from "../src/operator/worker-orchestrator.js";

const VEC0_PATH =
  process.env.LCM_TEST_VEC0_PATH?.trim() ||
  (() => {
    const realHome = process.env.REAL_HOME?.trim() || "/Users/lume";
    const ext = platform() === "win32" ? "dll" : platform() === "darwin" ? "dylib" : "so";
    const platformPkg = `sqlite-vec-${platform() === "win32" ? "windows" : platform()}-${arch()}`;
    return `${realHome}/.openclaw/extensions/node_modules/${platformPkg}/vec0.${ext}`;
  })();
const VEC0_AVAILABLE = existsSync(VEC0_PATH);

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false });
  db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s1', 'sk1')`).run();
  return db;
}

describe("worker-orchestrator — getWorkerStatusSnapshot", () => {
  it("returns empty locks + extraction count = 0 when no work pending", () => {
    const db = setupDb();
    const snap = getWorkerStatusSnapshot(db);
    expect(snap.locks["embedding-backfill"]).toBeNull();
    expect(snap.locks["extraction"]).toBeNull();
    expect(snap.locks["condensation"]).toBeNull();
    expect(snap.pending.extractionQueue).toBe(0);
    expect(snap.pending.procedureMining).toBe(-1); // not directly queryable
    expect(snap.pending.embeddingBackfill).toBe(-1); // no modelName given
    db.close();
  });

  it("reflects acquired locks in the snapshot", () => {
    const db = setupDb();
    acquireLock(db, "extraction", { workerId: "w1", jobMetadata: "test" });
    const snap = getWorkerStatusSnapshot(db);
    expect(snap.locks["extraction"]?.workerId).toBe("w1");
    expect(snap.locks["extraction"]?.jobMetadata).toBe("test");
    db.close();
  });

  it("counts pending extractions when queue has items", () => {
    const db = setupDb();
    db.prepare(
      `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key)
       VALUES ('leaf_a', 1, 'leaf', 'x', 1, 'sk1')`,
    ).run();
    db.prepare(
      `INSERT INTO lcm_extraction_queue (queue_id, leaf_id, kind, queued_at)
       VALUES ('q1', 'leaf_a', 'entity', datetime('now'))`,
    ).run();
    expect(getWorkerStatusSnapshot(db).pending.extractionQueue).toBe(1);
    db.close();
  });
});

describe("worker-orchestrator — tickExtraction (lock-protected)", () => {
  it("acquires lock, runs extraction, releases lock — happy path", async () => {
    const db = setupDb();
    db.prepare(
      `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key)
       VALUES ('leaf_a', 1, 'leaf', 'x', 1, 'sk1')`,
    ).run();
    db.prepare(
      `INSERT INTO lcm_extraction_queue (queue_id, leaf_id, kind, queued_at)
       VALUES ('q1', 'leaf_a', 'entity', datetime('now'))`,
    ).run();

    const r = await tickExtraction(db, {
      extractor: async () => [{ surface: "thing", entityType: "x" }],
    });
    expect(r.lockAcquired).toBe(true);
    expect(r.processedCount).toBe(1);

    // Lock released after tick
    expect(getWorkerStatusSnapshot(db).locks.extraction).toBeNull();
    db.close();
  });

  it("returns lockAcquired=false + zeros when another worker holds the lock", async () => {
    const db = setupDb();
    acquireLock(db, "extraction", { workerId: "other-worker" });

    let extractorCalled = 0;
    const r = await tickExtraction(db, {
      extractor: async () => {
        extractorCalled++;
        return [];
      },
    });
    expect(r.lockAcquired).toBe(false);
    expect(extractorCalled).toBe(0);
    expect(r.processedCount).toBe(0);
    db.close();
  });

  it("releases lock even if extractor throws on first item", async () => {
    const db = setupDb();
    db.prepare(
      `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key)
       VALUES ('leaf_a', 1, 'leaf', 'x', 1, 'sk1')`,
    ).run();
    db.prepare(
      `INSERT INTO lcm_extraction_queue (queue_id, leaf_id, kind, queued_at)
       VALUES ('q1', 'leaf_a', 'entity', datetime('now'))`,
    ).run();

    const r = await tickExtraction(db, {
      extractor: async () => {
        throw new Error("test");
      },
    });
    expect(r.lockAcquired).toBe(true);
    // Lock released
    expect(getWorkerStatusSnapshot(db).locks.extraction).toBeNull();
    db.close();
  });
});

// tickProcedureMining was REMOVED in first-principles pass (2026-05-06).
// Test preserved in deferred-features draft PR (#616).

describe("worker-orchestrator — forceReleaseLock", () => {
  it("returns true when lock existed; subsequent call returns false", () => {
    const db = setupDb();
    acquireLock(db, "embedding-backfill", { workerId: "stuck-worker" });
    expect(forceReleaseLock(db, "embedding-backfill")).toBe(true);
    expect(forceReleaseLock(db, "embedding-backfill")).toBe(false); // already gone
    expect(getWorkerStatusSnapshot(db).locks["embedding-backfill"]).toBeNull();
    db.close();
  });
});

describe("worker-orchestrator — heartbeatAllHeldLocks", () => {
  it("refreshes only locks whose worker_id matches the supplied map (per-kind status surfaced)", () => {
    const db = setupDb();
    acquireLock(db, "embedding-backfill", { workerId: "wA" });
    acquireLock(db, "extraction", { workerId: "wB" });
    // Wave-4 Auditor #13 P1: returns {refreshed, perKind} so callers can
    // distinguish "we never held it" from "we lost it" per kind.
    const result = heartbeatAllHeldLocks(db, {
      "embedding-backfill": "wA",
      "extraction": "wRONG", // mismatched id — should NOT refresh
    });
    expect(result.refreshed).toBe(1);
    expect(result.perKind["embedding-backfill"]).toBe("ok");
    expect(result.perKind["extraction"]).toBe("lost");
    db.close();
  });

  it("returns refreshed=0 + skipped per-kind when no workerIds supplied", () => {
    const db = setupDb();
    const result = heartbeatAllHeldLocks(db, {});
    expect(result.refreshed).toBe(0);
    // Both kinds should report "skipped"
    expect(result.perKind["embedding-backfill"]).toBe("skipped");
    expect(result.perKind["extraction"]).toBe("skipped");
    db.close();
  });
});
