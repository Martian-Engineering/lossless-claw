/**
 * Smoke test for the v4.1 synthetic fixture corpus.
 *
 * Verifies `buildTestCorpus()` produces a valid DB:
 * - All conversations inserted
 * - All leaves inserted with correct timestamps + suppression flags
 * - Condensed summaries link to leaves correctly
 * - Entities + mentions wire up
 * - FTS index is populated
 * - Suppression filter works on at least one read path
 *
 * If this test fails, no other fixture-based test will work.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  BASE_DATE,
  buildTestCorpus,
  FIXTURE_CONDENSED,
  FIXTURE_CONVERSATIONS,
  FIXTURE_ENTITIES,
  FIXTURE_LEAVES,
} from "./fixtures/v41-test-corpus.js";

describe("v4.1 synthetic fixture corpus", () => {
  it("builds a complete corpus with all conversations, leaves, condensed, entities", () => {
    const db = new DatabaseSync(":memory:");
    const meta = buildTestCorpus(db);

    expect(meta.baseDate).toEqual(BASE_DATE);
    expect(meta.conversations.length).toBe(FIXTURE_CONVERSATIONS.length);
    expect(meta.leafCount).toBe(FIXTURE_LEAVES.length);
    expect(meta.condensedCount).toBe(FIXTURE_CONDENSED.length);
    expect(meta.entityCount).toBe(FIXTURE_ENTITIES.length);
    expect(meta.suppressedCount).toBe(
      FIXTURE_LEAVES.filter((l) => l.suppressed).length,
    );

    // Verify counts in DB
    const convCount = (
      db.prepare("SELECT COUNT(*) AS n FROM conversations").get() as {
        n: number;
      }
    ).n;
    expect(convCount).toBe(FIXTURE_CONVERSATIONS.length);

    const leafCount = (
      db
        .prepare("SELECT COUNT(*) AS n FROM summaries WHERE kind = 'leaf'")
        .get() as { n: number }
    ).n;
    expect(leafCount).toBe(FIXTURE_LEAVES.length);

    const condensedCount = (
      db
        .prepare("SELECT COUNT(*) AS n FROM summaries WHERE kind = 'condensed'")
        .get() as { n: number }
    ).n;
    expect(condensedCount).toBe(FIXTURE_CONDENSED.length);

    const entityCount = (
      db.prepare("SELECT COUNT(*) AS n FROM lcm_entities").get() as {
        n: number;
      }
    ).n;
    expect(entityCount).toBe(FIXTURE_ENTITIES.length);

    db.close();
  });

  it("populates FTS index for both messages and summaries", () => {
    const db = new DatabaseSync(":memory:");
    buildTestCorpus(db);

    // Messages FTS — should find specific phrases
    const ftsHit = db
      .prepare(
        `SELECT m.message_id, m.content
           FROM messages m
           JOIN messages_fts ON messages_fts.rowid = m.rowid
           WHERE messages_fts MATCH ?`,
      )
      .get("rollups") as { message_id: number; content: string } | undefined;
    expect(ftsHit).toBeDefined();
    expect(ftsHit?.content).toMatch(/rollup/i);

    // Summaries FTS
    const sumFtsHit = db
      .prepare(
        `SELECT s.summary_id, s.content
           FROM summaries s
           JOIN summaries_fts ON summaries_fts.rowid = s.rowid
           WHERE summaries_fts MATCH ?`,
      )
      .get("rerank") as { summary_id: string; content: string } | undefined;
    expect(sumFtsHit).toBeDefined();

    db.close();
  });

  it("suppression filter excludes suppressed leaves from default reads", () => {
    const db = new DatabaseSync(":memory:");
    buildTestCorpus(db);

    // Default read: WHERE suppressed_at IS NULL
    const visibleLeaves = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM summaries WHERE kind = 'leaf' AND suppressed_at IS NULL",
        )
        .get() as { n: number }
    ).n;
    const totalLeaves = FIXTURE_LEAVES.length;
    const suppressedLeaves = FIXTURE_LEAVES.filter((l) => l.suppressed).length;
    expect(visibleLeaves).toBe(totalLeaves - suppressedLeaves);
    expect(suppressedLeaves).toBeGreaterThan(0); // sanity: we have suppressed leaves

    db.close();
  });

  it("condensed summaries link to their child leaves via summary_parents", () => {
    const db = new DatabaseSync(":memory:");
    buildTestCorpus(db);

    for (const cond of FIXTURE_CONDENSED) {
      const childRows = db
        .prepare(
          `SELECT summary_id FROM summary_parents WHERE parent_summary_id = ?`,
        )
        .all(cond.summary_id) as Array<{ summary_id: string }>;
      const childIds = childRows.map((r) => r.summary_id).sort();
      expect(childIds).toEqual([...cond.childIds].sort());
    }

    db.close();
  });

  it("entities have the correct number of mentions", () => {
    const db = new DatabaseSync(":memory:");
    buildTestCorpus(db);

    for (const ent of FIXTURE_ENTITIES) {
      const mentions = db
        .prepare(
          `SELECT COUNT(*) AS n FROM lcm_entity_mentions WHERE entity_id = ?`,
        )
        .get(ent.entity_id) as { n: number };
      expect(mentions.n).toBe(ent.mentionedIn.length);
    }

    db.close();
  });

  it("CJK content is searchable via direct LIKE on messages", () => {
    const db = new DatabaseSync(":memory:");
    buildTestCorpus(db);

    // FTS5 unicode61 can't tokenize CJK; LIKE is the fallback.
    const cjkHits = db
      .prepare(
        `SELECT message_id, content FROM messages WHERE content LIKE ? AND suppressed_at IS NULL`,
      )
      .all("%机器学习%") as Array<{ message_id: number; content: string }>;
    expect(cjkHits.length).toBeGreaterThan(0);
    expect(cjkHits[0]!.content).toContain("机器学习");

    db.close();
  });

  it("session_key scoping: legacy: prefix is distinct from agent:main:main", () => {
    const db = new DatabaseSync(":memory:");
    buildTestCorpus(db);

    const legacyLeaves = db
      .prepare(
        `SELECT summary_id FROM summaries
           WHERE kind = 'leaf' AND session_key = ? AND suppressed_at IS NULL`,
      )
      .all("legacy:conv_503") as Array<{ summary_id: string }>;
    const mainLeaves = db
      .prepare(
        `SELECT summary_id FROM summaries
           WHERE kind = 'leaf' AND session_key = ? AND suppressed_at IS NULL`,
      )
      .all("agent:main:main") as Array<{ summary_id: string }>;

    expect(legacyLeaves.length).toBeGreaterThan(0);
    expect(mainLeaves.length).toBeGreaterThan(0);
    // Legacy and main should be disjoint sets.
    const legacyIds = new Set(legacyLeaves.map((l) => l.summary_id));
    for (const m of mainLeaves) {
      expect(legacyIds.has(m.summary_id)).toBe(false);
    }

    db.close();
  });
});
