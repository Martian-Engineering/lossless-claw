import { existsSync } from "node:fs";
import { arch, platform } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import {
  candidateVec0Paths,
  deleteEmbedding,
  embeddingsTableExists,
  embeddingsTableName,
  ensureEmbeddingsTable,
  isEmbedded,
  markEmbeddingSuppressed,
  recordEmbedding,
  registerEmbeddingProfile,
  replaceEmbedding,
  searchSimilar,
  tryLoadSqliteVec,
  vec0Version,
} from "../src/embeddings/store.js";

/**
 * Tests for src/embeddings/store.ts.
 *
 * vec0-dependent tests are gated on the extension being loadable. The
 * vitest config (vitest.config.ts) overrides $HOME to a temp dir, so
 * `homedir()`-based path discovery WILL NOT find a dev-box-installed
 * sqlite-vec — set `LCM_TEST_VEC0_PATH` env var to point to a
 * `vec0.<dylib|so|dll>` to enable the vec0-dependent suite.
 *
 * On CI without sqlite-vec, the suite skips cleanly. On Eva's dev box,
 * `LCM_TEST_VEC0_PATH=/Users/lume/.openclaw/extensions/node_modules/sqlite-vec-darwin-arm64/vec0.dylib`
 * (or set in shell rc) enables the full suite.
 */

const DEV_VEC0_PATH =
  process.env.LCM_TEST_VEC0_PATH?.trim() ||
  // Fallback default: most-common dev install location with REAL_HOME if set
  (() => {
    const realHome = process.env.REAL_HOME?.trim() || "/Users/lume";
    const ext = platform() === "win32" ? "dll" : platform() === "darwin" ? "dylib" : "so";
    const platformPkg = `sqlite-vec-${platform() === "win32" ? "windows" : platform()}-${arch()}`;
    return `${realHome}/.openclaw/extensions/node_modules/${platformPkg}/vec0.${ext}`;
  })();
const VEC0_AVAILABLE = existsSync(DEV_VEC0_PATH);

function newDbWithExtAllowed(): DatabaseSync {
  return new DatabaseSync(":memory:", { allowExtension: true });
}

describe("embeddings store — embeddingsTableName", () => {
  it("sluggifies voyage-4-large to voyage4large", () => {
    expect(embeddingsTableName("voyage-4-large")).toBe("lcm_embeddings_voyage4large");
  });
  it("sluggifies voyage-3-lite to voyage3lite", () => {
    expect(embeddingsTableName("voyage-3-lite")).toBe("lcm_embeddings_voyage3lite");
  });
  it("rejects empty model name", () => {
    expect(() => embeddingsTableName("")).toThrow(/invalid model name/);
  });
  it("rejects model names with bad characters (defense vs SQL injection)", () => {
    expect(() => embeddingsTableName("foo; DROP TABLE")).toThrow(/invalid model name/);
    expect(() => embeddingsTableName("foo'bar")).toThrow(/invalid model name/);
    expect(() => embeddingsTableName("foo\nbar")).toThrow(/invalid model name/);
  });
  it("rejects model names that sluggify to empty", () => {
    expect(() => embeddingsTableName("___")).toThrow(/sluggifies to empty/);
  });
  it("accepts dot/underscore/dash characters", () => {
    expect(embeddingsTableName("voyage.4_large-test")).toBe("lcm_embeddings_voyage4largetest");
  });
});

describe("embeddings store — candidateVec0Paths", () => {
  it("includes LCM_SQLITE_VEC_PATH when set", () => {
    const original = process.env.LCM_SQLITE_VEC_PATH;
    process.env.LCM_SQLITE_VEC_PATH = "/custom/path/vec0.dylib";
    try {
      const paths = candidateVec0Paths();
      expect(paths[0]).toBe("/custom/path/vec0.dylib");
    } finally {
      if (original === undefined) delete process.env.LCM_SQLITE_VEC_PATH;
      else process.env.LCM_SQLITE_VEC_PATH = original;
    }
  });
  it("includes plugin-local node_modules path", () => {
    const paths = candidateVec0Paths();
    expect(paths.some((p) => p.includes("node_modules") && p.includes("sqlite-vec"))).toBe(true);
  });
  it("includes ~/.openclaw/extensions path", () => {
    const paths = candidateVec0Paths();
    expect(paths.some((p) => p.includes(".openclaw"))).toBe(true);
  });
});

