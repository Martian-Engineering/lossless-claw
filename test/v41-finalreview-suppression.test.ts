import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { SummaryStore } from "../src/store/summary-store.js";
import { runPurge } from "../src/operator/purge.js";

/**
 * Final whole-PR adversarial review Finding #1 (BLOCKER) regression test.
 *
 * v4.1 §10 invariant: agent-facing surfaces NEVER return suppressed
 * content. The original Group C suppression-cascade landed for SEARCH
 * paths but missed the STRUCTURAL lookup paths:
 *   - getSummary(id)              → used by lcm_describe + assembler
 *   - getSummaryParents(id)       → used by lcm_describe lineage
 *   - getSummaryChildren(id)      → used by lcm_describe lineage + lcm_expand
 *   - getSummarySubtree(id)       → used by lcm_describe subtree
 * AND context_items rows referencing suppressed summaries weren't
 * cleaned up by runPurge — so the assembler's resolveSummaryItem
 * could re-emit purged content into every turn's context.
 *
 * This test locks in the fix: SummaryStore methods exclude suppressed
 * by default, runPurge cleans up context_items.
 */

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false });
  db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s1', 'sk1')`).run();
  return db;
}

function insertLeaf(db: DatabaseSync, id: string, content = "x"): void {
  db.prepare(
    `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key)
     VALUES (?, 1, 'leaf', ?, 100, 'sk1')`,
  ).run(id, content);
}

function insertCondensed(db: DatabaseSync, id: string, parentLeafIds: string[]): void {
  db.prepare(
    `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key)
     VALUES (?, 1, 'condensed', 'cond', 1, 'sk1')`,
  ).run(id);
  for (let i = 0; i < parentLeafIds.length; i++) {
    db.prepare(
      `INSERT INTO summary_parents (summary_id, parent_summary_id, ordinal) VALUES (?, ?, ?)`,
    ).run(id, parentLeafIds[i], i);
  }
}

describe("Final review #1 — getSummary excludes suppressed by default", () => {
  it("getSummary returns null for a suppressed leaf (was BLOCKER: returned full content)", async () => {
    const db = setupDb();
    insertLeaf(db, "leaf_a", "secret content");
    const store = new SummaryStore(db, { fts5Available: false });

    expect((await store.getSummary("leaf_a"))?.content).toBe("secret content");
    db.prepare(`UPDATE summaries SET suppressed_at = datetime('now') WHERE summary_id = ?`).run("leaf_a");
    expect(await store.getSummary("leaf_a")).toBeNull();
    db.close();
  });

  it("getSummary with includeSuppressed=true still returns suppressed (for integrity / compaction)", async () => {
    const db = setupDb();
    insertLeaf(db, "leaf_a", "internal-only content");
    db.prepare(`UPDATE summaries SET suppressed_at = datetime('now') WHERE summary_id = ?`).run("leaf_a");
    const store = new SummaryStore(db, { fts5Available: false });

    expect(await store.getSummary("leaf_a")).toBeNull();
    expect((await store.getSummary("leaf_a", { includeSuppressed: true }))?.content).toBe(
      "internal-only content",
    );
    db.close();
  });
});

describe("Final review #1 — getSummaryChildren / getSummaryParents exclude suppressed", () => {
  it("suppressed parents not returned by getSummaryParents", async () => {
    const db = setupDb();
    insertLeaf(db, "leaf_a", "alpha");
    insertLeaf(db, "leaf_b", "beta (suppressed)");
    insertCondensed(db, "cond_x", ["leaf_a", "leaf_b"]);
    db.prepare(`UPDATE summaries SET suppressed_at = datetime('now') WHERE summary_id = ?`).run("leaf_b");

    const store = new SummaryStore(db, { fts5Available: false });
    const parents = await store.getSummaryParents("cond_x");
    expect(parents.map((p) => p.summaryId)).toEqual(["leaf_a"]);
    db.close();
  });

  it("suppressed children not returned by getSummaryChildren", async () => {
    const db = setupDb();
    insertLeaf(db, "leaf_a");
    insertCondensed(db, "cond_x", ["leaf_a"]);
    insertCondensed(db, "cond_suppressed", ["leaf_a"]);
    db.prepare(`UPDATE summaries SET suppressed_at = datetime('now') WHERE summary_id = ?`).run(
      "cond_suppressed",
    );

    const store = new SummaryStore(db, { fts5Available: false });
    const children = await store.getSummaryChildren("leaf_a");
    expect(children.map((c) => c.summaryId)).toEqual(["cond_x"]);
    db.close();
  });

  it("includeSuppressed=true still returns suppressed (integrity path)", async () => {
    const db = setupDb();
    insertLeaf(db, "leaf_a");
    insertLeaf(db, "leaf_b");
    insertCondensed(db, "cond_x", ["leaf_a", "leaf_b"]);
    db.prepare(`UPDATE summaries SET suppressed_at = datetime('now') WHERE summary_id = ?`).run("leaf_b");

    const store = new SummaryStore(db, { fts5Available: false });
    const all = await store.getSummaryParents("cond_x", { includeSuppressed: true });
    expect(all.map((p) => p.summaryId).sort()).toEqual(["leaf_a", "leaf_b"]);
    db.close();
  });
});

