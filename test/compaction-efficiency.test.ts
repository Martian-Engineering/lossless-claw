import { describe, it, expect } from "vitest";
import { estimateModelCost, estimateSavings, formatCurrency } from "../src/plugin/pricing.js";

describe("estimateModelCost", () => {
  it("matches known model by exact prefix", () => {
    const result = estimateModelCost("claude-haiku-4-5", 20_000, 2_400);
    expect(result.matched).toBe(true);
    expect(result.inputCost).toBeCloseTo(0.02, 4);
    expect(result.outputCost).toBeCloseTo(0.012, 4);
    expect(result.totalCost).toBeCloseTo(0.032, 4);
  });

  it("matches dated model variant via prefix", () => {
    const result = estimateModelCost("claude-opus-4-6-20260301", 20_000, 2_400);
    expect(result.matched).toBe(true);
    expect(result.inputCost).toBeCloseTo(0.10, 4);
  });

  it("matches gpt-4o-mini", () => {
    const result = estimateModelCost("gpt-4o-mini", 20_000, 2_400);
    expect(result.matched).toBe(true);
    expect(result.inputCost).toBeCloseTo(0.003, 4);
  });

  it("returns matched=false for unknown models with Sonnet-class default", () => {
    const result = estimateModelCost("my-custom-model-v3", 20_000, 2_400);
    expect(result.matched).toBe(false);
    expect(result.inputCost).toBeCloseTo(0.06, 4);
  });

  it("handles undefined model", () => {
    const result = estimateModelCost(undefined, 20_000, 2_400);
    expect(result.matched).toBe(false);
  });

  it("handles zero tokens", () => {
    const result = estimateModelCost("claude-haiku-4-5", 0, 0);
    expect(result.totalCost).toBe(0);
  });
});

describe("estimateSavings", () => {
  it("estimates savings with default parameters", () => {
    const savings = estimateSavings(48_200);
    expect(savings).toBeCloseTo(0.723, 2);
  });

  it("uses custom main model price", () => {
    const savings = estimateSavings(48_200, 5.00);
    expect(savings).toBeCloseTo(1.205, 2);
  });

  it("returns 0 for zero tokens saved", () => {
    expect(estimateSavings(0)).toBe(0);
  });
});

describe("formatCurrency", () => {
  it("formats positive amounts", () => {
    expect(formatCurrency(1.07)).toBe("$1.07");
  });

  it("formats small amounts", () => {
    expect(formatCurrency(0.032)).toBe("$0.03");
  });

  it("formats zero as $0.00", () => {
    expect(formatCurrency(0)).toBe("$0.00");
  });

  it("formats near-zero as $0.00", () => {
    expect(formatCurrency(0.001)).toBe("$0.00");
  });
});

describe("efficiency scoring", () => {
  it("positive efficiency: haiku compaction saving money", () => {
    const compactionCost = estimateModelCost("claude-haiku-4-5", 20_000 * 12, 2_400 * 12).totalCost;
    const savings = estimateSavings(48_200);
    const net = savings - compactionCost;
    expect(net).toBeGreaterThan(0);
    expect(compactionCost).toBeCloseTo(0.384, 2);
    expect(savings).toBeCloseTo(0.723, 2);
  });

  it("negative efficiency: opus compaction losing money", () => {
    const compactionCost = estimateModelCost("claude-opus-4-6", 20_000 * 28, 2_400 * 28).totalCost;
    const savings = estimateSavings(8_400);
    const net = savings - compactionCost;
    expect(net).toBeLessThan(0);
    expect(compactionCost).toBeGreaterThan(4);
    expect(savings).toBeLessThan(0.5);
  });
});
