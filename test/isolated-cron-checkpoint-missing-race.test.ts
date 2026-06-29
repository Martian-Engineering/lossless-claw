/**
 * Regression tests: fix/isolated-cron-sessionid-guard-race
 *
 * When multiple isolated cron runs fire simultaneously, they share the same
 * durable sessionKey (agent:<agentId>:cron:<jobId>). The checkpoint-missing
 * recovery path in transcript-reconciler.ts had a guard
 * `conversation.sessionId === params.sessionId` that could silently fail for
 * runner-up cron invocations whose sessionId had been overwritten.
 *
 * The fix relaxes the guard for isolated cron sessions: the durable
 * sessionKey serves as an alternate conversation binding identity.
 */
import { describe, expect, it } from "vitest";
import { isIsolatedCronSessionKey } from "../src/tools/lcm-conversation-scope.js";

describe("isIsolatedCronSessionKey export and behavior", () => {
  it("returns true for well-formed isolated cron session keys", () => {
    expect(isIsolatedCronSessionKey("agent:main:cron:nightly-summary")).toBe(true);
    expect(isIsolatedCronSessionKey("agent:test:cron:myjob")).toBe(true);
    expect(isIsolatedCronSessionKey("agent:chatbot:cron:daily-report")).toBe(true);
    expect(isIsolatedCronSessionKey("  agent:main:cron:nightly  ")).toBe(true); // trimmed
  });

  it("returns false for non-cron session keys", () => {
    expect(isIsolatedCronSessionKey(undefined)).toBe(false);
    expect(isIsolatedCronSessionKey("")).toBe(false);
    expect(isIsolatedCronSessionKey("   ")).toBe(false);
    expect(isIsolatedCronSessionKey("agent:main:default")).toBe(false);
    expect(isIsolatedCronSessionKey("agent:chatbot:session-id-123")).toBe(false);
    expect(isIsolatedCronSessionKey("cron:main:agent:nightly")).toBe(false); // wrong order
    expect(isIsolatedCronSessionKey("agent:cron:nightly")).toBe(false); // too few parts
  });
});
