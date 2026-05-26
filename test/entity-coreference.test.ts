import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import {
  countPendingExtractions,
  runCoreferenceTick,
  type ExtractEntities,
} from "../src/extraction/entity-coreference.js";

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false });
  db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s1', 'sk1')`).run();
  return db;
}

function insertLeafAndQueue(db: DatabaseSync, summaryId: string, content: string): string {
  db.prepare(
    `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key)
     VALUES (?, 1, 'leaf', ?, 1, 'sk1')`,
  ).run(summaryId, content);
  const queueId = `q_${summaryId}_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO lcm_extraction_queue (queue_id, leaf_id, kind, queued_at)
     VALUES (?, ?, 'entity', datetime('now'))`,
  ).run(queueId, summaryId);
  return queueId;
}

describe("entity-coreference — basic happy path", () => {
  it("processes queued leaf, inserts entity + mention, marks queue processed", async () => {
    const db = setupDb();
    insertLeafAndQueue(db, "leaf_a", "Talked about PR #71676 and the rebase work.");

    const extractor: ExtractEntities = async () => [
      { surface: "PR #71676", entityType: "pr_number" },
    ];

    const r = await runCoreferenceTick(db, extractor, { passId: "p1" });
    expect(r.processedCount).toBe(1);
    expect(r.newEntities).toBe(1);
    expect(r.newMentions).toBe(1);

    const ents = db.prepare(`SELECT canonical_text, entity_type, occurrence_count FROM lcm_entities`)
      .all() as Array<{ canonical_text: string; entity_type: string; occurrence_count: number }>;
    expect(ents).toEqual([
      { canonical_text: "PR #71676", entity_type: "pr_number", occurrence_count: 1 },
    ]);

    // Queue row marked processed
    const q = db.prepare(`SELECT completed_at FROM lcm_extraction_queue WHERE leaf_id = 'leaf_a'`)
      .get() as { completed_at: string | null };
    expect(q.completed_at).not.toBeNull();
    db.close();
  });
});

describe("entity-coreference — coreference on second mention", () => {
  it("same canonical text in different leaves: bumps occurrence_count, adds mention", async () => {
    const db = setupDb();
    insertLeafAndQueue(db, "leaf_a", "PR #71676 here");
    insertLeafAndQueue(db, "leaf_b", "PR #71676 again");

    const extractor: ExtractEntities = async () => [
      { surface: "PR #71676", entityType: "pr_number" },
    ];
    await runCoreferenceTick(db, extractor, { passId: "p2" });

    const ents = db.prepare(`SELECT entity_id, occurrence_count FROM lcm_entities`)
      .all() as Array<{ entity_id: string; occurrence_count: number }>;
    expect(ents).toHaveLength(1);
    expect(ents[0].occurrence_count).toBe(2); // bumped from 1 to 2

    const mentions = db.prepare(`SELECT summary_id FROM lcm_entity_mentions ORDER BY summary_id`)
      .all() as Array<{ summary_id: string }>;
    expect(mentions.map((m) => m.summary_id)).toEqual(["leaf_a", "leaf_b"]);
    db.close();
  });

  it("case-insensitive coreference (PR #71676 vs pr #71676)", async () => {
    const db = setupDb();
    insertLeafAndQueue(db, "leaf_upper", "PR #71676");
    insertLeafAndQueue(db, "leaf_lower", "pr #71676");

    const extractor: ExtractEntities = async ({ content }) => [
      // Use the surface as-it-appears
      { surface: content.includes("PR") ? "PR #71676" : "pr #71676", entityType: "pr_number" },
    ];
    await runCoreferenceTick(db, extractor, { passId: "p3" });

    const ents = db.prepare(`SELECT canonical_text, occurrence_count FROM lcm_entities`)
      .all() as Array<{ canonical_text: string; occurrence_count: number }>;
    expect(ents).toHaveLength(1); // case-insensitive UNIQUE collapsed them
    expect(ents[0].occurrence_count).toBe(2);
    db.close();
  });
});

describe("entity-coreference — multi-entity per leaf", () => {
  it("extracts multiple entities, writes all mentions", async () => {
    const db = setupDb();
    insertLeafAndQueue(db, "leaf_multi", "PR #71676 and agent R-23 fix the bug");

    const extractor: ExtractEntities = async () => [
      { surface: "PR #71676", entityType: "pr_number" },
      { surface: "R-23", entityType: "agent_id" },
    ];
    const r = await runCoreferenceTick(db, extractor, { passId: "p4" });

    expect(r.newEntities).toBe(2);
    expect(r.newMentions).toBe(2);
    const ents = db.prepare(`SELECT entity_type FROM lcm_entities ORDER BY entity_type`)
      .all() as Array<{ entity_type: string }>;
    expect(ents.map((e) => e.entity_type)).toEqual(["agent_id", "pr_number"]);
    db.close();
  });
});

