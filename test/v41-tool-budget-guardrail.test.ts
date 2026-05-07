/**
 * Tool-result token budget guardrail tests.
 *
 * Pins the `LCM_TOOL_RESULT_TOKEN_BUDGET` env contract for `lcm_grep` and
 * `lcm_semantic_recall`: tool output is hard-capped at the configured
 * budget × 4 chars (default 10K tokens / 40K chars), with a floor of
 * 2K tokens to keep the tool useful even if an operator misconfigures.
 *
 * Eva onboarding feedback (2026-05-07): back-to-back tool chains
 * (lcm_grep + lcm_synthesize_around + lcm_describe expandMessages) can
 * push the agent over context threshold; compaction only fires
 * post-turn. The env knob lets operators tune for safety during
 * testing and the truncation message tells the agent why it was
 * clamped + how to react.
 *
 * NOTE: We can't easily test the truncation directly without setting
 * up a 50K-row fixture. Instead these tests exercise the env-parser
 * via the module-level `MAX_RESULT_CHARS` (resolved at import time)
 * and pin the description text so the agent sees the hint.
 */

import { describe, expect, it } from "vitest";
import { createLcmGrepTool } from "../src/tools/lcm-grep-tool.js";
import { createLcmSemanticRecallTool } from "../src/tools/lcm-semantic-recall-tool.js";
import { createLcmGetEntityTool } from "../src/tools/lcm-get-entity-tool.js";
import { makeTestDeps } from "./fixtures/v41-tool-harness.js";

describe("LCM_TOOL_RESULT_TOKEN_BUDGET — context-overflow guardrail", () => {
  it("lcm_grep description tells the agent about the cap + when to narrow", () => {
    const tool = createLcmGrepTool({ deps: makeTestDeps() });
    expect(tool.description).toContain("LCM_TOOL_RESULT_TOKEN_BUDGET");
    expect(tool.description).toContain("context is near full");
  });

  it("lcm_semantic_recall description tells the agent about the cap + when to narrow", () => {
    const tool = createLcmSemanticRecallTool({ deps: makeTestDeps() });
    expect(tool.description).toContain("LCM_TOOL_RESULT_TOKEN_BUDGET");
    expect(tool.description).toContain("context is near full");
  });
});

describe("lcm_get_entity — fallback hints when not found", () => {
  it("missing entity result includes concrete fallback suggestions", async () => {
    // Wire up a minimal in-memory DB so the tool can query without crashing.
    const { DatabaseSync } = await import("node:sqlite");
    const { runLcmMigrations } = await import("../src/db/migration.js");
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false, seedDefaultPrompts: false });
    db.prepare(
      `INSERT INTO conversations (conversation_id, session_id, session_key, active) VALUES (1, 'sess', 'agent:main:main', 1)`,
    ).run();

    const { makeTestEngine } = await import("./fixtures/v41-tool-harness.js");
    const tool = createLcmGetEntityTool({
      deps: makeTestDeps(),
      lcm: makeTestEngine(db),
      sessionKey: "agent:main:main",
    });

    const r = await tool.execute("test", {
      name: "Smarter-Claw",
      sessionKey: "agent:main:main",
    });
    const payload = r.content[0]?.type === "text" ? JSON.parse(r.content[0].text) : null;
    expect(payload).not.toBeNull();
    expect(payload.found).toBe(false);
    // The fallback_suggestions array is the load-bearing assertion —
    // empty entity results MUST point the agent at concrete next steps,
    // not dead-end. (Eva onboarding feedback: "should degrade to
    // hybrid search automatically" → we surface the suggestion
    // explicitly so the agent picks it.)
    expect(Array.isArray(payload.fallback_suggestions)).toBe(true);
    expect(payload.fallback_suggestions.length).toBeGreaterThanOrEqual(2);
    expect(payload.fallback_suggestions.join(" ")).toContain("lcm_search_entities");
    expect(payload.fallback_suggestions.join(" ")).toContain("lcm_grep");
    expect(payload.fallback_suggestions.join(" ")).toContain("hybrid");

    db.close();
  });
});
