import { afterEach, describe, expect, it, vi } from "vitest";
import { appendUncoveredVolatileLiveInputsWithinBudget as append } from "../src/live-coverage.js";
import { clampMessagesToSerializedBudget } from "../src/assemble-fallback.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import * as accounting from "../src/token-accounting.js";
import * as repair from "../src/transcript-repair.js";

const user = (content: string) => ({ role: "user", content }) as AgentMessage;
const event = (text: string) => user(
  `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n[Internal task completion event]\n${text}\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>`,
);

/** Run the real append path with its serialized input estimate. */
function assemble(messages: AgentMessage[], live: AgentMessage[], budget: number, protectedIndexes?: Set<number>) {
  return append({
    assembledMessages: messages,
    assembledEstimatedTokens: accounting.estimateAgentMessageTokens(messages),
    liveMessages: live,
    tokenBudget: budget,
    protectedAssembledIndexes: protectedIndexes,
  });
}

afterEach(() => vi.restoreAllMocks());

describe("bounded volatile-input eviction", () => {
  it.each([64, 128, 256])("bounds complete projection work for %i historical messages", (count) => {
    const messages = Array.from({ length: count }, (_, index) => user(`${index}: ${"x".repeat(500)}`));
    const live = event("one new completion");
    const budget = Math.floor(accounting.estimateAgentMessageTokens(messages) / 2);
    const sanitizer = vi.spyOn(repair, "sanitizeToolUseResultPairing");
    const estimator = vi.spyOn(accounting, "estimateAgentMessageTokens");
    const before = JSON.stringify(messages);
    const result = assemble(messages, [live], budget);

    expect(result.overBudget).toBe(false);
    expect(result.messages.at(-1)).toEqual(live);
    expect(result.evictedMessages).toBeGreaterThan(count / 3);
    expect(JSON.stringify(messages)).toBe(before);
    expect(sanitizer.mock.calls.length).toBeLessThanOrEqual(3);
    expect(estimator.mock.calls.reduce((sum, [rows]) => sum + rows.length, 0)).toBeLessThan(5 * count);
  });

  it("evicts oldest eligible history, preserving exact duplicate occurrences and fresh tail", () => {
    const old = user("old ".repeat(300));
    const repeated = user("same live turn");
    const fresh = user("fresh protected turn");
    const live = event("new completion");
    const messages = [old, repeated, user("middle ".repeat(200)), repeated, fresh];
    const budget = accounting.estimateAgentMessageTokens([repeated, repeated, fresh, live]);
    const result = assemble(messages, [repeated, repeated, live], budget, new Set([4]));
    expect(result.messages).toEqual([repeated, repeated, fresh, live]);
    expect(result.evictedMessages).toBe(2);
    expect(result.overBudget).toBe(false);
  });

  it("evicts a historical tool exchange with its initiating user atomically", () => {
    const initiating = user("historical question");
    const call = { role: "assistant", content: [{ type: "toolCall", id: "call_old", name: "read", arguments: {} }] } as AgentMessage;
    const result = { role: "toolResult", toolCallId: "call_old", toolName: "read", content: "x".repeat(500) } as AgentMessage;
    const fresh = user("new question");
    const live = event("completion");
    const output = assemble([initiating, call, result, fresh], [live], accounting.estimateAgentMessageTokens([call, result, fresh, live]));
    expect(output.messages).toEqual([fresh, live]);
    expect(output.evictedMessages).toBe(3);
  });

  it("keeps the initiating user of a protected multi-tool exchange even above budget", () => {
    const initiating = user("protected tool question");
    const call = { role: "assistant", content: [
      { type: "toolCall", id: "a", name: "read", arguments: {} },
      { type: "toolCall", id: "b", name: "read", arguments: {} },
    ] } as AgentMessage;
    const results = ["a", "b"].map((id) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: "output" })) as AgentMessage[];
    const live = event("completion");
    const messages = [user("old history"), initiating, call, ...results];
    const output = assemble(messages, [live], 1, new Set([4]));
    expect(output.messages).toEqual([initiating, call, ...results, live]);
    expect(output.overBudget).toBe(true);
    const clamped = clampMessagesToSerializedBudget({ messages: output.messages, tokenBudget: 10_000 });
    expect(clamped.messages).toEqual(output.messages);
  });

  it("restores covered volatile occurrences once and in live order", () => {
    const covered = event("covered completion");
    const uncovered = event("new completion");
    const wrapper = user(`<summary id="old">${covered.content}</summary>`);
    const result = assemble([wrapper, user("ordinary history ".repeat(300))], [covered, covered, uncovered], 1);
    expect(result.messages).toEqual([covered, covered, uncovered]);
    expect(result.appendedMessages).toBe(3);
    expect(result.overBudget).toBe(true);
  });

  it("protects overlapping exchanges owned by one initiating user", () => {
    const initiating = user("one question, two exchanges");
    const exchange = (id: string) => [
      { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: {} }] },
      { role: "toolResult", toolCallId: id, toolName: "read", content: "result" },
    ] as AgentMessage[];
    const first = exchange("first");
    const second = exchange("second");
    const live = event("completion");
    const messages = [user("evictable"), initiating, ...first, ...second];
    const output = assemble(messages, [second[0]!, live], 1);
    expect(output.messages).toEqual([initiating, ...first, ...second, live]);
    expect(output.overBudget).toBe(true);
  });

  it("uses a bounded protected-only fallback when normalization changes token deltas", () => {
    const call = (argumentsValue: string) => ({ role: "assistant", content: [
      { type: "toolCall", id: "duplicate", name: "read", arguments: { value: argumentsValue } },
    ] }) as AgentMessage;
    const messages = [
      user("old tool question"), call("small"), call("x".repeat(10_000)),
      { role: "toolResult", toolCallId: "duplicate", toolName: "read", content: "result" } as AgentMessage,
      user("remaining history ".repeat(100)), user("protected fresh tail"),
    ];
    const live = event("completion");
    const sanitizer = vi.spyOn(repair, "sanitizeToolUseResultPairing");
    const before = JSON.stringify(messages);
    const output = assemble(messages, [live], 100, new Set([5]));
    expect(sanitizer).toHaveBeenCalledTimes(3);
    expect(output.messages).toEqual([messages[5], live]);
    expect(output.overBudget).toBe(false);
    expect(JSON.stringify(messages)).toBe(before);
  });
});
