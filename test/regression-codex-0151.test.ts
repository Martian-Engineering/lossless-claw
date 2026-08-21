import { describe, expect, it } from "vitest";
import {
  buildDegradedLiveAssembleResult,
  buildForkBoundedLiveFallback,
} from "../src/assemble-fallback.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";

const user = (content: string): AgentMessage => ({ role: "user", content }) as AgentMessage;

describe("Codex 0.15.1 regression contracts", () => {
  it("marks degraded live fallback as a thread bootstrap projection", () => {
    const result = buildDegradedLiveAssembleResult({
      liveMessages: [user("older"), user("newest")],
      tokenBudget: 100,
      contextProjection: {
        mode: "thread_bootstrap",
        epoch: "summary-prefix-v1:543:degraded",
      },
    });

    // The host must suppress per-turn re-projection when a resumed native
    // thread takes this fallback path.
    expect(result.contextProjection).toEqual({
      mode: "thread_bootstrap",
      epoch: "summary-prefix-v1:543:degraded",
    });
  });

  it("marks fork-bounded fallback as a thread bootstrap projection", () => {
    const result = buildForkBoundedLiveFallback({
      liveMessages: [user("parent"), user("child turn")],
      forkSourceMessageCount: 1,
      tokenBudget: 100,
      bootstrapMaxTokens: 100,
      contextProjection: {
        mode: "thread_bootstrap",
        epoch: "summary-prefix-v1:543:fork",
      },
    });

    expect(result.contextProjection).toEqual({
      mode: "thread_bootstrap",
      epoch: "summary-prefix-v1:543:fork",
    });
  });
});
