import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { SummaryStore } from "../src/store/summary-store.js";

/**
 * Wiring tests — ensures the v4.1 services aren't dead code.
 *
 * Final adversarial Finding #3 flagged that worker-orchestrator + leaf-
 * time embed + extraction queue were unwired. This file tests the
 * actually-wired paths.
 */

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false });
  db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s1', 'sk1')`).run();
  return db;
}

describe("Wiring — leaf-write hook enqueues lcm_extraction_queue", () => {
  it("inserting a leaf via SummaryStore enqueues an entity-extraction row", async () => {
    const db = setupDb();
    const store = new SummaryStore(db, { fts5Available: false });

    await store.insertSummary({
      summaryId: "leaf_x",
      conversationId: 1,
      kind: "leaf",
      content: "the test content",
      tokenCount: 100,
    });

    const row = db
      .prepare(`SELECT leaf_id, kind, completed_at FROM lcm_extraction_queue WHERE leaf_id = ?`)
      .get("leaf_x") as { leaf_id: string; kind: string; completed_at: string | null };
    expect(row).toBeDefined();
    expect(row.leaf_id).toBe("leaf_x");
    expect(row.kind).toBe("entity");
    expect(row.completed_at).toBeNull(); // unprocessed
    db.close();
  });

  it("inserting a CONDENSED summary does NOT enqueue (leaves only)", async () => {
    const db = setupDb();
    const store = new SummaryStore(db, { fts5Available: false });

    await store.insertSummary({
      summaryId: "cond_x",
      conversationId: 1,
      kind: "condensed",
      content: "x",
      tokenCount: 1,
    });

    const count = (
      db.prepare(`SELECT COUNT(*) AS n FROM lcm_extraction_queue`).get() as { n: number }
    ).n;
    expect(count).toBe(0);
    db.close();
  });

  it("queue insert failure (e.g. duplicate queue_id race) does NOT fail leaf-write", async () => {
    // Simulate the queue_id race by pre-inserting a row with the
    // deterministic-ish prefix shape used by the hook. The test
    // succeeds if insertSummary completes and the leaf is in summaries
    // even if the queue insert silently errored.
    const db = setupDb();
    const store = new SummaryStore(db, { fts5Available: false });

    // We can't easily race — use a malformed queue table to force
    // failure. Drop the queue table and insert; leaf-write should still
    // succeed.
    db.exec("DROP TABLE lcm_extraction_queue");
    const result = await store.insertSummary({
      summaryId: "leaf_resilient",
      conversationId: 1,
      kind: "leaf",
      content: "x",
      tokenCount: 100,
    });
    expect(result.summaryId).toBe("leaf_resilient");
    db.close();
  });
});
