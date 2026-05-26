import { existsSync } from "node:fs";
import { arch, platform } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import {
  countPendingDocs,
  runBackfillTick,
} from "../src/embeddings/backfill.js";
import {
  ensureEmbeddingsTable,
  isEmbedded,
  registerEmbeddingProfile,
  tryLoadSqliteVec,
} from "../src/embeddings/store.js";

/**
 * Backfill cron tests. Voyage HTTP is mocked end-to-end via the
 * `voyageFetch` option (the embedTexts() inside the cron honors this).
 * No live API calls.
 *
 * vec0-dependent — gated on LCM_TEST_VEC0_PATH (or default dev box path).
 */

const VEC0_PATH =
  process.env.LCM_TEST_VEC0_PATH?.trim() ||
  (() => {
    const realHome = process.env.REAL_HOME?.trim() || "/Users/lume";
    const ext = platform() === "win32" ? "dll" : platform() === "darwin" ? "dylib" : "so";
    const platformPkg = `sqlite-vec-${platform() === "win32" ? "windows" : platform()}-${arch()}`;
    return `${realHome}/.openclaw/extensions/node_modules/${platformPkg}/vec0.${ext}`;
  })();
const VEC0_AVAILABLE = existsSync(VEC0_PATH);

function mockResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const headers = new Headers({ "Content-Type": "application/json", ...(init.headers ?? {}) });
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:", { allowExtension: true });
  tryLoadSqliteVec(db, { path: VEC0_PATH });
  runLcmMigrations(db, { fts5Available: false });
  db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s1', 'sk1')`).run();
  registerEmbeddingProfile(db, "voyage-4-large", 3);
  ensureEmbeddingsTable(db, "voyage-4-large", 3);
  return db;
}

function insertLeaf(db: DatabaseSync, summaryId: string, tokenCount: number, content = "x"): void {
  // FYI signature: (id, count, content) — with content optional. Note
  // the SQL column order: content before token_count.
  db.prepare(
    `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key)
     VALUES (?, 1, 'leaf', ?, ?, 'sk1')`,
  ).run(summaryId, content, tokenCount);
}

