/**
 * Cross-module invariant tests.
 *
 * # Why this exists
 *
 * Wave-12 audit (W1A1 #2) found that the needs-compact-gate's
 * `HARD_CAP_TOKENS` was hard-coded at 10_000 while the per-tool char
 * cap (`MAX_RESULT_CHARS`) was operator-tunable via env. When the
 * operator raised the env knob to 30K, tools could emit 30K but the
 * gate's projection ceiling stayed at 10K — needsCompact decisions
 * drifted low (refusals missed when they should fire) by up to 3×.
 *
 * Root cause: each module pinned its own number in isolation; nothing
 * asserted the cross-module invariant `HARD_CAP_TOKENS === MAX_RESULT_TOKENS`.
 *
 * This file pins cross-module relationships that no single-module test
 * file naturally covers. When a refactor changes one side without
 * propagating to the other, these tests fail loudly — exactly the
 * detection W1A1 needed.
 *
 * # When this test fails
 *
 *   1. A constant moved between modules but the import wasn't updated
 *      → propagate the change.
 *   2. A new shared invariant was introduced → add it here.
 *   3. A documented relationship is broken → fix one side or the other,
 *      and check the docstring still reflects reality.
 */

import { describe, expect, it } from "vitest";

describe("cross-module invariant — needs-compact-gate's HARD_CAP equals result-budget's MAX_RESULT_TOKENS (W1A1 #2)", () => {
  it("estimator's projection ceiling equals the per-tool char-cap source-of-truth", async () => {
    // Both modules must read from src/plugin/result-budget.ts. If a
    // refactor re-introduces a hard-coded 10_000 in needs-compact-gate,
    // the estimator's lcm_grep verbatim limit=20 projection (which
    // saturates at the cap) will diverge from MAX_RESULT_TOKENS.
    const { MAX_RESULT_TOKENS } = await import(
      "../src/plugin/result-budget.js"
    );
    const { estimateResultTokens } = await import(
      "../src/plugin/needs-compact-gate.js"
    );
    // verbatim mode at limit=20 with avg 2400 chars/row = 48000 chars
    // = 12000 tokens. Pre-cap. The estimator's Math.min(HARD_CAP, ...)
    // saturates this. Saturation value === HARD_CAP_TOKENS.
    const projection = estimateResultTokens("lcm_grep", {
      mode: "verbatim",
      limit: 20,
    });
    // Expectation: projection saturates at MAX_RESULT_TOKENS at the
    // module-load-time env value (default 10_000). If a refactor
    // disconnects the two, projection will saturate at the old
    // hard-coded 10_000 even when MAX_RESULT_TOKENS is, say, 30_000.
    expect(projection).toBe(MAX_RESULT_TOKENS);
  });

  it("per-tool MAX_RESULT_CHARS = MAX_RESULT_TOKENS × 4", async () => {
    // Document the chars-per-token ratio so a refactor that splits
    // them notices.
    const { MAX_RESULT_TOKENS, MAX_RESULT_CHARS } = await import(
      "../src/plugin/result-budget.js"
    );
    expect(MAX_RESULT_CHARS).toBe(MAX_RESULT_TOKENS * 4);
  });
});

