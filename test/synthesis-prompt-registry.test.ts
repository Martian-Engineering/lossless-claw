import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import {
  bumpBundleVersion,
  getActivePrompt,
  getPromptById,
  listActivePrompts,
  registerPrompt,
} from "../src/synthesis/prompt-registry.js";

function newDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false });
  return db;
}

describe("prompt-registry — registerPrompt + getActivePrompt", () => {
  it("registers a new prompt and getActivePrompt returns it", () => {
    const db = newDb();
    const promptId = registerPrompt(db, {
      memoryType: "episodic-leaf",
      passKind: "single",
      template: "Summarize:",
    });
    expect(promptId).toMatch(/^prompt_episodic-leaf_any_single_v1_[0-9a-f]{6}$/);

    const active = getActivePrompt(db, {
      memoryType: "episodic-leaf",
      tierLabel: null,
      passKind: "single",
    });
    expect(active).not.toBeNull();
    expect(active?.promptId).toBe(promptId);
    expect(active?.template).toBe("Summarize:");
    expect(active?.version).toBe(1);
    expect(active?.active).toBe(true);
    expect(active?.bundleVersion).toBe(1);
    db.close();
  });

  it("registering again with same triple deactivates previous + bumps version", () => {
    const db = newDb();
    const v1 = registerPrompt(db, {
      memoryType: "episodic-condensed",
      tierLabel: "weekly",
      passKind: "single",
      template: "v1 template",
    });
    const v2 = registerPrompt(db, {
      memoryType: "episodic-condensed",
      tierLabel: "weekly",
      passKind: "single",
      template: "v2 template",
    });
    expect(v1).not.toBe(v2);

    const active = getActivePrompt(db, {
      memoryType: "episodic-condensed",
      tierLabel: "weekly",
      passKind: "single",
    });
    expect(active?.promptId).toBe(v2);
    expect(active?.template).toBe("v2 template");
    expect(active?.version).toBe(2);

    // v1 is still in the table (archived)
    const v1Row = getPromptById(db, v1);
    expect(v1Row).not.toBeNull();
    expect(v1Row?.active).toBe(false);
    expect(v1Row?.template).toBe("v1 template");
    db.close();
  });

  it("auto-versioning is per-triple — different triples have independent versions", () => {
    const db = newDb();
    registerPrompt(db, { memoryType: "episodic-leaf", passKind: "single", template: "leaf v1" });
    registerPrompt(db, { memoryType: "episodic-leaf", passKind: "single", template: "leaf v2" });
    registerPrompt(db, {
      memoryType: "episodic-condensed",
      tierLabel: "weekly",
      passKind: "single",
      template: "condensed v1",
    });

    expect(
      getActivePrompt(db, { memoryType: "episodic-leaf", tierLabel: null, passKind: "single" })
        ?.version,
    ).toBe(2);
    expect(
      getActivePrompt(db, {
        memoryType: "episodic-condensed",
        tierLabel: "weekly",
        passKind: "single",
      })?.version,
    ).toBe(1);
    db.close();
  });

  it("NULL tierLabel is matched literally (not coerced to empty string)", () => {
    const db = newDb();
    registerPrompt(db, {
      memoryType: "episodic-leaf",
      tierLabel: null,
      passKind: "single",
      template: "no-tier",
    });
    registerPrompt(db, {
      memoryType: "episodic-leaf",
      tierLabel: "monthly",
      passKind: "single",
      template: "monthly-tier",
    });

    const noTier = getActivePrompt(db, {
      memoryType: "episodic-leaf",
      tierLabel: null,
      passKind: "single",
    });
    expect(noTier?.template).toBe("no-tier");

    const monthlyTier = getActivePrompt(db, {
      memoryType: "episodic-leaf",
      tierLabel: "monthly",
      passKind: "single",
    });
    expect(monthlyTier?.template).toBe("monthly-tier");
    db.close();
  });

  it("getActivePrompt returns null when no prompt registered for triple", () => {
    const db = newDb();
    expect(
      getActivePrompt(db, {
        memoryType: "theme-consolidation",
        tierLabel: null,
        passKind: "single",
      }),
    ).toBeNull();
    db.close();
  });
});

