import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("v4.1 leaf-summarizer cap fix (A.10)", () => {
  it("DEFAULT_LEAF_TARGET_TOKENS is 4000 in src/summarize.ts (was 2400; raised per v4.1)", () => {
    const src = readFileSync("src/summarize.ts", "utf-8");
    // The constant declaration line should set 4000
    const match = src.match(/const DEFAULT_LEAF_TARGET_TOKENS = (\d+);/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("4000");
  });

  it("config.ts default is 4000 (was 2400; raised per v4.1)", () => {
    const src = readFileSync("src/db/config.ts", "utf-8");
    // The fallback default for pc.leafTargetTokens
    const match = src.match(/toNumber\(pc\.leafTargetTokens\) \?\? (\d+),/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("4000");
  });

  it("v4.1 doc rationale present in source comment (so future readers see why)", () => {
    const src = readFileSync("src/summarize.ts", "utf-8");
    expect(src).toContain("v4.1 (A.10)");
    expect(src).toContain("2,415");
  });
});
