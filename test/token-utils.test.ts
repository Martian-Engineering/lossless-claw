import { describe, it, expect, vi } from "vitest";
import { calculateTokens, estimateTokens } from "../src/token-utils.js";
import type { TokenizerService } from "../src/types.js";

describe("calculateTokens", () => {
  it("uses chars/4 when useTokenizer is false", () => {
    const result = calculateTokens("hello", false);
    expect(result).toBe(2); // "hello" = 5 chars, Math.ceil(5/4) = 2
  });

  it("uses tokenizer when enabled and available", () => {
    const mockTokenizer: TokenizerService = {
      isEnabled: () => true,
      countTokens: vi.fn().mockReturnValue(7),
    };
    const result = calculateTokens("hello world", true, mockTokenizer);
    expect(result).toBe(7);
    expect(mockTokenizer.countTokens).toHaveBeenCalledWith("hello world");
  });

  it("falls back to chars/4 when tokenizer fails", () => {
    const mockTokenizer: TokenizerService = {
      isEnabled: () => true,
      countTokens: vi.fn().mockImplementation(() => {
        throw new Error("tokenizer error");
      }),
    };
    const result = calculateTokens("hello", true, mockTokenizer);
    expect(result).toBe(2); // fallback to chars/4
  });

  it("uses chars/4 when tokenizer is disabled", () => {
    const mockTokenizer: TokenizerService = {
      isEnabled: () => false,
      countTokens: vi.fn(),
    };
    const result = calculateTokens("hello", true, mockTokenizer);
    expect(result).toBe(2);
    expect(mockTokenizer.countTokens).not.toHaveBeenCalled();
  });

  it("uses chars/4 when tokenizer is undefined", () => {
    const result = calculateTokens("hello", true, undefined);
    expect(result).toBe(2);
  });
});

describe("estimateTokens", () => {
  it("calculates tokens using chars/4 heuristic", () => {
    expect(estimateTokens("hello")).toBe(2); // 5 chars / 4 = 1.25 -> ceil = 2
    expect(estimateTokens("hello world")).toBe(3); // 11 chars / 4 = 2.75 -> ceil = 3
    expect(estimateTokens("")).toBe(0); // 0 chars
    expect(estimateTokens("a")).toBe(1); // 1 char / 4 = 0.25 -> ceil = 1
  });
});
