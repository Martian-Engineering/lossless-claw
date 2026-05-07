#!/usr/bin/env node
/**
 * v4.1 live-DB harness — end-to-end verification against Eva's real corpus.
 *
 * USAGE:
 *   VOYAGE_API_KEY=$(cat ~/.openclaw/credentials/voyage-api-key) \
 *   LCM_TEST_VEC0_PATH=/Users/lume/.openclaw/extensions/node_modules/sqlite-vec-darwin-arm64/vec0.dylib \
 *     node scripts/v41-live-db-harness.mjs
 *
 * What it does (NEVER touches the live DB):
 *   1. Copies ~/.openclaw/lcm.db → /Volumes/LEXAR/lcm-tmp/lcm-harness-<ts>.db
 *   2. Loads sqlite-vec, runs runLcmMigrations
 *   3. Registers voyage-4-large + ensureEmbeddingsTable
 *   4. Runs ONE backfill tick (perTickLimit=20 to keep cost low)
 *   5. Validates retrieval against the freshly-embedded slice:
 *        - lcm_semantic_recall: query "rebase" → expect any hits
 *        - lcm_grep --mode hybrid: query "rebase" → expect any hits
 *        - Suppression filter: suppress one leaf, verify it's hidden
 *   6. Emits a verdict report (PASS / FAIL with diagnostics)
 *
 * Cost: ~$0.05 (20 docs × ~250 tokens each at $0.10/1M tokens).
 * Total runtime: ~1-2 min.
 */

import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SRC = process.env.LCM_HARNESS_SRC_DB ?? join(homedir(), ".openclaw", "lcm.db");
const DST_DIR = process.env.LCM_HARNESS_DST_DIR ?? "/Volumes/LEXAR/lcm-tmp";
const VEC0_PATH =
  process.env.LCM_TEST_VEC0_PATH ??
  join(homedir(), ".openclaw", "extensions", "node_modules", "sqlite-vec-darwin-arm64", "vec0.dylib");

const log = (msg) => console.log(`[harness] ${msg}`);
const ok = (msg) => console.log(`[harness] ✓ ${msg}`);
const fail = (msg) => console.error(`[harness] ✗ ${msg}`);

let _failures = 0;
const expect = (cond, msg) => {
  if (cond) {
    ok(msg);
  } else {
    fail(msg);
    _failures++;
  }
};

