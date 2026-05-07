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
  getActiveEmbeddingModel,
  runSemanticSearch,
  SemanticSearchUnavailableError,
} from "../src/embeddings/semantic-search.js";

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
  db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s2', 'sk2')`).run();
  registerEmbeddingProfile(db, "voyage-4-large", 3);
  ensureEmbeddingsTable(db, "voyage-4-large", 3);
  return db;
}

function insertLeafWithEmbedding(
  db: DatabaseSync,
  summaryId: string,
  conversationId: number,
  vector: [number, number, number],
  content = "x",
  suppressed = false,
): void {
  db.prepare(
    `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key)
     VALUES (?, ?, 'leaf', ?, 1, (SELECT session_key FROM conversations WHERE conversation_id = ?))`,
  ).run(summaryId, conversationId, content, conversationId);
  recordEmbedding(db, {
    modelName: "voyage-4-large",
    embeddedId: summaryId,
    embeddedKind: "summary",
    vector,
    suppressed,
    sourceTokenCount: 1,
  });
}

describe("semantic-search — getActiveEmbeddingModel", () => {
  it("returns null when no profile registered", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    expect(getActiveEmbeddingModel(db)).toBeNull();
    db.close();
  });

  it("returns the active profile (active=1, archive_after IS NULL)", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    registerEmbeddingProfile(db, "voyage-4-large", 1024);
    expect(getActiveEmbeddingModel(db)).toEqual({ modelName: "voyage-4-large", dim: 1024 });
    db.close();
  });

  it("returns the most-recent active when multiple are active (e.g. cutover in progress)", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    registerEmbeddingProfile(db, "voyage-3-lite", 512);
    // Sleep to ensure registered_at differs (sqlite datetime is second-grain)
    db.prepare(`UPDATE lcm_embedding_profile SET registered_at = '2026-01-01 00:00:00' WHERE model_name = 'voyage-3-lite'`).run();
    registerEmbeddingProfile(db, "voyage-4-large", 1024);
    db.prepare(`UPDATE lcm_embedding_profile SET registered_at = '2026-05-05 00:00:00' WHERE model_name = 'voyage-4-large'`).run();

    expect(getActiveEmbeddingModel(db)).toEqual({ modelName: "voyage-4-large", dim: 1024 });
    db.close();
  });

  it("excludes archived profiles (archive_after IS NOT NULL)", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    registerEmbeddingProfile(db, "voyage-3-lite", 512);
    db.prepare(`UPDATE lcm_embedding_profile SET archive_after = '2026-01-01' WHERE model_name = 'voyage-3-lite'`).run();
    registerEmbeddingProfile(db, "voyage-4-large", 1024);
    expect(getActiveEmbeddingModel(db)?.modelName).toBe("voyage-4-large");
    db.close();
  });
});

describe("semantic-search — error paths", () => {
  it("throws SemanticSearchUnavailableError when vec0 not loaded", async () => {
    const db = new DatabaseSync(":memory:"); // no extension allow
    runLcmMigrations(db, { fts5Available: false });
    await expect(
      runSemanticSearch(db, { query: "anything" }),
    ).rejects.toBeInstanceOf(SemanticSearchUnavailableError);
    db.close();
  });
});

