import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { acquireLock } from "../src/concurrency/worker-lock.js";
import { getV41HealthSnapshot } from "../src/operator/health.js";
import { registerPrompt } from "../src/synthesis/prompt-registry.js";

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false });
  db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s1', 'sk1')`).run();
  return db;
}

function insertLeaf(
  db: DatabaseSync,
  summaryId: string,
  opts: { suppressed?: boolean } = {},
): void {
  const suppressedAt = opts.suppressed ? `datetime('now')` : `NULL`;
  db.prepare(
    `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key, suppressed_at)
     VALUES (?, 1, 'leaf', 'x', 100, 'sk1', ${suppressedAt})`,
  ).run(summaryId);
}

describe("operator-health — embeddings section", () => {
  it("reports NOT REGISTERED when no profile exists", () => {
    const db = setupDb();
    const snapshot = getV41HealthSnapshot(db);
    expect(snapshot.embeddings.activeProfile).toBeNull();
    expect(snapshot.embeddings.vec0Version).toBeNull();
    expect(snapshot.embeddings.pendingBackfill).toBe(0);
    expect(snapshot.embeddings.embeddedCount).toBe(0);
    db.close();
  });

  it("reports active profile + dim once registered", () => {
    const db = setupDb();
    db.prepare(
      `INSERT INTO lcm_embedding_profile (model_name, dim, active) VALUES ('voyage-4-large', 1024, 1)`,
    ).run();
    const snapshot = getV41HealthSnapshot(db);
    expect(snapshot.embeddings.activeProfile).not.toBeNull();
    expect(snapshot.embeddings.activeProfile?.modelName).toBe("voyage-4-large");
    expect(snapshot.embeddings.activeProfile?.dim).toBe(1024);
    db.close();
  });

  it("counts embedded rows from lcm_embedding_meta (archived=0 only)", () => {
    const db = setupDb();
    db.prepare(
      `INSERT INTO lcm_embedding_profile (model_name, dim, active) VALUES ('voyage-4-large', 1024, 1)`,
    ).run();
    insertLeaf(db, "leaf_1");
    insertLeaf(db, "leaf_2");
    db.prepare(
      `INSERT INTO lcm_embedding_meta (embedded_id, embedded_kind, embedding_model, source_token_count, archived)
       VALUES ('leaf_1', 'summary', 'voyage-4-large', 100, 0),
              ('leaf_2', 'summary', 'voyage-4-large', 100, 1)`,
    ).run();
    const snapshot = getV41HealthSnapshot(db);
    expect(snapshot.embeddings.embeddedCount).toBe(1);
    db.close();
  });

  it("reports pending backfill from countPendingDocs", () => {
    const db = setupDb();
    db.prepare(
      `INSERT INTO lcm_embedding_profile (model_name, dim, active) VALUES ('voyage-4-large', 1024, 1)`,
    ).run();
    // Two leaf summaries, neither embedded yet.
    insertLeaf(db, "leaf_a");
    insertLeaf(db, "leaf_b");
    const snapshot = getV41HealthSnapshot(db);
    expect(snapshot.embeddings.pendingBackfill).toBe(2);
    db.close();
  });

  it("reports vec0Version=null when sqlite-vec is not loaded", () => {
    const db = setupDb();
    const snapshot = getV41HealthSnapshot(db);
    expect(snapshot.embeddings.vec0Version).toBeNull();
    db.close();
  });
});

describe("operator-health — workers section", () => {
  it("reports all worker kinds as idle when no locks held", () => {
    const db = setupDb();
    const snapshot = getV41HealthSnapshot(db);
    expect(snapshot.workers.length).toBeGreaterThan(0);
    expect(snapshot.workers.every((w) => !w.active)).toBe(true);
    expect(snapshot.workers.find((w) => w.jobKind === "embedding-backfill")).toBeDefined();
    expect(snapshot.workers.find((w) => w.jobKind === "extraction")).toBeDefined();
    expect(snapshot.workers.find((w) => w.jobKind === "condensation")).toBeDefined();
    db.close();
  });

  it("reports active worker info when a lock is held", () => {
    const db = setupDb();
    expect(
      acquireLock(db, "embedding-backfill", {
        workerId: "test-worker-123",
        jobMetadata: "model=voyage-4-large",
      }),
    ).toBe(true);
    const snapshot = getV41HealthSnapshot(db);
    const ebWorker = snapshot.workers.find((w) => w.jobKind === "embedding-backfill")!;
    expect(ebWorker.active).toBe(true);
    expect(ebWorker.workerId).toBe("test-worker-123");
    expect(ebWorker.acquiredAt).not.toBeNull();
    expect(ebWorker.expiresAt).not.toBeNull();
    expect(ebWorker.expired).toBe(false);
    db.close();
  });

  it("flags expired locks (expires_at <= now)", () => {
    const db = setupDb();
    // Insert a lock row directly with an expires_at in the past.
    db.prepare(
      `INSERT INTO lcm_worker_lock
         (job_kind, worker_id, acquired_at, expires_at, last_heartbeat_at)
       VALUES ('extraction', 'dead-worker', datetime('now', '-5 minutes'),
               datetime('now', '-1 minute'), datetime('now', '-5 minutes'))`,
    ).run();
    const snapshot = getV41HealthSnapshot(db);
    const ext = snapshot.workers.find((w) => w.jobKind === "extraction")!;
    expect(ext.active).toBe(true);
    expect(ext.expired).toBe(true);
    db.close();
  });
});

