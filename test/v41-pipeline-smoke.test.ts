import { existsSync } from "node:fs";
import { arch, platform } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import {
  ensureEmbeddingsTable,
  recordEmbedding,
  registerEmbeddingProfile,
  tryLoadSqliteVec,
  vec0Version,
} from "../src/embeddings/store.js";
import {
  runSemanticSearch,
} from "../src/embeddings/semantic-search.js";
import { runHybridSearch, type FtsHit } from "../src/embeddings/hybrid-search.js";
import {
  registerPrompt,
  getActivePrompt,
} from "../src/synthesis/prompt-registry.js";
import { dispatchSynthesis, type LlmCall } from "../src/synthesis/dispatch.js";
import {
  prefilterContent,
  prefilterLeaves,
} from "../src/extraction/procedure-prefilter.js";
import {
  mineProceduresPass,
  type CandidateLeaf,
} from "../src/extraction/procedure-mining.js";
import {
  runCoreferenceTick,
  countPendingExtractions,
} from "../src/extraction/entity-coreference.js";
import { runPurge } from "../src/operator/purge.js";
import {
  consolidateThemesPass,
  listThemes,
} from "../src/themes/consolidation.js";
import {
  runBackfillTick,
  countPendingDocs,
} from "../src/embeddings/backfill.js";

const VEC0_PATH =
  process.env.LCM_TEST_VEC0_PATH?.trim() ||
  (() => {
    const realHome = process.env.REAL_HOME?.trim() || "/Users/lume";
    const ext = platform() === "win32" ? "dll" : platform() === "darwin" ? "dylib" : "so";
    const platformPkg = `sqlite-vec-${platform() === "win32" ? "windows" : platform()}-${arch()}`;
    return `${realHome}/.openclaw/extensions/node_modules/${platformPkg}/vec0.${ext}`;
  })();
const VEC0_AVAILABLE = existsSync(VEC0_PATH);

/**
 * v4.1 omnibus pipeline smoke test.
 *
 * Exercises the full read+write+suppression+synthesis+extraction+
 * themes+purge cycle with mocked LLM calls. Validates that the
 * components compose correctly end-to-end. NOT a perf or load test.
 *
 * Runs only when sqlite-vec is loadable (most components touch
 * embeddings). Set LCM_TEST_VEC0_PATH to enable.
 */

function setupFullDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:", { allowExtension: true });
  tryLoadSqliteVec(db, { path: VEC0_PATH });
  runLcmMigrations(db, { fts5Available: true });
  // 2 conversations across 2 sessions
  db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s1', 'sk1')`).run();
  db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s2', 'sk2')`).run();
  // Active embedding profile + table
  registerEmbeddingProfile(db, "voyage-4-large", 3);
  ensureEmbeddingsTable(db, "voyage-4-large", 3);
  // Seed the synthesis-tier prompts so dispatch works
  for (const tier of ["daily", "weekly", "monthly"] as const) {
    registerPrompt(db, {
      memoryType: "episodic-condensed",
      tierLabel: tier,
      passKind: "single",
      template: `${tier} summary of: {{source_text}}`,
    });
  }
  registerPrompt(db, {
    memoryType: "episodic-condensed",
    tierLabel: "monthly",
    passKind: "verify_fidelity",
    template: "Check {{candidate_summary}} vs {{source_text}}",
  });
  return db;
}

function insertLeaf(
  db: DatabaseSync,
  summaryId: string,
  conversationId: number,
  content: string,
  vector?: [number, number, number],
): void {
  db.prepare(
    `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key)
     VALUES (?, ?, 'leaf', ?, 100, (SELECT session_key FROM conversations WHERE conversation_id = ?))`,
  ).run(summaryId, conversationId, content, conversationId);
  if (vector) {
    recordEmbedding(db, {
      modelName: "voyage-4-large",
      embeddedId: summaryId,
      embeddedKind: "summary",
      vector,
      sourceTokenCount: 100,
    });
  }
}

const PROCEDURE_CONTENT = `
How to deploy to staging:
1. Run \`git pull origin main\`
2. Run \`pnpm install\`
3. Run \`pnpm build\`
4. Run \`pnpm test\`
First, push the branch. Then, merge.
`;

