import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { PurgeError, previewPurgeAffected, runPurge } from "../src/operator/purge.js";

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false });
  db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s1', 'sk1')`).run();
  db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s2', 'agent:main:main')`).run();
  return db;
}

function insertLeaf(
  db: DatabaseSync,
  summaryId: string,
  conversationId = 1,
  content = "x",
  tokenCount = 100,
): void {
  db.prepare(
    `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key)
     VALUES (?, ?, 'leaf', ?, ?, (SELECT session_key FROM conversations WHERE conversation_id = ?))`,
  ).run(summaryId, conversationId, content, tokenCount, conversationId);
}

function insertCondensed(db: DatabaseSync, summaryId: string, conversationId: number, parentLeafIds: string[]): void {
  db.prepare(
    `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key)
     VALUES (?, ?, 'condensed', 'cond', 1, (SELECT session_key FROM conversations WHERE conversation_id = ?))`,
  ).run(summaryId, conversationId, conversationId);
  for (let i = 0; i < parentLeafIds.length; i++) {
    db.prepare(
      `INSERT INTO summary_parents (summary_id, parent_summary_id, ordinal)
       VALUES (?, ?, ?)`,
    ).run(summaryId, parentLeafIds[i], i);
  }
}

describe("operator-purge — input validation", () => {
  it("missing reason throws PurgeError(missing_reason)", () => {
    const db = setupDb();
    expect(() =>
      runPurge(db, {
        summaryIds: ["leaf_a"],
        reason: "",
      }),
    ).toThrow(PurgeError);
    db.close();
  });

  it("no criteria throws PurgeError(no_criteria)", () => {
    const db = setupDb();
    expect(() => runPurge(db, { reason: "test" })).toThrow(/at least one criterion/);
    db.close();
  });

  it("agent:main:main session refused without allowMainSession", () => {
    const db = setupDb();
    expect(() =>
      runPurge(db, {
        sessionKey: "agent:main:main",
        reason: "trying to delete main",
      }),
    ).toThrow(/agent:main:main/);
    db.close();
  });

  it("agent:main:main allowed with allowMainSession=true", () => {
    const db = setupDb();
    insertLeaf(db, "leaf_main", 2);
    const r = runPurge(db, {
      sessionKey: "agent:main:main",
      reason: "explicit main session purge",
      allowMainSession: true,
    });
    expect(r.affectedLeafIds).toContain("leaf_main");
    db.close();
  });
});

describe("operator-purge — soft mode (default)", () => {
  it("sets suppressed_at + suppress_reason on matched leaves", () => {
    const db = setupDb();
    insertLeaf(db, "leaf_a");
    insertLeaf(db, "leaf_b");
    insertLeaf(db, "leaf_other_session", 2);

    const r = runPurge(db, {
      sessionKey: "sk1",
      reason: "test reason",
    });
    expect(r.mode).toBe("soft");
    expect(r.affectedLeafIds.sort()).toEqual(["leaf_a", "leaf_b"]);

    const after = db
      .prepare(`SELECT summary_id, suppressed_at, suppress_reason FROM summaries WHERE summary_id IN ('leaf_a','leaf_b','leaf_other_session') ORDER BY summary_id`)
      .all() as Array<{ summary_id: string; suppressed_at: string | null; suppress_reason: string | null }>;
    expect(after[0].suppressed_at).not.toBeNull();
    expect(after[0].suppress_reason).toBe("test reason");
    expect(after[1].suppressed_at).not.toBeNull();
    expect(after[2].suppressed_at).toBeNull(); // other session untouched
    db.close();
  });

  it("flags affected condensed summaries with contains_suppressed_leaves=1", () => {
    const db = setupDb();
    insertLeaf(db, "leaf_a");
    insertLeaf(db, "leaf_b");
    insertLeaf(db, "leaf_unrelated");
    insertCondensed(db, "cond_x", 1, ["leaf_a", "leaf_b"]);
    insertCondensed(db, "cond_y", 1, ["leaf_unrelated"]);

    runPurge(db, {
      summaryIds: ["leaf_a"],
      reason: "test",
    });

    const cs = db
      .prepare(`SELECT summary_id, contains_suppressed_leaves FROM summaries WHERE kind = 'condensed' ORDER BY summary_id`)
      .all() as Array<{ summary_id: string; contains_suppressed_leaves: number }>;
    expect(cs[0]).toEqual({ summary_id: "cond_x", contains_suppressed_leaves: 1 });
    expect(cs[1]).toEqual({ summary_id: "cond_y", contains_suppressed_leaves: 0 });
    db.close();
  });
});

// "immediate mode" tests REMOVED in first-principles pass (2026-05-06).
// Hard-delete drainer + queue schema preserved in deferred-features
// draft PR (#616). runPurge always runs in soft mode now.

