import { describe, expect, it } from "vitest";
import { validateRegexSafety } from "../src/store/regex-safety.js";

describe("validateRegexSafety", () => {
  it("accepts simple regex patterns", () => {
    const result = validateRegexSafety("foo.*bar");
    expect(result.safe).toBe(true);
  });

  it("rejects nested quantifiers", () => {
    expect(validateRegexSafety("(a+)+").safe).toBe(false);
    expect(validateRegexSafety("(a*)*b").safe).toBe(false);
  });

  it("rejects oversized patterns", () => {
    const pattern = "a".repeat(501);
    const result = validateRegexSafety(pattern);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("maximum length");
  });

  it("rejects invalid patterns", () => {
    const result = validateRegexSafety("[invalid");
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("Invalid regular expression");
  });
});