describe("cross-module invariant — toolResultTokenBudget config precedence (Wave-12 retro A1)", () => {
  it("env LCM_TOOL_RESULT_TOKEN_BUDGET wins over LcmConfig.toolResultTokenBudget (env-first precedence)", async () => {
    // Standard precedence pattern: every other LCM env knob wins over
    // plugin config. result-budget.ts honors it via `applyResultBudgetConfig`
    // checking `envValueAtLoad` first.
    const { resolveLcmConfigWithDiagnostics } = await import("../src/db/config.js");
    const { config } = resolveLcmConfigWithDiagnostics(
      { LCM_TOOL_RESULT_TOKEN_BUDGET: "30000" },
      { toolResultTokenBudget: 50000 },
    );
    expect(config.toolResultTokenBudget).toBe(30_000);
  });

  it("LcmConfig.toolResultTokenBudget honored when env unset (config wins over default)", async () => {
    const { resolveLcmConfigWithDiagnostics } = await import("../src/db/config.js");
    const { config } = resolveLcmConfigWithDiagnostics(
      {},
      { toolResultTokenBudget: 50000 },
    );
    expect(config.toolResultTokenBudget).toBe(50_000);
  });

  it("undefined when neither env nor config set (default applied downstream in result-budget.ts)", async () => {
    const { resolveLcmConfigWithDiagnostics } = await import("../src/db/config.js");
    const { config } = resolveLcmConfigWithDiagnostics({}, {});
    expect(config.toolResultTokenBudget).toBeUndefined();
  });

  it("applyResultBudgetConfig updates live bindings when env wasn't set", async () => {
    const { __resetResultBudgetForTesting, applyResultBudgetConfig } = await import(
      "../src/plugin/result-budget.js"
    );
    __resetResultBudgetForTesting();
    // No env set in this test process → config can override
    if (process.env.LCM_TOOL_RESULT_TOKEN_BUDGET) {
      // Env is set in the runner; skip the override-when-env-unset assertion
      // because it would require unstubEnv + module reset, and the simpler
      // "is env honored" path is covered above.
      return;
    }
    applyResultBudgetConfig(50_000);
    const { MAX_RESULT_TOKENS, MAX_RESULT_CHARS } = await import(
      "../src/plugin/result-budget.js"
    );
    expect(MAX_RESULT_TOKENS).toBe(50_000);
    expect(MAX_RESULT_CHARS).toBe(200_000);
    // Reset for downstream tests
    __resetResultBudgetForTesting();
  });
});

describe("cross-module invariant — REFUSAL_THRESHOLD calibration (Wave-14 Agent A)", () => {
  it("REFUSAL_THRESHOLD is 0.92 — calibrated against MAX_RESULT_TOKENS headroom", async () => {
    const { REFUSAL_THRESHOLD } = await import(
      "../src/plugin/needs-compact-gate.js"
    );
    // 0.92 × 200K = 184K — leaves 16K headroom = one full-cap call
    // (10K) + agent's own response (~6K). If a refactor changes the
    // threshold without recalibrating against MAX_RESULT_TOKENS, the
    // single-call-leaves-zero-margin failure mode returns.
    expect(REFUSAL_THRESHOLD).toBe(0.92);
    // Sanity: 1 - threshold > MAX_RESULT_TOKENS / typical_budget
    // (200K). Default 10K cap × (1/200K) = 0.05; threshold cushion
    // 0.08 = > 0.05. Calibration holds.
    const { MAX_RESULT_TOKENS } = await import(
      "../src/plugin/result-budget.js"
    );
    const cushion = 1 - REFUSAL_THRESHOLD;
    const capRatioAt200K = MAX_RESULT_TOKENS / 200_000;
    expect(cushion).toBeGreaterThan(capRatioAt200K);
  });
});

