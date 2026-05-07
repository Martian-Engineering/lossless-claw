import { existsSync } from "node:fs";
import { arch, platform } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import {
  registerEmbeddingProfile,
  tryLoadSqliteVec,
} from "../src/embeddings/store.js";
import { runBackfillTick } from "../src/embeddings/backfill.js";
import {
  ensureEmbeddingsTable,
} from "../src/embeddings/store.js";

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
 * Group B fix-pass-2: closes adversarial-pass HIGH/BLOCKER findings.
 *
 *   Gap 1 (BLOCKER): Voyage retry budget could exceed worker_lock TTL —
 *     other worker would steal the lock and double-bill. Fix: cap default
 *     voyageMaxRetries=1 + voyageTimeoutMs=30s in backfill.
 *
 *   Gap 2 (HIGH): Two model names that sluggify to the same vec0 table
 *     would silently corrupt KNN. Fix: reject slug collision in
 *     registerEmbeddingProfile.
 *
 *   Gap 8 (LOW, folded in): Align dim upper-bound between
 *     registerEmbeddingProfile and ensureEmbeddingsTable.
 */

describe("Group B Gap 2 — slug collision rejection in registerEmbeddingProfile", () => {
  it("rejects second profile that sluggifies to existing slug", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    registerEmbeddingProfile(db, "voyage-4-large", 1024);
    expect(() => registerEmbeddingProfile(db, "voyage_4_large", 1024)).toThrow(/slug collision/);
    expect(() => registerEmbeddingProfile(db, "Voyage-4-Large", 1024)).toThrow(/slug collision/);
    expect(() => registerEmbeddingProfile(db, "voyage4large", 1024)).toThrow(/slug collision/);
    db.close();
  });

  it("allows second profile with genuinely different slug", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    registerEmbeddingProfile(db, "voyage-4-large", 1024);
    expect(() => registerEmbeddingProfile(db, "voyage-3-lite", 512)).not.toThrow();
    expect(() => registerEmbeddingProfile(db, "openai-3-small", 1536)).not.toThrow();
    db.close();
  });

  it("re-registering same model_name same dim is still idempotent (not a collision)", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    registerEmbeddingProfile(db, "voyage-4-large", 1024);
    expect(() => registerEmbeddingProfile(db, "voyage-4-large", 1024)).not.toThrow();
    db.close();
  });

  it("collision detection is order-independent", () => {
    const db1 = new DatabaseSync(":memory:");
    runLcmMigrations(db1, { fts5Available: false });
    registerEmbeddingProfile(db1, "voyage_4_large", 1024); // underscore form first
    expect(() => registerEmbeddingProfile(db1, "voyage-4-large", 1024)).toThrow(/slug collision/);
    db1.close();
  });
});

describe("Group B Gap 8 — registerEmbeddingProfile dim upper bound aligned with ensureEmbeddingsTable", () => {
  it("rejects dim > 4096 (matching ensureEmbeddingsTable's bound)", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    expect(() => registerEmbeddingProfile(db, "huge-model", 4097)).toThrow(/max 4096/);
    expect(() => registerEmbeddingProfile(db, "huge-model", 5000)).toThrow(/max 4096/);
    db.close();
  });

  it("accepts dim = 4096 (boundary)", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    expect(() => registerEmbeddingProfile(db, "max-dim", 4096)).not.toThrow();
    db.close();
  });
});

describe.skipIf(!VEC0_AVAILABLE)(
  "Group B Gap 1 — backfill caps Voyage retry wall-time below WORKER_LOCK_TTL_MS",
  () => {
    it("backfill defaults voyageMaxRetries=1 + voyageTimeoutMs=30s", async () => {
      // Prove the new default is in effect: simulate 5xx, count calls.
      // With maxRetries=1 we should see exactly 2 calls per batch (initial
      // + 1 retry) — NOT 4 (which was the old Voyage-default behavior).
      const db = new DatabaseSync(":memory:", { allowExtension: true });
      tryLoadSqliteVec(db, { path: VEC0_PATH });
      runLcmMigrations(db, { fts5Available: false });
      db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s1', 'sk1')`).run();
      registerEmbeddingProfile(db, "voyage-4-large", 3);
      ensureEmbeddingsTable(db, "voyage-4-large", 3);
      db.prepare(
        `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key)
         VALUES (?, 1, 'leaf', ?, 1, 'sk1')`,
      ).run("leaf_a", "x");

      let calls = 0;
      const fetchMock = (async () => {
        calls++;
        return new Response(JSON.stringify({ error: "internal" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;

      // Don't pass voyageMaxRetries — let the default kick in
      await runBackfillTick(db, {
        modelName: "voyage-4-large",
        voyageModel: "voyage-4-large",
        inputType: "document",
        voyageApiKey: "k",
        voyageFetch: fetchMock,
        voyageTimeoutMs: 1000, // small for test speed
        maxRequestsPerSecond: 1000,
      });

      // 1 initial + 1 retry = 2 calls, NOT 4 (Voyage default would give 4)
      expect(calls).toBe(2);
      db.close();
    });

    it("caller can override to disable retries entirely (voyageMaxRetries: 0)", async () => {
      const db = new DatabaseSync(":memory:", { allowExtension: true });
      tryLoadSqliteVec(db, { path: VEC0_PATH });
      runLcmMigrations(db, { fts5Available: false });
      db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s1', 'sk1')`).run();
      registerEmbeddingProfile(db, "voyage-4-large", 3);
      ensureEmbeddingsTable(db, "voyage-4-large", 3);
      db.prepare(
        `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key)
         VALUES (?, 1, 'leaf', ?, 1, 'sk1')`,
      ).run("leaf_a", "x");

      let calls = 0;
      const fetchMock = (async () => {
        calls++;
        return new Response(JSON.stringify({ error: "internal" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;

      await runBackfillTick(db, {
        modelName: "voyage-4-large",
        voyageModel: "voyage-4-large",
        inputType: "document",
        voyageApiKey: "k",
        voyageFetch: fetchMock,
        voyageMaxRetries: 0,
        voyageTimeoutMs: 1000,
        maxRequestsPerSecond: 1000,
      });

      expect(calls).toBe(1); // no retries
      db.close();
    });
  },
);
