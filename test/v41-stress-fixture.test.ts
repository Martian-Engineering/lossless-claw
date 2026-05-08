/**
 * Stress fixture tests — exercise corpus-shape edges that the small
 * `v41-test-corpus.ts` (80 leaves) cannot expose.
 *
 * Wave-10 antipattern A4 closure (corpus-shape weaknesses).
 *
 * # Why these tests are in their own file
 *
 * The stress fixture builds 2000+ leaves and 100+ condenseds. Even
 * though the build is <1s, repeated rebuilds across the 1400+ small-
 * fixture tests would inflate suite time. By isolating the stress
 * tests in this file, the small fixture stays default-fast and stress
 * scenarios run only when this file is invoked.
 *
 * Ten tests covering:
 *   1. Build smoke (size + time)
 *   2. Determinism (twice-built corpus has identical digest + counts)
 *   3. Distribution validation (last7d ≈ 30%, suppression ≈ 5-10%)
 *   4. Dense-day query (>100 leaves in a 24h window)
 *   5. FTS5 performance under load
 *   6. Suppression cascade across many shared parents
 *   7. vec0 KNN with realistic vector counts (skipped if vec0 absent)
 *   8. Adversarial content does not break parsers
 *   9. Near-duplicate leaves both surface (no silent collapse)
 *  10. Recency floor (K=200 most recent recoverable)
 *  + bonus: long-leaf handling (50K-token adversarial leaf is stored)
 */

import { existsSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ADVERSARIAL_LEAVES,
  buildStressTestCorpus,
  STRESS_BASE_DATE,
} from "./fixtures/v41-stress-corpus.js";
import {
  ensureEmbeddingsTable,
  recordEmbedding,
  registerEmbeddingProfile,
  tryLoadSqliteVec,
} from "../src/embeddings/store.js";

// ────────────────────────────────────────────────────────────────────
// Optional vec0 setup — KNN tests are gated on availability.
//
// vitest can override HOME to a tmp dir, so `homedir()` is unreliable
// inside a test. Mirror the semantic-recall test pattern: prefer the
// explicit env var, then fall back to REAL_HOME, then the dev box's
// canonical path.
// ────────────────────────────────────────────────────────────────────

const VEC0_PATH =
  process.env.LCM_TEST_VEC0_PATH?.trim() ||
  (() => {
    const realHome = process.env.REAL_HOME?.trim() || "/Users/lume";
    const ext =
      platform() === "win32"
        ? "dll"
        : platform() === "darwin"
          ? "dylib"
          : "so";
    const platformPkg = `sqlite-vec-${platform() === "win32" ? "windows" : platform()}-${arch()}`;
    return join(
      realHome,
      ".openclaw",
      "extensions",
      "node_modules",
      platformPkg,
      `vec0.${ext}`,
    );
  })();
const VEC0_AVAILABLE = existsSync(VEC0_PATH);

// ────────────────────────────────────────────────────────────────────
// Per-test fixture management
// ────────────────────────────────────────────────────────────────────

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
});

afterEach(() => {
  db.close();
});

