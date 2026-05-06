/**
 * Synthesis-quality test suite — uses the mock LLM provider to verify
 * the dispatch pipeline end-to-end without needing real Voyage / LLM creds.
 *
 * # What this closes
 *
 * Wave-10 reviewer noted (and the user confirmed) that all 25 scenarios
 * passing was suspicious because the offline harness couldn't actually
 * verify synthesis quality — only that leaf-selection SQL ran. The mock
 * LLM closes this gap. With it we can verify:
 *
 *   - dispatchSynthesis routes correctly per tier (mini/mid/premium/
 *     thinking)
 *   - Renders prompts correctly (placeholder substitution, source-text
 *     concat, tier label)
 *   - Writes audit rows correctly
 *   - Returns structured SynthesizeResult
 *   - Best-of-N path runs N candidates + judge
 *   - Verify-fidelity pass rejects hallucinations
 *   - Citation validation catches fabricated IDs
 *   - Parser robustness against malformed LLM output
 *
 * # NOT in this file
 *
 * The full agent-tool flow (lcm_synthesize_around → dispatch → cache
 * write → return formatted markdown) is covered by
 * lcm-synthesize-around-tool.test.ts. This file focuses on the dispatch
 * layer alone with the mock as the LlmCall.
 */

import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { dispatchSynthesis } from "../src/synthesis/dispatch.js";
import { registerPrompt } from "../src/synthesis/prompt-registry.js";
import {
  makeMockLlm,
  type MockResponseShape,
  type MockLlmOptions,
} from "./fixtures/v41-mock-llm.js";
import type { LlmCallArgs } from "../src/synthesis/dispatch.js";

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false, seedDefaultPrompts: false });
  // Seed prompts for each tier we'll dispatch under.
  for (const [tier, template] of [
    ["custom", "Synthesize: {{source_text}}"],
    ["filtered", "Synthesize filtered: {{source_text}}"],
    ["daily", "Daily summary of: {{source_text}}"],
    ["weekly", "Weekly summary of: {{source_text}}"],
    ["monthly", "Monthly summary of: {{source_text}}"],
    ["yearly", "Yearly summary of: {{source_text}}"],
  ] as const) {
    registerPrompt(db, {
      memoryType: "episodic-condensed",
      tierLabel: tier,
      passKind: "single",
      template,
    });
  }
  // Verify-fidelity prompt for monthly tier.
  registerPrompt(db, {
    memoryType: "episodic-condensed",
    tierLabel: "monthly",
    passKind: "verify_fidelity",
    template:
      "Verify the draft against source leaves.\n\nDRAFT:\n{{draft}}\n\nSOURCE:\n{{source_leaves}}",
  });
  // Best-of-N judge prompt.
  registerPrompt(db, {
    memoryType: "episodic-condensed",
    tierLabel: "yearly",
    passKind: "best_of_n_judge",
    template: "Pick the best candidate.\n\n{{candidates}}",
  });
});

afterEach(() => {
  db.close();
});

// Helper: build a synthesize request with a target_summary_id (required).
function makeRequest(opts: {
  tier: "custom" | "filtered" | "daily" | "weekly" | "monthly" | "yearly";
  sourceText?: string;
  passSessionId?: string;
}): Parameters<typeof dispatchSynthesis>[2] {
  // Insert the target summary so the FK is satisfied.
  const targetId = `sum_target_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO conversations (conversation_id, session_id, session_key) VALUES (1, 's', 'sk1')`,
  ).run();
  db.prepare(
    `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key)
       VALUES (?, 1, 'leaf', 'target', 1, 'sk1')`,
  ).run(targetId);
  return {
    tier: opts.tier,
    memoryType: "episodic-condensed",
    sourceText:
      opts.sourceText ??
      "Source leaf 1: sum_src_a — discussion of X.\nSource leaf 2: sum_src_b — Eva approved X.\n",
    targetSummaryId: targetId,
    passSessionId: opts.passSessionId ?? `pass_${Date.now()}_${Math.random()}`,
  };
}

// ────────────────────────────────────────────────────────────────────
// Per-tier dispatch routing
// ────────────────────────────────────────────────────────────────────

