#!/usr/bin/env node
/**
 * v41 stress-fixture benchmark — exposes perf measurements for the
 * stress corpus build + a few representative read-path queries.
 *
 * Why a separate script:
 * - Vitest tests assert correctness with generous time budgets (CI noise
 *   tolerance), so they're not great for tracking perf trends.
 * - This script prints raw numbers so an operator can compare across
 *   commits ("did my change make FTS slower?").
 *
 * Usage (run via tsx so TS imports resolve):
 *   npx tsx scripts/v41-stress-bench.mjs [--target N] [--runs M] [--seed S]
 *
 *   --target  total leaves to generate (default 2000, clamped 1500..2500)
 *   --runs    repetitions of each measurement (default 3, median reported)
 *   --seed    RNG seed (default 42)
 *
 * Exits 0 on success.
 */

import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

function getArg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx === process.argv.length - 1) return fallback;
  return process.argv[idx + 1];
}

const target = Number(getArg("target", "2000"));
const runs = Number(getArg("runs", "3"));
const seed = Number(getArg("seed", "42"));

if (!Number.isFinite(target) || !Number.isFinite(runs) || !Number.isFinite(seed)) {
  console.error("invalid numeric arg");
  process.exit(1);
}

// Run via `npx tsx scripts/v41-stress-bench.mjs` so the TS imports
// inside the fixture resolve. We assume cwd is the repo root.
const { buildStressTestCorpus } = await import(
  `${process.cwd()}/test/fixtures/v41-stress-corpus.ts`
);

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function timed(fn) {
  const t0 = performance.now();
  const v = fn();
  return [performance.now() - t0, v];
}

console.log(
  `[v41-stress-bench] target=${target} runs=${runs} seed=${seed}\n`,
);

// ── Bench 1: full build ──────────────────────────────────────────────
const buildTimes = [];
let buildMeta = null;
for (let r = 0; r < runs; r++) {
  const db = new DatabaseSync(":memory:");
  const [ms, meta] = timed(() => buildStressTestCorpus(db, { seed, targetLeafCount: target }));
  buildTimes.push(ms);
  if (!buildMeta) buildMeta = meta;
  db.close();
}
console.log(
  `build:        median=${median(buildTimes).toFixed(0)}ms  ` +
    `(min=${Math.min(...buildTimes).toFixed(0)}, max=${Math.max(...buildTimes).toFixed(0)})\n` +
    `  → leaves=${buildMeta.leafCount} cond=${buildMeta.condensedCount} ` +
    `entities=${buildMeta.entityCount} suppressed=${buildMeta.suppressedCount}\n` +
    `  → buckets last7d=${buildMeta.bucketCounts.last7d} last30d=${buildMeta.bucketCounts.last30d} older=${buildMeta.bucketCounts.older}\n` +
    `  → contentDigest=${buildMeta.contentDigest}\n`,
);

// ── Reusable DB for read benches ─────────────────────────────────────
const db = new DatabaseSync(":memory:");
buildStressTestCorpus(db, { seed, targetLeafCount: target });

// ── Bench 2: FTS5 query ──────────────────────────────────────────────
const ftsQueries = [
  "Voyage rerank",
  "race condition plan",
  '"operator-VM" customer',
  "plan mode persistence",
];
console.log("FTS5 query times (median over runs):");
for (const q of ftsQueries) {
  const ts = [];
  let hits = 0;
  for (let r = 0; r < runs; r++) {
    const [ms, rows] = timed(() =>
      db
        .prepare(
          `SELECT s.summary_id FROM summaries_fts
             JOIN summaries s ON s.summary_id = summaries_fts.summary_id
             WHERE summaries_fts MATCH ?
               AND s.suppressed_at IS NULL
             ORDER BY rank LIMIT 50`,
        )
        .all(q),
    );
    ts.push(ms);
    hits = rows.length;
  }
  console.log(`  "${q}": ${median(ts).toFixed(1)}ms  (${hits} hits)`);
}

// ── Bench 3: recency window ──────────────────────────────────────────
const recencyTs = [];
let recencyHits = 0;
for (let r = 0; r < runs; r++) {
  const [ms, rows] = timed(() =>
    db
      .prepare(
        `SELECT summary_id, created_at FROM summaries
           WHERE kind = 'leaf' AND suppressed_at IS NULL
           ORDER BY created_at DESC LIMIT 200`,
      )
      .all(),
  );
  recencyTs.push(ms);
  recencyHits = rows.length;
}
console.log(
  `\nrecency K=200: median=${median(recencyTs).toFixed(1)}ms  (${recencyHits} hits)`,
);

// ── Bench 4: dense day window ────────────────────────────────────────
const denseDayTs = [];
let denseHits = 0;
for (let r = 0; r < runs; r++) {
  const [ms, rows] = timed(() =>
    db
      .prepare(
        `SELECT summary_id FROM summaries
           WHERE kind = 'leaf'
             AND created_at BETWEEN datetime('2026-04-23T00:00:00Z') AND datetime('2026-04-24T00:00:00Z')
             AND suppressed_at IS NULL`,
      )
      .all(),
  );
  denseDayTs.push(ms);
  denseHits = rows.length;
}
console.log(
  `dense-day:     median=${median(denseDayTs).toFixed(1)}ms  (${denseHits} hits)`,
);

// ── Bench 5: parent → children traversal ─────────────────────────────
const parentRow = db
  .prepare(
    `SELECT parent_summary_id AS parent FROM summary_parents
       WHERE parent_summary_id LIKE 'sum_cond1_%'
       GROUP BY parent_summary_id ORDER BY COUNT(*) DESC LIMIT 1`,
  )
  .get();

const cascadeTs = [];
for (let r = 0; r < runs; r++) {
  const [ms] = timed(() =>
    db
      .prepare(
        `SELECT s.summary_id FROM summary_parents sp
           JOIN summaries s ON s.summary_id = sp.summary_id
           WHERE sp.parent_summary_id = ?`,
      )
      .all(parentRow.parent),
  );
  cascadeTs.push(ms);
}
console.log(
  `cascade-fanout: median=${median(cascadeTs).toFixed(2)}ms  (parent=${parentRow.parent})`,
);

db.close();
console.log("\n[v41-stress-bench] done");
process.exit(0);