describe("v4.1 stress fixture — corpus-shape edges", () => {
  it("(1) builds in <30s and produces 1500-2500 leaves", () => {
    const t0 = performance.now();
    const meta = buildStressTestCorpus(db);
    const buildMs = performance.now() - t0;

    expect(buildMs).toBeLessThan(30_000);
    expect(meta.leafCount).toBeGreaterThanOrEqual(1500);
    expect(meta.leafCount).toBeLessThanOrEqual(2500);
    expect(meta.condensedCount).toBeGreaterThanOrEqual(100);
    expect(meta.condensedCount).toBeLessThanOrEqual(200);
    expect(meta.entityCount).toBeGreaterThanOrEqual(30);
    expect(meta.entityCount).toBeLessThanOrEqual(60);
    expect(meta.conversationCount).toBeGreaterThanOrEqual(8);
    expect(meta.conversationCount).toBeLessThanOrEqual(15);

    // Confirm DB row counts agree with meta.
    const sumCount = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM summaries WHERE kind = 'leaf'`)
        .get() as { n: number }
    ).n;
    expect(sumCount).toBe(meta.leafCount);
  });

  it("(2) is deterministic — twice-built corpus has identical digest + counts", () => {
    const m1 = buildStressTestCorpus(db);
    const db2 = new DatabaseSync(":memory:");
    try {
      const m2 = buildStressTestCorpus(db2);
      expect(m2.contentDigest).toBe(m1.contentDigest);
      expect(m2.leafCount).toBe(m1.leafCount);
      expect(m2.condensedCount).toBe(m1.condensedCount);
      expect(m2.entityCount).toBe(m1.entityCount);
      expect(m2.suppressedCount).toBe(m1.suppressedCount);
      expect(m2.bucketCounts.last7d).toBe(m1.bucketCounts.last7d);
      expect(m2.bucketCounts.last30d).toBe(m1.bucketCounts.last30d);
      expect(m2.bucketCounts.older).toBe(m1.bucketCounts.older);
    } finally {
      db2.close();
    }
  });

  it("(3) has the expected time + suppression distribution", () => {
    const meta = buildStressTestCorpus(db);
    const total = meta.leafCount;
    const last7Pct = (meta.bucketCounts.last7d / total) * 100;
    const last30Pct = (meta.bucketCounts.last30d / total) * 100;
    const olderPct = (meta.bucketCounts.older / total) * 100;
    const suppressionPct = (meta.suppressedCount / total) * 100;

    // ±5pp band on each bucket (briefing: 30% / 40% / 30%)
    expect(last7Pct).toBeGreaterThanOrEqual(25);
    expect(last7Pct).toBeLessThanOrEqual(35);
    expect(last30Pct).toBeGreaterThanOrEqual(35);
    expect(last30Pct).toBeLessThanOrEqual(45);
    expect(olderPct).toBeGreaterThanOrEqual(25);
    expect(olderPct).toBeLessThanOrEqual(35);

    // Suppression rate within 5-10% (briefing target)
    expect(suppressionPct).toBeGreaterThanOrEqual(5);
    expect(suppressionPct).toBeLessThanOrEqual(10);
  });

  it("(4) dense day window contains >100 leaves in correct chronological order", () => {
    const meta = buildStressTestCorpus(db);
    expect(meta.denseDay.leafCount).toBeGreaterThan(100);

    // Query the actual DB by created_at within ±12h of dense day center.
    const centerMs =
      STRESS_BASE_DATE.getTime() - meta.denseDay.centerHoursAgo * 3600 * 1000;
    const lo = new Date(centerMs - 12 * 3600 * 1000).toISOString();
    const hi = new Date(centerMs + 12 * 3600 * 1000).toISOString();
    const rows = db
      .prepare(
        `SELECT summary_id, created_at FROM summaries
           WHERE kind = 'leaf' AND created_at BETWEEN ? AND ?
           ORDER BY created_at ASC`,
      )
      .all(lo, hi) as Array<{ summary_id: string; created_at: string }>;

    expect(rows.length).toBeGreaterThan(100);
    // Confirm chronological ordering (no duplicates / out-of-order).
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.created_at >= rows[i - 1]!.created_at).toBe(true);
    }
  });

  it("(5) FTS5 hybrid-shaped query against stress fixture completes in <500ms", () => {
    buildStressTestCorpus(db);

    // Note: FTS5 treats unquoted hyphens as NOT operators; we phrase-quote
    // tokens with hyphens to mirror what the production sanitizer does.
    const queries = [
      "Voyage rerank",
      "race condition plan",
      "gateway timeout",
      `"operator-VM" customer`,
      "plan mode persistence",
    ];

    for (const q of queries) {
      const t0 = performance.now();
      const rows = db
        .prepare(
          `SELECT s.summary_id, snippet(summaries_fts, 1, '', '', '...', 32) AS snip
             FROM summaries_fts
             JOIN summaries s ON s.summary_id = summaries_fts.summary_id
             WHERE summaries_fts MATCH ?
               AND s.suppressed_at IS NULL
             ORDER BY rank
             LIMIT 50`,
        )
        .all(q) as Array<{ summary_id: string; snip: string }>;
      const ms = performance.now() - t0;

      // FTS5 over 2000+ rows should be sub-100ms; cap at 500ms for CI noise.
      expect(ms).toBeLessThan(500);
      // Each query should hit something — the topic templates cover all of these.
      expect(rows.length).toBeGreaterThan(0);
    }
  });

  it("(6) suppression cascade: marking a parent suppressed sweeps dependents', leaves intact", () => {
    buildStressTestCorpus(db);

    // Pick the largest level-1 condensed by child count.
    const condRow = db
      .prepare(
        `SELECT parent_summary_id AS parent, COUNT(*) AS n
           FROM summary_parents
           WHERE parent_summary_id LIKE 'sum_cond1_%'
           GROUP BY parent_summary_id
           ORDER BY n DESC LIMIT 1`,
      )
      .get() as { parent: string; n: number } | undefined;
    expect(condRow).toBeDefined();
    expect(condRow!.n).toBeGreaterThanOrEqual(3);

    // Suppress the parent.
    db.prepare(
      `UPDATE summaries SET suppressed_at = datetime('now') WHERE summary_id = ?`,
    ).run(condRow!.parent);

    // The parent_summary_id link still exists (FK preserved).
    const childRows = db
      .prepare(
        `SELECT sp.summary_id, s.suppressed_at AS child_suppressed
           FROM summary_parents sp
           JOIN summaries s ON s.summary_id = sp.summary_id
           WHERE sp.parent_summary_id = ?`,
      )
      .all(condRow!.parent) as Array<{
      summary_id: string;
      child_suppressed: string | null;
    }>;
    expect(childRows.length).toBe(condRow!.n);

    // Default reads should now exclude the parent but keep the children visible.
    const visibleCondensed = db
      .prepare(
        `SELECT 1 FROM summaries WHERE summary_id = ? AND suppressed_at IS NULL`,
      )
      .get(condRow!.parent);
    expect(visibleCondensed).toBeUndefined();

    // Children still visible (only parent was suppressed).
    const visibleChildren = childRows.filter((r) => r.child_suppressed == null);
    expect(visibleChildren.length).toBe(condRow!.n);
  });

  it("(7) vec0 KNN returns top-K under realistic vector counts", () => {
    if (!VEC0_AVAILABLE) {
      // Graceful skip when vec0 isn't installed — see the SEMANTIC tests
      // pattern. CI may not have the dylib. We mark the test as a no-op
      // PASS in this case (mirrors lcm_grep semantic-mode tests).
      // eslint-disable-next-line no-console
      console.log(`[stress-fixture] vec0 not available at ${VEC0_PATH} — skipping KNN test`);
      return;
    }

    const db2 = new DatabaseSync(":memory:", { allowExtension: true });
    try {
      tryLoadSqliteVec(db2, { path: VEC0_PATH, silent: true });
      buildStressTestCorpus(db2);

      // Register a small profile + table (dim 8 — keep tests cheap).
      const dim = 8;
      registerEmbeddingProfile(db2, "stress-test-model", dim);
      ensureEmbeddingsTable(db2, "stress-test-model", dim);

      // Pick the first 100 visible leaves; assign deterministic
      // pseudo-random unit-ish vectors (we don't need true unit norm
      // for KNN to work — vec0 returns L2 ordering either way).
      const leaves = db2
        .prepare(
          `SELECT summary_id FROM summaries
             WHERE kind = 'leaf' AND suppressed_at IS NULL
             ORDER BY summary_id LIMIT 100`,
        )
        .all() as Array<{ summary_id: string }>;
      expect(leaves.length).toBe(100);

      for (let i = 0; i < leaves.length; i++) {
        // Deterministic vector keyed on i.
        const v = new Float32Array(dim);
        for (let j = 0; j < dim; j++) {
          v[j] = Math.sin((i + 1) * (j + 1) * 0.31415);
        }
        recordEmbedding(db2, {
          modelName: "stress-test-model",
          embeddedId: leaves[i]!.summary_id,
          embeddedKind: "summary",
          vector: v,
          sourceTokenCount: 100,
        });
      }

      // KNN query against a probe vector.
      const probe = new Float32Array(dim);
      for (let j = 0; j < dim; j++) probe[j] = Math.sin((j + 1) * 0.31415);
      const probeJson = JSON.stringify(Array.from(probe));

      const t0 = performance.now();
      const knn = db2
        .prepare(
          `SELECT embedded_id, distance FROM lcm_embeddings_stresstestmodel
             WHERE embedding MATCH ? AND k = 10
             ORDER BY distance`,
        )
        .all(probeJson) as Array<{ embedded_id: string; distance: number }>;
      const ms = performance.now() - t0;

      expect(knn.length).toBe(10);
      expect(ms).toBeLessThan(100);
      // Distances should be non-decreasing (KNN ORDER BY distance).
      for (let i = 1; i < knn.length; i++) {
        expect(knn[i]!.distance).toBeGreaterThanOrEqual(knn[i - 1]!.distance);
      }
    } finally {
      db2.close();
    }
  });

  it("(8) adversarial content does not break parsers — grep/read paths return safely", () => {
    buildStressTestCorpus(db);

    // Verify all 6 adversarial leaves were inserted with their expected content.
    for (const adv of ADVERSARIAL_LEAVES) {
      const row = db
        .prepare(
          `SELECT summary_id, content FROM summaries WHERE summary_id = ?`,
        )
        .get(adv.summary_id) as
        | { summary_id: string; content: string }
        | undefined;
      expect(row).toBeDefined();
      expect(row!.summary_id).toBe(adv.summary_id);
      // Extreme-length leaf has expanded content; others use the literal text.
      if (adv.summary_id === "sum_adv_extreme_length") {
        expect(row!.content.length).toBeGreaterThan(100_000);
      } else {
        expect(row!.content).toBe(adv.content);
      }
    }

    // SQL injection probe: confirm summaries table still exists post-build.
    const sumExists = (
      db
        .prepare(
          `SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='summaries'`,
        )
        .get() as { ok?: number } | undefined
    )?.ok;
    expect(sumExists).toBe(1);

    // Verify each adversarial leaf is reachable via FTS by its unique
    // marker. (Skip extreme-length; its filler text is repetitive.)
    const ftsProbes = [
      { id: "sum_adv_template", phrase: "interpolation" },
      { id: "sum_adv_envelope", phrase: "envelope" },
      { id: "sum_adv_xss", phrase: "Reproduction notes" },
      { id: "sum_adv_sql", phrase: "injection probe" },
      { id: "sum_adv_malformed_json", phrase: "Defensive" },
    ];
    for (const p of ftsProbes) {
      const hit = db
        .prepare(
          `SELECT s.summary_id FROM summaries_fts
             JOIN summaries s ON s.summary_id = summaries_fts.summary_id
             WHERE summaries_fts MATCH ?
               AND s.suppressed_at IS NULL
             LIMIT 5`,
        )
        .all(p.phrase) as Array<{ summary_id: string }>;
      const found = hit.find((h) => h.summary_id === p.id);
      expect(
        found,
        `expected FTS5 to find "${p.phrase}" → ${p.id}; got ${JSON.stringify(hit.map((h) => h.summary_id))}`,
      ).toBeDefined();
    }
  });

  it("(9) near-duplicate leaves both surface — no silent collapse", () => {
    buildStressTestCorpus(db);

    const rows = db
      .prepare(
        `SELECT s.summary_id, s.content
           FROM summaries_fts
           JOIN summaries s ON s.summary_id = summaries_fts.summary_id
           WHERE summaries_fts MATCH ?
             AND s.suppressed_at IS NULL`,
      )
      .all("paraphrastic recall") as Array<{
      summary_id: string;
      content: string;
    }>;
    const ids = rows.map((r) => r.summary_id);
    expect(ids).toContain("sum_neardup_a");
    expect(ids).toContain("sum_neardup_b");

    // Bodies differ only in PR number — confirm.
    const a = rows.find((r) => r.summary_id === "sum_neardup_a")!;
    const b = rows.find((r) => r.summary_id === "sum_neardup_b")!;
    expect(a.content).toContain("PR #614");
    expect(b.content).toContain("PR #615");
    expect(a.content).not.toBe(b.content);
  });

  it("(10) recency floor: K=200 most-recent leaves are recoverable in chronological order", () => {
    buildStressTestCorpus(db);

    const rows = db
      .prepare(
        `SELECT summary_id, created_at FROM summaries
           WHERE kind = 'leaf' AND suppressed_at IS NULL
           ORDER BY created_at DESC
           LIMIT 200`,
      )
      .all() as Array<{ summary_id: string; created_at: string }>;
    expect(rows.length).toBe(200);

    // Confirm strictly non-increasing created_at (newest first).
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.created_at <= rows[i - 1]!.created_at).toBe(true);
    }

    // The oldest in the recency-200 should still be relatively recent
    // (within roughly the last 7-15 days) — a quick sanity check that
    // the bulk distribution biases toward recency.
    const oldestMs = new Date(rows[199]!.created_at).getTime();
    const ageDays =
      (STRESS_BASE_DATE.getTime() - oldestMs) / (1000 * 60 * 60 * 24);
    // Generous bound: top-200 should cover at most ~30 days even with
    // ~30% of leaves being older.
    expect(ageDays).toBeLessThan(30);
  });

  it("(bonus) extreme-length adversarial leaf is stored intact", () => {
    buildStressTestCorpus(db);

    const row = db
      .prepare(
        `SELECT length(content) AS clen, token_count FROM summaries WHERE summary_id = ?`,
      )
      .get("sum_adv_extreme_length") as
      | { clen: number; token_count: number }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.clen).toBeGreaterThan(100_000);
    expect(row!.token_count).toBeGreaterThan(10_000);
  });
});
