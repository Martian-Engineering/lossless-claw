import { describe, expect, it } from "vitest";
import {
  compileSessionPattern,
  compileSessionPatterns,
  matchesSessionPattern,
} from "../src/session-patterns.js";

describe("session ignore patterns", () => {
  it("treats * as non-colon wildcard and ** as cross-segment wildcard", () => {
    const cronPattern = compileSessionPattern("agent:*:cron:*");
    const deepPattern = compileSessionPattern("agent:main:subagent:**");

    expect(cronPattern.test("agent:main:cron:nightly")).toBe(true);
    expect(cronPattern.test("agent:main:cron:nightly:extra")).toBe(false);
    expect(deepPattern.test("agent:main:subagent:child")).toBe(true);
    expect(deepPattern.test("agent:main:subagent:batch:child")).toBe(true);
  });

  it("matches session keys against any compiled ignore pattern", () => {
    const patterns = compileSessionPatterns([
      "agent:*:cron:*",
      "agent:ops:**",
    ]);

    expect(matchesSessionPattern("agent:main:cron:nightly", patterns)).toBe(true);
    expect(matchesSessionPattern("agent:ops:subagent:123", patterns)).toBe(true);
    expect(matchesSessionPattern("agent:main:chat:123", patterns)).toBe(false);
  });
});