describe("prompt-registry — registerPrompt with overrides", () => {
  it("respects promptIdOverride", () => {
    const db = newDb();
    const id = registerPrompt(db, {
      memoryType: "episodic-leaf",
      passKind: "single",
      template: "x",
      promptIdOverride: "my-stable-id",
    });
    expect(id).toBe("my-stable-id");
    db.close();
  });

  it("stores modelRecommendation, bundleVersion, notes", () => {
    const db = newDb();
    registerPrompt(db, {
      memoryType: "episodic-leaf",
      passKind: "single",
      template: "x",
      modelRecommendation: "claude-haiku-4-5",
      bundleVersion: 3,
      notes: "test prompt",
    });
    const active = getActivePrompt(db, {
      memoryType: "episodic-leaf",
      tierLabel: null,
      passKind: "single",
    });
    expect(active?.modelRecommendation).toBe("claude-haiku-4-5");
    expect(active?.bundleVersion).toBe(3);
    expect(active?.notes).toBe("test prompt");
    db.close();
  });
});

describe("prompt-registry — listActivePrompts", () => {
  it("returns all active prompts; never returns archived", () => {
    const db = newDb();
    registerPrompt(db, { memoryType: "episodic-leaf", passKind: "single", template: "v1" });
    registerPrompt(db, { memoryType: "episodic-leaf", passKind: "single", template: "v2" });
    registerPrompt(db, {
      memoryType: "episodic-condensed",
      tierLabel: "weekly",
      passKind: "single",
      template: "weekly v1",
    });
    registerPrompt(db, {
      memoryType: "episodic-yearly",
      tierLabel: "2026",
      passKind: "best_of_n_judge",
      template: "yearly judge",
    });

    const active = listActivePrompts(db);
    expect(active).toHaveLength(3); // 1 leaf (v2 active), 1 weekly, 1 yearly
    const leafActive = active.find((p) => p.memoryType === "episodic-leaf");
    expect(leafActive?.template).toBe("v2");
    db.close();
  });
});

describe("prompt-registry — bumpBundleVersion", () => {
  it("increments bundle_version on every active prompt", () => {
    const db = newDb();
    registerPrompt(db, { memoryType: "episodic-leaf", passKind: "single", template: "x", bundleVersion: 1 });
    registerPrompt(db, {
      memoryType: "episodic-condensed",
      tierLabel: "weekly",
      passKind: "single",
      template: "y",
      bundleVersion: 1,
    });
    expect(bumpBundleVersion(db)).toBe(2);
    expect(
      getActivePrompt(db, { memoryType: "episodic-leaf", tierLabel: null, passKind: "single" })
        ?.bundleVersion,
    ).toBe(2);
    expect(
      getActivePrompt(db, {
        memoryType: "episodic-condensed",
        tierLabel: "weekly",
        passKind: "single",
      })?.bundleVersion,
    ).toBe(2);
    db.close();
  });

  it("does NOT bump archived prompts", () => {
    const db = newDb();
    const v1 = registerPrompt(db, { memoryType: "episodic-leaf", passKind: "single", template: "v1", bundleVersion: 5 });
    registerPrompt(db, { memoryType: "episodic-leaf", passKind: "single", template: "v2", bundleVersion: 1 });
    bumpBundleVersion(db);
    expect(getPromptById(db, v1)?.bundleVersion).toBe(5); // unchanged
    db.close();
  });
});

describe("prompt-registry — atomic transaction on registerPrompt", () => {
  it("rolls back deactivation if insert fails (e.g. promptIdOverride collision)", () => {
    const db = newDb();
    const v1 = registerPrompt(db, {
      memoryType: "episodic-leaf",
      passKind: "single",
      template: "v1",
      promptIdOverride: "stable-id",
    });
    expect(getPromptById(db, v1)?.active).toBe(true);

    // Try to insert with the SAME promptIdOverride — should fail PK constraint
    expect(() =>
      registerPrompt(db, {
        memoryType: "episodic-leaf",
        passKind: "single",
        template: "v2 attempt",
        promptIdOverride: "stable-id", // collision
      }),
    ).toThrow();

    // v1 should STILL be active (rollback restored it)
    expect(getPromptById(db, v1)?.active).toBe(true);
    db.close();
  });
});