describe("cross-module invariant — manifest.contracts.tools is a 1:1 set with registerTool sites", () => {
  // This invariant is already pinned by test/manifest.test.ts (which
  // caught the comment-placement regex bug earlier today). We add a
  // sanity check here that the manifest file actually contains entries
  // for each tool factory that exists in src/tools/. Catches "factory
  // exists but never registered" drift (which would otherwise present
  // as a tool that compiles + has tests but never appears in the
  // agent's palette).
  it("every src/tools/lcm-*-tool.ts factory has a corresponding tool entry in registration", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const REPO_ROOT = join(__dirname, "..");
    const toolsDir = join(REPO_ROOT, "src/tools");
    const factoryPattern = /export function (createLcm[A-Za-z]+Tool)\b/;
    const factories: string[] = [];
    for (const f of readdirSync(toolsDir)) {
      if (!f.startsWith("lcm-") || !f.endsWith("-tool.ts")) continue;
      // Skip helper modules (delegation.ts, scope.ts, etc.).
      const src = readFileSync(join(toolsDir, f), "utf8");
      const m = src.match(factoryPattern);
      if (m) factories.push(m[1]!);
    }
    const pluginSrc = readFileSync(
      join(REPO_ROOT, "src/plugin/index.ts"),
      "utf8",
    );
    for (const factory of factories) {
      // The plugin should at least mention the factory name (either
      // import OR registration). Lower bar than "must register" — some
      // factories might be helpers — but a missing mention is the
      // accidental-drop-from-registration smoke signal.
      expect(
        pluginSrc.includes(factory),
        `Factory ${factory} exists in src/tools/ but is not referenced ` +
          `in src/plugin/index.ts. Either register the tool or delete ` +
          `the dead factory.`,
      ).toBe(true);
    }
  });
});

describe("cross-module invariant — summaryKinds reaches BOTH semantic and hybrid dispatch (W1A5 #1 sister case)", () => {
  it("lcm_grep dispatch passes summaryKinds to runHybridLcmGrep AND runSemanticLcmGrep", async () => {
    // Wave-1 audit (W1A5 P1): the schema documented summaryKinds as
    // honored on both 'semantic' and 'hybrid' modes, but the dispatch
    // only plumbed it to the semantic branch — hybrid silently ignored
    // the filter. Schema lied. Fix: resolve once at dispatch and pass
    // to both helpers.
    //
    // Static check pins the fix: BOTH dispatch branches must reference
    // summaryKinds. A future refactor that drops one side regresses
    // the schema-vs-implementation invariant.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const REPO_ROOT = join(__dirname, "..");
    const grepSrc = readFileSync(
      join(REPO_ROOT, "src/tools/lcm-grep-tool.ts"),
      "utf8",
    );
    // Find the dispatch block: `if (mode === "hybrid")` and
    // `if (mode === "semantic")` — each must contain `summaryKinds:`
    // within ~15 lines (the helper-call argument list).
    const hybridBlock = grepSrc.match(
      /if\s*\(mode === "hybrid"\)[\s\S]{0,800}?\}/,
    )?.[0];
    const semanticBlock = grepSrc.match(
      /if\s*\(mode === "semantic"\)[\s\S]{0,800}?\}/,
    )?.[0];
    expect(hybridBlock, "Couldn't locate hybrid dispatch block").toBeTruthy();
    expect(semanticBlock, "Couldn't locate semantic dispatch block").toBeTruthy();
    expect(
      hybridBlock!.includes("summaryKinds"),
      `lcm_grep hybrid dispatch must pass summaryKinds (Wave-1 W1A5 P1 fix). ` +
        `Without it, the schema's documented filter silently fails on hybrid mode.`,
    ).toBe(true);
    expect(
      semanticBlock!.includes("summaryKinds"),
      `lcm_grep semantic dispatch must pass summaryKinds.`,
    ).toBe(true);
  });
});

describe("cross-module invariant — sub-agent expansion-auth gate is consistent across surfaces", () => {
  it("lcm_expand and lcm_describe both check delegated grant via expansion-auth manager", async () => {
    // Wave-9 P0 sister: both surfaces should consult the same
    // ExpansionAuthManager singleton. If a refactor moves one to a
    // local cache, sub-agent budget enforcement diverges.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const REPO_ROOT = join(__dirname, "..");
    const expandSrc = readFileSync(
      join(REPO_ROOT, "src/tools/lcm-expand-tool.ts"),
      "utf8",
    );
    const describeSrc = readFileSync(
      join(REPO_ROOT, "src/tools/lcm-describe-tool.ts"),
      "utf8",
    );
    expect(expandSrc).toContain("getRuntimeExpansionAuthManager");
    expect(describeSrc).toContain("getRuntimeExpansionAuthManager");
  });
});
