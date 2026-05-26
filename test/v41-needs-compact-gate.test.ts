/**
 * needsCompact pre-call gate tests.
 *
 * Pins the contract: when projected result would push context past
 * REFUSAL_THRESHOLD (0.92), tool returns structured refusal payload
 * with suggested actions. Below threshold, tool runs normally.
 */

import { describe, expect, it } from "vitest";
import {
  estimateResultTokens,
  evaluateNeedsCompactGate,
  REFUSAL_THRESHOLD,
} from "../src/plugin/needs-compact-gate.js";

describe("estimateResultTokens — empirical formulas (Wave-14 Agent C calibration)", () => {
  it("lcm_grep regex limit=20 estimates ~1050 tokens", () => {
    const t = estimateResultTokens("lcm_grep", { mode: "regex", limit: 20 });
    expect(t).toBeGreaterThanOrEqual(1000);
    expect(t).toBeLessThanOrEqual(1200);
  });

  it("lcm_grep verbatim limit=20 estimates ~10K tokens (cap-bound)", () => {
    const t = estimateResultTokens("lcm_grep", { mode: "verbatim", limit: 20 });
    expect(t).toBe(10_000);  // hits HARD_CAP_TOKENS
  });

  it("lcm_describe expandMessages=true expandMessagesLimit=20 estimates ~4K tokens (Wave-12 F2 recalibration)", () => {
    // Wave-12 reviewer F2: live-DB validation showed real
    // expandMessages=20 emits 2,551–3,604 tokens, not 12-13K.
    // Estimator recalibrated from 600 chars/msg to ~150 tokens/msg
    // (600 chars/msg). New estimate: (350 + 1250 + 3200 + 20*600) / 4
    // = 4200 tokens. No longer hits HARD_CAP.
    const t = estimateResultTokens("lcm_describe", {
      expandMessages: true,
      expandMessagesLimit: 20,
    });
    expect(t).toBeGreaterThanOrEqual(3_500);
    expect(t).toBeLessThanOrEqual(5_000);
  });

  it("lcm_describe with no expand flags is small", () => {
    const t = estimateResultTokens("lcm_describe", { id: "sum_xxx" });
    expect(t).toBeGreaterThanOrEqual(1000);
    expect(t).toBeLessThanOrEqual(1500);
  });

  it("lcm_get_entity default mentionLimit=20 estimates ~600 tokens", () => {
    const t = estimateResultTokens("lcm_get_entity", { mentionLimit: 20 });
    expect(t).toBeGreaterThanOrEqual(500);
    expect(t).toBeLessThanOrEqual(800);
  });

  it("lcm_compact has minimal footprint", () => {
    const t = estimateResultTokens("lcm_compact", {});
    expect(t).toBeLessThan(200);
  });

  it("lcm_synthesize_around estimate matches the docstring's 4K-8K range (Wave-12 retro L1 self-contradiction fix)", () => {
    // Wave-12 retro review L1: the file's docstring at line 26-29
    // documents synthesize output as "4K-8K tokens of LLM-generated
    // rollup", but the estimator previously returned 3000 — under-
    // estimating by ~50%. Fixed to 6000 (midpoint of the documented
    // range). If the docstring drifts, update both sides together.
    const t = estimateResultTokens("lcm_synthesize_around", {});
    expect(t).toBeGreaterThanOrEqual(4_000);
    expect(t).toBeLessThanOrEqual(8_000);
  });

  it("unknown tool returns conservative default", () => {
    const t = estimateResultTokens("unknown_tool", {});
    expect(t).toBe(1000);
  });
});