async function main() {
  log("v4.1 live-DB harness starting");

  // ── Pre-flight ────────────────────────────────────────────────────
  if (!existsSync(SRC)) {
    fail(`Source DB not found: ${SRC}`);
    process.exit(1);
  }
  if (!process.env.VOYAGE_API_KEY?.trim()) {
    fail("VOYAGE_API_KEY env var is empty. Set it from ~/.openclaw/credentials/voyage-api-key");
    process.exit(1);
  }
  if (!existsSync(VEC0_PATH)) {
    fail(`vec0 extension not found: ${VEC0_PATH}`);
    process.exit(1);
  }

  // ── Copy DB ───────────────────────────────────────────────────────
  if (!existsSync(DST_DIR)) {
    mkdirSync(DST_DIR, { recursive: true });
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const DST = join(DST_DIR, `lcm-harness-${ts}.db`);
  log(`Copying ${SRC} → ${DST}`);
  copyFileSync(SRC, DST);
  const sizeMB = (statSync(DST).size / 1024 / 1024).toFixed(1);
  log(`Copy done: ${sizeMB} MB`);

  // ── Imports (dynamic so missing modules surface here, not on require) ─
  const { runLcmMigrations } = await import(`${process.cwd()}/src/db/migration.ts`);
  const {
    tryLoadSqliteVec,
    vec0Version,
    registerEmbeddingProfile,
    ensureEmbeddingsTable,
  } = await import(`${process.cwd()}/src/embeddings/store.ts`);
  const { runSemanticSearch } = await import(`${process.cwd()}/src/embeddings/semantic-search.ts`);
  const { runHybridSearch } = await import(`${process.cwd()}/src/embeddings/hybrid-search.ts`);
  const { runBackfillTick, countPendingDocs } = await import(`${process.cwd()}/src/embeddings/backfill.ts`);
  const { SummaryStore } = await import(`${process.cwd()}/src/store/summary-store.ts`);
  const { runPurge } = await import(`${process.cwd()}/src/operator/purge.ts`);
  const { runCoreferenceTick } = await import(`${process.cwd()}/src/extraction/entity-coreference.ts`);

  // ── DB open + migration ───────────────────────────────────────────
  const db = new DatabaseSync(DST, { allowExtension: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");

  const vecLoaded = tryLoadSqliteVec(db, { path: VEC0_PATH });
  expect(vecLoaded, "vec0 extension loaded");
  expect(vec0Version(db) !== null, `vec0 version reported: ${vec0Version(db)}`);

  log("Running migration (may take 4-5s on Eva's 4187-leaf corpus)...");
  const migT0 = Date.now();
  runLcmMigrations(db, { fts5Available: true });
  log(`Migration completed in ${Date.now() - migT0}ms`);

  // ── Schema sanity ─────────────────────────────────────────────────
  const v41Tables = [
    "lcm_worker_lock", "lcm_extraction_queue", "lcm_purge_rebuild_queue",
    "lcm_voyage_rate_state", "lcm_session_key_audit", "lcm_prompt_registry",
    "lcm_synthesis_cache", "lcm_synthesis_audit",
    "lcm_eval_query_set", "lcm_eval_query", "lcm_eval_run", "lcm_eval_drift",
    "lcm_entities", "lcm_entity_mentions", "lcm_entity_type_registry",
    "lcm_procedures", "lcm_intentions",
    "lcm_embedding_profile", "lcm_embedding_meta",
    "lcm_themes", "lcm_theme_sources", "lcm_feature_flags",
  ];
  for (const t of v41Tables) {
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(t);
    expect(row !== undefined, `table exists: ${t}`);
  }

  // ── Register embedding profile + ensure vec0 table ────────────────
  registerEmbeddingProfile(db, "voyage-4-large", 1024);
  ensureEmbeddingsTable(db, "voyage-4-large", 1024);
  ok("embedding profile registered + vec0 table created");

  // ── Run ONE backfill tick (small perTickLimit to keep cost low) ───
  const pendingBefore = countPendingDocs(db, { modelName: "voyage-4-large" });
  log(`Pending docs before backfill: ${pendingBefore}`);
  expect(pendingBefore > 0, `corpus has unembedded docs: ${pendingBefore}`);

  log("Running backfill tick (perTickLimit=20, cost ≈ $0.05)...");
  const backfillT0 = Date.now();
  const backfill = await runBackfillTick(db, {
    modelName: "voyage-4-large",
    voyageModel: "voyage-4-large",
    inputType: "document",
    voyageMaxRetries: 1,
    voyageTimeoutMs: 30_000,
    maxRequestsPerSecond: 0.5,
    perTickLimit: 20,
  });
  log(
    `Backfill tick: embedded=${backfill.embeddedCount} skipped=${backfill.skipped.length} ` +
      `tokens=${backfill.voyageTokensConsumed} duration=${(Date.now() - backfillT0) / 1000}s`,
  );
  expect(backfill.embeddedCount > 0, "backfill embedded at least one doc");
  expect(backfill.voyageTokensConsumed > 0, `Voyage tokens consumed: ${backfill.voyageTokensConsumed}`);

  // ── Semantic recall validation ────────────────────────────────────
  log("Validating lcm_semantic_recall...");
  const semHits = await runSemanticSearch(db, {
    query: "rebase plan-mode openclaw",
    voyageMaxRetries: 1,
    voyageTimeoutMs: 30_000,
    k: 10,
  });
  expect(semHits.hits.length > 0, `semantic search returned ${semHits.hits.length} hits`);
  expect(semHits.modelName === "voyage-4-large", `model attribution: ${semHits.modelName}`);
  if (semHits.hits.length > 0) {
    log(`  Top hit: [${semHits.hits[0].summaryId}] dist=${semHits.hits[0].distance.toFixed(3)}`);
  }

  // ── Hybrid grep validation ────────────────────────────────────────
  log("Validating lcm_grep --mode hybrid...");
  const ftsAdapter = async () => {
    const rows = db
      .prepare(
        `SELECT s.summary_id, s.conversation_id, s.session_key, s.kind, s.content,
                s.token_count, s.created_at
         FROM summaries_fts JOIN summaries s ON s.summary_id = summaries_fts.summary_id
         WHERE summaries_fts MATCH 'rebase' AND s.suppressed_at IS NULL
         ORDER BY rank LIMIT 50`,
      )
      .all();
    return rows.map((r, i) => ({
      summaryId: r.summary_id,
      conversationId: r.conversation_id,
      sessionKey: r.session_key,
      kind: r.kind,
      content: r.content,
      tokenCount: r.token_count,
      createdAt: r.created_at,
      rank: i,
    }));
  };
  const hybrid = await runHybridSearch(db, {
    query: "rebase",
    ftsSearch: ftsAdapter,
    voyageMaxRetries: 1,
    voyageTimeoutMs: 30_000,
    topN: 5,
  });
  expect(hybrid.hits.length > 0, `hybrid search returned ${hybrid.hits.length} hits`);
  if (hybrid.hits.length > 0) {
    const fromBoth = hybrid.hits.filter((h) => h.fromFts && h.fromSemantic).length;
    log(
      `  Hybrid: ${hybrid.hits.length} hits (${fromBoth} from both arms); voyageTokens=${hybrid.voyageTokensConsumed}`,
    );
  }

  // ── Suppression cascade validation ────────────────────────────────
  log("Validating suppression cascade...");
  if (semHits.hits.length > 0) {
    const targetId = semHits.hits[0].summaryId;
    const beforeSuppressed = await runSemanticSearch(db, {
      query: "rebase plan-mode openclaw",
      voyageMaxRetries: 1,
      voyageTimeoutMs: 30_000,
      k: 10,
    });
    expect(
      beforeSuppressed.hits.some((h) => h.summaryId === targetId),
      "target leaf appears in pre-suppression semantic results",
    );

    runPurge(db, {
      summaryIds: [targetId],
      reason: "harness suppression validation",
    });

    const afterSuppressed = await runSemanticSearch(db, {
      query: "rebase plan-mode openclaw",
      voyageMaxRetries: 1,
      voyageTimeoutMs: 30_000,
      k: 10,
    });
    expect(
      !afterSuppressed.hits.some((h) => h.summaryId === targetId),
      "target leaf REMOVED from semantic results after suppression",
    );

    // Verify context_items cleaned up
    const ctxCount = db
      .prepare(`SELECT COUNT(*) AS n FROM context_items WHERE summary_id = ?`)
      .get(targetId);
    expect(ctxCount.n === 0, `context_items rows for suppressed leaf cleaned: ${ctxCount.n}`);
  }

  // ── Leaf-write hook validation ────────────────────────────────────
  log("Validating leaf-write hook → extraction queue...");
  const store = new SummaryStore(db, { fts5Available: true });
  const conv = db.prepare(`SELECT conversation_id FROM conversations LIMIT 1`).get();
  const newLeafId = `harness_leaf_${ts}`;
  await store.insertSummary({
    summaryId: newLeafId,
    conversationId: conv.conversation_id,
    kind: "leaf",
    content: "harness test leaf for extraction queue verification",
    tokenCount: 100,
  });
  const queueRow = db
    .prepare(`SELECT kind, completed_at FROM lcm_extraction_queue WHERE leaf_id = ?`)
    .get(newLeafId);
  expect(queueRow !== undefined, "leaf-write enqueued an entity-extraction row");
  expect(queueRow?.kind === "entity", `queue row kind=${queueRow?.kind}`);
  expect(queueRow?.completed_at === null, "queue row unprocessed (worker drains async)");

  // ── Extraction worker validation (mocked extractor; no LLM cost) ──
  log("Validating async entity coreference (mocked extractor; no LLM)...");
  const extractResult = await runCoreferenceTick(
    db,
    async ({ summaryId }) => [
      { surface: `harness-${summaryId}`, entityType: "harness_test" },
    ],
    { passId: "harness-extract", perTickLimit: 5 },
  );
  expect(extractResult.processedCount > 0, `extraction tick processed ${extractResult.processedCount} items`);
  expect(extractResult.newEntities > 0, `entity coref created ${extractResult.newEntities} entities`);

  // ── Verdict ──────────────────────────────────────────────────────
  console.log("");
  if (_failures === 0) {
    log(`✅ ALL CHECKS PASSED. Harness DB at: ${DST}`);
    log("v4.1 retrieval pipeline verified end-to-end against Eva's live corpus.");
    process.exit(0);
  } else {
    log(`❌ ${_failures} CHECKS FAILED. Harness DB at: ${DST}`);
    process.exit(1);
  }
}

main().catch((e) => {
  fail(`harness threw: ${e.stack || e}`);
  process.exit(1);
});
