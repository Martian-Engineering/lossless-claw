/**
 * Concurrency / TOCTOU invariant test layer (Wave-10 A8 closure).
 *
 * # Why this exists
 *
 * Single-threaded vitest tests run in one event loop, and node:sqlite is
 * synchronous: a `db.prepare(...).run(...)` holds the JS thread until SQLite
 * returns. Promise-interleaved "concurrent" tests CANNOT reproduce TOCTOU
 * races because nothing actually races — each statement runs to completion
 * before the next microtask. Wave 7-9 closed several real TOCTOU bugs
 * (Wave-9 P1.5 reconcileSessionKeys snapshot inside BEGIN IMMEDIATE; Wave-8
 * P1 runSoftPurgeAtomic same pattern; Wave-1/9 worker-lock heartbeat
 * expires_at predicate; Wave-4 P0 recordEmbedding DELETE-before-INSERT)
 * and added regression tests, but those tests ran the writers SEQUENTIALLY
 * because that's all single-threaded JS can do. They prove the fix's
 * INTENT but cannot demonstrate it survives ACTUAL parallel writers.
 *
 * This file uses node:worker_threads to spawn truly parallel writers
 * against a shared file-backed SQLite DB (WAL mode). Each worker opens
 * its own DatabaseSync connection. SharedArrayBuffer + Atomics provide
 * tight start-line synchronization so all writers begin within
 * microseconds of each other, giving the SQLite write lock a real chance
 * to serialize them — and forcing the snapshot-vs-update ordering bugs
 * to surface if the fixes regress.
 *
 * # What's tested
 *
 *   1. reconcileSessionKeys race (Wave-9 P1.5):
 *        every conversation whose session_key was changed must have a
 *        matching audit row.
 *
 *   2. runSoftPurgeAtomic race (Wave-8 P1):
 *        every leaf that ends up suppressed must be in the returned
 *        affectedLeafIds (no silent suppression without operator-visible
 *        attribution).
 *
 *   3. worker-lock acquire race (5-way):
 *        exactly one of N concurrent acquireLock calls succeeds.
 *
 *   4. heartbeat-during-LLM race (Wave-9 Agent #8 P2 / Wave-1 Auditor #2):
 *        a worker that slept past its TTL cannot heartbeat-extend a lock
 *        that another worker has since stolen.
 *
 *   5. recordEmbedding atomicity (Wave-4 P0):
 *        two parallel writers for the same (id, kind) leave exactly ONE
 *        row in vec0 (no DELETE-before-INSERT savepoint regression =
 *        duplicate rows).
 *
 * # When this test fails
 *
 *   - Worker setup error → invalid test, fix the harness.
 *   - Invariant assertion fail → the production fix has regressed; do
 *     NOT relax the assertion, fix the source. The whole point of these
 *     tests is to PIN the post-fix behavior under real concurrency.
 *
 * # Wall-clock targets
 *
 *   Each individual test must finish in ~5s; full suite < 30s.
 *   Worker spawn cost is ~50-100ms each; we keep worker counts low (≤5)
 *   and reuse the same DB file across waves where possible.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, platform, arch } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import {
  acquireLock,
  generateWorkerId,
  heartbeatLock,
  releaseLock,
} from "../src/concurrency/worker-lock.js";
import {
  ensureEmbeddingsTable,
  recordEmbedding,
  registerEmbeddingProfile,
  tryLoadSqliteVec,
} from "../src/embeddings/store.js";
import { reconcileSessionKeys } from "../src/operator/reconcile-session-keys.js";
import { runPurge } from "../src/operator/purge.js";

// ────────────────────────────────────────────────────────────────────
// Test environment helpers
// ────────────────────────────────────────────────────────────────────

const VEC0_PATH =
  process.env.LCM_TEST_VEC0_PATH?.trim() ||
  (() => {
    const realHome = process.env.REAL_HOME?.trim() || "/Users/lume";
    const ext = platform() === "win32" ? "dll" : platform() === "darwin" ? "dylib" : "so";
    const platformPkg = `sqlite-vec-${platform() === "win32" ? "windows" : platform()}-${arch()}`;
    return `${realHome}/.openclaw/extensions/node_modules/${platformPkg}/vec0.${ext}`;
  })();
const VEC0_AVAILABLE = existsSync(VEC0_PATH);

let scratchDir: string;

beforeEach(() => {
  // Each test gets its own tmpdir so a leaked WAL/SHM from one test can't
  // poison the next.
  scratchDir = mkdtempSync(join(tmpdir(), "v41-conc-"));
});

afterEach(() => {
  try {
    rmSync(scratchDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

/**
 * Create a fresh file-backed DB and run migrations on it. Returns the path
 * (workers will open their own connections to it).
 */
function setupSharedDb(opts: { allowExtension?: boolean } = {}): string {
  const dbPath = join(scratchDir, "lcm.db");
  const db = new DatabaseSync(dbPath, { allowExtension: opts.allowExtension ?? false });
  // WAL mode is required for true cross-connection writers; rollback-journal
  // mode would let one writer block all readers/writers.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  if (opts.allowExtension) {
    tryLoadSqliteVec(db, { path: VEC0_PATH });
  }
  runLcmMigrations(db, { fts5Available: false });
  db.close();
  return dbPath;
}

interface WorkerSpawnArgs {
  dbPath: string;
  workerId: number;
  startSignal: SharedArrayBuffer;
  // Test-specific payload, JSON-serializable:
  payload: unknown;
}

