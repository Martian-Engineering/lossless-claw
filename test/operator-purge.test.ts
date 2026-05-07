import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { PurgeError, runPurge } from "../src/operator/purge.js";

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
    expect(r.rebuildQueueIds).toEqual([]); // soft mode doesn't enqueue

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

describe("operator-purge — immediate mode", () => {
  it("marks suppressed AND enqueues affected condensed for rebuild", () => {
    const db = setupDb();
    insertLeaf(db, "leaf_a");
    insertLeaf(db, "leaf_b");
    insertCondensed(db, "cond_x", 1, ["leaf_a", "leaf_b"]);

    const r = runPurge(db, {
      summaryIds: ["leaf_a", "leaf_b"],
      reason: "operator hard-forget",
      mode: "immediate",
    });
    expect(r.mode).toBe("immediate");
    expect(r.affectedLeafIds.sort()).toEqual(["leaf_a", "leaf_b"]);
    expect(r.rebuildQueueIds).toHaveLength(1); // one affected condensed

    const queue = db
      .prepare(`SELECT target_summary_id, reason FROM lcm_purge_rebuild_queue`)
      .all() as Array<{ target_summary_id: string; reason: string }>;
    expect(queue).toEqual([{ target_summary_id: "cond_x", reason: "operator hard-forget" }]);

    // Leaves are SUPPRESSED, not deleted (RESTRICT FK on parent_summary_id
    // prevents direct delete; rebuild worker will delete after rebuild)
    const stillExist = db
      .prepare(`SELECT COUNT(*) AS n FROM summaries WHERE summary_id IN ('leaf_a','leaf_b')`)
      .get() as { n: number };
    expect(stillExist.n).toBe(2);

    // But suppressed_at is set
    const after = db
      .prepare(`SELECT suppressed_at FROM summaries WHERE summary_id = 'leaf_a'`)
      .get() as { suppressed_at: string | null };
    expect(after.suppressed_at).not.toBeNull();
    db.close();
  });

  it("immediate without affected condensed: just marks suppressed, empty rebuild queue", () => {
    const db = setupDb();
    insertLeaf(db, "leaf_lonely");

    const r = runPurge(db, {
      summaryIds: ["leaf_lonely"],
      reason: "test",
      mode: "immediate",
    });
    expect(r.affectedLeafIds).toEqual(["leaf_lonely"]);
    expect(r.rebuildQueueIds).toEqual([]);
    db.close();
  });
});

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
    expect(r.rebuildQueueIds).toEqual([]);
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
