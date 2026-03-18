import { describe, expect, it } from "vitest";
import {
  compileSessionPattern,
  compileSessionPatterns,
  matchesSessionPattern,
} from "../src/session-patterns.js";

describe("session ignore patterns", () => {
  it("treats * as non-colon wildcard and ** as cross-segment wildcard", () => {
    const baseCronPattern = compileSessionPattern("agent:*:cron:*");
    const cronRunPattern = compileSessionPattern("agent:*:cron:**");
    const deepPattern = compileSessionPattern("agent:main:subagent:**");

    expect(baseCronPattern.test("agent:main:cron:nightly")).toBe(true);
    expect(baseCronPattern.test("agent:main:cron:nightly:run:run-123")).toBe(false);
    expect(cronRunPattern.test("agent:main:cron:nightly:run:run-123")).toBe(true);
    expect(deepPattern.test("agent:main:subagent:child")).toBe(true);
    expect(deepPattern.test("agent:main:subagent:batch:child")).toBe(true);
  });

  it("matches session keys against any compiled ignore pattern", () => {
    const patterns = compileSessionPatterns([
      "agent:*:cron:**",
      "agent:ops:**",
    ]);

    expect(matchesSessionPattern("agent:main:cron:nightly:run:run-123", patterns)).toBe(true);
    expect(matchesSessionPattern("agent:ops:subagent:123", patterns)).toBe(true);
    expect(matchesSessionPattern("agent:main:main", patterns)).toBe(false);
  });
});