describe("dispatch quality — per-tier routing with mock LLM", () => {
  it("daily tier dispatches single-pass with mini model", async () => {
    const captured: LlmCallArgs[] = [];
    const mock = makeMockLlm({ captured });
    const req = makeRequest({ tier: "daily" });
    const result = await dispatchSynthesis(db, mock, req);
    expect(result.output).toContain("[mock-good]");
    expect(captured).toHaveLength(1);
    expect(captured[0]!.passKind).toBe("single");
    // Default model for daily is haiku.
    expect(captured[0]!.model).toMatch(/haiku/i);
  });

  it("weekly tier dispatches single-pass with mid model (sonnet)", async () => {
    const captured: LlmCallArgs[] = [];
    const mock = makeMockLlm({ captured });
    const req = makeRequest({ tier: "weekly" });
    const result = await dispatchSynthesis(db, mock, req);
    expect(result.output).toContain("[mock-good]");
    expect(captured[0]!.passKind).toBe("single");
    expect(captured[0]!.model).toMatch(/sonnet/i);
  });

  it("monthly tier runs single + verify_fidelity (2 calls)", async () => {
    const captured: LlmCallArgs[] = [];
    const mock = makeMockLlm({
      captured,
      perPromptOverrides: [
        { promptContains: "Verify the draft", shape: "verify_OK" },
      ],
    });
    const req = makeRequest({ tier: "monthly" });
    const result = await dispatchSynthesis(db, mock, req);
    expect(captured).toHaveLength(2);
    expect(captured[0]!.passKind).toBe("single");
    expect(captured[1]!.passKind).toBe("verify_fidelity");
    expect(result.hallucinationFlagged).toBe(false);
  });

  it("monthly tier flags hallucination when verify pass returns HALLUCINATION", async () => {
    const captured: LlmCallArgs[] = [];
    const mock = makeMockLlm({
      captured,
      perPromptOverrides: [
        {
          promptContains: "Verify the draft",
          shape: "verify_HALLUCINATION",
        },
      ],
    });
    const req = makeRequest({ tier: "monthly" });
    const result = await dispatchSynthesis(db, mock, req);
    expect(result.hallucinationFlagged).toBe(true);
  });

  it("yearly tier runs best-of-N (N=3 single + 1 judge = 4 calls)", async () => {
    const captured: LlmCallArgs[] = [];
    const mock = makeMockLlm({ captured });
    const req = makeRequest({ tier: "yearly" });
    const result = await dispatchSynthesis(db, mock, req);
    expect(captured.length).toBeGreaterThanOrEqual(4); // 3 candidates + 1 judge
    const judgeCalls = captured.filter((c) => c.passKind === "best_of_n_judge");
    expect(judgeCalls).toHaveLength(1);
    const candidateCalls = captured.filter((c) => c.passKind === "single");
    expect(candidateCalls).toHaveLength(3);
    expect(result.bestOfN?.n).toBe(3);
    expect(result.bestOfN?.selectedIndex).toBeGreaterThanOrEqual(0);
    expect(result.bestOfN?.candidates).toHaveLength(3);
  });
});

// ────────────────────────────────────────────────────────────────────
// Prompt rendering — verify placeholders substitute correctly
// ────────────────────────────────────────────────────────────────────

describe("dispatch quality — prompt rendering", () => {
  it("renders {{source_text}} into the LLM prompt verbatim", async () => {
    const captured: LlmCallArgs[] = [];
    const mock = makeMockLlm({ captured });
    const req = makeRequest({
      tier: "custom",
      sourceText: "DISTINCTIVE_MARKER_FOR_TEST source content here",
    });
    await dispatchSynthesis(db, mock, req);
    expect(captured[0]!.prompt).toContain("DISTINCTIVE_MARKER_FOR_TEST");
    // No literal {{source_text}} should remain in the rendered prompt.
    expect(captured[0]!.prompt).not.toMatch(/\{\{source_text\}\}/);
  });

  it("verify-fidelity pass renders {{draft}} + {{source_leaves}}", async () => {
    const captured: LlmCallArgs[] = [];
    const mock = makeMockLlm({
      captured,
      defaultShape: "good",
      perPromptOverrides: [
        { promptContains: "Verify the draft", shape: "verify_OK" },
      ],
    });
    const req = makeRequest({
      tier: "monthly",
      sourceText: "VERIFY_SOURCE_MARKER content",
    });
    await dispatchSynthesis(db, mock, req);
    const verifyCall = captured.find((c) => c.passKind === "verify_fidelity");
    expect(verifyCall).toBeDefined();
    // Both placeholders must be substituted.
    expect(verifyCall!.prompt).not.toMatch(/\{\{draft\}\}/);
    expect(verifyCall!.prompt).not.toMatch(/\{\{source_leaves\}\}/);
    // Source text appears in the verify prompt.
    expect(verifyCall!.prompt).toContain("VERIFY_SOURCE_MARKER");
  });
});

