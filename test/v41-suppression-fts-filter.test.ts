import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { SummaryStore } from "../src/store/summary-store.js";

/**
 * C.03 — verify suppressed summaries are filtered from FTS / LIKE / regex
 * search paths in SummaryStore. This is the v4.1 §10 invariant: every
 * agent-facing retrieval surface defaults to exclude-suppressed.
 *
 * vec0 paths (semantic-search, hybrid-search) have their own tests in
 * test/semantic-search.test.ts and test/hybrid-search.test.ts.
 */

function setupStore(): { db: DatabaseSync; store: SummaryStore } {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false }); // forces LIKE fallback
  db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s1', 'sk1')`).run();
  const store = new SummaryStore(db, { fts5Available: false });
  return { db, store };
}

function insertLeaf(
  db: DatabaseSync,
  summaryId: string,
  content: string,
  conversationId = 1,
): void {
  db.prepare(
    `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key)
     VALUES (?, ?, 'leaf', ?, 1, (SELECT session_key FROM conversations WHERE conversation_id = ?))`,
  ).run(summaryId, conversationId, content, conversationId);
}

describe("v4.1 C.03 — searchSummaries (LIKE fallback path) excludes suppressed", () => {
  it("LIKE / full_text path: suppressed summary not returned", async () => {
    const { db, store } = setupStore();
    insertLeaf(db, "leaf_visible", "The visible payment failure on 2026-04-01");
    insertLeaf(db, "leaf_suppressed", "The suppressed payment failure on 2026-04-02");
    db.prepare(`UPDATE summaries SET suppressed_at = ? WHERE summary_id = ?`).run(
      "2026-05-05",
      "leaf_suppressed",
    );

    const results = await store.searchSummaries({
      query: "payment failure",
      mode: "full_text",
    });
    expect(results.map((r) => r.summaryId)).toEqual(["leaf_visible"]);
    db.close();
  });

  it("regex path: suppressed summary not returned", async () => {
    const { db, store } = setupStore();
    insertLeaf(db, "leaf_visible", "Order #123 visible");
    insertLeaf(db, "leaf_suppressed", "Order #999 suppressed");
    db.prepare(`UPDATE summaries SET suppressed_at = ? WHERE summary_id = ?`).run(
      "2026-05-05",
      "leaf_suppressed",
    );

    const results = await store.searchSummaries({
      query: "Order #",
      mode: "regex",
    });
    expect(results.map((r) => r.summaryId)).toEqual(["leaf_visible"]);
    db.close();
  });

  it("un-suppressing a row restores it to search results", async () => {
    const { db, store } = setupStore();
    insertLeaf(db, "leaf_a", "the alpha doc");
    db.prepare(`UPDATE summaries SET suppressed_at = ? WHERE summary_id = ?`).run(
      "2026-05-05",
      "leaf_a",
    );
    expect(
      (await store.searchSummaries({ query: "alpha", mode: "full_text" })).map((r) => r.summaryId),
    ).toEqual([]);

    db.prepare(`UPDATE summaries SET suppressed_at = NULL WHERE summary_id = ?`).run("leaf_a");
    expect(
      (await store.searchSummaries({ query: "alpha", mode: "full_text" })).map((r) => r.summaryId),
    ).toEqual(["leaf_a"]);
    db.close();
  });

  it("CJK path (searchLikeCjk): suppressed rows hidden — Group C Finding #1", async () => {
    const { db, store } = setupStore();
    insertLeaf(db, "leaf_visible", "你好 hello rebase test");
    insertLeaf(db, "leaf_suppressed", "你好 hello rebase suppressed");
    db.prepare(`UPDATE summaries SET suppressed_at = ? WHERE summary_id = ?`).run(
      "2026-05-05",
      "leaf_suppressed",
    );

    // CJK queries route through searchCjkTrigram or searchLikeCjk based
    // on whether trigram returns hits. Either path must filter suppressed.
    const results = await store.searchSummaries({
      query: "你好",
      mode: "full_text",
    });
    expect(results.map((r) => r.summaryId)).toEqual(["leaf_visible"]);
    expect(results.map((r) => r.summaryId)).not.toContain("leaf_suppressed");
    db.close();
  });

  it("multiple suppressed rows all hidden in same query", async () => {
    const { db, store } = setupStore();
    insertLeaf(db, "leaf_a", "alpha doc");
    insertLeaf(db, "leaf_b", "alpha beta");
    insertLeaf(db, "leaf_c", "alpha gamma");
    db.prepare(`UPDATE summaries SET suppressed_at = ? WHERE summary_id IN (?, ?)`).run(
      "2026-05-05",
      "leaf_a",
      "leaf_c",
    );

    const results = await store.searchSummaries({ query: "alpha", mode: "full_text" });
    expect(results.map((r) => r.summaryId)).toEqual(["leaf_b"]);
    db.close();
  });
});
