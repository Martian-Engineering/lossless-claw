#!/usr/bin/env node
/**
 * v4.1 agent harness — PRE-FLIGHT step.
 *
 * Sets up the harness DB exactly the way an agent-harness session needs it:
 *   1. Copy ~/.openclaw/lcm.db → harness DB (separate file, never touches live DB)
 *   2. Load sqlite-vec; run runLcmMigrations
 *   3. Init semantic infra (register voyage-4-large profile, ensure vec0 table)
 *   4. Run FULL Voyage backfill (not just 20 sample docs like the live-DB harness)
 *      Embeds all unembedded leaves at 0.5 RPS = ~1hr for 4187 leaves, ~$1.
 *      This is the "Voyage actually working" validation Eva asked for.
 *
 * After this completes, the harness DB has every leaf embedded + vec0 table
 * populated. The agent harness can then exercise lcm_grep --mode hybrid /
 * lcm_semantic_recall against real embedded data and get real semantic hits.
 *
 * USAGE:
 *   VOYAGE_API_KEY=$(cat ~/.openclaw/credentials/voyage-api-key) \
 *   LCM_TEST_VEC0_PATH=/Users/lume/.openclaw/extensions/node_modules/sqlite-vec-darwin-arm64/vec0.dylib \
 *     npx tsx scripts/v41-agent-harness-preflight.mjs
 *
 * On completion, prints the harness DB path. Use that path with
 *   LCM_HARNESS_DB=<path> npx tsx scripts/v41-agent-harness.mjs
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SRC = process.env.LCM_HARNESS_SRC_DB ?? join(homedir(), ".openclaw", "lcm.db");
const DST_DIR = process.env.LCM_HARNESS_DST_DIR ?? "/Volumes/LEXAR/lcm-tmp/agent-harness-2026-05-06";
const VEC0_PATH =
  process.env.LCM_TEST_VEC0_PATH ??
  join(homedir(), ".openclaw", "extensions", "node_modules", "sqlite-vec-darwin-arm64", "vec0.dylib");

const log = (msg) => console.log(`[preflight] ${msg}`);
const ok = (msg) => console.log(`[preflight] ✓ ${msg}`);
const fail = (msg) => console.error(`[preflight] ✗ ${msg}`);

if (!existsSync(SRC)) {
  fail(`Source DB not found: ${SRC}`);
  process.exit(1);
}
if (!process.env.VOYAGE_API_KEY?.trim()) {
  fail("VOYAGE_API_KEY env var is empty. Set it from ~/.openclaw/credentials/voyage-api-key");
  process.exit(1);
}
if (!existsSync(VEC0_PATH)) {
  fail(`vec0 dylib not found at ${VEC0_PATH}. Set LCM_TEST_VEC0_PATH.`);
  process.exit(1);
}

mkdirSync(DST_DIR, { recursive: true });
const DST = join(DST_DIR, `lcm-agent-harness.db`);

if (existsSync(DST) && process.env.LCM_HARNESS_REUSE_DB !== "true") {
  log(`harness DB already exists at ${DST}.`);
  log(`set LCM_HARNESS_REUSE_DB=true to reuse it (skips copy + backfill).`);
  log(`otherwise delete it manually to force a fresh copy.`);
  process.exit(0);
}

if (!existsSync(DST)) {
  // The live DB is WAL-mode + the gateway is actively writing, so a raw
  // copyFileSync of just the .db file produces a "malformed" snapshot
  // (WAL changes aren't included). Use SQLite's VACUUM INTO for atomic
  // snapshot — it acquires a read transaction + writes a clean
  // consistent copy of the entire DB.
  log(`creating atomic VACUUM INTO snapshot ${SRC} → ${DST} (~2.6GB; takes a few min)...`);
  const t0 = Date.now();
  const snapDb = new DatabaseSync(SRC, { readOnly: true });
  try {
    snapDb.exec(`VACUUM INTO '${DST.replace(/'/g, "''")}'`);
  } finally {
    snapDb.close();
  }
  log(`snapshot complete in ${Math.round((Date.now() - t0) / 1000)}s`);
}

// ── Migration ─────────────────────────────────────────────────────
log("opening DB + running v4.1 migration...");
const dbWrite = new DatabaseSync(DST, { allowExtension: true });
dbWrite.exec("PRAGMA foreign_keys=ON;");

const { runLcmMigrations } = await import(`${process.cwd()}/src/db/migration.ts`);
const migT0 = Date.now();
runLcmMigrations(dbWrite, { fts5Available: true });
ok(`migration complete in ${Math.round((Date.now() - migT0) / 1000)}s`);

// ── Load sqlite-vec ────────────────────────────────────────────────
const { tryLoadSqliteVec, vec0Version, registerEmbeddingProfile, ensureEmbeddingsTable } = await import(
  `${process.cwd()}/src/embeddings/store.ts`
);
const loaded = tryLoadSqliteVec(dbWrite, { path: VEC0_PATH });
if (!loaded) {
  fail(`sqlite-vec load failed (path=${VEC0_PATH})`);
  process.exit(1);
}
const version = vec0Version(dbWrite);
ok(`sqlite-vec loaded: ${version ?? "(version probe failed)"}`);

// ── Register Voyage profile + ensure vec0 table ────────────────────
try {
  registerEmbeddingProfile(dbWrite, "voyage-4-large", 1024);
  ok(`profile registered: voyage-4-large dim=1024`);
} catch (e) {
  // Idempotent: already registered is fine
  if (e instanceof Error && e.message.includes("already")) {
    ok(`profile already registered: voyage-4-large`);
  } else {
    throw e;
  }
}

ensureEmbeddingsTable(dbWrite, "voyage-4-large", 1024);
ok(`vec0 table ensured: lcm_embeddings_voyage4large`);

// ── Run FULL backfill ──────────────────────────────────────────────
const { runBackfillTick, countPendingDocs } = await import(
  `${process.cwd()}/src/embeddings/backfill.ts`
);
const tickEmbeddingBackfill = runBackfillTick; // alias for clarity

const initialPending = countPendingDocs(dbWrite, { modelName: "voyage-4-large" });
log(`initial pending docs: ${initialPending}`);

if (initialPending === 0) {
  ok("nothing to backfill — corpus already fully embedded");
  dbWrite.close();
  console.log("");
  console.log("[preflight] ✅ READY. Harness DB at:");
  console.log(DST);
  process.exit(0);
}

log(`running FULL backfill at 0.5 RPS (estimated ${Math.ceil(initialPending / 0.5 / 60)} min, ~$${(initialPending * 0.0001).toFixed(2)} cost)`);
log(`progress reported every 200 docs (one tick).`);

let totalEmbedded = 0;
let totalSkipped = 0;
let totalTokens = 0;
let tickN = 0;

while (true) {
  tickN++;
  const tickT0 = Date.now();
  const result = await tickEmbeddingBackfill(dbWrite, {
    modelName: "voyage-4-large",
    voyageModel: "voyage-4-large",
    inputType: "document",
    voyageMaxRetries: 1,
    voyageTimeoutMs: 30_000,
    maxRequestsPerSecond: 0.5,
    perTickLimit: 200,
  });
  const tickDuration = Math.round((Date.now() - tickT0) / 1000);

  if (result.lockNotAcquired) {
    log("tick: lock held; waiting 60s before retry");
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    continue;
  }

  totalEmbedded += result.embeddedCount;
  totalSkipped += result.skipped.length;
  totalTokens += result.voyageTokensConsumed;

  const remaining = countPendingDocs(dbWrite, { modelName: "voyage-4-large" });
  log(
    `tick ${tickN}: embedded=${result.embeddedCount} skipped=${result.skipped.length} tokens=${result.voyageTokensConsumed} duration=${tickDuration}s | total embedded=${totalEmbedded} pending=${remaining}`,
  );

  if (remaining === 0) {
    ok(`backfill complete: ${totalEmbedded} embedded total, ${totalSkipped} skipped, ${totalTokens} Voyage tokens consumed`);
    break;
  }
  if (result.embeddedCount === 0 && result.skipped.length > 0) {
    fail(`tick produced 0 embeddings with ${result.skipped.length} skipped; sample reasons: ${result.skipped.slice(0, 3).map((s) => s.reason).join(", ")}`);
    fail("aborting backfill — investigate Voyage availability");
    process.exit(1);
  }
}

dbWrite.close();

console.log("");
console.log("[preflight] ✅ READY. Harness DB at:");
console.log(DST);
console.log("");
console.log("Next: build + run the agent harness against this DB.");