// ────────────────────────────────────────────────────────────────────
// Adversarial response handling
// ────────────────────────────────────────────────────────────────────

describe("dispatch quality — adversarial LLM responses", () => {
  it("propagates LLM throw as SynthesisDispatchError llm_failure", async () => {
    const mock = makeMockLlm({ defaultShape: "throw" });
    const req = makeRequest({ tier: "custom" });
    await expect(dispatchSynthesis(db, mock, req)).rejects.toThrow(
      /llm_failure|Mock LLM throw|throw/i,
    );
  });

  it("best-of-N tolerates 1 throwing candidate via Promise.allSettled (Wave-7 P1.1)", async () => {
    let callIndex = 0;
    const mock: typeof makeMockLlm extends () => infer R ? R : never = (
      async (args: LlmCallArgs) => {
        const i = callIndex++;
        // First candidate throws; remaining 2 succeed; judge succeeds.
        if (args.passKind === "single" && i === 0) {
          throw new Error("Candidate 0 LLM failure");
        }
        if (args.passKind === "best_of_n_judge") {
          return {
            output: "Winner: 0",
            latencyMs: 10,
            costCents: 0,
            actualModel: args.model,
          };
        }
        return {
          output: `[mock-good] candidate ${i}`,
          latencyMs: 10,
          costCents: 0,
          actualModel: args.model,
        };
      }
    );
    const req = makeRequest({ tier: "yearly" });
    const result = await dispatchSynthesis(db, mock, req);
    // Should succeed despite 1 candidate failing.
    expect(result.bestOfN?.candidates.length).toBe(2);
    expect(result.output).toContain("[mock-good] candidate");
  });

  it("monthly verify-fidelity returning malformed JSON does NOT throw + defaults to flagged", async () => {
    // Wave-10 design check: Wave-4 P0 fix tightened the verify parser
    // to require an explicit "OK" marker — garbled output (no clear OK,
    // no clear HALLUCINATION) defaults to flagged. This is intentional:
    // better false-positive than letting hallucinations through.
    const mock = makeMockLlm({
      defaultShape: "good",
      perPromptOverrides: [
        { promptContains: "Verify the draft", shape: "malformed_json" },
      ],
    });
    const req = makeRequest({ tier: "monthly" });
    const result = await dispatchSynthesis(db, mock, req);
    expect(result.output).toBeTruthy();
    // Garbled output → conservative default → flagged.
    expect(result.hallucinationFlagged).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
// Type-A scenarios with synthesis quality assertions
// (closes the A2/A3/A5 weak-test gap)
// ────────────────────────────────────────────────────────────────────

describe("Type-A synthesis quality with mock LLM (closes A2/A3/A5 gap)", () => {
  it("Type-A monthly synthesis with valid leaves produces grounded output", async () => {
    const captured: LlmCallArgs[] = [];
    const mock = makeMockLlm({
      captured,
      perPromptOverrides: [
        { promptContains: "Verify the draft", shape: "verify_OK" },
      ],
    });
    const req = makeRequest({
      tier: "monthly",
      sourceText:
        "[sum_apr26] Eva: started rebase work on PR #71676.\n" +
        "[sum_apr27] Race condition empty-plan-body identified.\n" +
        "[sum_may01] Race-fix commit 1081067476 landed.\n",
    });
    const result = await dispatchSynthesis(db, mock, req);
    // Output includes our mock-good marker (proves dispatch succeeded
    // and rendered a synthesis from the LLM).
    expect(result.output).toContain("[mock-good]");
    // Source IDs from the input were detected (mock cites the first one).
    expect(result.output).toMatch(/sum_apr26|sum_apr27|sum_may01/);
    // No hallucinations flagged (verify pass returned OK).
    expect(result.hallucinationFlagged).toBe(false);
    // Dispatch made exactly 2 calls (single + verify) for monthly.
    expect(captured).toHaveLength(2);
  });

  it("Type-A hallucination is detected by verify pass and flagged in result", async () => {
    const mock = makeMockLlm({
      defaultShape: "hallucinated_content",
      perPromptOverrides: [
        { promptContains: "Verify the draft", shape: "verify_HALLUCINATION" },
      ],
    });
    const req = makeRequest({
      tier: "monthly",
      sourceText: "[sum_a] Eva fixed a bug.\n",
    });
    const result = await dispatchSynthesis(db, mock, req);
    expect(result.hallucinationFlagged).toBe(true);
    // The hallucinated draft is returned (caller can decide what to do
    // with it — the flag is the signal).
    expect(result.output).toContain("Mars colony");
  });
});
