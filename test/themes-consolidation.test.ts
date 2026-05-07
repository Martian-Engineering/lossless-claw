import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import {
  consolidateThemesPass,
  listThemes,
  markThemesStaleFor,
  type CandidateLeafForTheme,
  type NameThemeFn,
} from "../src/themes/consolidation.js";

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false });
  db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s1', 'sk1')`).run();
  return db;
}

function leaf(id: string, vec: [number, number, number]): CandidateLeafForTheme {
  return { summaryId: id, vector: new Float32Array(vec) };
}

function insertSummary(db: DatabaseSync, summaryId: string): void {
  db.prepare(
    `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key)
     VALUES (?, 1, 'leaf', 'x', 1, 'sk1')`,
  ).run(summaryId);
}

describe("themes-consolidation — schema migration", () => {
  it("lcm_themes + lcm_theme_sources + suppression trigger present after migration", () => {
    const db = setupDb();
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'lcm_theme%'`,
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name).sort()).toEqual(["lcm_theme_sources", "lcm_themes"]);

    const trigger = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='trigger' AND name = 'lcm_themes_stale_on_suppress'`,
      )
      .get();
    expect(trigger).not.toBeUndefined();
    db.close();
  });
});

describe("themes-consolidation — basic happy path", () => {
  it("clusters 5+ leaves, names + writes theme + sources", async () => {
    const db = setupDb();
    for (let i = 0; i < 6; i++) insertSummary(db, `leaf_${i}`);

    const candidates = Array.from({ length: 6 }, (_, i) => leaf(`leaf_${i}`, [0.1, 0.2, 0.3]));
    const namer: NameThemeFn = async () => ({
      name: "Pre-launch debugging",
      description: "Cluster of debugging-related leaves.",
      confidence: 0.85,
      modelUsed: "test-model",
    });
    const r = await consolidateThemesPass(db, candidates, namer, {
      sessionKey: "sk1",
      passId: "pass1",
    });

    expect(r.themesWritten).toBe(1);
    const themes = listThemes(db, { sessionKey: "sk1" });
    expect(themes).toHaveLength(1);
    expect(themes[0].name).toBe("Pre-launch debugging");
    expect(themes[0].sourceLeafCount).toBe(6);

    // theme_sources rows
    const sources = db
      .prepare(
        `SELECT summary_id FROM lcm_theme_sources WHERE theme_id = ? ORDER BY summary_id`,
      )
      .all(themes[0].themeId) as Array<{ summary_id: string }>;
    expect(sources.map((s) => s.summary_id).sort()).toEqual([
      "leaf_0", "leaf_1", "leaf_2", "leaf_3", "leaf_4", "leaf_5",
    ]);
    db.close();
  });

  it("clusters below minOccurrences (5) skipped silently", async () => {
    const db = setupDb();
    for (let i = 0; i < 3; i++) insertSummary(db, `leaf_${i}`);
    const candidates = Array.from({ length: 3 }, (_, i) => leaf(`leaf_${i}`, [0.1, 0.2, 0.3]));
    const namer: NameThemeFn = async () => ({ name: "x", description: "y" });
    const r = await consolidateThemesPass(db, candidates, namer, {
      sessionKey: "sk1",
      passId: "pass2",
    });
    expect(r.themesWritten).toBe(0);
    expect(r.largeClusterCount).toBe(0);
    db.close();
  });

  it("operator can lower minOccurrences for testing", async () => {
    const db = setupDb();
    for (let i = 0; i < 3; i++) insertSummary(db, `leaf_${i}`);
    const candidates = Array.from({ length: 3 }, (_, i) => leaf(`leaf_${i}`, [0.1, 0.2, 0.3]));
    const namer: NameThemeFn = async () => ({ name: "small", description: "test", confidence: 0.9 });
    const r = await consolidateThemesPass(db, candidates, namer, {
      sessionKey: "sk1",
      passId: "pass3",
      minOccurrences: 2,
    });
    expect(r.themesWritten).toBe(1);
    db.close();
  });
});

describe("themes-consolidation — naming pass declines", () => {
  it("low confidence (< minConfidence default 0.6) is rejected", async () => {
    const db = setupDb();
    for (let i = 0; i < 5; i++) insertSummary(db, `leaf_${i}`);
    const candidates = Array.from({ length: 5 }, (_, i) => leaf(`leaf_${i}`, [0.1, 0.2, 0.3]));
    const namer: NameThemeFn = async () => ({
      name: "Maybe a theme",
      description: "?",
      confidence: 0.3,
    });
    const r = await consolidateThemesPass(db, candidates, namer, {
      sessionKey: "sk1",
      passId: "pass4",
    });
    expect(r.themesWritten).toBe(0);
    expect(r.namingRejected).toBe(1);
    db.close();
  });

  it("namer throws → naming-rejected, consolidation continues for other clusters", async () => {
    const db = setupDb();
    // Two ORTHOGONAL clusters of 5 — first namer call fails, second succeeds
    for (let i = 0; i < 10; i++) insertSummary(db, `leaf_${i}`);
    const candidates: CandidateLeafForTheme[] = [];
    for (let i = 0; i < 5; i++) candidates.push(leaf(`leaf_${i}`, [1, 0, 0]));
    for (let i = 5; i < 10; i++) candidates.push(leaf(`leaf_${i}`, [0, 1, 0]));

    let calls = 0;
    const namer: NameThemeFn = async () => {
      calls++;
      if (calls === 1) throw new Error("namer flake");
      return { name: "Theme 2", description: "ok", confidence: 0.9 };
    };
    const r = await consolidateThemesPass(db, candidates, namer, {
      sessionKey: "sk1",
      passId: "pass5",
      cutHeight: 0.5,
    });
    expect(r.themesWritten).toBe(1);
    expect(r.namingRejected).toBeGreaterThan(0);
    db.close();
  });

  it("empty name from namer is rejected", async () => {
    const db = setupDb();
    for (let i = 0; i < 5; i++) insertSummary(db, `leaf_${i}`);
    const candidates = Array.from({ length: 5 }, (_, i) => leaf(`leaf_${i}`, [0.1, 0.2, 0.3]));
    const namer: NameThemeFn = async () => ({ name: "  ", description: "x", confidence: 1 });
    const r = await consolidateThemesPass(db, candidates, namer, {
      sessionKey: "sk1",
      passId: "pass6",
    });
    expect(r.themesWritten).toBe(0);
    expect(r.namingRejected).toBe(1);
    db.close();
  });
});

