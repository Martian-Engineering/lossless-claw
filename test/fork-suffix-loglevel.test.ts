import { describe, expect, it } from "vitest";

import { forkBoundedLiveSuffixAppendLogLevel } from "../src/assemble-fallback.js";

describe("forkBoundedLiveSuffixAppendLogLevel", () => {
  it("logs the healthy append at debug", () => {
    expect(forkBoundedLiveSuffixAppendLogLevel({ evictedMessages: 0, overBudget: false })).toBe(
      "debug",
    );
  });

  it("keeps warn when messages were evicted", () => {
    expect(forkBoundedLiveSuffixAppendLogLevel({ evictedMessages: 2, overBudget: false })).toBe(
      "warn",
    );
  });

  it("keeps warn when the append ran over budget", () => {
    expect(forkBoundedLiveSuffixAppendLogLevel({ evictedMessages: 0, overBudget: true })).toBe(
      "warn",
    );
  });
});
