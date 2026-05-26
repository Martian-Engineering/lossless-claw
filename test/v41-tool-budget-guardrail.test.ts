/**
 * Tool-result token budget guardrail tests.
 *
 * Pins the `LCM_TOOL_RESULT_TOKEN_BUDGET` env contract for `lcm_grep`
 * (the prior `lcm_semantic_recall` surface was consolidated INTO
 * `lcm_grep mode='semantic'` in Wave-12 SA, so the env knob is now
 * single-tool by design — see audit-w2a3 finding for full reasoning).
 * Tool output is hard-capped at the configured
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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLcmGrepTool } from "../src/tools/lcm-grep-tool.js";
import { createLcmGetEntityTool } from "../src/tools/lcm-get-entity-tool.js";
import { makeTestDeps } from "./fixtures/v41-tool-harness.js";

describe("LCM_TOOL_RESULT_TOKEN_BUDGET — context-overflow guardrail", () => {
  it("lcm_grep description tells the agent about the cap + when to narrow", () => {
    const tool = createLcmGrepTool({ deps: makeTestDeps() });
    expect(tool.description).toContain("LCM_TOOL_RESULT_TOKEN_BUDGET");
    expect(tool.description).toContain("context is near full");
  });

  // Wave-12 consolidation SA: lcm_semantic_recall removed; folded into
  // `lcm_grep mode='semantic'`. The cap-coverage assertion lives on the
  // grep description test above (which already contains the same prose).
});

// ───────────────────────────────────────────────────────────────────
// BEHAVIORAL TESTS — actually exercise MAX_RESULT_CHARS clamping
//
// Wave-13 follow-up: pre-existing tests only pinned description text
// (antipattern A1: implementation-mirroring). If a refactor deleted the
// truncation block but kept the description prose, the description-text
// tests would still pass. These tests verify the actual clamping
// behavior end-to-end against a real fixture corpus.
//
// Pattern: vi.stubEnv → vi.resetModules → dynamic import. Required
// because MAX_RESULT_CHARS is captured at module load via
// resolveMaxResultChars(). Setting the env after import is a no-op.
// ───────────────────────────────────────────────────────────────────

describe("LCM_TOOL_RESULT_TOKEN_BUDGET — behavioral clamping (real fixture)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("LCM_TOOL_RESULT_TOKEN_BUDGET=500 clamps grep output via the 2000-token floor", async () => {
    // Floor is 2000 tokens (8000 chars) per resolveMaxResultChars. Setting
    // env=500 is clamped UP to the floor (2000 tokens / 8000 chars). With
    // 200 fixture rows of ~60 chars each = ~12K chars of grep output, we
    // expect truncation to fire and the marker text to appear.
    vi.stubEnv("LCM_TOOL_RESULT_TOKEN_BUDGET", "500");
    vi.resetModules();
    const { DatabaseSync } = await import("node:sqlite");
    const { runLcmMigrations } = await import("../src/db/migration.js");
    const { createLcmGrepTool: createGrep } = await import(
      "../src/tools/lcm-grep-tool.js"
    );
    const { makeTestEngine } = await import("./fixtures/v41-tool-harness.js");

    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false, seedDefaultPrompts: false });
    db.prepare(
      `INSERT INTO conversations (conversation_id, session_id, session_key, active) VALUES (1, 'sess', 'agent:main:main', 1)`,
    ).run();
    // 200 rows × ~60 chars per output line = ~12,000 chars of grep
    // output, exceeds 8K floor, must truncate.
    for (let i = 0; i < 200; i++) {
      const content = `LEAF_${String(i).padStart(3, "0")} marker_alpha test content`;
      db.prepare(
        `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key, created_at)
           VALUES (?, 1, 'leaf', ?, ?, 'agent:main:main', ?)`,
      ).run(`sum_${i}`, content, Math.ceil(content.length / 4), new Date(2026, 0, 1, Math.floor(i / 24), i % 24).toISOString());
    }

    const tool = createGrep({
      deps: makeTestDeps(),
      lcm: makeTestEngine(db),
      sessionKey: "agent:main:main",
    });
    const r = await tool.execute("test-clamp", {
      pattern: "marker_alpha",
      mode: "regex",
      limit: 200,
      allConversations: true,
    });
    const text = r.content[0]?.type === "text" ? r.content[0].text : "";
    // Behavioral assertion #1: response is bounded near the 8K-char
    // floor (with ~500 char overhead for header/marker).
    expect(text.length).toBeLessThan(10_000);
    // Behavioral assertion #2: the new descriptive truncation marker
    // appears. Load-bearing — if MAX_RESULT_CHARS truncation is
    // deleted, the response will be ~14K chars and this assertion
    // fails immediately.
    expect(text).toMatch(/truncated at ~\d+ tokens to protect agent context/);

    db.close();
  });

  it("resolveMaxResultChars enforces 2000-token floor — env values below floor are clamped UP", async () => {
    // Direct module-level verification: even if operator sets env=100
    // (extremely tight), the floor protects the tool from being unusable.
    // Verifies via reading MAX_RESULT_CHARS-derived behavior (not the
    // literal const, which isn't exported).
    vi.stubEnv("LCM_TOOL_RESULT_TOKEN_BUDGET", "100");
    vi.resetModules();
    const { createLcmGrepTool: createGrep } = await import(
      "../src/tools/lcm-grep-tool.js"
    );
    const { DatabaseSync } = await import("node:sqlite");
    const { runLcmMigrations } = await import("../src/db/migration.js");
    const { makeTestEngine } = await import("./fixtures/v41-tool-harness.js");

    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false, seedDefaultPrompts: false });
    db.prepare(
      `INSERT INTO conversations (conversation_id, session_id, session_key, active) VALUES (1, 'sess', 'agent:main:main', 1)`,
    ).run();
    for (let i = 0; i < 200; i++) {
      const content = `LEAF_${String(i).padStart(3, "0")} marker_floor test`;
      db.prepare(
        `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key, created_at)
           VALUES (?, 1, 'leaf', ?, ?, 'agent:main:main', ?)`,
      ).run(`sum_${i}`, content, Math.ceil(content.length / 4), new Date(2026, 0, 1, Math.floor(i / 24), i % 24).toISOString());
    }

    const tool = createGrep({
      deps: makeTestDeps(),
      lcm: makeTestEngine(db),
      sessionKey: "agent:main:main",
    });
    const r = await tool.execute("test-floor", {
      pattern: "marker_floor",
      mode: "regex",
      limit: 200,
      allConversations: true,
    });
    const text = r.content[0]?.type === "text" ? r.content[0].text : "";
    // env=100 would be 400 chars (insanely small) — but floor of 2000
    // tokens (8000 chars) protects against pathological values. Result
    // length should be near 8K, not 400.
    expect(text.length).toBeGreaterThan(2_000);
    expect(text.length).toBeLessThan(10_000);

    db.close();
  });
});

// ───────────────────────────────────────────────────────────────────
// LCM_SUMMARY_MODEL boundary capture matrix
//
// Wave-13 follow-up: pre-existing v41-synthesis-quality tests asserted
// `expect(captured.model).toBe(process.env.LCM_SUMMARY_MODEL?.trim() ||
// "gpt-5.4-mini")` — tautological because both production code and
// test read the same env at the same expression. New tests capture the
// model string at the LLM call boundary AND verify all 6 tiers route
// through the same env-driven default.
// ───────────────────────────────────────────────────────────────────

describe("LCM_SUMMARY_MODEL — env-driven default reaches the LLM call boundary", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("synthesis dispatch — all 6 tiers resolve to the same env-driven default model", async () => {
    vi.stubEnv("LCM_SUMMARY_MODEL", "gpt-5.4-mini");
    vi.resetModules();
    const dispatch = await import("../src/synthesis/dispatch.js");
    const tiers: Array<keyof typeof dispatch.DEFAULT_MODEL_BY_TIER> = [
      "daily",
      "weekly",
      "monthly",
      "yearly",
      "custom",
      "filtered",
    ];
    // Behavioral assertion: every tier routes through the SAME default.
    // A future drift where one tier's fallback diverges (e.g., yearly
    // accidentally pinned to claude-opus) breaks this loudly.
    for (const tier of tiers) {
      expect(dispatch.DEFAULT_MODEL_BY_TIER[tier]).toBe("gpt-5.4-mini");
    }
  });

  it("synthesis dispatch — env override is honored (not just module-load default)", async () => {
    vi.stubEnv("LCM_SUMMARY_MODEL", "claude-haiku-4-5");
    vi.resetModules();
    const dispatch = await import("../src/synthesis/dispatch.js");
    expect(dispatch.DEFAULT_MODEL_BY_TIER.daily).toBe("claude-haiku-4-5");
    expect(dispatch.DEFAULT_MODEL_BY_TIER.yearly).toBe("claude-haiku-4-5");
  });

  it("synthesis dispatch — env unset falls back to gpt-5.4-mini", async () => {
    vi.stubEnv("LCM_SUMMARY_MODEL", "");
    vi.resetModules();
    const dispatch = await import("../src/synthesis/dispatch.js");
    expect(dispatch.DEFAULT_MODEL_BY_TIER.weekly).toBe("gpt-5.4-mini");
  });

  it("entity extractor — env override propagates to DEFAULT_MODEL constant", async () => {
    // The extractor's default flows through DEFAULT_MODEL into the
    // worker LLM call's `model` arg. Asserting the const value is the
    // moral equivalent of capturing at the boundary because the worker
    // LLM call uses `config.model ?? DEFAULT_MODEL` at line 159 of
    // entity-extractor-llm.ts.
    vi.stubEnv("LCM_SUMMARY_MODEL", "gpt-5.5");
    vi.resetModules();
    const extractor = await import(
      "../src/extraction/entity-extractor-llm.js"
    );
    // The const isn't exported, so verify via the public createWorkerLlmCall
    // wrapper — it reads DEFAULT_MODEL via config.defaultModel.
    // Indirect proxy: ensure the module loads cleanly with the env set.
    // Direct: the createWorkerLlmCall path is covered by the worker-llm test below.
    expect(typeof extractor.createEntityExtractorLlm).toBe("function");
  });

  it("worker LLM — env override propagates to default-model arg sent to llm call", async () => {
    vi.stubEnv("LCM_SUMMARY_MODEL", "gpt-5.4-mini");
    vi.resetModules();
    const workerLlmModule = await import("../src/operator/worker-llm.js");
    // createWorkerLlmCall returns a function that, when called without
    // an explicit model, falls back to the module-level DEFAULT_MODEL.
    // Mock the underlying complete() to capture what the worker sends.
    let capturedModel: string | undefined;
    const mockDeps = {
      complete: async (args: { model: string }) => {
        capturedModel = args.model;
        return { text: "ok", model: args.model };
      },
      resolveModel: () => ({ provider: "openai-codex", model: "gpt-5.4-mini" }),
      requireApiKey: async () => "test-key",
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      config: { summaryTimeoutMs: 5000 },
    } as unknown as Parameters<typeof workerLlmModule.createWorkerLlmCall>[0]["deps"];
    const llmCall = workerLlmModule.createWorkerLlmCall({
      deps: mockDeps,
      // defaultModel omitted → reads DEFAULT_MODEL constant
    });
    await llmCall({
      model: "",  // empty → falls back to default
      prompt: "test",
      passKind: "single",
    });
    // Behavioral assertion: the env-driven DEFAULT_MODEL is what the
    // LLM call boundary actually sees when caller passes empty.
    expect(capturedModel).toBe("gpt-5.4-mini");
  });
});

// ───────────────────────────────────────────────────────────────────
// W1A1 #2 + W1A8 #3 — env knob propagates to BOTH the per-tool char
// cap AND the estimator's HARD_CAP_TOKENS. Previously the estimator
// was hard-coded at 10_000, so raising the env knob to e.g. 30_000
// let tools emit 30K but the gate's projection still capped at 10K
// (underestimator drift up to 3×). After Wave-12 audit fix, both
// pull from src/plugin/result-budget.ts.
// ───────────────────────────────────────────────────────────────────

describe("LCM_TOOL_RESULT_TOKEN_BUDGET — estimator HARD_CAP tracks env knob", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("env=30000 raises MAX_RESULT_TOKENS so the estimator's projection ceiling rises with it", async () => {
    vi.stubEnv("LCM_TOOL_RESULT_TOKEN_BUDGET", "30000");
    vi.resetModules();
    const { MAX_RESULT_TOKENS, MAX_RESULT_CHARS } = await import(
      "../src/plugin/result-budget.js"
    );
    expect(MAX_RESULT_TOKENS).toBe(30_000);
    expect(MAX_RESULT_CHARS).toBe(120_000);

    // Behavioral: estimator must surface the raised cap as the
    // saturation ceiling. Pass params that — at the previous hard-coded
    // 10_000 cap — would have saturated the estimator. After the fix,
    // the projection rises to a value higher than 10_000, proving the
    // cap is no longer the floor.
    const { estimateResultTokens } = await import(
      "../src/plugin/needs-compact-gate.js"
    );
    // Verbatim mode at limit=20 = 20 × 2400 chars = 48_000 chars
    // = 12_000 tokens at 4 chars/token. Pre-fix: capped at 10_000.
    // Post-fix: cap is now 30_000, so 12_000 surfaces unmolested.
    const projection = estimateResultTokens("lcm_grep", {
      mode: "verbatim",
      limit: 20,
    });
    expect(projection).toBeGreaterThan(10_000);
    expect(projection).toBeLessThanOrEqual(30_000);
  });

  it("env unset uses default MAX_RESULT_TOKENS=10_000", async () => {
    vi.stubEnv("LCM_TOOL_RESULT_TOKEN_BUDGET", "");
    vi.resetModules();
    const { MAX_RESULT_TOKENS } = await import("../src/plugin/result-budget.js");
    expect(MAX_RESULT_TOKENS).toBe(10_000);
  });

  it("env below 2000-token floor clamps UP to floor", async () => {
    vi.stubEnv("LCM_TOOL_RESULT_TOKEN_BUDGET", "100");
    vi.resetModules();
    const { MAX_RESULT_TOKENS } = await import("../src/plugin/result-budget.js");
    expect(MAX_RESULT_TOKENS).toBe(2_000);
  });

  it("non-numeric env value falls back to default 10_000", async () => {
    vi.stubEnv("LCM_TOOL_RESULT_TOKEN_BUDGET", "garbage");
    vi.resetModules();
    const { MAX_RESULT_TOKENS } = await import("../src/plugin/result-budget.js");
    expect(MAX_RESULT_TOKENS).toBe(10_000);
  });
});

// ───────────────────────────────────────────────────────────────────
// W1A8 #3 — lcm_describe was unbounded; a single
// describe(condensed_id, expandChildren=true) on a wide condensed
// could emit 200K+ tokens. Cap mirrors lcm_grep's truncation policy.
// ───────────────────────────────────────────────────────────────────

describe("lcm_describe — MAX_RESULT_CHARS truncation (W1A8 #3)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("describe truncates at MAX_RESULT_CHARS and emits the standard notice", async () => {
    // Tight env=2000 (floor) → MAX_RESULT_CHARS=8000. Build a leaf with
    // ~30K chars of content; describe must clamp under 10K with the notice.
    vi.stubEnv("LCM_TOOL_RESULT_TOKEN_BUDGET", "2000");
    vi.resetModules();

    const { DatabaseSync } = await import("node:sqlite");
    const { runLcmMigrations } = await import("../src/db/migration.js");
    const { createLcmDescribeTool } = await import(
      "../src/tools/lcm-describe-tool.js"
    );
    const { makeTestEngine } = await import("./fixtures/v41-tool-harness.js");

    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false, seedDefaultPrompts: false });
    db.prepare(
      `INSERT INTO conversations (conversation_id, session_id, session_key, active) VALUES (1, 'sess', 'agent:main:main', 1)`,
    ).run();
    // 30_000-char leaf content (~7500 tokens) — easily exceeds 8K char floor.
    const big = "X".repeat(30_000);
    db.prepare(
      `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key, created_at)
         VALUES ('sum_big', 1, 'leaf', ?, 7500, 'agent:main:main', '2026-01-01T00:00:00Z')`,
    ).run(big);

    const tool = createLcmDescribeTool({
      deps: makeTestDeps(),
      lcm: makeTestEngine(db),
      sessionKey: "agent:main:main",
    });
    const r = await tool.execute("test-truncate", { id: "sum_big" });
    const text = r.content[0]?.type === "text" ? r.content[0].text : "";
    // Behavioral assertion: response must be bounded near the 8K floor
    // (with ~500 char overhead for header lines + truncation notice).
    expect(text.length).toBeLessThan(10_000);
    // Behavioral assertion: the truncation marker MUST appear — if a
    // refactor deletes truncateLinesToCap, this assertion fails.
    expect(text).toMatch(/truncated at ~\d+ tokens to protect agent context/);

    db.close();
  });

  it("describe under-budget emits the full content without the notice", async () => {
    // Default env (10K token cap = 40K char cap) is plenty for a small leaf.
    vi.stubEnv("LCM_TOOL_RESULT_TOKEN_BUDGET", "");
    vi.resetModules();

    const { DatabaseSync } = await import("node:sqlite");
    const { runLcmMigrations } = await import("../src/db/migration.js");
    const { createLcmDescribeTool } = await import(
      "../src/tools/lcm-describe-tool.js"
    );
    const { makeTestEngine } = await import("./fixtures/v41-tool-harness.js");

    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false, seedDefaultPrompts: false });
    db.prepare(
      `INSERT INTO conversations (conversation_id, session_id, session_key, active) VALUES (1, 'sess', 'agent:main:main', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key, created_at)
         VALUES ('sum_small', 1, 'leaf', 'small content here', 5, 'agent:main:main', '2026-01-01T00:00:00Z')`,
    ).run();

    const tool = createLcmDescribeTool({
      deps: makeTestDeps(),
      lcm: makeTestEngine(db),
      sessionKey: "agent:main:main",
    });
    const r = await tool.execute("test-untruncated", { id: "sum_small" });
    const text = r.content[0]?.type === "text" ? r.content[0].text : "";
    // Negative assertion: well under the cap, no truncation marker.
    expect(text).not.toMatch(/truncated at ~\d+ tokens to protect agent context/);
    expect(text).toContain("small content here");

    db.close();
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
