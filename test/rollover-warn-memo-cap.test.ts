import { describe, expect, it, vi } from "vitest";

import {
  SessionRolloverDetector,
  type AmbiguousSessionKeyRuntimeRollover,
} from "../src/session-rollover.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import type { ConversationStore } from "../src/store/conversation-store.js";
import type { SummaryStore } from "../src/store/summary-store.js";

// warnedAmbiguousRolloverGenerations is bounded at
// WARNED_AMBIGUOUS_ROLLOVER_GENERATIONS_CAP (500, session-rollover.ts) with
// FIFO eviction so a long-lived host process accumulating many distinct
// frozen rollover generations doesn't grow the memo map indefinitely.
const CAP = 500;

function makeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function baseRollover(sessionKey: string): AmbiguousSessionKeyRuntimeRollover {
  return {
    conversationId: 1,
    activeSessionId: "old-session",
    sessionKey,
    trackedSessionFile: "/tmp/old-transcript.jsonl",
    hasDeliberateRolloverEvidence: false,
  };
}

// A future candidate that predates the persisted "last message" is a genuine
// (non-transient) freshness conflict, so it reaches the once-only WARN +
// memo-write branch without needing to stub getLastMessages/identity overlap.
function conflictingCandidates(): AgentMessage[] {
  return [
    { role: "user", content: "post-roll turn", timestamp: Date.now() },
  ] as unknown as AgentMessage[];
}

function makeDetector(): { detector: SessionRolloverDetector; log: ReturnType<typeof makeLog> } {
  const log = makeLog();
  const conversationStore = {
    getLastMessage: async () => ({ createdAt: new Date(Date.now() + 10 * 60_000) }),
    getLastMessages: async () => [],
    rebindConversationSession: async () => ({ sessionId: "new-session", active: true }),
  } as unknown as ConversationStore;
  const detector = new SessionRolloverDetector(
    conversationStore,
    {} as unknown as SummaryStore,
    { log },
    async () => {},
  );
  return { detector, log };
}

describe("ambiguous-rollover once-only WARN memo cap", () => {
  it("evicts the oldest generation once the cap is exceeded (FIFO), so re-freezing it warns again", async () => {
    const { detector, log } = makeDetector();

    // Fill the memo past its cap with distinct generations (unique sessionId
    // per call keeps each one a new Map key).
    for (let index = 0; index < CAP + 1; index += 1) {
      await detector.rotateAmbiguousRolloverForProvablyFreshTranscript({
        phase: "bootstrap",
        sessionId: `filler-session-${index}`,
        rollover: baseRollover("agent:cap-test:main"),
        candidateMessages: conflictingCandidates(),
        createReplacement: false,
      });
    }
    expect(log.warn).toHaveBeenCalledTimes(CAP + 1);

    // The very first generation (index 0) should have been evicted by FIFO:
    // re-triggering it must warn again instead of being deduped.
    await detector.rotateAmbiguousRolloverForProvablyFreshTranscript({
      phase: "bootstrap",
      sessionId: "filler-session-0",
      rollover: baseRollover("agent:cap-test:main"),
      candidateMessages: conflictingCandidates(),
      createReplacement: false,
    });
    expect(log.warn).toHaveBeenCalledTimes(CAP + 2);
  });

  it("evicts a generation that sits untouched while other generations churn past the cap", async () => {
    const { detector, log } = makeDetector();

    const rollover = baseRollover("agent:cap-test-retained:main");
    // The very first call for this generation warns once.
    await detector.rotateAmbiguousRolloverForProvablyFreshTranscript({
      phase: "bootstrap",
      sessionId: "retained-session",
      rollover,
      candidateMessages: conflictingCandidates(),
      createReplacement: false,
    });
    expect(log.warn).toHaveBeenCalledTimes(1);

    // Fill the memo with enough distinct OTHER generations to exceed the cap
    // several times over, without ever re-touching "retained-session".
    for (let index = 0; index < CAP * 2; index += 1) {
      await detector.rotateAmbiguousRolloverForProvablyFreshTranscript({
        phase: "bootstrap",
        sessionId: `other-session-${index}`,
        rollover,
        candidateMessages: conflictingCandidates(),
        createReplacement: false,
      });
    }

    // The retained generation was evicted long ago (FIFO, cap-bounded), so
    // re-triggering it now warns again rather than staying deduped forever.
    await detector.rotateAmbiguousRolloverForProvablyFreshTranscript({
      phase: "bootstrap",
      sessionId: "retained-session",
      rollover,
      candidateMessages: conflictingCandidates(),
      createReplacement: false,
    });
    expect(log.warn).toHaveBeenCalledTimes(CAP * 2 + 2);
  });
});