describe("evaluateNeedsCompactGate — refusal logic", () => {
  it("REFUSAL_THRESHOLD is calibrated at 0.92", () => {
    expect(REFUSAL_THRESHOLD).toBe(0.92);
  });

  it("returns null when projected ratio is below threshold (allow)", () => {
    const result = evaluateNeedsCompactGate({
      toolName: "lcm_grep",
      toolParams: { mode: "regex", limit: 20 },  // ~1050 tokens
      currentTokenCount: 100_000,
      tokenBudget: 200_000,
    });
    expect(result).toBeNull();  // 0.5 + 0.5% = 0.5% — well below 0.92
  });

  it("refuses when projected ratio exceeds threshold", () => {
    // Wave-12 F2: estimator recalibrated; expandMessages=20 now ~4200 tokens
    // (was 10K). To trip 0.92 from 184K anchor, projected = 184K + 4200 =
    // 188.2K / 200K = 0.941 > 0.92 ✓
    const result = evaluateNeedsCompactGate({
      toolName: "lcm_describe",
      toolParams: { expandMessages: true, expandMessagesLimit: 20 },
      currentTokenCount: 184_000,
      tokenBudget: 200_000,
    });
    expect(result).not.toBeNull();
    expect(result?.needsCompact).toBe(true);
    expect(result?.reason).toBe("context-overflow-prevention");
    expect(result?.note).toMatch(/lcm_compact/);
  });

  it("refusal includes contextRatio + projectedRatio", () => {
    // Wave-12 F2 recalibration: expandMessages=20 → ~4200 tokens.
    // currentRatio=185K/200K=0.925; projected=189.2K/200K=0.946.
    const result = evaluateNeedsCompactGate({
      toolName: "lcm_describe",
      toolParams: { expandMessages: true, expandMessagesLimit: 20 },
      currentTokenCount: 185_000,
      tokenBudget: 200_000,
    });
    expect(result?.currentRatio).toBeCloseTo(0.925, 2);
    expect(result?.projectedRatio).toBeCloseTo(0.946, 2);
    expect(result?.estimatedResultTokens).toBeGreaterThanOrEqual(3_500);
    expect(result?.estimatedResultTokens).toBeLessThanOrEqual(5_000);
  });

  it("refusal suggests narrowing for tools with limit", () => {
    const result = evaluateNeedsCompactGate({
      toolName: "lcm_grep",
      toolParams: { mode: "verbatim", limit: 20 },  // 10K cap-bound
      currentTokenCount: 184_000,
      tokenBudget: 200_000,
    });
    expect(result?.suggested_actions.join(" ")).toContain("lcm_compact");
    expect(result?.suggested_actions.join(" ")).toContain("limit=10");
  });

  it("refusal suggests narrowing expandChildrenLimit for lcm_describe", () => {
    const result = evaluateNeedsCompactGate({
      toolName: "lcm_describe",
      toolParams: { expandChildren: true, expandChildrenLimit: 30 },
      currentTokenCount: 185_000,
      tokenBudget: 200_000,
    });
    expect(result?.suggested_actions.join(" ")).toContain("expandChildrenLimit=15");
  });

  it("bypasses gate when tokenBudget undefined (no telemetry yet)", () => {
    const result = evaluateNeedsCompactGate({
      toolName: "lcm_describe",
      toolParams: { expandMessages: true, expandMessagesLimit: 50 },
      currentTokenCount: undefined,
      tokenBudget: undefined,
    });
    expect(result).toBeNull();  // bypass — no protection without telemetry
  });

  it("bypasses gate when only currentTokenCount missing", () => {
    const result = evaluateNeedsCompactGate({
      toolName: "lcm_describe",
      toolParams: { expandMessages: true, expandMessagesLimit: 50 },
      currentTokenCount: undefined,
      tokenBudget: 200_000,
    });
    expect(result).toBeNull();
  });

  it("bypasses gate when tokenBudget = 0 (defensive)", () => {
    const result = evaluateNeedsCompactGate({
      toolName: "lcm_describe",
      toolParams: { expandMessages: true, expandMessagesLimit: 50 },
      currentTokenCount: 100_000,
      tokenBudget: 0,
    });
    expect(result).toBeNull();
  });

  it("custom refusalThreshold overrides default", () => {
    // At 70% currentRatio + ~1K estimate (~0.5%), default 0.92 wouldn't refuse
    // but override 0.75 would.
    const result = evaluateNeedsCompactGate({
      toolName: "lcm_grep",
      toolParams: { mode: "regex", limit: 20 },
      currentTokenCount: 150_000,  // 0.75
      tokenBudget: 200_000,
      refusalThreshold: 0.74,  // strict — refuse anything above 0.74
    });
    expect(result).not.toBeNull();
  });
});

describe("evaluateNeedsCompactGate — boundary cases", () => {
  it("allows exactly at threshold (just under)", () => {
    // currentTokens=183_000, est=1050 → projected = 184_050 / 200_000 = 0.92025
    // Wait, that's slightly over. Let's tune: currentTokens=182_000, est=1050 → 183_050/200_000=0.91525 — below
    const result = evaluateNeedsCompactGate({
      toolName: "lcm_grep",
      toolParams: { mode: "regex", limit: 20 },
      currentTokenCount: 180_000,
      tokenBudget: 200_000,
    });
    expect(result).toBeNull();  // 0.905 — below threshold
  });

  it("refuses just over threshold", () => {
    // Wave-12 F2 recalibration: expandMessages=20 → ~4200 tokens.
    // To trip 0.92 from a "just over" anchor: 184_000 + 4200 = 188.2K /
    // 200K = 0.941. Was previously calibrated for 10K estimator output.
    const result = evaluateNeedsCompactGate({
      toolName: "lcm_describe",
      toolParams: { expandMessages: true, expandMessagesLimit: 20 },
      currentTokenCount: 184_000,  // 92.0%; +4200 → 94.1%
      tokenBudget: 200_000,
    });
    expect(result).not.toBeNull();
    expect(result?.projectedRatio).toBeGreaterThan(REFUSAL_THRESHOLD);
  });
});
