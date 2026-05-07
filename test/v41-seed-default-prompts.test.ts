import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../src/db/migration.js";
import { seedDefaultPrompts } from "../src/synthesis/seed-default-prompts.js";
import { getActivePrompt } from "../src/synthesis/prompt-registry.js";

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON;");
  // Run with the seed off so the test controls when seeding happens.
  runLcmMigrations(db, { fts5Available: false, seedDefaultPrompts: false });
  return db;
}

describe("v4.1 Final.review.2 — seedDefaultPrompts (BLOCKER fix)", () => {
  it("seeds the §12 default prompts on an empty registry", () => {
    const db = freshDb();
    const before = db
      .prepare(`SELECT COUNT(*) AS n FROM lcm_prompt_registry`)
      .get() as { n: number };
    expect(before.n).toBe(0);

    const result = seedDefaultPrompts(db);
    expect(result.seeded).toBeGreaterThan(0);
    expect(result.skipped).toBe(0);

    const after = db
      .prepare(`SELECT COUNT(*) AS n FROM lcm_prompt_registry`)
      .get() as { n: number };
    expect(after.n).toBe(result.seeded);

    db.close();
  });

  it("seeds the specific (memory_type, tier_label, pass_kind) triples that synthesize_around + dispatch require", () => {
    const db = freshDb();
    seedDefaultPrompts(db);

    // The triples the production code paths depend on:
    const required: Array<{ memoryType: string; tierLabel: string | null; passKind: string }> = [
      { memoryType: "episodic-leaf", tierLabel: null, passKind: "single" },
      { memoryType: "episodic-condensed", tierLabel: "daily", passKind: "single" },
      { memoryType: "episodic-condensed", tierLabel: "weekly", passKind: "single" },
      { memoryType: "episodic-condensed", tierLabel: "monthly", passKind: "single" },
      { memoryType: "episodic-condensed", tierLabel: "monthly", passKind: "verify_fidelity" },
      { memoryType: "episodic-yearly", tierLabel: "yearly", passKind: "single" },
      { memoryType: "episodic-yearly", tierLabel: "yearly", passKind: "best_of_n_judge" },
      { memoryType: "episodic-condensed", tierLabel: "custom", passKind: "single" },
      { memoryType: "episodic-condensed", tierLabel: "filtered", passKind: "single" },
      { memoryType: "procedural-extract", tierLabel: null, passKind: "single" },
      { memoryType: "prospective-extract", tierLabel: null, passKind: "single" },
      { memoryType: "entity-extract", tierLabel: null, passKind: "single" },
    ];

    for (const r of required) {
      const found = getActivePrompt(db, {
        memoryType: r.memoryType as never,
        tierLabel: r.tierLabel,
        passKind: r.passKind as never,
      });
      expect(found, `expected seed for ${JSON.stringify(r)}`).toBeTruthy();
      expect(found?.template.length).toBeGreaterThan(50);
    }

    db.close();
  });

  it("is idempotent — re-running the seed does not duplicate or change rows", () => {
    const db = freshDb();
    const r1 = seedDefaultPrompts(db);
    expect(r1.seeded).toBeGreaterThan(0);
    expect(r1.skipped).toBe(0);

    const r2 = seedDefaultPrompts(db);
    expect(r2.seeded).toBe(0);
    expect(r2.skipped).toBe(r1.seeded); // every triple already exists

    const count = db.prepare(`SELECT COUNT(*) AS n FROM lcm_prompt_registry`).get() as { n: number };
    expect(count.n).toBe(r1.seeded);
    db.close();
  });

  it("does NOT overwrite an operator-registered prompt at the same triple (skips that row)", () => {
    const db = freshDb();

    // Operator manually registered a custom prompt for episodic-condensed/daily/single
    db.prepare(
      `INSERT INTO lcm_prompt_registry
         (prompt_id, memory_type, tier_label, pass_kind, version, template,
          model_recommendation, active, bundle_version, notes)
       VALUES (?, ?, ?, ?, 1, ?, ?, 1, 1, ?)`,
    ).run(
      "prompt_operator_override",
      "episodic-condensed",
      "daily",
      "single",
      "OPERATOR-OVERRIDE-TEMPLATE",
      "claude-opus-4-7",
      "operator override",
    );

    const result = seedDefaultPrompts(db);
    // Daily was already there → skipped; everything else seeded.
    expect(result.skipped).toBe(1);
    expect(result.seeded).toBeGreaterThan(0);

    // Operator's prompt is still active and unchanged.
    const active = getActivePrompt(db, {
      memoryType: "episodic-condensed",
      tierLabel: "daily",
      passKind: "single",
    });
    expect(active?.promptId).toBe("prompt_operator_override");
    expect(active?.template).toBe("OPERATOR-OVERRIDE-TEMPLATE");
    expect(active?.modelRecommendation).toBe("claude-opus-4-7");

    db.close();
  });

  it("runs inside the migration transaction without nested-tx error", () => {
    // The bug we caught was that registerPrompt does BEGIN IMMEDIATE which
    // fails inside the migration's outer BEGIN EXCLUSIVE. Verify that the
    // production migration path (default seedDefaultPrompts: true) succeeds.
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON;");
    expect(() => {
      runLcmMigrations(db, { fts5Available: false }); // default seedDefaultPrompts=true
    }).not.toThrow();

    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM lcm_prompt_registry`)
      .get() as { n: number };
    expect(count.n).toBeGreaterThan(0);
    db.close();
  });

  it("running migration twice on the same DB stays idempotent (re-run skips all)", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON;");
    runLcmMigrations(db, { fts5Available: false });
    const after1 = db
      .prepare(`SELECT COUNT(*) AS n FROM lcm_prompt_registry`)
      .get() as { n: number };

    runLcmMigrations(db, { fts5Available: false });
    const after2 = db
      .prepare(`SELECT COUNT(*) AS n FROM lcm_prompt_registry`)
      .get() as { n: number };

    expect(after2.n).toBe(after1.n);
    db.close();
  });
});
