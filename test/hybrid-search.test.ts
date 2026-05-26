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
} from "../src/embeddings/store.js";
import {
  runHybridSearch,
  type FtsHit,
} from "../src/embeddings/hybrid-search.js";

const VEC0_PATH =
  process.env.LCM_TEST_VEC0_PATH?.trim() ||
  (() => {
    const realHome = process.env.REAL_HOME?.trim() || "/Users/lume";
    const ext = platform() === "win32" ? "dll" : platform() === "darwin" ? "dylib" : "so";
    const platformPkg = `sqlite-vec-${platform() === "win32" ? "windows" : platform()}-${arch()}`;
    return `${realHome}/.openclaw/extensions/node_modules/${platformPkg}/vec0.${ext}`;
  })();
const VEC0_AVAILABLE = existsSync(VEC0_PATH);

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:", { allowExtension: true });
  tryLoadSqliteVec(db, { path: VEC0_PATH });
  runLcmMigrations(db, { fts5Available: false });
  db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s1', 'sk1')`).run();
  registerEmbeddingProfile(db, "voyage-4-large", 3);
  ensureEmbeddingsTable(db, "voyage-4-large", 3);
  return db;
}

function insertLeaf(
  db: DatabaseSync,
  summaryId: string,
  vector: [number, number, number] | null,
  content: string,
  conversationId = 1,
): void {
  db.prepare(
    `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key, created_at)
     VALUES (?, ?, 'leaf', ?, 1, (SELECT session_key FROM conversations WHERE conversation_id = ?), datetime('now'))`,
  ).run(summaryId, conversationId, content, conversationId);
  if (vector) {
    recordEmbedding(db, {
      modelName: "voyage-4-large",
      embeddedId: summaryId,
      embeddedKind: "summary",
      vector,
      sourceTokenCount: 1,
    });
  }
}

function makeFtsSearch(hits: Array<Pick<FtsHit, "summaryId" | "content">>) {
  // Helper: convert id+content tuples into full FtsHit shape
  return async (_args: unknown): Promise<FtsHit[]> =>
    hits.map((h, i) => ({
      summaryId: h.summaryId,
      conversationId: 1,
      sessionKey: "sk1",
      kind: "leaf" as const,
      content: h.content,
      tokenCount: 1,
      createdAt: "2026-05-05",
      rank: i,
    }));
}