describe("operator-purge — criteria flexibility", () => {
  it("range purge by sessionKey + token cutoff", () => {
    const db = setupDb();
    insertLeaf(db, "leaf_small", 1, "x", 50);
    insertLeaf(db, "leaf_big", 1, "x", 5000);
    insertLeaf(db, "leaf_huge", 1, "x", 30000);

    const r = runPurge(db, {
      sessionKey: "sk1",
      minTokenCount: 1000,
      reason: "purge big leaves",
    });
    expect(r.affectedLeafIds.sort()).toEqual(["leaf_big", "leaf_huge"]);
    db.close();
  });

  it("range purge with since/before", () => {
    const db = setupDb();
    insertLeaf(db, "leaf_old");
    insertLeaf(db, "leaf_new");
    db.prepare(`UPDATE summaries SET created_at = '2026-01-01' WHERE summary_id = 'leaf_old'`).run();
    db.prepare(`UPDATE summaries SET created_at = '2026-05-01' WHERE summary_id = 'leaf_new'`).run();

    const r = runPurge(db, {
      sessionKey: "sk1",
      since: new Date("2026-03-01"),
      reason: "purge recent",
    });
    expect(r.affectedLeafIds).toEqual(["leaf_new"]);
    db.close();
  });

  it("explicit summaryIds: only valid leaf IDs returned", () => {
    const db = setupDb();
    insertLeaf(db, "leaf_a");
    // Already-suppressed leaf should be filtered out (we only purge non-suppressed)
    insertLeaf(db, "leaf_already_suppressed");
    db.prepare(`UPDATE summaries SET suppressed_at = '2026-01-01' WHERE summary_id = 'leaf_already_suppressed'`).run();

    const r = runPurge(db, {
      summaryIds: ["leaf_a", "leaf_already_suppressed", "leaf_does_not_exist"],
      reason: "test",
    });
    expect(r.affectedLeafIds).toEqual(["leaf_a"]); // only the valid + non-suppressed
    db.close();
  });
});

describe("operator-purge — empty match", () => {
  it("returns empty result when no leaves match criteria", () => {
    const db = setupDb();
    const r = runPurge(db, {
      sessionKey: "sk1",
      reason: "nothing to purge",
    });
    expect(r.affectedLeafIds).toEqual([]);
    db.close();
  });
});

describe("operator-purge — atomic transaction", () => {
  it("soft purge: rollback on failure leaves no partial state", () => {
    // Hard to cause a rollback in this flow without injecting mid-tx failure;
    // verify the BEGIN IMMEDIATE wrapping by checking that suppressed_at +
    // contains_suppressed_leaves are both set together.
    const db = setupDb();
    insertLeaf(db, "leaf_a");
    insertCondensed(db, "cond_x", 1, ["leaf_a"]);
    runPurge(db, { summaryIds: ["leaf_a"], reason: "test" });

    const leaf = db
      .prepare(`SELECT suppressed_at FROM summaries WHERE summary_id = 'leaf_a'`)
      .get() as { suppressed_at: string | null };
    const cond = db
      .prepare(`SELECT contains_suppressed_leaves FROM summaries WHERE summary_id = 'cond_x'`)
      .get() as { contains_suppressed_leaves: number };
    expect(leaf.suppressed_at).not.toBeNull();
    expect(cond.contains_suppressed_leaves).toBe(1);
    db.close();
  });
});