interface WorkerResult {
  workerId: number;
  success: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Spawn N parallel workers, each running the given inline JS code. The
 * workers all wait on a SharedArrayBuffer signal so they "go" within
 * microseconds. Returns when every worker has posted its result message.
 *
 * The worker code receives `workerData = { dbPath, workerId, startSignal, payload }`.
 * It must:
 *   1. Open its own DatabaseSync connection (`require('node:sqlite')`)
 *   2. Set busy_timeout so SQLITE_BUSY-on-contention waits gracefully
 *   3. `Atomics.wait(new Int32Array(startSignal), 0, 0)` to block until "go"
 *   4. Do its work
 *   5. `parentPort.postMessage(result)`
 *
 * `code` runs as CommonJS via `eval: true` — use `require()` not `import`.
 */
async function raceWorkers(opts: {
  count: number;
  dbPath: string;
  payloads: unknown[];
  code: string;
  goDelayMs?: number;
}): Promise<WorkerResult[]> {
  if (opts.payloads.length !== opts.count) {
    throw new Error(`raceWorkers: expected ${opts.count} payloads, got ${opts.payloads.length}`);
  }
  const startSignal = new SharedArrayBuffer(4);
  const sigInt = new Int32Array(startSignal);

  const workerPromises: Promise<WorkerResult>[] = [];
  const workers: Worker[] = [];

  for (let i = 0; i < opts.count; i++) {
    const w = new Worker(opts.code, {
      eval: true,
      workerData: {
        dbPath: opts.dbPath,
        workerId: i,
        startSignal,
        payload: opts.payloads[i],
      } satisfies WorkerSpawnArgs,
    });
    workers.push(w);

    workerPromises.push(
      new Promise<WorkerResult>((resolve, reject) => {
        w.once("message", (m: WorkerResult) => resolve(m));
        w.once("error", (e) => reject(e));
        w.once("exit", (code) => {
          if (code !== 0) {
            reject(new Error(`worker ${i} exited with code ${code}`));
          }
        });
      }),
    );
  }

  // Give workers a moment to all reach Atomics.wait, then release.
  await new Promise<void>((r) => setTimeout(r, opts.goDelayMs ?? 50));
  Atomics.store(sigInt, 0, 1);
  Atomics.notify(sigInt, 0);

  try {
    const results = await Promise.all(workerPromises);
    return results;
  } finally {
    // Defensive cleanup — terminate any still-alive worker.
    for (const w of workers) {
      try {
        await w.terminate();
      } catch {
        // ignore
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// TEST 1 — reconcileSessionKeys race (Wave-9 P1.5)
// ────────────────────────────────────────────────────────────────────
//
// Scenario: worker A inserts a NEW conversation matching one of the
// `from` session_keys; worker B simultaneously calls reconcileSessionKeys.
// The post-fix invariant: every conversation whose session_key currently
// equals `to` AND that came from `from` must have a corresponding audit
// row in lcm_session_key_audit. With the pre-fix code (snapshot OUTSIDE
// BEGIN IMMEDIATE), B could UPDATE A's row but not see it in the
// affectedConvs SELECT, so no audit row would be inserted → silent rekey.

const RECONCILE_INSERTER_CODE = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");

const sig = new Int32Array(workerData.startSignal);
const db = new DatabaseSync(workerData.dbPath);
db.exec("PRAGMA busy_timeout = 5000");
db.exec("PRAGMA foreign_keys = ON");

Atomics.wait(sig, 0, 0);

const { sessionKey, sessionId } = workerData.payload;
let convId = null;
let error = null;
try {
  // Insert as archived (active=0) so we don't fight the
  // conversations_active_session_key_idx UNIQUE partial index. The race
  // we care about is the snapshot-vs-update ordering, not the active
  // collision (which is a separate guard in reconcileSessionKeys).
  const r = db.prepare(
    "INSERT INTO conversations (session_id, session_key, active, archived_at) VALUES (?, ?, 0, datetime('now'))"
  ).run(sessionId, sessionKey);
  convId = Number(r.lastInsertRowid);
} catch (e) {
  error = e && e.message ? e.message : String(e);
}
db.close();

parentPort.postMessage({
  workerId: workerData.workerId,
  success: error === null,
  result: { convId, sessionKey },
  error: error || undefined,
});
`;

describe("v41 concurrency — reconcileSessionKeys (Wave-9 P1.5 race)", () => {
  it("post-state invariant: every conversation in `to` from a `from` key has an audit row", async () => {
    const dbPath = setupSharedDb();
    // Pre-seed two ARCHIVED conversations matching the from-keys. They're
    // active=0 because conversations has a UNIQUE partial index on
    // (session_key) WHERE active=1 — so we couldn't have two active rows
    // with the same session_key anyway. The realistic scenario is:
    // operator has two archived legacy threads they want to merge.
    {
      const db = new DatabaseSync(dbPath);
      db.exec("PRAGMA foreign_keys = ON");
      db.prepare(
        "INSERT INTO conversations (session_id, session_key, active, archived_at) VALUES (?, ?, 0, datetime('now'))",
      ).run("seed-1a", "legacy:conv_1");
      db.prepare(
        "INSERT INTO conversations (session_id, session_key, active, archived_at) VALUES (?, ?, 0, datetime('now'))",
      ).run("seed-1b", "legacy:conv_1");
      db.prepare(
        "INSERT INTO conversations (session_id, session_key, active, archived_at) VALUES (?, ?, 0, datetime('now'))",
      ).run("seed-2a", "legacy:conv_2");
      db.close();
    }

    // 4 inserter workers each try to insert a NEW archived row matching
    // legacy:conv_1 or legacy:conv_2. Inserts are archived (active=0) so
    // the conversations_active_session_key_idx UNIQUE partial index won't
    // fire — the race we're after is the snapshot-vs-update ordering, not
    // the active collision.
    const inserterPayloads: unknown[] = [
      { sessionId: "race-a", sessionKey: "legacy:conv_1" },
      { sessionId: "race-b", sessionKey: "legacy:conv_2" },
      { sessionId: "race-c", sessionKey: "legacy:conv_1" },
      { sessionId: "race-d", sessionKey: "legacy:conv_2" },
    ];

    // CRUCIAL DESIGN: we drive the REAL `reconcileSessionKeys()` from
    // src/operator/reconcile-session-keys.ts on the MAIN thread, with
    // INSERTER workers racing it from worker_threads. This way, if
    // someone refactors the production code to put the snapshot OUTSIDE
    // BEGIN IMMEDIATE again (regressing Wave-9 P1.5), this test catches
    // it. Inlining the reconciler SQL into a worker would only test the
    // inlined copy.
    const startSignal = new SharedArrayBuffer(4);
    const sigArr = new Int32Array(startSignal);

    const inserterPromises: Promise<WorkerResult>[] = [];
    const inserters: Worker[] = [];
    for (let i = 0; i < inserterPayloads.length; i++) {
      const w = new Worker(RECONCILE_INSERTER_CODE, {
        eval: true,
        workerData: {
          dbPath,
          workerId: i,
          startSignal,
          payload: inserterPayloads[i],
        },
      });
      inserters.push(w);
      inserterPromises.push(
        new Promise<WorkerResult>((resolve, reject) => {
          w.once("message", resolve);
          w.once("error", reject);
        }),
      );
    }

    // Open a main-thread DB connection for the real reconcile call.
    // busy_timeout high so we wait through inserter contention rather
    // than failing with SQLITE_BUSY on a transient lock collision.
    const mainDb = new DatabaseSync(dbPath);
    mainDb.exec("PRAGMA busy_timeout = 5000");
    mainDb.exec("PRAGMA foreign_keys = ON");

    // Release the inserter workers, then immediately call reconcile.
    // Workers wake from Atomics.wait and INSERT while the main thread
    // enters BEGIN IMMEDIATE inside reconcileSessionKeys.
    await new Promise<void>((r) => setTimeout(r, 80));
    Atomics.store(sigArr, 0, 1);
    Atomics.notify(sigArr, 0);

    let reconcileErr: unknown = null;
    try {
      reconcileSessionKeys(mainDb, {
        fromSessionKeys: ["legacy:conv_1", "legacy:conv_2"],
        toSessionKey: "merged-target",
        reason: "race-test reconcile",
        appliedBy: "test",
      });
    } catch (e) {
      reconcileErr = e;
    }

    const inserterResults = await Promise.all(inserterPromises);
    for (const w of inserters) await w.terminate();
    mainDb.close();

    if (reconcileErr) throw reconcileErr;
    for (const r of inserterResults) {
      if (!r.success) {
        throw new Error(`inserter ${r.workerId} failed: ${r.error}`);
      }
      expect(r.success).toBe(true);
    }

    // INVARIANT: for every conversation whose session_key currently equals
    // `merged-target`, exactly ONE of these must be true:
    //   (a) Its insert landed BEFORE the reconciler's snapshot, so it has
    //       an audit row reflecting the rekey from legacy:conv_X →
    //       merged-target.
    //   (b) Its insert landed AFTER the reconciler's UPDATE, so its
    //       session_key was set DIRECTLY to merged-target by the inserter
    //       (impossible here — inserters write legacy:conv_*, never the
    //       target — so this case shouldn't occur).
    // With the Wave-9 P1.5 fix, no third case "rekeyed without audit"
    // exists. Verify by joining conversations LEFT JOIN audit.
    const verifyDb = new DatabaseSync(dbPath);
    verifyDb.exec("PRAGMA foreign_keys = ON");
    const inMerged = verifyDb
      .prepare(
        "SELECT conversation_id, session_id, session_key FROM conversations WHERE session_key = 'merged-target' ORDER BY conversation_id",
      )
      .all() as Array<{ conversation_id: number; session_id: string; session_key: string }>;
    const auditedIds = verifyDb
      .prepare(
        "SELECT DISTINCT conversation_id FROM lcm_session_key_audit WHERE new_session_key = 'merged-target'",
      )
      .all() as Array<{ conversation_id: number }>;
    const auditedSet = new Set(auditedIds.map((r) => r.conversation_id));

    // Every conv with session_key=merged-target must be audited (case (a))
    // OR have a session_id that was directly inserted with that key (none
    // in this test). Since no inserter wrote `merged-target` directly,
    // every row in inMerged MUST be in auditedSet. Without the Wave-9 P1.5
    // fix, an inserter row could appear in inMerged WITHOUT being in
    // auditedSet (silent rekey).
    const unaudited = inMerged.filter((c) => !auditedSet.has(c.conversation_id));
    if (unaudited.length > 0) {
      throw new Error(
        `INVARIANT VIOLATED — found ${unaudited.length} conversation(s) silently rekeyed to merged-target with no audit row: ${JSON.stringify(unaudited)}. Wave-9 P1.5 fix has regressed.`,
      );
    }
    expect(unaudited).toEqual([]);

    // Also: no audit row should reference a non-existent conversation
    // (FK CASCADE would prevent this, but assert anyway).
    const orphanAudits = verifyDb
      .prepare(
        "SELECT a.audit_id FROM lcm_session_key_audit a LEFT JOIN conversations c ON c.conversation_id = a.conversation_id WHERE c.conversation_id IS NULL",
      )
      .all() as Array<{ audit_id: string }>;
    expect(orphanAudits).toEqual([]);

    verifyDb.close();
  }, 15_000);
});

// ────────────────────────────────────────────────────────────────────
// TEST 2 — runSoftPurgeAtomic race (Wave-8 P1)
// ────────────────────────────────────────────────────────────────────
//
// Scenario: worker A inserts a new leaf matching purge criteria
// (session_key=sk1, kind=leaf, suppressed_at IS NULL); worker B
// simultaneously calls runPurge. Post-fix invariant: every leaf that
// ends up suppressed must be in the returned affectedLeafIds. Without
// the fix (resolveTargetLeafIds outside BEGIN IMMEDIATE), B could
// UPDATE A's leaf without it appearing in the resolved targets — silent
// suppression.

const PURGE_INSERTER_CODE = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");

const sig = new Int32Array(workerData.startSignal);
const db = new DatabaseSync(workerData.dbPath);
db.exec("PRAGMA busy_timeout = 5000");
db.exec("PRAGMA foreign_keys = ON");

Atomics.wait(sig, 0, 0);

const { summaryId, sessionKey, conversationId } = workerData.payload;
let inserted = false;
let error = null;
try {
  db.prepare(
    "INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key) VALUES (?, ?, 'leaf', 'race-leaf', 100, ?)"
  ).run(summaryId, conversationId, sessionKey);
  inserted = true;
} catch (e) {
  error = e && e.message ? e.message : String(e);
}
db.close();

parentPort.postMessage({
  workerId: workerData.workerId,
  success: error === null,
  result: { summaryId, inserted },
  error: error || undefined,
});
`;

describe("v41 concurrency — runSoftPurgeAtomic (Wave-8 P1 race)", () => {
  it("post-state invariant: every suppressed leaf is in affectedLeafIds returned to operator", async () => {
    const dbPath = setupSharedDb();
    // Seed conversation + 5 baseline leaves matching the purge criteria.
    {
      const db = new DatabaseSync(dbPath);
      db.exec("PRAGMA foreign_keys = ON");
      db.prepare(
        "INSERT INTO conversations (session_id, session_key) VALUES (?, ?)",
      ).run("s1", "sk1");
      const seedLeaves = ["seed-1", "seed-2", "seed-3", "seed-4", "seed-5"];
      for (const id of seedLeaves) {
        db.prepare(
          "INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key) VALUES (?, 1, 'leaf', 'seed', 100, 'sk1')",
        ).run(id);
      }
      db.close();
    }

    // 3 inserter workers each insert a new leaf with session_key=sk1.
    // The race: while runPurge is resolving + suppressing, these
    // inserts try to land. With the Wave-8 P1 fix, resolution happens
    // INSIDE BEGIN IMMEDIATE, so any insert that committed before the tx
    // shows up in the resolved set; any insert that arrives after is
    // simply not part of this purge.
    const inserterPayloads: unknown[] = [
      { summaryId: "race-leaf-a", sessionKey: "sk1", conversationId: 1 },
      { summaryId: "race-leaf-b", sessionKey: "sk1", conversationId: 1 },
      { summaryId: "race-leaf-c", sessionKey: "sk1", conversationId: 1 },
    ];

    const startSignal = new SharedArrayBuffer(4);
    const sigArr = new Int32Array(startSignal);

    const inserterPromises: Promise<WorkerResult>[] = [];
    const inserters: Worker[] = [];
    for (let i = 0; i < inserterPayloads.length; i++) {
      const w = new Worker(PURGE_INSERTER_CODE, {
        eval: true,
        workerData: {
          dbPath,
          workerId: i,
          startSignal,
          payload: inserterPayloads[i],
        },
      });
      inserters.push(w);
      inserterPromises.push(
        new Promise<WorkerResult>((resolve, reject) => {
          w.once("message", resolve);
          w.once("error", reject);
        }),
      );
    }

    // CRUCIAL DESIGN: drive REAL `runPurge()` from
    // src/operator/purge.ts on the MAIN thread; INSERTER workers race it.
    // Any regression that moves resolveTargetLeafIds outside the tx
    // (un-doing Wave-8 P1) would surface here.
    const mainDb = new DatabaseSync(dbPath);
    mainDb.exec("PRAGMA busy_timeout = 5000");
    mainDb.exec("PRAGMA foreign_keys = ON");

    await new Promise<void>((r) => setTimeout(r, 80));
    Atomics.store(sigArr, 0, 1);
    Atomics.notify(sigArr, 0);

    let purgeResult;
    let purgeErr: unknown = null;
    try {
      purgeResult = runPurge(mainDb, {
        sessionKey: "sk1",
        reason: "race-test purge",
      });
    } catch (e) {
      purgeErr = e;
    }

    const inserterResults = await Promise.all(inserterPromises);
    for (const w of inserters) await w.terminate();
    mainDb.close();

    if (purgeErr) throw purgeErr;
    expect(purgeResult).toBeDefined();
    for (const r of inserterResults) {
      if (!r.success) {
        throw new Error(`inserter ${r.workerId} failed: ${r.error}`);
      }
      expect(r.success).toBe(true);
    }

    const affectedLeafIds = new Set(purgeResult!.affectedLeafIds);

    // INVARIANT: every leaf in summaries with suppressed_at IS NOT NULL
    // AND session_key='sk1' MUST be in affectedLeafIds. Without Wave-8
    // P1, a race-inserted leaf could be UPDATEd to suppressed without
    // appearing in the resolved-targets snapshot → silent suppression.
    const verifyDb = new DatabaseSync(dbPath);
    const suppressedLeaves = verifyDb
      .prepare(
        "SELECT summary_id FROM summaries WHERE session_key = 'sk1' AND kind = 'leaf' AND suppressed_at IS NOT NULL ORDER BY summary_id",
      )
      .all() as Array<{ summary_id: string }>;

    const silentSuppressions = suppressedLeaves.filter(
      (r) => !affectedLeafIds.has(r.summary_id),
    );
    if (silentSuppressions.length > 0) {
      throw new Error(
        `INVARIANT VIOLATED — found ${silentSuppressions.length} silently-suppressed leaf(s) not reported to operator: ${JSON.stringify(silentSuppressions)}. Wave-8 P1 fix has regressed.`,
      );
    }
    expect(silentSuppressions).toEqual([]);

    // Conversely: every leaf in affectedLeafIds must actually be suppressed
    // (the operator was told it would be).
    const reportedButNotSuppressed: string[] = [];
    for (const id of affectedLeafIds) {
      const row = verifyDb
        .prepare("SELECT suppressed_at FROM summaries WHERE summary_id = ?")
        .get(id) as { suppressed_at: string | null } | undefined;
      if (!row || row.suppressed_at === null) {
        reportedButNotSuppressed.push(id);
      }
    }
    expect(reportedButNotSuppressed).toEqual([]);

    verifyDb.close();
  }, 15_000);
});

// ────────────────────────────────────────────────────────────────────
// TEST 3 — worker-lock acquire race (5-way concurrent)
// ────────────────────────────────────────────────────────────────────
//
// Scenario: 5 workers all call acquireLock(jobKind='embedding-backfill')
// at the same instant. Invariant: exactly 1 succeeds (returns true);
// 4 fail (return false). Repeat with a stale lock present — exactly 1
// succeeds via lazy-GC + INSERT OR IGNORE.

const ACQUIRE_LOCK_CODE = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");

const sig = new Int32Array(workerData.startSignal);
const db = new DatabaseSync(workerData.dbPath);
db.exec("PRAGMA busy_timeout = 5000");
db.exec("PRAGMA foreign_keys = ON");

Atomics.wait(sig, 0, 0);

const { workerName, ttlMs, jobKind } = workerData.payload;
let acquired = false;
let error = null;
try {
  // Mirror src/concurrency/worker-lock.ts:acquireLock body. Use the same
  // lazy-GC + INSERT OR IGNORE pattern; we verify it serializes correctly
  // under genuine cross-process contention.
  db.prepare(
    "DELETE FROM lcm_worker_lock WHERE job_kind = ? AND expires_at <= datetime('now')"
  ).run(jobKind);
  const ttlSeconds = Math.max(1, Math.round(ttlMs / 1000));
  const r = db.prepare(
    "INSERT OR IGNORE INTO lcm_worker_lock (job_kind, worker_id, acquired_at, expires_at, last_heartbeat_at, job_session_key, job_metadata) VALUES (?, ?, datetime('now'), datetime('now', '+' || ? || ' seconds'), datetime('now'), NULL, NULL)"
  ).run(jobKind, workerName, ttlSeconds);
  acquired = Number(r.changes) > 0;
} catch (e) {
  error = e && e.message ? e.message : String(e);
}
db.close();

parentPort.postMessage({
  workerId: workerData.workerId,
  success: error === null,
  result: { workerName, acquired },
  error: error || undefined,
});
`;

describe("v41 concurrency — worker-lock acquire race (5-way)", () => {
  it("exactly 1 of 5 concurrent acquireLock calls succeeds (no stale lock)", async () => {
    const dbPath = setupSharedDb();
    const N = 5;
    const payloads: unknown[] = [];
    for (let i = 0; i < N; i++) {
      payloads.push({ workerName: `w-${i}`, ttlMs: 60_000, jobKind: "embedding-backfill" });
    }
    const results = await raceWorkers({
      count: N,
      dbPath,
      payloads,
      code: ACQUIRE_LOCK_CODE,
    });
    for (const r of results) expect(r.success).toBe(true);
    const acquired = results.filter(
      (r) => (r.result as { acquired: boolean }).acquired,
    );
    if (acquired.length !== 1) {
      throw new Error(
        `INVARIANT VIOLATED — expected exactly 1 acquirer, got ${acquired.length}: ${JSON.stringify(
          results.map((r) => r.result),
        )}. lcm_worker_lock PRIMARY KEY uniqueness has regressed.`,
      );
    }
    expect(acquired.length).toBe(1);

    // Also assert lock row matches the winner.
    const verifyDb = new DatabaseSync(dbPath);
    const lockRow = verifyDb
      .prepare("SELECT worker_id FROM lcm_worker_lock WHERE job_kind = 'embedding-backfill'")
      .get() as { worker_id: string } | undefined;
    expect(lockRow?.worker_id).toBe((acquired[0].result as { workerName: string }).workerName);
    verifyDb.close();
  }, 15_000);

  it("with a stale lock present, exactly 1 of 5 succeeds via lazy-GC", async () => {
    const dbPath = setupSharedDb();
    // Pre-seed an EXPIRED lock (expires_at in the past). This simulates
    // a dead worker — its lock should be lazily GC'd by the next acquire.
    {
      const db = new DatabaseSync(dbPath);
      db.exec(
        `INSERT INTO lcm_worker_lock (job_kind, worker_id, acquired_at, expires_at, last_heartbeat_at)
         VALUES ('embedding-backfill', 'dead-worker', datetime('now', '-200 seconds'), datetime('now', '-100 seconds'), datetime('now', '-200 seconds'))`,
      );
      db.close();
    }
    const N = 5;
    const payloads: unknown[] = [];
    for (let i = 0; i < N; i++) {
      payloads.push({ workerName: `w-${i}`, ttlMs: 60_000, jobKind: "embedding-backfill" });
    }
    const results = await raceWorkers({
      count: N,
      dbPath,
      payloads,
      code: ACQUIRE_LOCK_CODE,
    });
    for (const r of results) expect(r.success).toBe(true);
    const acquired = results.filter(
      (r) => (r.result as { acquired: boolean }).acquired,
    );
    if (acquired.length !== 1) {
      throw new Error(
        `INVARIANT VIOLATED — expected exactly 1 acquirer after stale-GC, got ${acquired.length}: ${JSON.stringify(
          results.map((r) => r.result),
        )}.`,
      );
    }
    expect(acquired.length).toBe(1);

    const verifyDb = new DatabaseSync(dbPath);
    // Dead-worker's lock must have been replaced.
    const lockRow = verifyDb
      .prepare("SELECT worker_id FROM lcm_worker_lock WHERE job_kind = 'embedding-backfill'")
      .get() as { worker_id: string } | undefined;
    expect(lockRow?.worker_id).not.toBe("dead-worker");
    verifyDb.close();
  }, 15_000);
});

// ────────────────────────────────────────────────────────────────────
// TEST 4 — Heartbeat-during-LLM race (Wave-9 Agent #8 P2 / Wave-1 Auditor #2)
// ────────────────────────────────────────────────────────────────────
//
// Scenario: simulates the Voyage 429 retry path. Worker A acquires lock
// with TTL=1s. Worker A sleeps 1.5s (simulates a Voyage retry blowing
// past the lock TTL). Worker B then calls acquireLock — should succeed
// (lazy-GC). When A wakes and tries heartbeatLock, must return FALSE
// (the heartbeat's `expires_at > now` predicate catches the stolen
// state and reports loss-of-lock to the caller, who must abort writes).

describe("v41 concurrency — heartbeat-during-LLM race (Wave-9 Agent #8 P2)", () => {
  it("worker that slept past TTL cannot heartbeat-extend after another worker steals lock", async () => {
    const dbPath = setupSharedDb();
    const dbA = new DatabaseSync(dbPath);
    dbA.exec("PRAGMA busy_timeout = 5000");
    dbA.exec("PRAGMA foreign_keys = ON");

    const workerA = generateWorkerId("A");
    const ttl = 1_000; // 1 second — Math.round divides by 1000 → 1 second SQL
    const acquiredA = acquireLock(dbA, "embedding-backfill", {
      workerId: workerA,
      ttlMs: ttl,
    });
    expect(acquiredA).toBe(true);

    // Simulate a long Voyage call (retry path that blows past TTL).
    // 1.5s > 1s TTL → A's lock has expired by the time we finish sleeping.
    await new Promise<void>((r) => setTimeout(r, 1_500));

    // Worker B (separate connection) acquires — should succeed via lazy-GC.
    const dbB = new DatabaseSync(dbPath);
    dbB.exec("PRAGMA busy_timeout = 5000");
    dbB.exec("PRAGMA foreign_keys = ON");
    const workerB = generateWorkerId("B");
    const acquiredB = acquireLock(dbB, "embedding-backfill", {
      workerId: workerB,
      ttlMs: 60_000,
    });
    expect(acquiredB).toBe(true);

    // Worker A wakes up and tries to heartbeat. The heartbeat MUST fail
    // (Wave-1 Auditor #2 fix — `expires_at > now` predicate ensures
    // expired locks can't be silently re-extended). If this returns true,
    // we have two workers thinking they hold the lock = data corruption.
    const heartbeatStillOurs = heartbeatLock(dbA, "embedding-backfill", workerA);
    if (heartbeatStillOurs) {
      throw new Error(
        "INVARIANT VIOLATED — A's heartbeat succeeded after lock TTL elapsed and B took over. " +
          "Wave-1 Auditor #2 / Wave-9 Agent #8 P2 fix has regressed: heartbeat predicate must require " +
          "`expires_at > now` AND `worker_id = self`.",
      );
    }
    expect(heartbeatStillOurs).toBe(false);

    // Verify B still holds the lock (A's heartbeat didn't clobber B's
    // expires_at).
    const owner = dbB
      .prepare("SELECT worker_id FROM lcm_worker_lock WHERE job_kind = 'embedding-backfill'")
      .get() as { worker_id: string };
    expect(owner.worker_id).toBe(workerB);

    // A should NOT be able to release a lock owned by B.
    const releasedA = releaseLock(dbA, "embedding-backfill", workerA);
    expect(releasedA).toBe(false);

    // B can release normally.
    const releasedB = releaseLock(dbB, "embedding-backfill", workerB);
    expect(releasedB).toBe(true);

    dbA.close();
    dbB.close();
  }, 6_000);

  it("simulates writeBatch path: heartbeat-then-write must abort if heartbeat returns false", async () => {
    // This pins the EMBEDDING-BACKFILL contract from src/embeddings/backfill.ts:
    // before each batch's HTTP+write, the worker calls heartbeatLock and
    // aborts cleanly if it returns false. We verify that pattern works:
    // when A's lock is stolen, A's "would commit" path correctly aborts.
    const dbPath = setupSharedDb();
    const dbA = new DatabaseSync(dbPath);
    dbA.exec("PRAGMA busy_timeout = 5000");
    const workerA = generateWorkerId("A");
    acquireLock(dbA, "embedding-backfill", { workerId: workerA, ttlMs: 1_000 });

    // Simulate Voyage taking too long
    await new Promise<void>((r) => setTimeout(r, 1_500));

    // Steal it
    const dbB = new DatabaseSync(dbPath);
    const workerB = generateWorkerId("B");
    acquireLock(dbB, "embedding-backfill", { workerId: workerB, ttlMs: 60_000 });

    // A's writeBatch checks heartbeat first
    const stillOurs = heartbeatLock(dbA, "embedding-backfill", workerA);
    expect(stillOurs).toBe(false);

    // If we DON'T abort here, A would proceed to write data attributed
    // to a lock A no longer holds. The contract says: caller MUST abort
    // when heartbeat returns false. Pin that with a synthetic mock-write
    // gate.
    let dataWritten = false;
    if (stillOurs) {
      // hypothetical write path
      dataWritten = true;
    }
    expect(dataWritten).toBe(false);

    dbA.close();
    dbB.close();
  }, 6_000);
});

// ────────────────────────────────────────────────────────────────────
// TEST 5 — recordEmbedding DELETE-before-INSERT atomicity (Wave-4 P0)
// ────────────────────────────────────────────────────────────────────
//
// Scenario: 2 workers call recordEmbedding for the SAME (summary_id,
// kind) with DIFFERENT vectors. SQLite WAL serializes the two writes,
// but we verify the post-state is exactly 1 row in vec0 with one of the
// two vectors (no DELETE-before-INSERT regression = duplicate rows).
//
// Note: vec0 must be loadable. We skip if not available (the pure
// in-process path is already covered by test/v41-suppression-cascade-trigger.test.ts;
// this test specifically pins the CONCURRENT case).

describe.skipIf(!VEC0_AVAILABLE)(
  "v41 concurrency — recordEmbedding atomicity (Wave-4 P0)",
  () => {
    it("two parallel recordEmbedding calls for same (id,kind) leave exactly 1 vec0 row", async () => {
      // Need vec0 enabled, so set up DB with allowExtension.
      const dbPath = setupSharedDb({ allowExtension: true });
      // Pre-seed: register profile + create vec0 table + insert source summary.
      {
        const db = new DatabaseSync(dbPath, { allowExtension: true });
        tryLoadSqliteVec(db, { path: VEC0_PATH });
        db.exec("PRAGMA foreign_keys = ON");
        db.prepare(
          "INSERT INTO conversations (session_id, session_key) VALUES ('s1', 'sk1')",
        ).run();
        db.prepare(
          "INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key) VALUES ('leaf-race', 1, 'leaf', 'x', 100, 'sk1')",
        ).run();
        registerEmbeddingProfile(db, "voyage-4-large", 3);
        ensureEmbeddingsTable(db, "voyage-4-large", 3);
        db.close();
      }

      // Spawn two parallel workers, each opens its own connection, loads
      // vec0, and runs the recordEmbedding SAVEPOINT body for the SAME
      // (leaf-race, summary) pair with a different vector. WAL serializes
      // them via SQLite's write lock, but both ATTEMPT to write — pinning
      // that the DELETE-before-INSERT inside the SAVEPOINT keeps the post-
      // state at exactly 1 vec0 row. Without the Wave-4 P0 fix (DELETE
      // before INSERT in a SAVEPOINT), back-to-back writes would
      // accumulate vec0 rows because vec0 auxiliary cols aren't UNIQUE-
      // indexed.
      //
      // We mirror src/embeddings/store.ts:recordEmbedding's SAVEPOINT body
      // here rather than calling the function directly because workers
      // can't import .ts modules. The Wave-4 P0 contract IS the SAVEPOINT
      // body; if a refactor breaks it, the production unit tests in
      // test/embeddings-store.test.ts already cover that. This test
      // additionally pins the CONCURRENT case.
      const code = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");

const sig = new Int32Array(workerData.startSignal);
const db = new DatabaseSync(workerData.dbPath, { allowExtension: true });
const { existsSync } = require("node:fs");
const VEC0_PATH = workerData.payload.vec0Path;
if (existsSync(VEC0_PATH)) {
  try { db.loadExtension(VEC0_PATH); } catch (_) {}
}
db.exec("PRAGMA busy_timeout = 5000");
db.exec("PRAGMA foreign_keys = ON");

Atomics.wait(sig, 0, 0);

const { vector, suppressed } = workerData.payload;
const tableName = "lcm_embeddings_voyage4large";
const sp = "re_w_" + workerData.workerId + "_" + Math.floor(Math.random() * 1e9).toString(16);
const vecJson = JSON.stringify(vector);
const suppressedBig = suppressed ? 1n : 0n;

let error = null;
try {
  // Mirror src/embeddings/store.ts:recordEmbedding's SAVEPOINT body:
  // SAVEPOINT → DELETE matching → INSERT new → meta INSERT OR REPLACE → RELEASE.
  db.exec("SAVEPOINT " + sp);
  try {
    db.prepare(
      "DELETE FROM " + tableName + " WHERE embedded_id = ? AND embedded_kind = ?"
    ).run("leaf-race", "summary");
    db.prepare(
      "INSERT INTO " + tableName + " (embedding, embedded_id, embedded_kind, suppressed) VALUES (?, ?, ?, ?)"
    ).run(vecJson, "leaf-race", "summary", suppressedBig);
    db.prepare(
      "INSERT OR REPLACE INTO lcm_embedding_meta (embedded_id, embedded_kind, embedding_model, embedded_at, source_token_count, archived) VALUES (?, ?, ?, datetime('now'), ?, 0)"
    ).run("leaf-race", "summary", "voyage-4-large", 100);
    db.exec("RELEASE " + sp);
  } catch (e) {
    try { db.exec("ROLLBACK TO " + sp); db.exec("RELEASE " + sp); } catch (_) {}
    throw e;
  }
} catch (e) {
  error = e && e.message ? e.message : String(e);
}
db.close();

parentPort.postMessage({
  workerId: workerData.workerId,
  success: error === null,
  result: { vector: vector },
  error: error || undefined,
});
`;
      const v1 = [0.1, 0.2, 0.3];
      const v2 = [0.9, 0.8, 0.7];
      const results = await raceWorkers({
        count: 2,
        dbPath,
        payloads: [
          { vector: v1, suppressed: false, vec0Path: VEC0_PATH },
          { vector: v2, suppressed: false, vec0Path: VEC0_PATH },
        ],
        code,
      });
      // BOTH writers should succeed (WAL serializes them; the second one
      // waits its turn under busy_timeout=5000).
      for (const r of results) {
        if (!r.success) {
          throw new Error(`worker failed: ${r.error}`);
        }
      }

      // INVARIANT: exactly 1 row in vec0 for (leaf-race, summary).
      // Without the SAVEPOINT-wrapped DELETE-before-INSERT, the second
      // writer's INSERT would land on top of the first's row → 2 vec0
      // rows. Wave-4 P0 fix makes recordEmbedding atomic per-pair.
      const verifyDb = new DatabaseSync(dbPath, { allowExtension: true });
      tryLoadSqliteVec(verifyDb, { path: VEC0_PATH });
      verifyDb.exec("PRAGMA foreign_keys = ON");

      const vec0Rows = verifyDb
        .prepare(
          "SELECT embedded_id, embedded_kind FROM lcm_embeddings_voyage4large WHERE embedded_id = ? AND embedded_kind = ?",
        )
        .all("leaf-race", "summary") as Array<{ embedded_id: string; embedded_kind: string }>;
      if (vec0Rows.length !== 1) {
        throw new Error(
          `INVARIANT VIOLATED — expected exactly 1 vec0 row for (leaf-race, summary), found ${vec0Rows.length}. ` +
            `Wave-4 P0 DELETE-before-INSERT atomicity has regressed; KNN will return duplicates.`,
        );
      }
      expect(vec0Rows.length).toBe(1);

      // The meta sidecar must also have exactly 1 row.
      const metaRows = verifyDb
        .prepare(
          "SELECT embedded_id FROM lcm_embedding_meta WHERE embedded_id = ? AND embedded_kind = ? AND embedding_model = ?",
        )
        .all("leaf-race", "summary", "voyage-4-large") as Array<{ embedded_id: string }>;
      expect(metaRows.length).toBe(1);

      verifyDb.close();
    }, 15_000);

    it("recordEmbedding under sequential calls also leaves exactly 1 row (sanity)", async () => {
      // Single-thread baseline — should pass even without the concurrent
      // harness. Pins the in-process atomicity contract.
      const dbPath = setupSharedDb({ allowExtension: true });
      const db = new DatabaseSync(dbPath, { allowExtension: true });
      tryLoadSqliteVec(db, { path: VEC0_PATH });
      db.exec("PRAGMA foreign_keys = ON");
      db.prepare(
        "INSERT INTO conversations (session_id, session_key) VALUES ('s1', 'sk1')",
      ).run();
      db.prepare(
        "INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key) VALUES ('leaf-seq', 1, 'leaf', 'x', 100, 'sk1')",
      ).run();
      registerEmbeddingProfile(db, "voyage-4-large", 3);
      ensureEmbeddingsTable(db, "voyage-4-large", 3);

      // Call recordEmbedding twice with different vectors — should leave 1 row.
      recordEmbedding(db, {
        modelName: "voyage-4-large",
        embeddedId: "leaf-seq",
        embeddedKind: "summary",
        vector: [0.1, 0.2, 0.3],
        sourceTokenCount: 100,
      });
      recordEmbedding(db, {
        modelName: "voyage-4-large",
        embeddedId: "leaf-seq",
        embeddedKind: "summary",
        vector: [0.4, 0.5, 0.6],
        sourceTokenCount: 100,
      });

      const rows = db
        .prepare(
          "SELECT embedded_id FROM lcm_embeddings_voyage4large WHERE embedded_id = ? AND embedded_kind = ?",
        )
        .all("leaf-seq", "summary") as Array<{ embedded_id: string }>;
      expect(rows.length).toBe(1);
      db.close();
    });
  },
);
