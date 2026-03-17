import { describe, it, expect } from "vitest";
import {
  LCM_SUMMARIZER_SYSTEM_PROMPT,
  buildLeafSummaryPrompt,
  buildCondensedSummaryPrompt,
  resolveTargetTokens,
} from "../../src/summarize.js";

describe("summarize exports", () => {
  it("exports system prompt string", () => {
    expect(typeof LCM_SUMMARIZER_SYSTEM_PROMPT).toBe("string");
    expect(LCM_SUMMARIZER_SYSTEM_PROMPT.length).toBeGreaterThan(10);
  });
  it("buildLeafSummaryPrompt returns non-empty string", () => {
    const p = buildLeafSummaryPrompt({ text: "Hello world", mode: "normal", targetTokens: 200 });
    expect(typeof p).toBe("string");
    expect(p.length).toBeGreaterThan(0);
  });
  it("buildCondensedSummaryPrompt returns non-empty string", () => {
    const p = buildCondensedSummaryPrompt({ text: "Summaries", targetTokens: 200, depth: 2 });
    expect(typeof p).toBe("string");
  });
  it("resolveTargetTokens returns number", () => {
    expect(typeof resolveTargetTokens({ inputTokens: 1000, mode: "normal", isCondensed: false, condensedTargetTokens: 2000 })).toBe("number");
  });
});