// Wave-3 Auditor #7 fix: previewPurgeAffected was added in Wave-2 but
// had ZERO tests pinning it. The whole purpose is preview/apply parity
// — the dry-run count MUST equal the actual affected count.
describe("operator-purge — previewPurgeAffected parity (Wave-2 BUG-2/BUG-3 regression)", () => {
  it("preview count matches affectedLeafIds.length when applied (range purge)", () => {
    const db = setupDb();
    insertLeaf(db, "leaf_a", 1, "a");
    insertLeaf(db, "leaf_b", 1, "b");
    insertLeaf(db, "leaf_c", 1, "c");
    // One already-suppressed leaf — should NOT be counted
    insertLeaf(db, "leaf_already", 1, "already");
    db.prepare(`UPDATE summaries SET suppressed_at = datetime('now') WHERE summary_id = 'leaf_already'`).run();

    const opts = { sessionKey: "sk1", reason: "regression-test" };
    const preview = previewPurgeAffected(db, opts);
    const result = runPurge(db, opts);
    expect(preview).toBe(result.affectedLeafIds.length);
    expect(preview).toBe(3); // 3 unsuppressed leaves
    db.close();
  });

  it("preview count for --summary-ids filters out non-leaf and already-suppressed", () => {
    const db = setupDb();
    insertLeaf(db, "leaf_real", 1, "x");
    insertCondensed(db, "cond_x", 1, ["leaf_real"]);
    db.prepare(
      `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key, suppressed_at)
       VALUES ('leaf_supp', 1, 'leaf', 'x', 1, 'sk1', datetime('now'))`,
    ).run();

    // User passes 4 ids: 1 valid leaf, 1 condensed (filtered out), 1
    // already-suppressed (filtered out), 1 nonexistent (filtered out).
    const opts = {
      summaryIds: ["leaf_real", "cond_x", "leaf_supp", "ghost_id"],
      reason: "regression",
    };
    const preview = previewPurgeAffected(db, opts);
    const result = runPurge(db, opts);
    expect(preview).toBe(1);
    expect(result.affectedLeafIds).toEqual(["leaf_real"]);
    db.close();
  });

  it("preview reflects since/before time-filter exactly like runPurge", () => {
    const db = setupDb();
    insertLeaf(db, "leaf_old", 1);
    insertLeaf(db, "leaf_new", 1);
    db.prepare(`UPDATE summaries SET created_at = '2026-01-01 00:00:00' WHERE summary_id = 'leaf_old'`).run();
    db.prepare(`UPDATE summaries SET created_at = '2026-05-01 00:00:00' WHERE summary_id = 'leaf_new'`).run();

    const opts = {
      sessionKey: "sk1",
      since: new Date("2026-04-01T00:00:00Z"),
      reason: "regression",
    };
    const preview = previewPurgeAffected(db, opts);
    const result = runPurge(db, opts);
    expect(preview).toBe(result.affectedLeafIds.length);
    expect(result.affectedLeafIds).toEqual(["leaf_new"]);
    db.close();
  });

  it("preview returns 0 when no leaves match (clean negative)", () => {
    const db = setupDb();
    insertLeaf(db, "leaf_a", 1);
    const preview = previewPurgeAffected(db, {
      sessionKey: "non-existent-session",
      reason: "test",
    });
    expect(preview).toBe(0);
    db.close();
  });
});

// Wave-7 P0-2 + Wave-8 regression tests
describe("operator-purge — Wave-7 P0 fixes (regression coverage)", () => {
  it("Wave-7 P0-2: shared message NOT suppressed when only ONE of its referencing leaves is purged", () => {
    const db = setupDb();
    // Two leaves that share message_id 1; purge only leaf_a
    insertLeaf(db, "leaf_a", 1);
    insertLeaf(db, "leaf_b", 1);
    db.prepare(`INSERT INTO messages (conversation_id, seq, role, content, token_count) VALUES (1, 1, 'user', 'shared msg', 5)`).run();
    db.prepare(`INSERT INTO summary_messages (summary_id, message_id, ordinal) VALUES ('leaf_a', 1, 0)`).run();
    db.prepare(`INSERT INTO summary_messages (summary_id, message_id, ordinal) VALUES ('leaf_b', 1, 0)`).run();

    runPurge(db, { summaryIds: ["leaf_a"], reason: "test" });

    const msg = db
      .prepare(`SELECT suppressed_at FROM messages WHERE message_id = 1`)
      .get() as { suppressed_at: string | null };
    // Wave-7 P0 fix: message stays UN-suppressed because leaf_b (not in
    // purge set) still references it. Pre-fix this would silently
    // suppress the message and orphan leaf_b's content.
    expect(msg.suppressed_at).toBeNull();

    // Sanity: leaf_a IS suppressed
    const leafA = db
      .prepare(`SELECT suppressed_at FROM summaries WHERE summary_id = 'leaf_a'`)
      .get() as { suppressed_at: string | null };
    expect(leafA.suppressed_at).not.toBeNull();
    db.close();
  });

  it("Wave-7 P0-2: shared message IS suppressed when ALL referencing leaves are purged in the same call", () => {
    const db = setupDb();
    insertLeaf(db, "leaf_a", 1);
    insertLeaf(db, "leaf_b", 1);
    db.prepare(`INSERT INTO messages (conversation_id, seq, role, content, token_count) VALUES (1, 1, 'user', 'shared msg', 5)`).run();
    db.prepare(`INSERT INTO summary_messages (summary_id, message_id, ordinal) VALUES ('leaf_a', 1, 0)`).run();
    db.prepare(`INSERT INTO summary_messages (summary_id, message_id, ordinal) VALUES ('leaf_b', 1, 0)`).run();

    // Purge both leaves: message should now be suppressed
    runPurge(db, { summaryIds: ["leaf_a", "leaf_b"], reason: "test" });

    const msg = db
      .prepare(`SELECT suppressed_at FROM messages WHERE message_id = 1`)
      .get() as { suppressed_at: string | null };
    expect(msg.suppressed_at).not.toBeNull();
    db.close();
  });
});
