import { describe, it, expect } from "vitest";
import { estimateTokens } from "../src/estimate-tokens.js";

describe("estimateTokens", () => {
  it("estimates ASCII text at ~0.25 tokens/char", () => {
    expect(estimateTokens("Hello world")).toBe(3); // 11 chars × 0.25 = 2.75 → 3
  });

  it("estimates CJK Han at ~1.5 tokens/char", () => {
    expect(estimateTokens("你好世界")).toBe(6); // 4 chars × 1.5 = 6
  });

  it("estimates Hiragana at ~1.5 tokens/char", () => {
    expect(estimateTokens("こんにちは")).toBe(8); // 5 chars × 1.5 = 7.5 → 8
  });

  it("estimates Katakana at ~1.5 tokens/char", () => {
    expect(estimateTokens("カタカナ")).toBe(6); // 4 chars × 1.5 = 6
  });

  it("estimates Hangul at ~1.5 tokens/char", () => {
    expect(estimateTokens("안녕하세요")).toBe(8); // 5 chars × 1.5 = 7.5 → 8
  });

  it("estimates emoji at ~2 tokens/char", () => {
    expect(estimateTokens("🔥🎉💯")).toBe(6); // 3 emoji × 2 = 6
  });

  it("handles mixed CJK + ASCII + emoji", () => {
    const result = estimateTokens("Hello 你好 🔥");
    // 5 ASCII (1.25) + space (0.25) + 2 Han (3) + space (0.25) + emoji (2) = 6.75 → 7
    expect(result).toBe(7);
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("estimates CJK Extension B characters", () => {
    // 𠮷 (U+20BB7, CJK Extension B)
    expect(estimateTokens("𠮷")).toBe(2); // supplementary plane CJK → 1.5 → 2
  });

  it("estimates fullwidth forms at ~1.5 tokens/char", () => {
    expect(estimateTokens("ＡＢＣ")).toBe(5); // 3 fullwidth × 1.5 = 4.5 → 5
  });

  it("estimates CJK punctuation at ~1.5 tokens/char", () => {
    expect(estimateTokens("、。！")).toBe(5); // 3 chars × 1.5 = 4.5 → 5
  });
});