describe("entity-coreference — type registry", () => {
  it("inserts new type into lcm_entity_type_registry; bumps occurrence_count on repeat", async () => {
    const db = setupDb();
    insertLeafAndQueue(db, "leaf_a", "x");
    insertLeafAndQueue(db, "leaf_b", "y");

    const extractor: ExtractEntities = async () => [
      { surface: "thing-A", entityType: "category_x" },
      { surface: "thing-B", entityType: "category_x" },
    ];
    await runCoreferenceTick(db, extractor, { passId: "p5" });

    const types = db.prepare(`SELECT type_name, occurrence_count FROM lcm_entity_type_registry`)
      .all() as Array<{ type_name: string; occurrence_count: number }>;
    expect(types).toHaveLength(1);
    // Type registry counts NEW entity inserts only, not every mention.
    // 2 distinct canonical_text values (thing-A, thing-B) — first insert
    // creates the row (count=1), second insert ON CONFLICT bumps to 2.
    // Subsequent mentions of those existing entities don't bump the type
    // registry (entity already exists, so the type-registry path is skipped).
    expect(types[0]).toEqual({ type_name: "category_x", occurrence_count: 2 });
    db.close();
  });
});

describe("entity-coreference — error handling", () => {
  it("extractor throws → cluster skipped, queue NOT marked processed (will retry next tick)", async () => {
    const db = setupDb();
    insertLeafAndQueue(db, "leaf_a", "hi");

    const extractor: ExtractEntities = async () => {
      throw new Error("API timeout");
    };
    const r = await runCoreferenceTick(db, extractor, { passId: "p6" });
    expect(r.extractorFailures).toBe(1);
    expect(r.processedCount).toBe(0);

    // Queue row still pending
    const q = db.prepare(`SELECT completed_at FROM lcm_extraction_queue WHERE leaf_id = 'leaf_a'`)
      .get() as { completed_at: string | null };
    expect(q.completed_at).toBeNull();
    db.close();
  });

  it("processes other items in batch even if one extractor throws", async () => {
    const db = setupDb();
    insertLeafAndQueue(db, "leaf_a", "first");
    insertLeafAndQueue(db, "leaf_b", "second");
    insertLeafAndQueue(db, "leaf_c", "third");

    let calls = 0;
    const extractor: ExtractEntities = async () => {
      calls++;
      if (calls === 2) throw new Error("flake on second");
      return [{ surface: `e${calls}`, entityType: "x" }];
    };
    const r = await runCoreferenceTick(db, extractor, { passId: "p7" });
    expect(r.processedCount).toBe(2); // first + third
    expect(r.extractorFailures).toBe(1);
    db.close();
  });
});

describe("entity-coreference — perTickLimit + countPendingExtractions", () => {
  it("perTickLimit caps work; countPendingExtractions reflects unprocessed", async () => {
    const db = setupDb();
    for (let i = 0; i < 10; i++) {
      insertLeafAndQueue(db, `leaf_${i}`, `content ${i}`);
    }
    expect(countPendingExtractions(db)).toBe(10);

    const extractor: ExtractEntities = async ({ summaryId }) => [
      { surface: summaryId, entityType: "test" },
    ];
    const r = await runCoreferenceTick(db, extractor, { passId: "p8", perTickLimit: 4 });
    expect(r.processedCount).toBe(4);
    expect(countPendingExtractions(db)).toBe(6);
    db.close();
  });
});

describe("entity-coreference — suppressed leaves skipped", () => {
  it("queue items pointing to suppressed leaves are not processed", async () => {
    const db = setupDb();
    insertLeafAndQueue(db, "leaf_visible", "x");
    insertLeafAndQueue(db, "leaf_suppressed", "y");
    db.prepare(`UPDATE summaries SET suppressed_at = '2026-05-05' WHERE summary_id = ?`).run(
      "leaf_suppressed",
    );

    let calls = 0;
    const extractor: ExtractEntities = async ({ summaryId }) => {
      calls++;
      return [{ surface: summaryId, entityType: "x" }];
    };
    const r = await runCoreferenceTick(db, extractor, { passId: "p9" });
    expect(calls).toBe(1); // only leaf_visible
    expect(r.processedCount).toBe(1);
    db.close();
  });
});

describe("entity-coreference — empty extraction", () => {
  it("extractor returns [] → no entity inserted, queue marked processed", async () => {
    const db = setupDb();
    insertLeafAndQueue(db, "leaf_a", "a benign thought, no entities");
    const extractor: ExtractEntities = async () => [];
    const r = await runCoreferenceTick(db, extractor, { passId: "p10" });
    expect(r.processedCount).toBe(1);
    expect(r.newEntities).toBe(0);
    expect(r.newMentions).toBe(0);

    const q = db.prepare(`SELECT completed_at FROM lcm_extraction_queue WHERE leaf_id = 'leaf_a'`)
      .get() as { completed_at: string | null };
    expect(q.completed_at).not.toBeNull();
    db.close();
  });
});