describe.skipIf(!VEC0_AVAILABLE)("embeddings-backfill — basic tick (no lock contention)", () => {
  it("embeds all pending leaves; result count matches; isEmbedded true after", async () => {
    const db = setupDb();
    insertLeaf(db, "leaf_a", 100, "alpha");
    insertLeaf(db, "leaf_b", 200, "beta");
    insertLeaf(db, "leaf_c", 300, "gamma");

    const calls: number[] = [];
    const fetchMock = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { input: string[] };
      calls.push(body.input.length);
      // One response per input, indexed in order
      return mockResponse({
        data: body.input.map((_, i) => ({
          embedding: [0.1 * (i + 1), 0.2 * (i + 1), 0.3 * (i + 1)],
          index: i,
        })),
        model: "voyage-4-large",
        usage: { total_tokens: body.input.length * 50 },
      });
    }) as unknown as typeof fetch;

    const result = await runBackfillTick(db, {
      modelName: "voyage-4-large",
      voyageModel: "voyage-4-large",
      inputType: "document",
      voyageApiKey: "test",
      voyageFetch: fetchMock,
      maxRequestsPerSecond: 1000, // skip rate-limit pacing in test
      perTickLimit: 10,
    });

    expect(result.embeddedCount).toBe(3);
    expect(result.skippedOverCap).toBe(0);
    expect(result.skipped).toEqual([]);
    expect(result.lockNotAcquired).toBe(false);
    expect(result.perTickLimitReached).toBe(false);

    expect(isEmbedded(db, { modelName: "voyage-4-large", embeddedId: "leaf_a", embeddedKind: "summary" })).toBe(true);
    expect(isEmbedded(db, { modelName: "voyage-4-large", embeddedId: "leaf_b", embeddedKind: "summary" })).toBe(true);
    expect(isEmbedded(db, { modelName: "voyage-4-large", embeddedId: "leaf_c", embeddedKind: "summary" })).toBe(true);
    db.close();
  });

  it("skips suppressed leaves (suppressed_at IS NOT NULL) — no Voyage call for them", async () => {
    const db = setupDb();
    insertLeaf(db, "leaf_a", 100);
    insertLeaf(db, "leaf_suppressed", 100);
    db.prepare(`UPDATE summaries SET suppressed_at = ? WHERE summary_id = ?`).run(
      "2026-05-05",
      "leaf_suppressed",
    );

    const inputs: string[] = [];
    const fetchMock = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { input: string[] };
      inputs.push(...body.input);
      return mockResponse({
        data: body.input.map((_, i) => ({ embedding: [0.1, 0.2, 0.3], index: i })),
        usage: { total_tokens: 1 },
      });
    }) as unknown as typeof fetch;

    const result = await runBackfillTick(db, {
      modelName: "voyage-4-large",
      voyageModel: "voyage-4-large",
      inputType: "document",
      voyageApiKey: "k",
      voyageFetch: fetchMock,
      maxRequestsPerSecond: 1000,
    });

    expect(result.embeddedCount).toBe(1); // only leaf_a
    expect(isEmbedded(db, { modelName: "voyage-4-large", embeddedId: "leaf_a", embeddedKind: "summary" })).toBe(true);
    expect(
      isEmbedded(db, { modelName: "voyage-4-large", embeddedId: "leaf_suppressed", embeddedKind: "summary" }),
    ).toBe(false);
    db.close();
  });

  it("skips already-embedded leaves on subsequent ticks (idempotent)", async () => {
    const db = setupDb();
    insertLeaf(db, "leaf_a", 100);
    insertLeaf(db, "leaf_b", 100);

    let callCount = 0;
    const fetchMock = (async (_url: string, init: RequestInit) => {
      callCount++;
      const body = JSON.parse(init.body as string) as { input: string[] };
      return mockResponse({
        data: body.input.map((_, i) => ({ embedding: [0.1, 0.2, 0.3], index: i })),
        usage: { total_tokens: 1 },
      });
    }) as unknown as typeof fetch;

    const r1 = await runBackfillTick(db, {
      modelName: "voyage-4-large",
      voyageModel: "voyage-4-large",
      inputType: "document",
      voyageApiKey: "k",
      voyageFetch: fetchMock,
      maxRequestsPerSecond: 1000,
    });
    expect(r1.embeddedCount).toBe(2);

    // Second tick — should embed nothing, no Voyage calls
    const callsAfterFirst = callCount;
    const r2 = await runBackfillTick(db, {
      modelName: "voyage-4-large",
      voyageModel: "voyage-4-large",
      inputType: "document",
      voyageApiKey: "k",
      voyageFetch: fetchMock,
      maxRequestsPerSecond: 1000,
    });
    expect(r2.embeddedCount).toBe(0);
    expect(callCount).toBe(callsAfterFirst); // no new calls
    db.close();
  });

  it("over-cap leaves (token_count > maxTokenCount) skipped + reported", async () => {
    const db = setupDb();
    insertLeaf(db, "leaf_normal", 1000);
    insertLeaf(db, "leaf_over", 50_000); // way over 30K cap

    let callCount = 0;
    const fetchMock = (async (_url: string, init: RequestInit) => {
      callCount++;
      const body = JSON.parse(init.body as string) as { input: string[] };
      return mockResponse({
        data: body.input.map((_, i) => ({ embedding: [0.1, 0.2, 0.3], index: i })),
        usage: { total_tokens: 100 },
      });
    }) as unknown as typeof fetch;

    const result = await runBackfillTick(db, {
      modelName: "voyage-4-large",
      voyageModel: "voyage-4-large",
      inputType: "document",
      voyageApiKey: "k",
      voyageFetch: fetchMock,
      maxRequestsPerSecond: 1000,
    });

    // The over-cap doc was filtered at SELECT level (token_count BETWEEN min..max)
    expect(result.embeddedCount).toBe(1);
    // The over-cap doc isn't included in skippedOverCap — SELECT filtered it
    // out before runBackfillTick saw it. countPendingDocs would still report
    // 1 pending (the over-cap one). We expect the operator to track via
    // `lcm_describe` / `/lcm health`.
    const stillPending = countPendingDocs(db, {
      modelName: "voyage-4-large",
      maxTokenCount: 1_000_000, // bypass the limit to find the over-cap doc
    });
    expect(stillPending).toBe(1); // leaf_over still unembedded
    db.close();
  });

  it("perTickLimit caps work, returns perTickLimitReached=true", async () => {
    const db = setupDb();
    for (let i = 0; i < 10; i++) {
      insertLeaf(db, `leaf_${i}`, 100);
    }

    const fetchMock = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { input: string[] };
      return mockResponse({
        data: body.input.map((_, i) => ({ embedding: [0.1, 0.2, 0.3], index: i })),
        usage: { total_tokens: 100 },
      });
    }) as unknown as typeof fetch;

    const result = await runBackfillTick(db, {
      modelName: "voyage-4-large",
      voyageModel: "voyage-4-large",
      inputType: "document",
      voyageApiKey: "k",
      voyageFetch: fetchMock,
      maxRequestsPerSecond: 1000,
      perTickLimit: 5,
    });

    expect(result.embeddedCount).toBe(5);
    expect(result.perTickLimitReached).toBe(true);
    db.close();
  });
});

