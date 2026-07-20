import { describe, expect, it, vi } from "vitest";

import {
  SessionRolloverDetector,
  type AmbiguousSessionKeyRuntimeRollover,
} from "../src/session-rollover.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import type { ConversationStore } from "../src/store/conversation-store.js";
import type { SummaryStore } from "../src/store/summary-store.js";

function makeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

const ROLLOVER: AmbiguousSessionKeyRuntimeRollover = {
  conversationId: 1,
  activeSessionId: "old-session",
  sessionKey: "agent:main:main",
  trackedSessionFile: "/tmp/old-transcript.jsonl",
  hasDeliberateRolloverEvidence: false,
};

const NEW_SESSION_ID = "new-session";

function freshCandidates(): AgentMessage[] {
  const base = Date.now() + 60_000;
  return [
    { role: "user", content: "real question after the roll", timestamp: base },
    { role: "assistant", content: "real answer after the roll", timestamp: base + 1 },
  ] as unknown as AgentMessage[];
}

function makeDetector(
  conversationStoreOverrides: Record<string, unknown> = {},
): { detector: SessionRolloverDetector; log: ReturnType<typeof makeLog> } {
  const log = makeLog();
  const conversationStore = {
    getLastMessage: async () => null,
    getLastMessages: async () => [],
    rebindConversationSession: async () => ({ sessionId: NEW_SESSION_ID, active: true }),
    ...conversationStoreOverrides,
  } as unknown as ConversationStore;
  const detector = new SessionRolloverDetector(
    conversationStore,
    {} as unknown as SummaryStore,
    { log },
    async () => {},
  );
  return { detector, log };
}

describe("ambiguous-rollover rebind happy-path log levels", () => {
  it("logs the successful fresh-transcript rebind at info, not warn", async () => {
    const { detector, log } = makeDetector({
      getLastMessage: async () => null,
      rebindConversationSession: async () => ({ sessionId: NEW_SESSION_ID, active: true }),
    });

    const rebound = await detector.rotateAmbiguousRolloverForProvablyFreshTranscript({
      phase: "bootstrap",
      sessionId: NEW_SESSION_ID,
      rollover: ROLLOVER,
      candidateMessages: freshCandidates(),
      createReplacement: false,
    });

    expect(rebound).toEqual({ rebound: true });
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("resolved by fresh-transcript rebind"),
    );
  });

  it("marks a transient (unjudgeable) freshness failure as an expected preserve", async () => {
    // The new transcript has no usable timestamps yet (the live conv-56 /new
    // shape): freshness cannot be judged, so the preserve is a pending state the
    // next turn re-evaluates. preserveExpected lets the caller demote its log.
    const { detector, log } = makeDetector({ getLastMessage: async () => null });

    const rebound = await detector.rotateAmbiguousRolloverForProvablyFreshTranscript({
      phase: "bootstrap",
      sessionId: NEW_SESSION_ID,
      rollover: ROLLOVER,
      candidateMessages: [
        { role: "user", content: "first turn after the roll, no usable timestamp" },
      ] as unknown as AgentMessage[],
      createReplacement: false,
    });

    expect(rebound).toEqual({ rebound: false, preserveExpected: true, alreadyWarned: false });
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("freshness=candidate-missing-timestamp"),
    );
  });

  it("logs the conflicting not-provably-fresh preserve decision at warn", async () => {
    const { detector, log } = makeDetector({
      // Persisted history is newer than the candidate entries: the rollover is
      // a genuine conflict, so preserve/freeze is correct and actionable.
      getLastMessage: async () => ({ createdAt: new Date(Date.now() + 10 * 60_000) }),
    });

    const rebound = await detector.rotateAmbiguousRolloverForProvablyFreshTranscript({
      phase: "bootstrap",
      sessionId: NEW_SESSION_ID,
      rollover: ROLLOVER,
      candidateMessages: freshCandidates(),
      createReplacement: false,
    });

    expect(rebound).toEqual({ rebound: false, preserveExpected: false, alreadyWarned: false });
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("not provably fresh"));
  });

  it("logs the assemble-phase per-phase preserve restatement at debug, not warn", () => {
    const { detector, log } = makeDetector({});

    detector.logAmbiguousSessionKeyRuntimeRollover({
      phase: "assemble",
      rollover: ROLLOVER,
      sessionId: NEW_SESSION_ID,
      expected: true,
    });

    expect(log.warn).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining("ambiguous session-key runtime rollover; preserving"),
    );
  });
});

describe("ambiguous-rollover rebind anomaly log levels stay at warn", () => {
  it("keeps the rebind-failed anomaly at warn", async () => {
    const { detector, log } = makeDetector({
      getLastMessage: async () => null,
      rebindConversationSession: async () => null,
    });

    const rebound = await detector.rotateAmbiguousRolloverForProvablyFreshTranscript({
      phase: "bootstrap",
      sessionId: NEW_SESSION_ID,
      rollover: ROLLOVER,
      candidateMessages: freshCandidates(),
      createReplacement: false,
    });

    expect(rebound).toEqual({ rebound: false, preserveExpected: false, alreadyWarned: false });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("rebind failed"));
  });

  it("keeps the freshness-check exception at warn", async () => {
    const { detector, log } = makeDetector({
      getLastMessage: async () => {
        throw new Error("store offline");
      },
    });

    const rebound = await detector.rotateAmbiguousRolloverForProvablyFreshTranscript({
      phase: "bootstrap",
      sessionId: NEW_SESSION_ID,
      rollover: ROLLOVER,
      candidateMessages: freshCandidates(),
      createReplacement: false,
    });

    expect(rebound).toEqual({ rebound: false, preserveExpected: false, alreadyWarned: false });
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("ambiguous rollover freshness check failed"),
    );
  });

  it("keeps the genuine freeze preserve (bootstrap/afterTurn, not deferred) at warn", () => {
    const { detector, log } = makeDetector({});

    detector.logAmbiguousSessionKeyRuntimeRollover({
      phase: "bootstrap",
      rollover: ROLLOVER,
      sessionId: NEW_SESSION_ID,
    });

    expect(log.debug).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("ambiguous session-key runtime rollover; preserving"),
    );
  });
});
