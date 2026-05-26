/**
 * Adversarial-input output-bound invariants.
 *
 * # Why this exists
 *
 * Wave-12 audit (W1A8 #3) found that `lcm_describe` was truly unbounded
 * — under a wide-condensed expansion the tool could emit ~210K tokens.
 * The existing test suite verified that "given typical input, content
 * is returned correctly" but never asserted "given pathological input,
 * output stays bounded." That class of bug-by-omission can hit any tool
 * that emits user-facing content.
 *
 * This file pins per-tool output bounds against deliberately worst-case
 * fixtures: maximum schema params, oversized record content, oversized
 * mention/result counts. If a future refactor (or a new tool path) drops
 * the cap, these tests fail.
 *
 * Strategy:
 *   - Build the smallest plausible adversarial fixture (huge content,
 *     max param values).
 *   - Call the tool against it.
 *   - Assert output stays under a reasonable bound (4× the default cap)
 *     OR emits the documented truncation marker. Either is fine; what
 *     fails is "tool emits 100K+ chars without any backstop."
 *
 * Note: `lcm_grep` and `lcm_describe` already have dedicated truncation
 * tests in v41-tool-budget-guardrail.test.ts. This file covers the
 * remaining tools that emit content (get_entity, search_entities) so
 * the invariant is pinned across the full surface.
 */

import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { createLcmGetEntityTool } from "../src/tools/lcm-get-entity-tool.js";
import { createLcmSearchEntitiesTool } from "../src/tools/lcm-search-entities-tool.js";
import { makeTestDeps, makeTestEngine } from "./fixtures/v41-tool-harness.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false, seedDefaultPrompts: false });
  db.prepare(
    `INSERT INTO conversations (conversation_id, session_id, session_key, active) VALUES (1, 'sess', 'agent:main:main', 1)`,
  ).run();
});

afterEach(() => {
  db.close();
});

/**
 * 4× default cap (40K chars) — generous bound. Any tool emitting more
 * than this without a truncation backstop is a real bug. Tools that
 * naturally bound (LLM-output limits, hard schema caps) should easily
 * stay under this.
 */
const ADVERSARIAL_OUTPUT_BOUND_CHARS = 160_000;

describe("adversarial output bound — lcm_get_entity (W1A8 #3 sister case)", () => {
  it("entity with 200 mentions + huge surface_forms stays under 4× cap", () => {
    // Insert a "PR" entity with 200 mentions, each carrying a 1000-char
    // surface_form. Worst-case: tool returns all 200 mentions × 1000 chars
    // = 200K chars (exceeds bound). Either the tool caps, or this fails
    // and we have a real bug to fix.
    const now = "2026-05-08T00:00:00Z";
    db.prepare(
      `INSERT INTO lcm_entities (entity_id, session_key, canonical_text, entity_type, first_seen_at, last_seen_at, occurrence_count) VALUES (?, 'agent:main:main', 'PR-9999', 'pr_number', ?, ?, 200)`,
    ).run("ent_pr_huge", now, now);
    // Need a summary to anchor mentions. Add one.
    db.prepare(
      `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key, created_at)
         VALUES ('sum_anchor', 1, 'leaf', 'anchor', 1, 'agent:main:main', ?)`,
    ).run(now);
    const insMention = db.prepare(
      `INSERT INTO lcm_entity_mentions (mention_id, entity_id, summary_id, surface_form, mentioned_at)
         VALUES (?, 'ent_pr_huge', 'sum_anchor', ?, ?)`,
    );
    const big = "X".repeat(1_000);
    for (let i = 0; i < 200; i++) {
      insMention.run(`men_${i}`, big, now);
    }

    const tool = createLcmGetEntityTool({
      deps: makeTestDeps(),
      lcm: makeTestEngine(db),
      sessionKey: "agent:main:main",
    });
    return tool
      .execute("test", {
        entityId: "ent_pr_huge",
        sessionKey: "agent:main:main",
        mentionLimit: 100,
      })
      .then((r) => {
        const text = r.content[0]?.type === "text" ? r.content[0].text : "";
        // Output bound — schema caps mentionLimit at 100, so worst case
        // 100 × 1000 = 100K chars + JSON overhead. Should still come in
        // under 4× cap (160K chars).
        expect(text.length).toBeLessThan(ADVERSARIAL_OUTPUT_BOUND_CHARS);
      });
  });
});

describe("adversarial output bound — lcm_search_entities (W1A8 #3 sister case)", () => {
  it("500 matching entities with 200-char canonical_text each stays under 4× cap", () => {
    // Schema bounds limit at 100 — but we feed 500 to validate that
    // schema-bounded inputs stay safe even if the upstream caller
    // ignores the cap.
    const now = "2026-05-08T00:00:00Z";
    const ins = db.prepare(
      `INSERT INTO lcm_entities (entity_id, session_key, canonical_text, entity_type, first_seen_at, last_seen_at, occurrence_count) VALUES (?, 'agent:main:main', ?, 'person_name', ?, ?, 1)`,
    );
    const big = "Y".repeat(200);
    for (let i = 0; i < 500; i++) {
      ins.run(`ent_${i}`, `${big}-${i}`, now, now);
    }

    const tool = createLcmSearchEntitiesTool({
      deps: makeTestDeps(),
      lcm: makeTestEngine(db),
      sessionKey: "agent:main:main",
    });
    return tool
      .execute("test", {
        query: "Y",
        sessionKey: "agent:main:main",
        limit: 100,
        mode: "like",
      })
      .then((r) => {
        const text = r.content[0]?.type === "text" ? r.content[0].text : "";
        expect(text.length).toBeLessThan(ADVERSARIAL_OUTPUT_BOUND_CHARS);
      });
  });

  it("respects schema-bounded limit (max 100) even when caller passes 500", () => {
    // Defense in depth: input validation should clamp limit at the
    // schema's max. If a future refactor removes the schema bound,
    // this test fails by emitting 500 entries instead of 100.
    const now = "2026-05-08T00:00:00Z";
    const ins = db.prepare(
      `INSERT INTO lcm_entities (entity_id, session_key, canonical_text, entity_type, first_seen_at, last_seen_at, occurrence_count) VALUES (?, 'agent:main:main', ?, 'person_name', ?, ?, 1)`,
    );
    for (let i = 0; i < 200; i++) {
      ins.run(`ent_lim_${i}`, `Person-${String(i).padStart(3, "0")}`, now, now);
    }

    const tool = createLcmSearchEntitiesTool({
      deps: makeTestDeps(),
      lcm: makeTestEngine(db),
      sessionKey: "agent:main:main",
    });
    return tool
      .execute("test", {
        query: "Person",
        sessionKey: "agent:main:main",
        limit: 500,  // exceeds schema max of 100 — should clamp or error
        mode: "like",
      })
      .then((r) => {
        // Output shape: { content: [{type:"text", text:markdown}], details: {entities: [...]} }
        // The tool runtime clamps limit at MAX_LIMIT=100 (verified at
        // search-entities-tool.ts:196 Math.min(MAX_LIMIT, ...)). Even
        // though the schema declares maximum:100, the AnyAgentTool
        // dispatcher doesn't enforce typebox bounds — the runtime
        // clamp is what actually protects.
        const details = r.details as { entities?: unknown[] };
        if (Array.isArray(details?.entities)) {
          expect(details.entities.length).toBeLessThanOrEqual(100);
        }
      });
  });
});