describe("embeddings store — tryLoadSqliteVec graceful degrade", () => {
  it("returns false when no extension is found at any candidate path (silent)", () => {
    // Override with non-existent path; suppress console.warn
    const db = newDbWithExtAllowed();
    const loaded = tryLoadSqliteVec(db, { path: "/nonexistent/path/vec0.dylib", silent: true });
    expect(loaded).toBe(false);
    db.close();
  });
  it("vec0Version returns null when not loaded", () => {
    const db = newDbWithExtAllowed();
    expect(vec0Version(db)).toBeNull();
    db.close();
  });
});

describe("embeddings store — registerEmbeddingProfile", () => {
  it("inserts profile row, idempotent on second call with same dim", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    registerEmbeddingProfile(db, "voyage-4-large", 1024);
    const row1 = db
      .prepare(`SELECT model_name, dim, active FROM lcm_embedding_profile WHERE model_name = ?`)
      .get("voyage-4-large") as { model_name: string; dim: number; active: number };
    expect(row1).toEqual({ model_name: "voyage-4-large", dim: 1024, active: 1 });

    registerEmbeddingProfile(db, "voyage-4-large", 1024); // again — no-op
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM lcm_embedding_profile WHERE model_name = ?`)
      .get("voyage-4-large") as { n: number };
    expect(count.n).toBe(1);
    db.close();
  });

  it("throws on dim mismatch (profiles are immutable; bump model_name to switch)", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    registerEmbeddingProfile(db, "voyage-4-large", 1024);
    expect(() => registerEmbeddingProfile(db, "voyage-4-large", 2048)).toThrow(/dim mismatch/);
    db.close();
  });

  it("rejects bad model names", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    expect(() => registerEmbeddingProfile(db, "foo;DROP", 1024)).toThrow(/invalid model name/);
    db.close();
  });

  it("rejects bad dim", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    expect(() => registerEmbeddingProfile(db, "x", 0)).toThrow(/invalid dim/);
    expect(() => registerEmbeddingProfile(db, "x", -5)).toThrow(/invalid dim/);
    db.close();
  });
});

describe.skipIf(!VEC0_AVAILABLE)(
  "embeddings store — vec0-dependent (requires sqlite-vec at ~/.openclaw/extensions/...)",
  () => {
    it("loads vec0 from the dev path; vec0Version returns a version string", () => {
      const db = newDbWithExtAllowed();
      const loaded = tryLoadSqliteVec(db, { path: DEV_VEC0_PATH });
      expect(loaded).toBe(true);
      const v = vec0Version(db);
      expect(v).toMatch(/^v\d/); // e.g. "v0.1.9"
      db.close();
    });

    it("ensureEmbeddingsTable creates lcm_embeddings_<slug> virtual table; idempotent", () => {
      const db = newDbWithExtAllowed();
      tryLoadSqliteVec(db, { path: DEV_VEC0_PATH });
      runLcmMigrations(db, { fts5Available: false });
      registerEmbeddingProfile(db, "voyage-4-large", 1024);

      expect(embeddingsTableExists(db, "voyage-4-large")).toBe(false);
      ensureEmbeddingsTable(db, "voyage-4-large", 1024);
      expect(embeddingsTableExists(db, "voyage-4-large")).toBe(true);

      // idempotent
      ensureEmbeddingsTable(db, "voyage-4-large", 1024);
      expect(embeddingsTableExists(db, "voyage-4-large")).toBe(true);
      db.close();
    });

    it("recordEmbedding inserts vec0 row + meta row; isEmbedded reflects this", () => {
      const db = newDbWithExtAllowed();
      tryLoadSqliteVec(db, { path: DEV_VEC0_PATH });
      runLcmMigrations(db, { fts5Available: false });
      registerEmbeddingProfile(db, "voyage-4-large", 4);
      ensureEmbeddingsTable(db, "voyage-4-large", 4);

      expect(
        isEmbedded(db, {
          embeddedId: "leaf_a",
          embeddedKind: "summary",
          modelName: "voyage-4-large",
        }),
      ).toBe(false);

      recordEmbedding(db, {
        modelName: "voyage-4-large",
        embeddedId: "leaf_a",
        embeddedKind: "summary",
        vector: new Float32Array([0.1, 0.2, 0.3, 0.4]),
        sourceTokenCount: 100,
      });

      expect(
        isEmbedded(db, {
          embeddedId: "leaf_a",
          embeddedKind: "summary",
          modelName: "voyage-4-large",
        }),
      ).toBe(true);

      const meta = db
        .prepare(`SELECT source_token_count, archived FROM lcm_embedding_meta WHERE embedded_id = ?`)
        .get("leaf_a") as { source_token_count: number; archived: number };
      expect(meta).toEqual({ source_token_count: 100, archived: 0 });
      db.close();
    });

    it("recordEmbedding rejects vector with wrong dimension", () => {
      const db = newDbWithExtAllowed();
      tryLoadSqliteVec(db, { path: DEV_VEC0_PATH });
      runLcmMigrations(db, { fts5Available: false });
      registerEmbeddingProfile(db, "voyage-4-large", 4);
      ensureEmbeddingsTable(db, "voyage-4-large", 4);

      expect(() =>
        recordEmbedding(db, {
          modelName: "voyage-4-large",
          embeddedId: "leaf_a",
          embeddedKind: "summary",
          vector: new Float32Array([0.1, 0.2]), // dim 2, not 4
          sourceTokenCount: 100,
        }),
      ).toThrow(/dim mismatch/);
      db.close();
    });

    it("recordEmbedding throws when no profile registered for model", () => {
      const db = newDbWithExtAllowed();
      tryLoadSqliteVec(db, { path: DEV_VEC0_PATH });
      runLcmMigrations(db, { fts5Available: false });
      // Skip registerEmbeddingProfile — should fail
      expect(() =>
        recordEmbedding(db, {
          modelName: "voyage-4-large",
          embeddedId: "x",
          embeddedKind: "summary",
          vector: new Float32Array([0.1]),
          sourceTokenCount: 1,
        }),
      ).toThrow(/no profile registered/);
      db.close();
    });

    it("searchSimilar finds nearest vectors, excludes suppressed by default", () => {
      const db = newDbWithExtAllowed();
      tryLoadSqliteVec(db, { path: DEV_VEC0_PATH });
      runLcmMigrations(db, { fts5Available: false });
      registerEmbeddingProfile(db, "voyage-4-large", 3);
      ensureEmbeddingsTable(db, "voyage-4-large", 3);

      recordEmbedding(db, {
        modelName: "voyage-4-large",
        embeddedId: "leaf_a",
        embeddedKind: "summary",
        vector: [0.1, 0.2, 0.3],
        sourceTokenCount: 1,
      });
      recordEmbedding(db, {
        modelName: "voyage-4-large",
        embeddedId: "leaf_b",
        embeddedKind: "summary",
        vector: [0.4, 0.5, 0.6],
        sourceTokenCount: 1,
      });
      recordEmbedding(db, {
        modelName: "voyage-4-large",
        embeddedId: "leaf_suppressed",
        embeddedKind: "summary",
        vector: [0.1, 0.2, 0.3], // identical to leaf_a, but suppressed
        suppressed: true,
        sourceTokenCount: 1,
      });

      const hits = searchSimilar(db, {
        modelName: "voyage-4-large",
        queryVector: [0.1, 0.2, 0.3],
        k: 5,
      });
      // leaf_a should be top result (distance 0); leaf_suppressed excluded
      expect(hits.length).toBe(2);
      expect(hits[0].embeddedId).toBe("leaf_a");
      expect(hits.map((h) => h.embeddedId)).not.toContain("leaf_suppressed");
      db.close();
    });

    it("searchSimilar with excludeSuppressed=false returns suppressed rows too", () => {
      const db = newDbWithExtAllowed();
      tryLoadSqliteVec(db, { path: DEV_VEC0_PATH });
      runLcmMigrations(db, { fts5Available: false });
      registerEmbeddingProfile(db, "voyage-4-large", 3);
      ensureEmbeddingsTable(db, "voyage-4-large", 3);

      recordEmbedding(db, {
        modelName: "voyage-4-large",
        embeddedId: "leaf_visible",
        embeddedKind: "summary",
        vector: [0.1, 0.2, 0.3],
        sourceTokenCount: 1,
      });
      recordEmbedding(db, {
        modelName: "voyage-4-large",
        embeddedId: "leaf_hidden",
        embeddedKind: "summary",
        vector: [0.4, 0.5, 0.6],
        suppressed: true,
        sourceTokenCount: 1,
      });

      const hitsAll = searchSimilar(db, {
        modelName: "voyage-4-large",
        queryVector: [0.1, 0.2, 0.3],
        k: 5,
        excludeSuppressed: false,
      });
      expect(hitsAll.length).toBe(2);
      expect(new Set(hitsAll.map((h) => h.embeddedId))).toEqual(
        new Set(["leaf_visible", "leaf_hidden"]),
      );
      db.close();
    });

    it("searchSimilar filters by embeddedKind", () => {
      const db = newDbWithExtAllowed();
      tryLoadSqliteVec(db, { path: DEV_VEC0_PATH });
      runLcmMigrations(db, { fts5Available: false });
      registerEmbeddingProfile(db, "voyage-4-large", 3);
      ensureEmbeddingsTable(db, "voyage-4-large", 3);

      recordEmbedding(db, {
        modelName: "voyage-4-large",
        embeddedId: "leaf_a",
        embeddedKind: "summary",
        vector: [0.1, 0.1, 0.1],
        sourceTokenCount: 1,
      });
      recordEmbedding(db, {
        modelName: "voyage-4-large",
        embeddedId: "ent_b",
        embeddedKind: "entity",
        vector: [0.1, 0.1, 0.1], // identical, so distance 0 for both
        sourceTokenCount: 1,
      });

      const summariesOnly = searchSimilar(db, {
        modelName: "voyage-4-large",
        queryVector: [0.1, 0.1, 0.1],
        k: 5,
      });
      expect(summariesOnly.map((h) => h.embeddedId)).toEqual(["leaf_a"]);

      const entitiesOnly = searchSimilar(db, {
        modelName: "voyage-4-large",
        queryVector: [0.1, 0.1, 0.1],
        k: 5,
        embeddedKinds: ["entity"],
      });
      expect(entitiesOnly.map((h) => h.embeddedId)).toEqual(["ent_b"]);

      const both = searchSimilar(db, {
        modelName: "voyage-4-large",
        queryVector: [0.1, 0.1, 0.1],
        k: 5,
        embeddedKinds: ["summary", "entity"],
      });
      expect(new Set(both.map((h) => h.embeddedId))).toEqual(new Set(["leaf_a", "ent_b"]));
      db.close();
    });

    it("markEmbeddingSuppressed flips visibility on subsequent search", () => {
      const db = newDbWithExtAllowed();
      tryLoadSqliteVec(db, { path: DEV_VEC0_PATH });
      runLcmMigrations(db, { fts5Available: false });
      registerEmbeddingProfile(db, "voyage-4-large", 3);
      ensureEmbeddingsTable(db, "voyage-4-large", 3);

      recordEmbedding(db, {
        modelName: "voyage-4-large",
        embeddedId: "leaf_a",
        embeddedKind: "summary",
        vector: [0.1, 0.2, 0.3],
        sourceTokenCount: 1,
      });
      const before = searchSimilar(db, {
        modelName: "voyage-4-large",
        queryVector: [0.1, 0.2, 0.3],
        k: 5,
      });
      expect(before.map((h) => h.embeddedId)).toEqual(["leaf_a"]);

      markEmbeddingSuppressed(db, {
        modelName: "voyage-4-large",
        embeddedId: "leaf_a",
        embeddedKind: "summary",
        suppressed: true,
      });
      const after = searchSimilar(db, {
        modelName: "voyage-4-large",
        queryVector: [0.1, 0.2, 0.3],
        k: 5,
      });
      expect(after).toEqual([]); // suppressed by metadata pre-filter

      // Restoring works
      markEmbeddingSuppressed(db, {
        modelName: "voyage-4-large",
        embeddedId: "leaf_a",
        embeddedKind: "summary",
        suppressed: false,
      });
      const restored = searchSimilar(db, {
        modelName: "voyage-4-large",
        queryVector: [0.1, 0.2, 0.3],
        k: 5,
      });
      expect(restored.map((h) => h.embeddedId)).toEqual(["leaf_a"]);
      db.close();
    });

    it("replaceEmbedding removes prior + inserts new in one logical op", () => {
      const db = newDbWithExtAllowed();
      tryLoadSqliteVec(db, { path: DEV_VEC0_PATH });
      runLcmMigrations(db, { fts5Available: false });
      registerEmbeddingProfile(db, "voyage-4-large", 3);
      ensureEmbeddingsTable(db, "voyage-4-large", 3);

      recordEmbedding(db, {
        modelName: "voyage-4-large",
        embeddedId: "leaf_a",
        embeddedKind: "summary",
        vector: [0.1, 0.0, 0.0],
        sourceTokenCount: 100,
      });
      replaceEmbedding(db, {
        modelName: "voyage-4-large",
        embeddedId: "leaf_a",
        embeddedKind: "summary",
        vector: [0.0, 0.0, 1.0], // very different — query toward old vec should miss
        sourceTokenCount: 200,
      });

      const tableName = embeddingsTableName("voyage-4-large");
      const count = db
        .prepare(`SELECT COUNT(*) AS n FROM ${tableName} WHERE embedded_id = ?`)
        .get("leaf_a") as { n: number };
      expect(count.n).toBe(1); // not 2 — old row removed

      const meta = db
        .prepare(`SELECT source_token_count FROM lcm_embedding_meta WHERE embedded_id = ?`)
        .get("leaf_a") as { source_token_count: number };
      expect(meta.source_token_count).toBe(200); // updated
      db.close();
    });

    it("deleteEmbedding removes from both vec0 and meta", () => {
      const db = newDbWithExtAllowed();
      tryLoadSqliteVec(db, { path: DEV_VEC0_PATH });
      runLcmMigrations(db, { fts5Available: false });
      registerEmbeddingProfile(db, "voyage-4-large", 3);
      ensureEmbeddingsTable(db, "voyage-4-large", 3);

      recordEmbedding(db, {
        modelName: "voyage-4-large",
        embeddedId: "leaf_a",
        embeddedKind: "summary",
        vector: [0.1, 0.2, 0.3],
        sourceTokenCount: 1,
      });
      deleteEmbedding(db, {
        modelName: "voyage-4-large",
        embeddedId: "leaf_a",
        embeddedKind: "summary",
      });

      expect(
        isEmbedded(db, {
          modelName: "voyage-4-large",
          embeddedId: "leaf_a",
          embeddedKind: "summary",
        }),
      ).toBe(false);
      const tableName = embeddingsTableName("voyage-4-large");
      const count = db
        .prepare(`SELECT COUNT(*) AS n FROM ${tableName} WHERE embedded_id = ?`)
        .get("leaf_a") as { n: number };
      expect(count.n).toBe(0);
      db.close();
    });

    it("ensureEmbeddingsTable rejects bad dim", () => {
      const db = newDbWithExtAllowed();
      tryLoadSqliteVec(db, { path: DEV_VEC0_PATH });
      expect(() => ensureEmbeddingsTable(db, "voyage-4-large", 0)).toThrow(/invalid dim/);
      expect(() => ensureEmbeddingsTable(db, "voyage-4-large", 99999)).toThrow(/invalid dim/);
      db.close();
    });

    it("two different models get two independent vec0 tables", () => {
      const db = newDbWithExtAllowed();
      tryLoadSqliteVec(db, { path: DEV_VEC0_PATH });
      runLcmMigrations(db, { fts5Available: false });
      registerEmbeddingProfile(db, "voyage-4-large", 4);
      registerEmbeddingProfile(db, "voyage-3-lite", 2);
      ensureEmbeddingsTable(db, "voyage-4-large", 4);
      ensureEmbeddingsTable(db, "voyage-3-lite", 2);

      expect(embeddingsTableExists(db, "voyage-4-large")).toBe(true);
      expect(embeddingsTableExists(db, "voyage-3-lite")).toBe(true);

      // Names differ
      expect(embeddingsTableName("voyage-4-large")).not.toBe(embeddingsTableName("voyage-3-lite"));
      db.close();
    });
  },
);