describe.skipIf(!VEC0_AVAILABLE)("embeddings-backfill — error handling", () => {
  it("Voyage 400 records skipped doc but does NOT abort the tick", async () => {
    const db = setupDb();
    insertLeaf(db, "leaf_a", 100);

    const fetchMock = (async () =>
      mockResponse({ error: "bad input" }, { status: 400 })) as unknown as typeof fetch;

    const result = await runBackfillTick(db, {
      modelName: "voyage-4-large",
      voyageModel: "voyage-4-large",
      inputType: "document",
      voyageApiKey: "k",
      voyageFetch: fetchMock,
      voyageMaxRetries: 0,
      maxRequestsPerSecond: 1000,
    });

    expect(result.embeddedCount).toBe(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe("voyage_400");
    expect(result.skipped[0].summaryId).toBe("leaf_a");
    db.close();
  });

  it("Voyage 401 (auth error) is fatal and re-thrown to caller", async () => {
    const db = setupDb();
    insertLeaf(db, "leaf_a", 100);

    const fetchMock = (async () =>
      mockResponse({ error: "bad key" }, { status: 401 })) as unknown as typeof fetch;

    await expect(
      runBackfillTick(db, {
        modelName: "voyage-4-large",
        voyageModel: "voyage-4-large",
        inputType: "document",
        voyageApiKey: "k",
        voyageFetch: fetchMock,
        maxRequestsPerSecond: 1000,
      }),
    ).rejects.toMatchObject({ name: "VoyageError", kind: "auth" });
    db.close();
  });

  it("Voyage 500 on first batch — marks skipped, continues with other batches", async () => {
    const db = setupDb();
    for (let i = 0; i < 6; i++) {
      insertLeaf(db, `leaf_${i}`, 100, `distinct_${i}`);
    }

    // Track first batch's input set. Anything matching it 500's; everything
    // else succeeds. voyageMaxRetries=0 keeps the test fast.
    let firstKey: string | null = null;
    const fetchMock = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { input: string[] };
      const key = body.input.join("|");
      if (firstKey === null) firstKey = key;
      if (key === firstKey) {
        return mockResponse({ error: "internal" }, { status: 500 });
      }
      return mockResponse({
        data: body.input.map((_, i) => ({ embedding: [0.1, 0.2, 0.3], index: i })),
        usage: { total_tokens: 1 },
      });
    }) as unknown as typeof fetch;

    const result = await runBackfillTick(db, {
      modelName: "voyage-4-large",
      voyageModel: "voyage-4-large",
      inputType: "document",
      voyageApiKey: "k",
      voyageFetch: fetchMock,
      voyageMaxRetries: 0, // immediate surface, no backoff
      maxRequestsPerSecond: 1000,
      maxBatchTokens: 200,
    });

    // 6 leaves total, batches of 2 (200 tokens / 100 each). First batch
    // fails → 2 skipped. Other 2 batches succeed → 4 embedded.
    expect(result.embeddedCount).toBe(4);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped.every((s) => s.reason === "voyage_other")).toBe(true);
    db.close();
  });
});