describe("themes-consolidation — suppression cascade trigger", () => {
  it("AFTER UPDATE OF suppressed_at flips active themes referencing the leaf to 'stale'", async () => {
    const db = setupDb();
    for (let i = 0; i < 5; i++) insertSummary(db, `leaf_${i}`);
    const candidates = Array.from({ length: 5 }, (_, i) => leaf(`leaf_${i}`, [0.1, 0.2, 0.3]));
    const namer: NameThemeFn = async () => ({ name: "T", description: "x", confidence: 0.9 });
    await consolidateThemesPass(db, candidates, namer, {
      sessionKey: "sk1",
      passId: "p7",
    });

    const before = listThemes(db, { sessionKey: "sk1" });
    expect(before[0].status).toBe("active");

    // Suppress one of the source leaves
    db.prepare(`UPDATE summaries SET suppressed_at = datetime('now') WHERE summary_id = ?`).run("leaf_0");

    const after = listThemes(db, { sessionKey: "sk1", status: "stale" });
    expect(after).toHaveLength(1);
    expect(after[0].themeId).toBe(before[0].themeId);
    db.close();
  });

  it("trigger does NOT fire when suppressed_at is set to itself (NULL → NULL)", async () => {
    const db = setupDb();
    for (let i = 0; i < 5; i++) insertSummary(db, `leaf_${i}`);
    const candidates = Array.from({ length: 5 }, (_, i) => leaf(`leaf_${i}`, [0.1, 0.2, 0.3]));
    const namer: NameThemeFn = async () => ({ name: "T", description: "x", confidence: 0.9 });
    await consolidateThemesPass(db, candidates, namer, { sessionKey: "sk1", passId: "p8" });

    db.prepare(`UPDATE summaries SET suppressed_at = NULL WHERE summary_id = 'leaf_0'`).run();
    const after = listThemes(db, { sessionKey: "sk1" });
    expect(after[0].status).toBe("active"); // not flipped
    db.close();
  });
});

describe("themes-consolidation — markThemesStaleFor", () => {
  it("manually flip themes to stale for a specific leaf", async () => {
    const db = setupDb();
    for (let i = 0; i < 5; i++) insertSummary(db, `leaf_${i}`);
    const candidates = Array.from({ length: 5 }, (_, i) => leaf(`leaf_${i}`, [0.1, 0.2, 0.3]));
    const namer: NameThemeFn = async () => ({ name: "T", description: "x", confidence: 0.9 });
    await consolidateThemesPass(db, candidates, namer, { sessionKey: "sk1", passId: "p9" });

    const flipped = markThemesStaleFor(db, "leaf_0");
    expect(flipped).toBe(1);
    expect(listThemes(db, { sessionKey: "sk1", status: "stale" })).toHaveLength(1);
    db.close();
  });
});

describe("themes-consolidation — listThemes status filter", () => {
  it("default 'active'; 'all' returns all statuses", async () => {
    const db = setupDb();
    for (let i = 0; i < 5; i++) insertSummary(db, `leaf_${i}`);
    const candidates = Array.from({ length: 5 }, (_, i) => leaf(`leaf_${i}`, [0.1, 0.2, 0.3]));
    const namer: NameThemeFn = async () => ({ name: "T", description: "x", confidence: 0.9 });
    await consolidateThemesPass(db, candidates, namer, { sessionKey: "sk1", passId: "p10" });

    db.prepare(`UPDATE lcm_themes SET status = 'archived' WHERE 1=1`).run();
    expect(listThemes(db, { sessionKey: "sk1" })).toHaveLength(0); // active only
    expect(listThemes(db, { sessionKey: "sk1", status: "archived" })).toHaveLength(1);
    expect(listThemes(db, { sessionKey: "sk1", status: "all" })).toHaveLength(1);
    db.close();
  });
});

describe("themes-consolidation — empty input", () => {
  it("returns empty report when no candidates", async () => {
    const db = setupDb();
    const namer: NameThemeFn = async () => ({ name: "x", description: "y" });
    const r = await consolidateThemesPass(db, [], namer, { sessionKey: "sk1", passId: "p11" });
    expect(r.candidateCount).toBe(0);
    expect(r.themesWritten).toBe(0);
    db.close();
  });
});