describe("Final review #1 — getSummarySubtree excludes suppressed nodes", () => {
  it("subtree from a leaf with suppressed condensed-children: omits the suppressed", async () => {
    // Walk: leaf_a → cond_visible (active), cond_hidden (suppressed)
    // summary_parents schema: summary_id = child, parent_summary_id = parent
    // So traversal from leaf_a finds rows with parent_summary_id=leaf_a
    // → child summaries cond_visible + cond_hidden.
    const db = setupDb();
    insertLeaf(db, "leaf_a");
    insertCondensed(db, "cond_visible", ["leaf_a"]);
    insertCondensed(db, "cond_hidden", ["leaf_a"]);
    db.prepare(`UPDATE summaries SET suppressed_at = datetime('now') WHERE summary_id = ?`).run(
      "cond_hidden",
    );

    const store = new SummaryStore(db, { fts5Available: false });
    const subtree = await store.getSummarySubtree("leaf_a");
    expect(subtree.map((n) => n.summaryId)).toContain("cond_visible");
    expect(subtree.map((n) => n.summaryId)).not.toContain("cond_hidden");
    db.close();
  });
});

describe("Final review #1 — runPurge cleans up context_items", () => {
  it("soft purge removes context_items rows so assembler can't re-emit", () => {
    const db = setupDb();
    insertLeaf(db, "leaf_a");

    // Simulate the assembler having recorded this leaf in context_items
    db.prepare(
      `INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id, created_at)
       VALUES (1, 1, 'summary', ?, datetime('now'))`,
    ).run("leaf_a");

    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM context_items WHERE summary_id = ?`).get("leaf_a") as { n: number }).n,
    ).toBe(1);

    const result = runPurge(db, {
      summaryIds: ["leaf_a"],
      reason: "test",
    });

    expect(result.affectedLeafIds).toEqual(["leaf_a"]);
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM context_items WHERE summary_id = ?`).get("leaf_a") as { n: number }).n,
    ).toBe(0); // Cleaned up — assembler can no longer resolve this
    db.close();
  });

  it("immediate purge also cleans up context_items", () => {
    const db = setupDb();
    insertLeaf(db, "leaf_a");
    db.prepare(
      `INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id, created_at)
       VALUES (1, 1, 'summary', ?, datetime('now'))`,
    ).run("leaf_a");

    // Wave-9 TS-tightening: mode='immediate' was REMOVED during
    // first-principles cuts (2026-05-06) — runPurge always operates
    // in soft-suppression mode now. context_items still get cleaned
    // because the soft-purge path runs the cascade DELETE regardless.
    runPurge(db, {
      summaryIds: ["leaf_a"],
      reason: "test",
    });

    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM context_items WHERE summary_id = ?`).get("leaf_a") as { n: number }).n,
    ).toBe(0);
    db.close();
  });

  it("purge does NOT touch context_items for non-targeted summaries", () => {
    const db = setupDb();
    insertLeaf(db, "leaf_a");
    insertLeaf(db, "leaf_b");
    db.prepare(
      `INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id, created_at)
       VALUES (1, 1, 'summary', 'leaf_a', datetime('now')),
              (1, 2, 'summary', 'leaf_b', datetime('now'))`,
    ).run();

    runPurge(db, { summaryIds: ["leaf_a"], reason: "test" });

    const remaining = db
      .prepare(`SELECT summary_id FROM context_items ORDER BY ordinal`)
      .all() as Array<{ summary_id: string }>;
    expect(remaining).toEqual([{ summary_id: "leaf_b" }]);
    db.close();
  });
});