describe.skipIf(!VEC0_AVAILABLE)("semantic-search — vec0-dependent paths", () => {
  it("throws SemanticSearchUnavailableError when no active profile registered", async () => {
    const db = new DatabaseSync(":memory:", { allowExtension: true });
    tryLoadSqliteVec(db, { path: VEC0_PATH });
    runLcmMigrations(db, { fts5Available: false });
    await expect(
      runSemanticSearch(db, { query: "anything" }),
    ).rejects.toBeInstanceOf(SemanticSearchUnavailableError);
    db.close();
  });

  it("requires either query or queryVector", async () => {
    const db = setupDb();
    insertLeafWithEmbedding(db, "leaf_a", 1, [0.1, 0.2, 0.3]);
    await expect(
      runSemanticSearch(db, { query: "" }),
    ).rejects.toThrow(/query is required/);
    db.close();
  });

  it("queryVector dim mismatch is caught", async () => {
    const db = setupDb();
    await expect(
      runSemanticSearch(db, { query: "x", queryVector: new Float32Array([0.1, 0.2]) }),
    ).rejects.toThrow(/queryVector dim 2 != active model dim 3/);
    db.close();
  });

  it("returns ranked hits joined with summary content (queryVector path)", async () => {
    const db = setupDb();
    insertLeafWithEmbedding(db, "leaf_close", 1, [0.1, 0.2, 0.3], "the alpha doc");
    insertLeafWithEmbedding(db, "leaf_far", 1, [0.9, 0.9, 0.9], "the omega doc");

    const result = await runSemanticSearch(db, {
      query: "ignored when queryVector provided",
      queryVector: new Float32Array([0.1, 0.2, 0.3]),
      k: 5,
    });

    expect(result.hits).toHaveLength(2);
    expect(result.hits[0].summaryId).toBe("leaf_close");
    expect(result.hits[0].content).toBe("the alpha doc");
    expect(result.hits[0].sessionKey).toBe("sk1");
    expect(result.hits[0].distance).toBe(0); // identical vector
    expect(result.voyageTokensConsumed).toBe(0); // no Voyage call (queryVector path)
    expect(result.modelName).toBe("voyage-4-large");
    db.close();
  });

  it("excludes suppressed by default; includes when excludeSuppressed=false", async () => {
    const db = setupDb();
    insertLeafWithEmbedding(db, "leaf_v", 1, [0.1, 0.2, 0.3], "visible");
    insertLeafWithEmbedding(db, "leaf_h", 1, [0.1, 0.2, 0.3], "hidden", /*suppressed*/ true);
    // The suppression-trigger setup means UPDATE summaries.suppressed_at
    // would mirror to vec0; but recordEmbedding directly sets it true,
    // so both layers agree. Belt-and-suspenders also caught by the JOIN
    // filter.
    db.prepare(`UPDATE summaries SET suppressed_at = ? WHERE summary_id = ?`).run(
      "2026-05-05",
      "leaf_h",
    );

    const visibleOnly = await runSemanticSearch(db, {
      query: "x",
      queryVector: new Float32Array([0.1, 0.2, 0.3]),
      k: 5,
    });
    expect(visibleOnly.hits.map((h) => h.summaryId)).toEqual(["leaf_v"]);

    const includeAll = await runSemanticSearch(db, {
      query: "x",
      queryVector: new Float32Array([0.1, 0.2, 0.3]),
      k: 5,
      excludeSuppressed: false,
    });
    expect(includeAll.hits.map((h) => h.summaryId).sort()).toEqual(["leaf_h", "leaf_v"]);
    db.close();
  });

  it("session_keys filter restricts to matching sessions", async () => {
    const db = setupDb();
    insertLeafWithEmbedding(db, "leaf_a", 1, [0.1, 0.2, 0.3]); // sk1
    insertLeafWithEmbedding(db, "leaf_b", 2, [0.1, 0.2, 0.3]); // sk2

    const result = await runSemanticSearch(db, {
      query: "x",
      queryVector: new Float32Array([0.1, 0.2, 0.3]),
      sessionKeys: ["sk1"],
      k: 5,
    });
    expect(result.hits.map((h) => h.summaryId)).toEqual(["leaf_a"]);
    db.close();
  });

  it("conversation_ids filter restricts to matching conversations", async () => {
    const db = setupDb();
    insertLeafWithEmbedding(db, "leaf_a", 1, [0.1, 0.2, 0.3]);
    insertLeafWithEmbedding(db, "leaf_b", 2, [0.1, 0.2, 0.3]);

    const result = await runSemanticSearch(db, {
      query: "x",
      queryVector: new Float32Array([0.1, 0.2, 0.3]),
      conversationIds: [1],
      k: 5,
    });
    expect(result.hits.map((h) => h.summaryId)).toEqual(["leaf_a"]);
    db.close();
  });

  it("time filters (since, before) restrict by created_at", async () => {
    const db = setupDb();
    insertLeafWithEmbedding(db, "leaf_old", 1, [0.1, 0.2, 0.3]);
    insertLeafWithEmbedding(db, "leaf_new", 1, [0.1, 0.2, 0.3]);
    db.prepare(`UPDATE summaries SET created_at = '2026-01-01 00:00:00' WHERE summary_id = ?`).run("leaf_old");
    db.prepare(`UPDATE summaries SET created_at = '2026-05-01 00:00:00' WHERE summary_id = ?`).run("leaf_new");

    const recent = await runSemanticSearch(db, {
      query: "x",
      queryVector: new Float32Array([0.1, 0.2, 0.3]),
      since: new Date("2026-04-01"),
      k: 5,
    });
    expect(recent.hits.map((h) => h.summaryId)).toEqual(["leaf_new"]);

    const ancient = await runSemanticSearch(db, {
      query: "x",
      queryVector: new Float32Array([0.1, 0.2, 0.3]),
      before: new Date("2026-04-01"),
      k: 5,
    });
    expect(ancient.hits.map((h) => h.summaryId)).toEqual(["leaf_old"]);
    db.close();
  });

  it("calls Voyage when queryVector not provided; voyageTokensConsumed reflects usage", async () => {
    const db = setupDb();
    insertLeafWithEmbedding(db, "leaf_a", 1, [0.5, 0.5, 0.5]);

    const fetchMock = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { input: string[]; input_type?: string };
      // Verify input_type is 'query' (asymmetric retrieval)
      expect(body.input_type).toBe("query");
      return new Response(
        JSON.stringify({
          data: [{ embedding: [0.5, 0.5, 0.5], index: 0 }],
          usage: { total_tokens: 17 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await runSemanticSearch(db, {
      query: "test",
      voyageApiKey: "k",
      voyageFetch: fetchMock,
      voyageMaxRetries: 0,
      k: 5,
    });
    expect(result.voyageTokensConsumed).toBe(17);
    expect(result.hits[0].summaryId).toBe("leaf_a");
    db.close();
  });

  it("summary_kinds filter restricts to leaf vs condensed", async () => {
    const db = setupDb();
    insertLeafWithEmbedding(db, "leaf_a", 1, [0.1, 0.2, 0.3]);
    // Insert a 'condensed' summary
    db.prepare(
      `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key)
       VALUES (?, 1, 'condensed', 'sum', 1, 'sk1')`,
    ).run("cond_a");
    recordEmbedding(db, {
      modelName: "voyage-4-large",
      embeddedId: "cond_a",
      embeddedKind: "summary",
      vector: [0.1, 0.2, 0.3],
      sourceTokenCount: 1,
    });

    const leavesOnly = await runSemanticSearch(db, {
      query: "x",
      queryVector: new Float32Array([0.1, 0.2, 0.3]),
      summaryKinds: ["leaf"],
      k: 5,
    });
    expect(leavesOnly.hits.map((h) => h.summaryId)).toEqual(["leaf_a"]);

    const both = await runSemanticSearch(db, {
      query: "x",
      queryVector: new Float32Array([0.1, 0.2, 0.3]),
      k: 5,
    });
    expect(both.hits.map((h) => h.summaryId).sort()).toEqual(["cond_a", "leaf_a"]);
    db.close();
  });
});