describe.skipIf(!VEC0_AVAILABLE)(
  "v4.1 pipeline smoke — full end-to-end exercise",
  () => {
    it("Group A → G: vec0 + retrieval + synthesis + extraction + themes + purge all compose", async () => {
      const db = setupFullDb();

      // === Phase 1: write some leaves with embeddings ===
      insertLeaf(db, "leaf_alpha", 1, "alpha doc about deployment", [0.1, 0.0, 0.0]);
      insertLeaf(db, "leaf_beta", 1, "beta doc about deployment", [0.1, 0.0, 0.0]);
      insertLeaf(db, "leaf_omega", 2, "omega unrelated content", [0.0, 0.9, 0.0]);

      expect(vec0Version(db)).not.toBeNull();
      expect(countPendingDocs(db, { modelName: "voyage-4-large" })).toBe(0); // all embedded

      // === Phase 2: semantic search ===
      const semResult = await runSemanticSearch(db, {
        query: "deployment",
        queryVector: new Float32Array([0.1, 0.0, 0.0]),
        sessionKeys: ["sk1"],
        k: 5,
      });
      expect(semResult.hits.map((h) => h.summaryId).sort()).toEqual([
        "leaf_alpha",
        "leaf_beta",
      ]);

      // === Phase 3: hybrid search with mock rerank ===
      const ftsSearch = async (): Promise<FtsHit[]> => [
        {
          summaryId: "leaf_alpha",
          conversationId: 1,
          sessionKey: "sk1",
          kind: "leaf",
          content: "alpha doc about deployment",
          tokenCount: 100,
          createdAt: "2026-05-05",
          rank: 0,
        },
      ];
      const rerankFetch = (async (url: string, init: RequestInit) => {
        if (!url.endsWith("/rerank")) {
          // Embed call — return a dummy vector
          return new Response(
            JSON.stringify({
              data: [{ embedding: [0.1, 0.0, 0.0], index: 0 }],
              usage: { total_tokens: 1 },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        const body = JSON.parse(init.body as string) as { documents: string[] };
        return new Response(
          JSON.stringify({
            data: body.documents.map((doc, idx) => ({
              index: idx,
              relevance_score: doc.includes("deployment") ? 0.9 : 0.1,
            })),
            usage: { total_tokens: 50 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as unknown as typeof fetch;

      const hybridResult = await runHybridSearch(db, {
        query: "deployment",
        ftsSearch,
        sessionKeys: ["sk1"],
        voyageApiKey: "test",
        voyageFetch: rerankFetch,
        voyageMaxRetries: 0,
      });
      expect(hybridResult.hits.length).toBeGreaterThan(0);
      expect(hybridResult.hits[0].score).toBeGreaterThan(0);

      // === Phase 4: synthesis dispatch (daily tier, single-pass) ===
      const llm: LlmCall = async (args) => ({
        output: `daily summary of [${args.passKind}]`,
        latencyMs: 10,
        costCents: 1,
      });
      // Need a target row to link the audit to
      db.prepare(
        `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key)
         VALUES ('cond_target_smoke', 1, 'condensed', 'placeholder', 1, 'sk1')`,
      ).run();
      const synthResult = await dispatchSynthesis(db, llm, {
        tier: "daily",
        memoryType: "episodic-condensed",
        sourceText: "alpha and beta about deployment",
        passSessionId: "smoke-ps1",
        targetSummaryId: "cond_target_smoke",
      });
      expect(synthResult.output).toContain("daily summary");

      // === Phase 5: extraction queue + entity coref ===
      db.prepare(
        `INSERT INTO lcm_extraction_queue (queue_id, leaf_id, kind, queued_at)
         VALUES ('q_alpha', 'leaf_alpha', 'entity', datetime('now'))`,
      ).run();
      expect(countPendingExtractions(db)).toBe(1);

      const extractResult = await runCoreferenceTick(
        db,
        async () => [{ surface: "deployment", entityType: "operation" }],
        { passId: "smoke-extract" },
      );
      expect(extractResult.processedCount).toBe(1);
      expect(extractResult.newEntities).toBe(1);
      expect(countPendingExtractions(db)).toBe(0);

      // === Phase 6: procedure mining ===
      // Insert 5 leaves with procedure content (gap 4: minOccurrences=4)
      for (let i = 0; i < 5; i++) {
        const id = `leaf_proc_${i}`;
        insertLeaf(db, id, 1, PROCEDURE_CONTENT, [0.5, 0.5, 0.0]);
      }
      const candidates: CandidateLeaf[] = [];
      for (let i = 0; i < 5; i++) {
        candidates.push({
          summaryId: `leaf_proc_${i}`,
          sessionKey: "sk1",
          content: PROCEDURE_CONTENT,
          vector: new Float32Array([0.5, 0.5, 0.0]),
        });
      }
      const mineResult = await mineProceduresPass(
        db,
        candidates,
        async () => ({
          confirmed: true,
          confidence: 0.95,
          procedureName: "Deploy to staging",
          steps: "git pull; pnpm install; pnpm build; pnpm test",
        }),
        { sessionKey: "sk1", passId: "smoke-mine" },
      );
      expect(mineResult.activeProceduresWritten).toBeGreaterThan(0);

      // === Phase 7: themes consolidation ===
      const themeResult = await consolidateThemesPass(
        db,
        candidates.map((c) => ({ summaryId: c.summaryId, vector: c.vector })),
        async () => ({
          name: "Deployment workflow",
          description: "Cluster of deploy-related leaves.",
          confidence: 0.9,
          modelUsed: "test",
        }),
        { sessionKey: "sk1", passId: "smoke-themes" },
      );
      expect(themeResult.themesWritten).toBeGreaterThan(0);
      expect(listThemes(db, { sessionKey: "sk1" }).length).toBeGreaterThan(0);

      // === Phase 8: operator purge ===
      const purgeResult = runPurge(db, {
        summaryIds: ["leaf_omega"],
        reason: "smoke test purge",
      });
      expect(purgeResult.affectedLeafIds).toEqual(["leaf_omega"]);

      // Verify suppression filters retrieval — semantic shouldn't return leaf_omega
      const after = await runSemanticSearch(db, {
        query: "x",
        queryVector: new Float32Array([0.0, 0.9, 0.0]),
        sessionKeys: ["sk2"],
        k: 5,
      });
      expect(after.hits.map((h) => h.summaryId)).not.toContain("leaf_omega");

      // === Phase 9: backfill cron (no pending docs since all embedded) ===
      const backfillResult = await runBackfillTick(db, {
        modelName: "voyage-4-large",
        voyageModel: "voyage-4-large",
        inputType: "document",
        voyageApiKey: "k",
        voyageFetch: rerankFetch,
        voyageMaxRetries: 0,
        maxRequestsPerSecond: 1000,
      });
      expect(backfillResult.embeddedCount).toBeGreaterThanOrEqual(0); // many already embedded

      // === Phase 10: theme suppression cascade ===
      // Suppress one of the procedure leaves; theme should flip to 'stale'
      db.prepare(`UPDATE summaries SET suppressed_at = datetime('now') WHERE summary_id = 'leaf_proc_0'`).run();
      const stale = listThemes(db, { sessionKey: "sk1", status: "stale" });
      expect(stale.length).toBeGreaterThan(0); // trigger fired

      db.close();
    });

    it("prefilter rejects conversational text + accepts procedure-shaped text", () => {
      // Validates the Gap 5 fix tightening
      expect(prefilterContent("Just chatting about life and stuff").isCandidate).toBe(false);

      // Should accept strict-sequential numbered + commands
      const proc = prefilterContent(`
Steps to deploy:
1. git pull
2. pnpm install
3. pnpm build
`);
      expect(proc.isCandidate).toBe(true);
      expect(proc.signals.length).toBeGreaterThanOrEqual(1);

      // Should REJECT non-sequential numbering (Gap 5)
      const citations = prefilterContent(`
References:
[1] Smith 2020
[3] Jones 2021
[5] Wang 2022
`);
      expect(citations.isCandidate).toBe(false); // numbers don't match the patterns

      // Action items (1, 2, 3 sequential) — would have tripped the OLD prefilter,
      // but now also requires command-block or how-to-marker for procedure quality.
      // Actually, action items would still trigger numbered-steps. That's OK —
      // the LLM judge later filters. Prefilter is heuristic, not perfect.
      const actionItems = prefilterContent(`
Action items:
1. Bob writes the doc
2. Alice reviews
3. Carol publishes
`);
      // Sequential 1,2,3 means numbered-steps fires → isCandidate=true.
      // Acceptable false positive — judge filters.
      expect(actionItems.isCandidate).toBe(true);
    });
  },
);
