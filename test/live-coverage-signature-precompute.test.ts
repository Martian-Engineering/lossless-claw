import { describe, expect, it } from "vitest";
import { resolveExactAssembledLiveSortIndexes } from "../src/live-coverage.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";

describe("precomputed live-coverage signatures", () => {
  it("matches duplicate occurrences newest-first without reusing assembled slots", () => {
    const repeated = { role: "user", content: "repeated turn" } as AgentMessage;
    const assembledMessages = [
      repeated,
      repeated,
      { role: "assistant", content: "tail" },
    ] as AgentMessage[];
    const liveMessages = [repeated, repeated] as AgentMessage[];

    const matches = resolveExactAssembledLiveSortIndexes({ assembledMessages, liveMessages });

    expect([...matches.entries()]).toEqual([
      [1, 1],
      [0, 0],
    ]);
  });
});
