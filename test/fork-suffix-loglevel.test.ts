import { describe, expect, it } from "vitest";

import { forkBoundedLiveSuffixAppendLogLevel } from "../src/assemble-fallback.js";

describe("forkBoundedLiveSuffixAppendLogLevel", () => {
  it.each([
    {
      append: { evictedMessages: 0, overBudget: false },
      expectedLevel: "debug",
      label: "healthy append",
    },
    {
      append: { evictedMessages: 2, overBudget: false },
      expectedLevel: "warn",
      label: "evicted messages",
    },
    {
      append: { evictedMessages: 0, overBudget: true },
      expectedLevel: "warn",
      label: "over budget",
    },
    {
      append: { evictedMessages: 2, overBudget: true },
      expectedLevel: "warn",
      label: "evicted messages and over budget",
    },
  ])("logs $label at $expectedLevel", ({ append, expectedLevel }) => {
    expect(forkBoundedLiveSuffixAppendLogLevel(append)).toBe(expectedLevel);
  });
});