describe("operator-health — synthesis section", () => {
  it("reports zero active prompts on a fresh DB", () => {
    const db = setupDb();
    const snapshot = getV41HealthSnapshot(db);
    expect(snapshot.synthesis.activePromptCount).toBe(0);
    expect(snapshot.synthesis.distinctMemoryTypeCount).toBe(0);
    expect(snapshot.synthesis.recentSynthesisRuns7d).toBe(0);
    db.close();
  });

  it("counts active prompts and distinct memory types", () => {
    const db = setupDb();
    registerPrompt(db, {
      memoryType: "episodic-leaf",
      tierLabel: null,
      passKind: "single",
      template: "leaf template",
    });
    registerPrompt(db, {
      memoryType: "episodic-condensed",
      tierLabel: "daily",
      passKind: "single",
      template: "daily template",
    });
    registerPrompt(db, {
      memoryType: "episodic-condensed",
      tierLabel: "weekly",
      passKind: "single",
      template: "weekly template",
    });
    const snapshot = getV41HealthSnapshot(db);
    expect(snapshot.synthesis.activePromptCount).toBe(3);
    expect(snapshot.synthesis.distinctMemoryTypeCount).toBe(2);
    db.close();
  });
});

describe("operator-health — eval section", () => {
  it("reports (none) when no eval runs exist", () => {
    const db = setupDb();
    const snapshot = getV41HealthSnapshot(db);
    expect(snapshot.eval.querySetCount).toBe(0);
    expect(snapshot.eval.mostRecentRun).toBeNull();
    expect(snapshot.eval.driftIndex).toBeNull();
    db.close();
  });

  it("reports query set count + most-recent run", () => {
    const db = setupDb();
    db.prepare(
      `INSERT INTO lcm_eval_query_set (query_set_id, version, description) VALUES ('eva-baseline@v1', 1, 'tst')`,
    ).run();
    db.prepare(
      `INSERT INTO lcm_eval_run (run_id, query_set_id, prompt_bundle_version, retrieval_recall_score, synthesis_quality_score, per_query_scores, judge_models, trigger)
       VALUES ('run_a', 'eva-baseline@v1', 1, 0.876, 0, ?, '[]', 'manual')`,
    ).run(JSON.stringify({ v: 1, mode: "fts_only", hasRecall: true, hasQuality: false, perQuery: {} }));
    const snapshot = getV41HealthSnapshot(db);
    expect(snapshot.eval.querySetCount).toBe(1);
    expect(snapshot.eval.mostRecentRun).not.toBeNull();
    expect(snapshot.eval.mostRecentRun?.runId).toBe("run_a");
    expect(snapshot.eval.mostRecentRun?.mode).toBe("fts_only");
    expect(snapshot.eval.mostRecentRun?.recallScore).toBeCloseTo(0.876, 3);
    db.close();
  });

  it("reports drift index from latest lcm_eval_drift row", () => {
    const db = setupDb();
    db.prepare(
      `INSERT INTO lcm_eval_query_set (query_set_id, version, description) VALUES ('eva-baseline@v1', 1, 'tst')`,
    ).run();
    db.prepare(
      `INSERT INTO lcm_eval_drift (drift_id, query_set_id, cumulative_delta, window_runs)
       VALUES ('d1', 'eva-baseline@v1', -0.05, 2)`,
    ).run();
    const snapshot = getV41HealthSnapshot(db);
    expect(snapshot.eval.driftIndex).toBeCloseTo(-0.05, 4);
    db.close();
  });
});

describe("operator-health — suppression section", () => {
  it("counts suppressed leaves", () => {
    const db = setupDb();
    insertLeaf(db, "live");
    insertLeaf(db, "suppressed_1", { suppressed: true });
    insertLeaf(db, "suppressed_2", { suppressed: true });
    const snapshot = getV41HealthSnapshot(db);
    expect(snapshot.suppression.suppressedLeaves).toBe(2);
    db.close();
  });

  it("counts pending purge rebuilds (picked_at IS NULL only)", () => {
    const db = setupDb();
    insertLeaf(db, "leaf_target_1");
    insertLeaf(db, "leaf_target_2");
    db.prepare(
      `INSERT INTO lcm_purge_rebuild_queue (queue_id, target_summary_id, purge_session_id, reason)
       VALUES ('q1', 'leaf_target_1', 'ps_test', 'test'),
              ('q2', 'leaf_target_2', 'ps_test', 'test')`,
    ).run();
    db.prepare(
      `UPDATE lcm_purge_rebuild_queue SET picked_at = datetime('now') WHERE queue_id = 'q1'`,
    ).run();
    const snapshot = getV41HealthSnapshot(db);
    expect(snapshot.suppression.pendingPurgeRebuilds).toBe(1);
    db.close();
  });
});

describe("operator-health — overall snapshot shape", () => {
  it("returns a fully-populated object on a fresh DB", () => {
    const db = setupDb();
    const snapshot = getV41HealthSnapshot(db);
    expect(snapshot).toHaveProperty("embeddings");
    expect(snapshot).toHaveProperty("workers");
    expect(snapshot).toHaveProperty("synthesis");
    expect(snapshot).toHaveProperty("eval");
    expect(snapshot).toHaveProperty("suppression");
    expect(Array.isArray(snapshot.workers)).toBe(true);
    db.close();
  });
});
