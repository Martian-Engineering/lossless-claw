/**
 * Token-state cache + tool self-update tests.
 *
 * Pins the contract: llm_output anchors current tokens; tool self-updates
 * accumulate within an iteration; next llm_output snaps back to ground
 * truth; cache tolerates missing data gracefully.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  recordLlmOutput,
  accumulateToolResultTokens,
  getRuntimeContext,
  inferTokenBudget,
  __resetTokenStateForTesting,
} from "../src/plugin/token-state.js";

beforeEach(() => {
  __resetTokenStateForTesting();
});

afterEach(() => {
  __resetTokenStateForTesting();
});

describe("token-state — llm_output anchoring", () => {
  it("records current tokens from llm_output usage payload", () => {
    recordLlmOutput({
      sessionKey: "agent:main:main",
      usage: { input: 100_000, output: 5_000, cacheRead: 30_000, cacheWrite: 0 },
      tokenBudget: 200_000,
    });
    const ctx = getRuntimeContext("agent:main:main");
    // Match LCM's input + cacheRead + cacheWrite (output is response, not context)
    expect(ctx.currentTokenCount).toBe(130_000);
    expect(ctx.tokenBudget).toBe(200_000);
    expect(ctx.lastUpdateSource).toBe("llm_output");
  });

  it("returns empty object when session has no anchor yet", () => {
    const ctx = getRuntimeContext("never-seen-key");
    expect(ctx.currentTokenCount).toBeUndefined();
    expect(ctx.tokenBudget).toBeUndefined();
  });

  it("returns empty for undefined sessionKey (defensive)", () => {
    const ctx = getRuntimeContext(undefined);
    expect(ctx).toEqual({});
  });

  it("treats missing usage fields as 0", () => {
    recordLlmOutput({
      sessionKey: "k1",
      usage: { input: 50_000 },  // no cacheRead, no cacheWrite
      tokenBudget: 200_000,
    });
    expect(getRuntimeContext("k1").currentTokenCount).toBe(50_000);
  });

  it("ignores empty sessionKey (no-op)", () => {
    recordLlmOutput({ sessionKey: "", usage: { input: 100 }, tokenBudget: 200 });
    expect(getRuntimeContext("").currentTokenCount).toBeUndefined();
  });
});

describe("token-state — per-tool additive update (parallel-tool-call protection)", () => {
  it("accumulates tool result tokens onto the anchor", () => {
    recordLlmOutput({
      sessionKey: "k1",
      usage: { input: 100_000 },
      tokenBudget: 200_000,
    });
    accumulateToolResultTokens("k1", "x".repeat(8_000));  // ~2000 tokens
    const ctx = getRuntimeContext("k1");
    expect(ctx.currentTokenCount).toBeGreaterThanOrEqual(101_900);
    expect(ctx.currentTokenCount).toBeLessThanOrEqual(102_100);
    expect(ctx.lastUpdateSource).toBe("tool-self-report");
  });

  it("multiple tool updates accumulate (5 sequential tools in one iteration)", () => {
    recordLlmOutput({
      sessionKey: "k1",
      usage: { input: 100_000 },
      tokenBudget: 200_000,
    });
    // Simulate 5 tools each returning ~4K chars (~1K tokens)
    for (let i = 0; i < 5; i++) {
      accumulateToolResultTokens("k1", "x".repeat(4_000));
    }
    const ctx = getRuntimeContext("k1");
    // 100K + 5*1K = 105K
    expect(ctx.currentTokenCount).toBeGreaterThanOrEqual(104_900);
    expect(ctx.currentTokenCount).toBeLessThanOrEqual(105_100);
  });

  it("next llm_output snaps cache back to ground truth (drift reset)", () => {
    recordLlmOutput({
      sessionKey: "k1",
      usage: { input: 100_000 },
      tokenBudget: 200_000,
    });
    accumulateToolResultTokens("k1", "x".repeat(4_000));  // estimate +1K
    accumulateToolResultTokens("k1", "x".repeat(4_000));  // estimate +1K
    expect(getRuntimeContext("k1").currentTokenCount).toBeCloseTo(102_000, -2);

    // Simulate next iteration — llm_output fires with ACTUAL accumulated tokens
    recordLlmOutput({
      sessionKey: "k1",
      usage: { input: 102_500 },  // real number from API
      tokenBudget: 200_000,
    });
    expect(getRuntimeContext("k1").currentTokenCount).toBe(102_500);
    expect(getRuntimeContext("k1").lastUpdateSource).toBe("llm_output");
  });

  it("accumulate is no-op when no anchor exists yet", () => {
    accumulateToolResultTokens("never-anchored", "x".repeat(1_000));
    expect(getRuntimeContext("never-anchored").currentTokenCount).toBeUndefined();
  });

  it("accumulate ignores empty result text", () => {
    recordLlmOutput({ sessionKey: "k1", usage: { input: 1000 } });
    accumulateToolResultTokens("k1", "");
    expect(getRuntimeContext("k1").currentTokenCount).toBe(1000);
  });
});

describe("token-state — sessions are isolated", () => {
  it("different sessionKeys do not share state", () => {
    recordLlmOutput({ sessionKey: "session-A", usage: { input: 50_000 }, tokenBudget: 200_000 });
    recordLlmOutput({ sessionKey: "session-B", usage: { input: 80_000 }, tokenBudget: 200_000 });
    accumulateToolResultTokens("session-A", "x".repeat(4_000));
    expect(getRuntimeContext("session-A").currentTokenCount).toBeCloseTo(51_000, -2);
    expect(getRuntimeContext("session-B").currentTokenCount).toBe(80_000);  // untouched
  });
});

describe("token-state — inferTokenBudget", () => {
  it("infers 1M for opus-4-7", () => {
    expect(inferTokenBudget("anthropic", "claude-opus-4-7")).toBe(1_000_000);
  });
  it("infers 1M for gpt-5.4-mini", () => {
    expect(inferTokenBudget("openai-codex", "gpt-5.4-mini")).toBe(1_000_000);
  });
  it("infers 200K for sonnet-4-5", () => {
    expect(inferTokenBudget("anthropic", "claude-sonnet-4-5")).toBe(200_000);
  });
  it("returns undefined for unknown providers", () => {
    expect(inferTokenBudget("unknown-provider", "unknown-model")).toBeUndefined();
  });
  it("handles missing provider/model gracefully", () => {
    expect(inferTokenBudget(undefined, undefined)).toBeUndefined();
  });
});