function rerankFetch(scores: Record<string, number>): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as {
      documents: string[];
      top_k: number;
    };
    // Score each doc by content lookup; default 0.1 if missing
    const data = body.documents.map((doc, idx) => ({
      index: idx,
      relevance_score: scores[doc] ?? 0.1,
    }));
    return new Response(
      JSON.stringify({
        data,
        model: "rerank-2.5",
        usage: { total_tokens: 100 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
}

describe.skipIf(!VEC0_AVAILABLE)("hybrid-search — happy path with rerank", () => {
  it("merges FTS + semantic candidates, reranks, returns top-N", async () => {
    const db = setupDb();
    insertLeaf(db, "leaf_a", [0.1, 0.2, 0.3], "alpha doc"); // semantic match
    insertLeaf(db, "leaf_b", [0.9, 0.9, 0.9], "beta doc");  // semantic far

    const result = await runHybridSearch(db, {
      query: "alpha",
      ftsSearch: makeFtsSearch([
        { summaryId: "leaf_a", content: "alpha doc" },
        // FTS misses leaf_b; it shows up only via semantic
      ]),
      semantic: { queryVector: new Float32Array([0.1, 0.2, 0.3]) },
      voyageApiKey: "k",
      voyageFetch: rerankFetch({
        "alpha doc": 0.95,
        "beta doc": 0.30,
      }),
      voyageMaxRetries: 0,
      topN: 5,
    });

    expect(result.hits).toHaveLength(2);
    expect(result.hits[0].summaryId).toBe("leaf_a");
    expect(result.hits[0].score).toBe(0.95);
    expect(result.hits[0].fromFts).toBe(true);
    expect(result.hits[0].fromSemantic).toBe(true);
    expect(result.hits[0].semanticDistance).toBe(0); // identical vector
    expect(result.hits[0].ftsRank).toBe(0);

    expect(result.hits[1].summaryId).toBe("leaf_b");
    expect(result.hits[1].fromFts).toBe(false);
    expect(result.hits[1].fromSemantic).toBe(true);
    expect(result.hits[1].ftsRank).toBeNull();

    expect(result.candidateCount).toBe(2);
    expect(result.degradedToFtsOnly).toBe(false);
    expect(result.degradedSkippedRerank).toBe(false);
  });

  it("dedupes overlap (FTS + semantic both find same doc)", async () => {
    const db = setupDb();
    insertLeaf(db, "leaf_x", [0.1, 0.2, 0.3], "shared doc");

    const result = await runHybridSearch(db, {
      query: "shared",
      ftsSearch: makeFtsSearch([{ summaryId: "leaf_x", content: "shared doc" }]),
      semantic: { queryVector: new Float32Array([0.1, 0.2, 0.3]) },
      voyageApiKey: "k",
      voyageFetch: rerankFetch({ "shared doc": 0.99 }),
      voyageMaxRetries: 0,
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].fromFts).toBe(true);
    expect(result.hits[0].fromSemantic).toBe(true);
  });
});

describe.skipIf(!VEC0_AVAILABLE)("hybrid-search — graceful degrade", () => {
  it("vec0 not loaded → degradedToFtsOnly=true, FTS-only results", async () => {
    // Use a fresh DB without loading vec0
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s1', 'sk1')`).run();

    const result = await runHybridSearch(db, {
      query: "hello",
      ftsSearch: makeFtsSearch([{ summaryId: "leaf_a", content: "hello world" }]),
      voyageApiKey: "k",
      voyageFetch: rerankFetch({ "hello world": 0.8 }),
      voyageMaxRetries: 0,
    });

    expect(result.degradedToFtsOnly).toBe(true);
    expect(result.hits[0].summaryId).toBe("leaf_a");
    expect(result.hits[0].fromFts).toBe(true);
    expect(result.hits[0].fromSemantic).toBe(false);
    db.close();
  });

  it("rerank Voyage 500 → falls back to RRF, sets degradedSkippedRerank=true", async () => {
    const db = setupDb();
    insertLeaf(db, "leaf_a", [0.1, 0.2, 0.3], "alpha");
    insertLeaf(db, "leaf_b", [0.9, 0.9, 0.9], "beta");

    let calls = 0;
    const fetchMock = (async (url: string) => {
      calls++;
      if (url.endsWith("/rerank")) {
        return new Response(JSON.stringify({ error: "internal" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      // For /embeddings (semantic side), succeed
      return new Response(
        JSON.stringify({
          data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
          usage: { total_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await runHybridSearch(db, {
      query: "alpha",
      ftsSearch: makeFtsSearch([
        { summaryId: "leaf_a", content: "alpha" },
        { summaryId: "leaf_b", content: "beta" },
      ]),
      voyageApiKey: "k",
      voyageFetch: fetchMock,
      voyageMaxRetries: 0,
    });

    expect(result.degradedSkippedRerank).toBe(true);
    expect(result.hits.length).toBeGreaterThan(0);
    // Both hits got an RRF-fused score
    expect(result.hits[0].score).toBeGreaterThan(0);
  });

  it("rerank Voyage 401 (auth) → re-thrown, NOT degraded silently", async () => {
    const db = setupDb();
    insertLeaf(db, "leaf_a", [0.1, 0.2, 0.3], "alpha");

    const fetchMock = (async (url: string) => {
      if (url.endsWith("/rerank")) {
        return new Response(JSON.stringify({ error: "bad key" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
          usage: { total_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await expect(
      runHybridSearch(db, {
        query: "alpha",
        ftsSearch: makeFtsSearch([{ summaryId: "leaf_a", content: "alpha" }]),
        voyageApiKey: "k",
        voyageFetch: fetchMock,
        voyageMaxRetries: 0,
      }),
    ).rejects.toMatchObject({ name: "VoyageError", kind: "auth" });
  });
});

describe.skipIf(!VEC0_AVAILABLE)("hybrid-search — rerank=false → RRF mode", () => {
  it("RRF fuses FTS+semantic ranks without calling Voyage rerank", async () => {
    const db = setupDb();
    insertLeaf(db, "leaf_top", [0.1, 0.2, 0.3], "top doc");
    insertLeaf(db, "leaf_other", [0.5, 0.5, 0.5], "other");

    let rerankCalls = 0;
    const fetchMock = (async (url: string) => {
      if (url.endsWith("/rerank")) rerankCalls++;
      return new Response(JSON.stringify({ data: [], usage: { total_tokens: 0 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await runHybridSearch(db, {
      query: "top",
      ftsSearch: makeFtsSearch([
        { summaryId: "leaf_top", content: "top doc" }, // rank 0
        { summaryId: "leaf_other", content: "other" }, // rank 1
      ]),
      semantic: { queryVector: new Float32Array([0.1, 0.2, 0.3]) },
      rerank: false,
      voyageApiKey: "k",
      voyageFetch: fetchMock,
      voyageMaxRetries: 0,
    });

    expect(rerankCalls).toBe(0); // no rerank
    expect(result.hits[0].summaryId).toBe("leaf_top"); // best in both arms
    expect(result.degradedSkippedRerank).toBe(false); // explicit choice, not failure
    // RRF score ~ 1/(60+0) + 1/(60+0) for leaf_top (best in both)
    expect(result.hits[0].score).toBeGreaterThan(0.03);
  });
});

describe.skipIf(!VEC0_AVAILABLE)("hybrid-search — input validation", () => {
  it("rejects empty query", async () => {
    const db = setupDb();
    await expect(
      runHybridSearch(db, {
        query: "",
        ftsSearch: makeFtsSearch([]),
        voyageApiKey: "k",
      }),
    ).rejects.toThrow(/query is required/);
  });
});

describe.skipIf(!VEC0_AVAILABLE)("hybrid-search — no candidates", () => {
  it("returns empty hits + 0 candidates when both arms return nothing", async () => {
    const db = setupDb();
    const result = await runHybridSearch(db, {
      query: "nonexistent",
      ftsSearch: makeFtsSearch([]),
      semantic: { queryVector: new Float32Array([0.1, 0.2, 0.3]) },
      voyageApiKey: "k",
      voyageFetch: rerankFetch({}),
      voyageMaxRetries: 0,
    });
    expect(result.hits).toEqual([]);
    expect(result.candidateCount).toBe(0);
  });
});
