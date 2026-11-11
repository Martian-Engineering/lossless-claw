import { afterEach, describe, expect, it, vi } from "vitest";
import { matchVolatileLiveInputsToCoverageSlots, normalizeSummaryOverlapText, resolveExactAssembledLiveSortIndexes } from "../src/live-coverage.js";
import * as messageContent from "../src/message-content.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";

afterEach(() => vi.restoreAllMocks());

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

  it.each([false, true])("bounds parsing across volatile inputs and history (summaries: %s)", (summaries) => {
    const event = (text: string) => ({
      role: "user",
      content: `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n[Internal task completion event]\n${text}\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>`,
    }) as AgentMessage;
    const repeated = event("same completion");
    const history = Array.from({ length: 32 }, (_, index) => ({
      role: "user",
      content: summaries
        ? `<summary id="${index}">${repeated.content} ${index}</summary>`
        : `history ${index}: ${"context ".repeat(100)}`,
    })) as AgentMessage[];
    const assembledMessages = [...history, repeated, repeated];
    const live = [...Array.from({ length: 16 }, (_, index) => event(`new completion ${index}`)), repeated, repeated, repeated];
    const volatileLiveInputs = live.map((message, liveIndex) => ({
      message, liveIndex, liveText: normalizeSummaryOverlapText(String(message.content)),
    }));
    const parse = vi.spyOn(messageContent, "toStoredMessage");

    const matches = matchVolatileLiveInputsToCoverageSlots({ assembledMessages, volatileLiveInputs });

    // Two raw occurrences cover two events; a historical summary cannot cover
    // the third occurrence or any new event, even when it quotes the same text.
    expect([...matches.keys()].sort((a, b) => a - b)).toEqual([16, 17]);
    expect([...matches.values()].sort((a, b) => a - b)).toEqual([32, 33]);
    expect(parse.mock.calls.length).toBeLessThanOrEqual(4 * (assembledMessages.length + live.length));
  });
});
