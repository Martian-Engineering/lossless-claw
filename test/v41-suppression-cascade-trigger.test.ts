import { existsSync } from "node:fs";
import { arch, platform } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import {
  dropEmbeddingsTriggers,
  embeddingsTableName,
  ensureEmbeddingsTable,
  isEmbedded,
  recordEmbedding,
  registerEmbeddingProfile,
  searchSimilar,
  tryLoadSqliteVec,
} from "../src/embeddings/store.js";

/**
 * B.03 — suppression + deletion cascade triggers.
 *
 * Two layers being verified here:
 *
 *   1. Per-model vec0 triggers (created by ensureEmbeddingsTable):
 *      - AFTER UPDATE OF suppressed_at ON summaries → mirror to vec0.suppressed
 *      - AFTER DELETE ON summaries → DELETE matching vec0 row
 *
 *   2. Shared meta-table cleanup trigger (created by migration):
 *      - AFTER DELETE ON summaries → DELETE matching lcm_embedding_meta row
 *        (filtered to kind='summary' to leave entity/theme meta alone)
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

function newDbWithExtAllowed(): DatabaseSync {
  return new DatabaseSync(":memory:", { allowExtension: true });
}

function setupDb(): DatabaseSync {
  const db = newDbWithExtAllowed();
  tryLoadSqliteVec(db, { path: VEC0_PATH });
  runLcmMigrations(db, { fts5Available: false });
  // Conversation row required because summaries.conversation_id has FK
  db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s1', 'sk1')`).run();
  registerEmbeddingProfile(db, "voyage-4-large", 3);
  ensureEmbeddingsTable(db, "voyage-4-large", 3);
  return db;
}

function insertSummary(db: DatabaseSync, summaryId: string, conversationId = 1): void {
  db.prepare(
    `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key)
     VALUES (?, ?, 'leaf', 'x', 1, 'sk1')`,
  ).run(summaryId, conversationId);
}

function insertEmbeddingFor(db: DatabaseSync, summaryId: string, suppressed = false): void {
  recordEmbedding(db, {
    modelName: "voyage-4-large",
    embeddedId: summaryId,
    embeddedKind: "summary",
    vector: [0.1, 0.2, 0.3],
    suppressed,
    sourceTokenCount: 1,
  });
}

describe("v4.1 B.03 — meta-table cleanup trigger (always-on, no vec0)", () => {
  it("AFTER DELETE on summaries cascades to lcm_embedding_meta (kind='summary' rows only)", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s1', 'sk1')`).run();
    registerEmbeddingProfile(db, "voyage-4-large", 3);
    db.prepare(
      `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key)
       VALUES (?, 1, 'leaf', 'x', 1, 'sk1')`,
    ).run("leaf_a");
    db.prepare(
      `INSERT INTO lcm_embedding_meta (embedded_id, embedded_kind, embedding_model, source_token_count)
       VALUES (?, 'summary', 'voyage-4-large', 100)`,
    ).run("leaf_a");
    // Also an entity-kind meta row that should NOT be touched
    db.prepare(
      `INSERT INTO lcm_embedding_meta (embedded_id, embedded_kind, embedding_model, source_token_count)
       VALUES ('ent_x', 'entity', 'voyage-4-large', 50)`,
    ).run();

    expect(
      (
        db.prepare(`SELECT COUNT(*) AS n FROM lcm_embedding_meta`).get() as { n: number }
      ).n,
    ).toBe(2);

    db.prepare(`DELETE FROM summaries WHERE summary_id = ?`).run("leaf_a");

    const remaining = db
      .prepare(`SELECT embedded_id, embedded_kind FROM lcm_embedding_meta`)
      .all() as Array<{ embedded_id: string; embedded_kind: string }>;
    expect(remaining).toEqual([{ embedded_id: "ent_x", embedded_kind: "entity" }]);
    db.close();
  });

  it("trigger is idempotent — re-running migration does not duplicate it", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    runLcmMigrations(db, { fts5Available: false }); // again — IF NOT EXISTS keeps this safe
    const triggers = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='trigger' AND name = 'lcm_embedding_meta_cleanup_summary'`,
      )
      .all() as Array<{ name: string }>;
    expect(triggers.length).toBe(1);
    db.close();
  });
});

describe.skipIf(!VEC0_AVAILABLE)("v4.1 B.03 — vec0 suppression cascade trigger", () => {
  it("AFTER UPDATE OF suppressed_at on summaries flips vec0.suppressed; KNN search excludes the row", () => {
    const db = setupDb();
    insertSummary(db, "leaf_a");
    insertEmbeddingFor(db, "leaf_a");

    const before = searchSimilar(db, {
      modelName: "voyage-4-large",
      queryVector: [0.1, 0.2, 0.3],
      k: 5,
    });
    expect(before.map((h) => h.embeddedId)).toEqual(["leaf_a"]);

    // Mark suppressed via UPDATE — trigger should mirror to vec0
    db.prepare(`UPDATE summaries SET suppressed_at = ? WHERE summary_id = ?`).run(
      "2026-05-05 00:00:00",
      "leaf_a",
    );

    const after = searchSimilar(db, {
      modelName: "voyage-4-large",
      queryVector: [0.1, 0.2, 0.3],
      k: 5,
    });
    expect(after).toEqual([]); // suppressed by metadata pre-filter
    db.close();
  });

  it("un-suppression cascade works too (suppressed_at → NULL)", () => {
    const db = setupDb();
    insertSummary(db, "leaf_a");
    insertEmbeddingFor(db, "leaf_a", /*suppressed*/ true);

    db.prepare(`UPDATE summaries SET suppressed_at = ? WHERE summary_id = ?`).run(
      "2026-05-05 00:00:00",
      "leaf_a",
    );
    const stillHidden = searchSimilar(db, {
      modelName: "voyage-4-large",
      queryVector: [0.1, 0.2, 0.3],
      k: 5,
    });
    expect(stillHidden).toEqual([]);

    db.prepare(`UPDATE summaries SET suppressed_at = NULL WHERE summary_id = ?`).run("leaf_a");

    const restored = searchSimilar(db, {
      modelName: "voyage-4-large",
      queryVector: [0.1, 0.2, 0.3],
      k: 5,
    });
    expect(restored.map((h) => h.embeddedId)).toEqual(["leaf_a"]);
    db.close();
  });

  it("trigger fires only on suppressed_at column change, not on other column updates", () => {
    // The trigger uses `WHEN (NEW.suppressed_at IS NULL) != (OLD.suppressed_at IS NULL)`
    // to avoid running on every other UPDATE. Verifies that AFTER UPDATE OF
    // is column-scoped AND that the WHEN clause skips no-op transitions.
    const db = setupDb();
    insertSummary(db, "leaf_a");
    insertEmbeddingFor(db, "leaf_a");

    // Update an unrelated column — should not flip vec0.suppressed
    db.prepare(`UPDATE summaries SET content = 'updated' WHERE summary_id = ?`).run("leaf_a");
    const stillVisible = searchSimilar(db, {
      modelName: "voyage-4-large",
      queryVector: [0.1, 0.2, 0.3],
      k: 5,
    });
    expect(stillVisible.map((h) => h.embeddedId)).toEqual(["leaf_a"]);

    // Update suppressed_at to the SAME value (NULL → NULL) — trigger WHEN
    // clause should skip
    db.prepare(`UPDATE summaries SET suppressed_at = NULL WHERE summary_id = ?`).run("leaf_a");
    const stillVisible2 = searchSimilar(db, {
      modelName: "voyage-4-large",
      queryVector: [0.1, 0.2, 0.3],
      k: 5,
    });
    expect(stillVisible2.map((h) => h.embeddedId)).toEqual(["leaf_a"]);
    db.close();
  });

  it("AFTER DELETE on summaries removes the vec0 row", () => {
    const db = setupDb();
    insertSummary(db, "leaf_a");
    insertSummary(db, "leaf_b");
    insertEmbeddingFor(db, "leaf_a");
    insertEmbeddingFor(db, "leaf_b");

    const tableName = embeddingsTableName("voyage-4-large");
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM ${tableName}`).get() as { n: number }).n,
    ).toBe(2);

    db.prepare(`DELETE FROM summaries WHERE summary_id = ?`).run("leaf_a");

    const remaining = db
      .prepare(`SELECT embedded_id FROM ${tableName} ORDER BY embedded_id`)
      .all() as Array<{ embedded_id: string }>;
    expect(remaining).toEqual([{ embedded_id: "leaf_b" }]);

    // And meta should be cleaned up too (separate trigger)
    expect(isEmbedded(db, { modelName: "voyage-4-large", embeddedId: "leaf_a", embeddedKind: "summary" })).toBe(false);
    expect(isEmbedded(db, { modelName: "voyage-4-large", embeddedId: "leaf_b", embeddedKind: "summary" })).toBe(true);
    db.close();
  });

  it("two embedding models — both vec0 tables get cleaned up by the cascade", () => {
    const db = setupDb();
    registerEmbeddingProfile(db, "voyage-3-lite", 3);
    ensureEmbeddingsTable(db, "voyage-3-lite", 3);

    insertSummary(db, "leaf_a");
    insertEmbeddingFor(db, "leaf_a");
    recordEmbedding(db, {
      modelName: "voyage-3-lite",
      embeddedId: "leaf_a",
      embeddedKind: "summary",
      vector: [0.5, 0.5, 0.5],
      sourceTokenCount: 1,
    });

    db.prepare(`DELETE FROM summaries WHERE summary_id = ?`).run("leaf_a");

    // Both models' vec0 tables should be empty
    expect(
      (
        db
          .prepare(`SELECT COUNT(*) AS n FROM ${embeddingsTableName("voyage-4-large")}`)
          .get() as { n: number }
      ).n,
    ).toBe(0);
    expect(
      (
        db
          .prepare(`SELECT COUNT(*) AS n FROM ${embeddingsTableName("voyage-3-lite")}`)
          .get() as { n: number }
      ).n,
    ).toBe(0);
    db.close();
  });

  it("dropEmbeddingsTriggers removes per-model triggers (used during model archival)", () => {
    const db = setupDb();
    insertSummary(db, "leaf_a");
    insertEmbeddingFor(db, "leaf_a");

    dropEmbeddingsTriggers(db, "voyage-4-large");

    // After dropping triggers, suppression cascade no longer happens
    db.prepare(`UPDATE summaries SET suppressed_at = ? WHERE summary_id = ?`).run(
      "2026-05-05 00:00:00",
      "leaf_a",
    );
    // vec0.suppressed should still be 0 — trigger no longer firing
    const tableName = embeddingsTableName("voyage-4-large");
    const row = db
      .prepare(`SELECT suppressed FROM ${tableName} WHERE embedded_id = ?`)
      .get("leaf_a") as { suppressed: number };
    expect(row.suppressed).toBe(0);
    db.close();
  });

  it("triggers are idempotent — calling ensureEmbeddingsTable twice doesn't error", () => {
    const db = setupDb();
    // Already called once in setupDb; call again — IF NOT EXISTS keeps it safe
    ensureEmbeddingsTable(db, "voyage-4-large", 3);
    const triggers = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'lcm_embed_%_voyage4large'`,
      )
      .all() as Array<{ name: string }>;
    expect(triggers.map((t) => t.name).sort()).toEqual([
      "lcm_embed_delete_voyage4large",
      "lcm_embed_suppress_voyage4large",
    ]);
    db.close();
  });
});
