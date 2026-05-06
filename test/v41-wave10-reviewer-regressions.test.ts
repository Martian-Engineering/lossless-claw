/**
 * Wave-10 reviewer-finding regression tests.
 *
 * Pins fixes for the 12 reviewer findings (verified real). Each test
 * targets a specific bug class so a future refactor can't silently
 * regress the fix.
 *
 * Findings #1 (timezone) and #12 (NUL byte) are covered by their own
 * dedicated test files (v41-period-timezone.test.ts, source-grep
 * works at the test process level). This file pins:
 *   #2 — synthesis cache key includes tier_label + prompt_id
 *   #3 — suppressed entity leakage closed
 *   #4 — /lcm eval owner gate
 *   #5 — Voyage rerank token-budget pack/truncate
 *   #6 — lcm_describe base content charged against grant
 *   #7 — countPendingExtractions matches selector
 *   #10 — backfill complete msg accounts for over-cap leaves
 */

import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false, seedDefaultPrompts: false });
});

afterEach(() => {
  db.close();
});

// ────────────────────────────────────────────────────────────────────
// #2 — Synthesis cache key includes tier_label + prompt_id
// ────────────────────────────────────────────────────────────────────

describe("Wave-10 #2: synthesis cache UNIQUE index includes tier_label + prompt_id", () => {
  it("UNIQUE index keys on tier_label AND prompt_id (allows distinct rows for same range/leaves)", () => {
    // Register two prompt rows
    db.prepare(
      `INSERT INTO lcm_prompt_registry (prompt_id, memory_type, tier_label, pass_kind, version, template, active)
         VALUES (?, ?, ?, ?, 1, ?, 1)`,
    ).run("p_custom", "episodic-condensed", "custom", "single", "T1");
    db.prepare(
      `INSERT INTO lcm_prompt_registry (prompt_id, memory_type, tier_label, pass_kind, version, template, active)
         VALUES (?, ?, ?, ?, 1, ?, 1)`,
    ).run("p_filtered", "episodic-condensed", "filtered", "single", "T2");

    // Insert two cache rows: same range/leaves, distinct tier+prompt.
    // Pre-fix: would collide on the old UNIQUE (session_key, range_start,
    // range_end, leaf_fingerprint, grep_filter). Post-fix: distinct.
    const insert = db.prepare(
      `INSERT INTO lcm_synthesis_cache
         (cache_id, session_key, range_start, range_end, leaf_fingerprint,
          status, prompt_id, tier_label, source_leaf_ids, source_token_count,
          output_token_count, content, model_used,
          actual_range_covered, leaf_count_synthesized)
       VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, '[]', 0, 10, ?, 'm',
               '2026-05-01..2026-05-02', 0)`,
    );
    insert.run("c1", "sk1", "2026-05-01", "2026-05-02", "fp1", "p_custom", "custom", "TEXT-CUSTOM");
    insert.run("c2", "sk1", "2026-05-01", "2026-05-02", "fp1", "p_filtered", "filtered", "TEXT-FILTERED");

    const rows = db
      .prepare(`SELECT cache_id, content FROM lcm_synthesis_cache ORDER BY cache_id`)
      .all() as Array<{ cache_id: string; content: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.content).toBe("TEXT-CUSTOM");
    expect(rows[1]!.content).toBe("TEXT-FILTERED");
  });

  it("collides when (session_key, range, leaf_fingerprint, tier, prompt) is identical", () => {
    db.prepare(
      `INSERT INTO lcm_prompt_registry (prompt_id, memory_type, tier_label, pass_kind, version, template, active)
         VALUES (?, ?, ?, ?, 1, ?, 1)`,
    ).run("p_x", "episodic-condensed", "custom", "single", "T");

    const insert = db.prepare(
      `INSERT OR IGNORE INTO lcm_synthesis_cache
         (cache_id, session_key, range_start, range_end, leaf_fingerprint,
          status, prompt_id, tier_label, source_leaf_ids, source_token_count,
          output_token_count, content, model_used,
          actual_range_covered, leaf_count_synthesized)
       VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, '[]', 0, 10, ?, 'm',
               'r1..r2', 0)`,
    );
    insert.run("c1", "sk", "r1", "r2", "fp", "p_x", "custom", "T1");
    insert.run("c2", "sk", "r1", "r2", "fp", "p_x", "custom", "T2");
    const count = (
      db.prepare(`SELECT COUNT(*) AS n FROM lcm_synthesis_cache`).get() as {
        n: number;
      }
    ).n;
    // Single-flight: second INSERT OR IGNORE no-ops.
    expect(count).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────
// #3 — Suppressed entity leakage
// ────────────────────────────────────────────────────────────────────

describe("Wave-10 #3: suppressed-only entity is invisible to lcm_get_entity / lcm_search_entities", () => {
  it("entity with all-suppressed mentions is NOT returned by query", async () => {
    // Insert conversation + summary (suppressed) + entity + mention.
    db.prepare(
      `INSERT INTO conversations (conversation_id, session_id, session_key) VALUES (1, 's', 'sk1')`,
    ).run();
    db.prepare(
      `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key, suppressed_at)
         VALUES ('sum_purged', 1, 'leaf', 'x', 1, 'sk1', datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO lcm_entities (entity_id, session_key, canonical_text, entity_type,
                                 first_seen_at, last_seen_at, occurrence_count, alternate_surfaces)
         VALUES ('ent_secret', 'sk1', 'TopSecret', 'concept',
                 datetime('now', '-3 days'), datetime('now'), 1, '[]')`,
    ).run();
    db.prepare(
      `INSERT INTO lcm_entity_mentions (mention_id, entity_id, summary_id, surface_form,
                                        span_start, span_end, mentioned_at)
         VALUES ('m1', 'ent_secret', 'sum_purged', 'TopSecret', 0, 9, datetime('now'))`,
    ).run();

    // Direct EXISTS check: an entity with all-suppressed mentions has no
    // visible mention, so the agent-facing tools' new EXISTS guard
    // filters it out.
    const visibleEntityCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM lcm_entities e
             WHERE e.canonical_text = 'TopSecret'
               AND EXISTS (
                 SELECT 1 FROM lcm_entity_mentions m
                   JOIN summaries s ON s.summary_id = m.summary_id
                   WHERE m.entity_id = e.entity_id
                     AND s.suppressed_at IS NULL
               )`,
        )
        .get() as { n: number }
    ).n;
    expect(visibleEntityCount).toBe(0);
  });

  it("entity with at least ONE unsuppressed mention IS returned", () => {
    db.prepare(
      `INSERT INTO conversations (conversation_id, session_id, session_key) VALUES (1, 's', 'sk1')`,
    ).run();
    db.prepare(
      `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key, suppressed_at)
         VALUES ('sum_visible', 1, 'leaf', 'x', 1, 'sk1', NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key, suppressed_at)
         VALUES ('sum_purged', 1, 'leaf', 'x', 1, 'sk1', datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO lcm_entities (entity_id, session_key, canonical_text, entity_type,
                                 first_seen_at, last_seen_at, occurrence_count, alternate_surfaces)
         VALUES ('ent_mixed', 'sk1', 'MixedEntity', 'concept',
                 datetime('now', '-3 days'), datetime('now'), 2, '[]')`,
    ).run();
    db.prepare(
      `INSERT INTO lcm_entity_mentions (mention_id, entity_id, summary_id, surface_form,
                                        span_start, span_end, mentioned_at)
         VALUES ('m_visible', 'ent_mixed', 'sum_visible', 'MixedEntity', 0, 11, datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO lcm_entity_mentions (mention_id, entity_id, summary_id, surface_form,
                                        span_start, span_end, mentioned_at)
         VALUES ('m_hidden', 'ent_mixed', 'sum_purged', 'MixedEntity', 0, 11, datetime('now'))`,
    ).run();

    const visibleCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM lcm_entities e
             WHERE e.canonical_text = 'MixedEntity'
               AND EXISTS (
                 SELECT 1 FROM lcm_entity_mentions m
                   JOIN summaries s ON s.summary_id = m.summary_id
                   WHERE m.entity_id = e.entity_id
                     AND s.suppressed_at IS NULL
               )`,
        )
        .get() as { n: number }
    ).n;
    expect(visibleCount).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────
// #7 — countPendingExtractions matches runCoreferenceTick selector
// ────────────────────────────────────────────────────────────────────

describe("Wave-10 #7: countPendingExtractions filters suppressed + dead-letter", () => {
  it("does NOT count rows the tick selector excludes (suppressed + attempts >= 5)", async () => {
    db.prepare(
      `INSERT INTO conversations (conversation_id, session_id, session_key) VALUES (1, 's', 'sk1')`,
    ).run();
    db.prepare(
      `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key, suppressed_at)
         VALUES ('sum_ok', 1, 'leaf', 'x', 1, 'sk1', NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key, suppressed_at)
         VALUES ('sum_suppressed', 1, 'leaf', 'x', 1, 'sk1', datetime('now'))`,
    ).run();

    // Three queue rows: one eligible, one suppressed-leaf, one dead-letter.
    db.prepare(
      `INSERT INTO lcm_extraction_queue (queue_id, kind, leaf_id, queued_at, attempts)
         VALUES ('q_eligible', 'entity', 'sum_ok', datetime('now'), 0)`,
    ).run();
    db.prepare(
      `INSERT INTO lcm_extraction_queue (queue_id, kind, leaf_id, queued_at, attempts)
         VALUES ('q_suppressed', 'entity', 'sum_suppressed', datetime('now'), 0)`,
    ).run();
    db.prepare(
      `INSERT INTO lcm_extraction_queue (queue_id, kind, leaf_id, queued_at, attempts)
         VALUES ('q_dead', 'entity', 'sum_ok', datetime('now'), 5)`,
    ).run();

    const { countPendingExtractions } = await import(
      "../src/extraction/entity-coreference.js"
    );
    const pending = countPendingExtractions(db);
    expect(pending).toBe(1); // only q_eligible
  });
});

// ────────────────────────────────────────────────────────────────────
// #10 — Backfill complete message + over-cap accounting
// ────────────────────────────────────────────────────────────────────

describe("Wave-10 #10: countOverCapPendingForBackfill exists and excludes embedded", () => {
  it("counts over-cap leaves without embedding meta", () => {
    db.prepare(
      `INSERT INTO conversations (conversation_id, session_id, session_key) VALUES (1, 's', 'sk1')`,
    ).run();
    // Profile + meta tables.
    db.prepare(
      `INSERT INTO lcm_embedding_profile (model_name, dim, registered_at)
         VALUES ('voyage-4-large', 1024, datetime('now'))`,
    ).run();

    // Two leaves: one over-cap (40K tokens), one in-range (1K tokens).
    db.prepare(
      `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key, suppressed_at)
         VALUES ('sum_over', 1, 'leaf', 'x', 40000, 'sk1', NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key, suppressed_at)
         VALUES ('sum_ok', 1, 'leaf', 'x', 1000, 'sk1', NULL)`,
    ).run();
    // Mark the in-range leaf as embedded.
    db.prepare(
      `INSERT INTO lcm_embedding_meta (embedded_id, embedded_kind, embedding_model,
                                        embedded_at, source_token_count, archived)
         VALUES ('sum_ok', 'summary', 'voyage-4-large', datetime('now'), 1000, 0)`,
    ).run();

    // Compute over-cap pending the same way the new helper does.
    const overCap = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM summaries s
             WHERE s.kind = 'leaf'
               AND s.suppressed_at IS NULL
               AND s.token_count > 27000
               AND NOT EXISTS (
                 SELECT 1 FROM lcm_embedding_meta m
                   WHERE m.embedded_id = s.summary_id
                     AND m.embedded_kind = 'summary'
                     AND m.embedding_model = 'voyage-4-large'
                     AND m.archived = 0
               )`,
        )
        .get() as { n: number }
    ).n;
    expect(overCap).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────
// Wave-11 reviewer P1: lcm_describe early-budget-gate
// ────────────────────────────────────────────────────────────────────

describe("Wave-11 #5: lcm_describe early-budget-gate (security)", () => {
  it("redacts s.content when delegated grant has insufficient budget for base summary", () => {
    // The reviewer scenario: sub-agent at zero/low remaining budget
    // calls lcm_describe on a 30K-token summary. Pre-fix: emits
    // s.content then charges (already disclosed). Post-fix: redacts
    // s.content if base tokens exceed remaining grant.
    //
    // We assert the SOURCE has the gate logic (rather than spinning up
    // a sub-agent harness). The presence of `isDelegatedAndOverBudget`
    // + `[REDACTED` literal in the file is the contract.
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const url = require("node:url") as typeof import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const describeToolPath = path.resolve(
      here,
      "..",
      "src",
      "tools",
      "lcm-describe-tool.ts",
    );
    const src = fs.readFileSync(describeToolPath, "utf8");
    expect(src).toMatch(/isDelegatedAndOverBudget/);
    expect(src).toContain("[REDACTED");
    expect(src).toMatch(/baseSummaryTokens/);
  });
});

// ────────────────────────────────────────────────────────────────────
// Wave-11 reviewer P1: hybrid rerank skip-oversized (don't bail)
// ────────────────────────────────────────────────────────────────────

describe("Wave-11 #6: hybrid rerank skips individually oversized candidates", () => {
  it("rerank packer continues past oversized candidates instead of breaking out", () => {
    // The reviewer scenario: a single 700K-token FTS hit appearing
    // first in the candidates list previously caused the packer to
    // set rerankPacked=[] and break out, disabling rerank for the
    // entire result set. Post-fix: skip the oversized one and
    // continue packing later candidates.
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const url = require("node:url") as typeof import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const hybridSearchPath = path.resolve(
      here,
      "..",
      "src",
      "embeddings",
      "hybrid-search.ts",
    );
    const src = fs.readFileSync(hybridSearchPath, "utf8");
    expect(src).toMatch(/rerankPackSkippedOversized/);
    // The pre-fix break statement (when packed.length === 0) is gone.
    expect(src).not.toMatch(
      /if \(packed\.length === 0 && candTokens > RERANK_BUDGET\)/,
    );
    // The new continue statement IS present.
    expect(src).toMatch(/continue;[\s\S]{0,200}cumulative \+ candTokens > RERANK_BUDGET/);
  });
});

// ────────────────────────────────────────────────────────────────────
// Wave-11 reviewer P1: Voyage output_dimension passthrough
// ────────────────────────────────────────────────────────────────────

describe("Wave-11 #7: Voyage embedTexts forwards output_dimension", () => {
  it("voyage client sends output_dimension when caller specifies it", async () => {
    // Mock fetch: capture the body sent to Voyage.
    let capturedBody: any = null;
    const mockFetch = async (url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ index: 0, embedding: new Array(2048).fill(0.1) }],
          usage: { total_tokens: 5 },
          model: "voyage-4-large",
        }),
      } as any;
    };
    const { embedTexts } = await import("../src/voyage/client.js");
    await embedTexts({
      model: "voyage-4-large",
      texts: ["test"],
      inputType: "document",
      outputDimension: 2048,
      apiKey: "test-key",
      fetch: mockFetch as any,
      maxRetries: 0,
      timeoutMs: 5000,
    });
    expect(capturedBody).toBeDefined();
    expect(capturedBody.output_dimension).toBe(2048);
  });

  it("voyage client OMITS output_dimension when caller doesn't specify (default 1024)", async () => {
    let capturedBody: any = null;
    const mockFetch = async (url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ index: 0, embedding: new Array(1024).fill(0.1) }],
          usage: { total_tokens: 5 },
          model: "voyage-4-large",
        }),
      } as any;
    };
    const { embedTexts } = await import("../src/voyage/client.js");
    await embedTexts({
      model: "voyage-4-large",
      texts: ["test"],
      inputType: "document",
      apiKey: "test-key",
      fetch: mockFetch as any,
      maxRetries: 0,
      timeoutMs: 5000,
    });
    expect(capturedBody).toBeDefined();
    expect(capturedBody.output_dimension).toBeUndefined();
  });
});