describe.skipIf(!VEC0_AVAILABLE)("embeddings-backfill — single-flight via worker lock", () => {
  it("if another worker holds the lock, returns lockNotAcquired=true (no Voyage calls)", async () => {
    const db = setupDb();
    insertLeaf(db, "leaf_a", 100);

    // Simulate another worker holding the lock
    db.prepare(
      `INSERT INTO lcm_worker_lock (job_kind, worker_id, expires_at)
       VALUES ('embedding-backfill', 'other-worker', datetime('now', '+1 hour'))`,
    ).run();

    let calls = 0;
    const fetchMock = (async () => {
      calls++;
      return mockResponse({ data: [], usage: { total_tokens: 0 } });
    }) as unknown as typeof fetch;

    const result = await runBackfillTick(db, {
      modelName: "voyage-4-large",
      voyageModel: "voyage-4-large",
      inputType: "document",
      voyageApiKey: "k",
      voyageFetch: fetchMock,
    });

    expect(result.lockNotAcquired).toBe(true);
    expect(result.embeddedCount).toBe(0);
    expect(calls).toBe(0); // no Voyage calls
    db.close();
  });

  it("releases lock on success — next tick can re-acquire", async () => {
    const db = setupDb();
    insertLeaf(db, "leaf_a", 100);

    const fetchMock = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { input: string[] };
      return mockResponse({
        data: body.input.map((_, i) => ({ embedding: [0.1, 0.2, 0.3], index: i })),
        usage: { total_tokens: 1 },
      });
    }) as unknown as typeof fetch;

    await runBackfillTick(db, {
      modelName: "voyage-4-large",
      voyageModel: "voyage-4-large",
      inputType: "document",
      voyageApiKey: "k",
      voyageFetch: fetchMock,
      maxRequestsPerSecond: 1000,
    });

    // Lock should be released
    const lockHolder = db
      .prepare(`SELECT worker_id FROM lcm_worker_lock WHERE job_kind = 'embedding-backfill'`)
      .get();
    expect(lockHolder).toBeUndefined();
    db.close();
  });

  it("releases lock on Voyage auth error (re-throw) too — try/finally", async () => {
    const db = setupDb();
    insertLeaf(db, "leaf_a", 100);

    const fetchMock = (async () =>
      mockResponse({ error: "bad key" }, { status: 401 })) as unknown as typeof fetch;

    await expect(
      runBackfillTick(db, {
        modelName: "voyage-4-large",
        voyageModel: "voyage-4-large",
        inputType: "document",
        voyageApiKey: "k",
        voyageFetch: fetchMock,
        maxRequestsPerSecond: 1000,
      }),
    ).rejects.toMatchObject({ kind: "auth" });

    // Lock must still be released so the next tick can run after operator
    // fixes the API key
    const lockHolder = db
      .prepare(`SELECT worker_id FROM lcm_worker_lock WHERE job_kind = 'embedding-backfill'`)
      .get();
    expect(lockHolder).toBeUndefined();
    db.close();
  });
});

describe.skipIf(!VEC0_AVAILABLE)("embeddings-backfill — batching (token budget)", () => {
  it("packs batches that respect maxBatchTokens", async () => {
    // Wave-1 Auditor #2 finding #3: MAX_TOKENS_PER_EMBED_DOC dropped 30K→27K
    // to absorb Voyage's ~9.5% tokenizer inflation. Use 25K-token leaves
    // here so the per-doc filter doesn't drop them before batching.
    const db = setupDb();
    insertLeaf(db, "leaf_a", 25_000);
    insertLeaf(db, "leaf_b", 25_000);
    insertLeaf(db, "leaf_c", 25_000);

    const seenBatchSizes: number[] = [];
    const fetchMock = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { input: string[] };
      seenBatchSizes.push(body.input.length);
      return mockResponse({
        data: body.input.map((_, i) => ({ embedding: [0.1, 0.2, 0.3], index: i })),
        usage: { total_tokens: 25_000 * body.input.length },
      });
    }) as unknown as typeof fetch;

    await runBackfillTick(db, {
      modelName: "voyage-4-large",
      voyageModel: "voyage-4-large",
      inputType: "document",
      voyageApiKey: "k",
      voyageFetch: fetchMock,
      maxRequestsPerSecond: 1000,
      maxBatchTokens: 60_000, // → batches of 2 + 1
    });

    // 75K total tokens, 60K limit per batch — must be at least 2 batches.
    // Bin packing is greedy: 25+25=50≤60, then add 25 → 75>60, flush, new batch with 25.
    // So 2 batches: [2 docs, 1 doc].
    expect(seenBatchSizes).toEqual([2, 1]);
    db.close();
  });

  it("countPendingDocs returns accurate count of unembedded documents", () => {
    const db = setupDb();
    insertLeaf(db, "leaf_a", 100);
    insertLeaf(db, "leaf_b", 100);
    insertLeaf(db, "leaf_c", 100);
    expect(countPendingDocs(db, { modelName: "voyage-4-large" })).toBe(3);

    // Simulate one being already embedded
    db.prepare(
      `INSERT INTO lcm_embedding_meta (embedded_id, embedded_kind, embedding_model, source_token_count)
       VALUES ('leaf_a', 'summary', 'voyage-4-large', 100)`,
    ).run();
    expect(countPendingDocs(db, { modelName: "voyage-4-large" })).toBe(2);
    db.close();
  });
});
