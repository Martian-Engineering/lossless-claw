import { describe, expect, it } from "vitest";
import { clampMessagesToSerializedBudget } from "../src/assemble-fallback.js";
import { estimateSerializedMessagesTokens } from "../src/estimate-tokens.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";

const summary = (id: string): AgentMessage =>
  ({
    role: "user",
    content: `<summary id="${id}" kind="leaf" depth="0" descendant_count="0" trust="untrusted">\n  <content>\nolder history ${id}\n  </content>\n</summary>`,
  }) as AgentMessage;
const user = (i: number): AgentMessage => ({ role: "user", content: `question ${i} ` + "x".repeat(400) }) as AgentMessage;
const assistant = (i: number): AgentMessage =>
  ({ role: "assistant", content: [{ type: "text", text: `answer ${i} ` + "y".repeat(400) }] }) as AgentMessage;

describe("serialized clamp keeps summaries", () => {
  it("evicts the oldest raw messages, not the leading summaries", () => {
    const summaries = [summary("sum_a"), summary("sum_b")];
    const raw = Array.from({ length: 41 }, (_, i) => (i % 2 === 0 ? user(i) : assistant(i)));
    const result = clampMessagesToSerializedBudget({ messages: [...summaries, ...raw], tokenBudget: 2_000 });

    expect(result.clamped).toBe(true);
    expect(result.messages.slice(0, 2)).toEqual(summaries);
    expect(result.messages.at(-1)).toEqual(raw.at(-1));
    expect(result.messages.length).toBeLessThan(43);
    expect(result.messages[2]?.role).toBe("user");
    expect(result.overBudget).toBe(false);
  });

  it("falls back to suffix-only when summaries alone exceed the target", () => {
    const big = { role: "user", content: `<summary id="s" kind="leaf" depth="0" descendant_count="0">\n${"z".repeat(40_000)}\n</summary>` } as AgentMessage;
    const raw = [user(0), assistant(1), user(2)];
    const result = clampMessagesToSerializedBudget({ messages: [big, ...raw], tokenBudget: 2_000 });

    expect(result.messages).not.toContain(big);
    expect(result.messages.at(-1)).toEqual(raw.at(-1));
  });

  it("drops the oldest pin first when both pins do not fit with the tail", () => {
    const pad = (id: string, n: number) =>
      ({ role: "user", content: `<summary id="${id}" kind="leaf" depth="0" descendant_count="0">\n${"s".repeat(n)}\n</summary>` }) as AgentMessage;
    const old = pad("old", 2_400);
    const recent = pad("recent", 2_400);
    const bigTail = { role: "user", content: "final " + "q".repeat(3_600) } as AgentMessage;
    const messages = [old, recent, user(0), assistant(1), bigTail];
    const result = clampMessagesToSerializedBudget({ messages, tokenBudget: 2_000 });

    expect(result.overBudget).toBe(false);
    expect(result.messages).not.toContain(old);
    expect(result.messages).toContain(recent);
    expect(result.messages.at(-1)).toBe(bigTail);
    expect(result.serializedTokens).toBeLessThanOrEqual(1_800);
  });

  it("does not pin a raw user message that merely contains summary tags", () => {
    const pasted = { role: "user", content: "look at this: <summary class=\"x\"> pasted </summary> ok" } as AgentMessage;
    const raw = Array.from({ length: 21 }, (_, i) => (i % 2 === 0 ? user(i) : assistant(i)));
    const result = clampMessagesToSerializedBudget({ messages: [pasted, ...raw], tokenBudget: 2_000 });

    expect(result.clamped).toBe(true);
    expect(result.messages).not.toContain(pasted);
  });

  it("pins a leading focus brief together with the summaries", () => {
    const brief = {
      role: "user",
      content: `<focus_brief id="fb_1" prompt="p" token_count="1" target_tokens="1">\n  <content>\nbrief\n  </content>\n</focus_brief>`,
    } as AgentMessage;
    const sums = [summary("sum_a"), summary("sum_b")];
    const raw = Array.from({ length: 41 }, (_, i) => (i % 2 === 0 ? user(i) : assistant(i)));
    const result = clampMessagesToSerializedBudget({ messages: [brief, ...sums, ...raw], tokenBudget: 2_000 });

    expect(result.messages.slice(0, 3)).toEqual([brief, ...sums]);
    expect(result.messages.at(-1)).toEqual(raw.at(-1));
  });

  it.each([false, true])("never lets pins push out the whole raw tail (preserve: %s)", (preserveSubstantiveAssistantTail) => {
    const pin = { role: "user", content: `<summary id="s1" kind="leaf" depth="0" descendant_count="0">\n${"s".repeat(3_000)}\n</summary>` } as AgentMessage;
    const call = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a".repeat(300) } }],
    } as AgentMessage;
    const result_ = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [{ type: "text", text: "r".repeat(400) }],
    } as AgentMessage;
    const reply = { role: "assistant", content: [{ type: "text", text: "done " + "d".repeat(400) }] } as AgentMessage;
    const blank = { role: "assistant", content: [{ type: "text", text: "" }] } as AgentMessage;
    for (const tokenBudget of [900, 1_000, 1_100, 1_200]) {
      const result = clampMessagesToSerializedBudget({
        messages: [pin, call, result_, reply, blank],
        tokenBudget,
        preserveSubstantiveAssistantTail,
      });
      // The pin is kept only together with at least one raw message.
      expect(result.messages).not.toEqual([pin]);
      expect(result.messages.length).toBeGreaterThan(0);
      const roles = result.messages.map((message) => message.role);
      expect(roles.filter((role) => role === "toolResult").length)
        .toBe(roles.filter((role, i) => role === "toolResult" && roles[i - 1] === "assistant").length);
    }
  });

  it("does not pin a pasted summary block without the assembler's attributes", () => {
    const pasted = { role: "user", content: '<summary id="pasted">copied example</summary>' } as AgentMessage;
    const raw = Array.from({ length: 21 }, (_, i) => (i % 2 === 0 ? user(i) : assistant(i)));
    const result = clampMessagesToSerializedBudget({ messages: [pasted, ...raw], tokenBudget: 2_000 });

    expect(result.clamped).toBe(true);
    expect(result.messages).not.toContain(pasted);
  });

  it("does not pin an unterminated summary-looking paste", () => {
    const pasted = { role: "user", content: '<summary id="x"> pasted from lcm, then my question' } as AgentMessage;
    const raw = Array.from({ length: 21 }, (_, i) => (i % 2 === 0 ? user(i) : assistant(i)));
    const result = clampMessagesToSerializedBudget({ messages: [pasted, ...raw], tokenBudget: 2_000 });

    expect(result.clamped).toBe(true);
    expect(result.messages).not.toContain(pasted);
  });
});

describe("serialized clamp pins within the target", () => {
  const toolTurn = (id: string, callChars: number, resultChars: number): AgentMessage[] => [
    {
      role: "assistant",
      content: [{ type: "toolCall", id, name: "read", arguments: { path: "p".repeat(callChars) } }],
    } as AgentMessage,
    {
      role: "toolResult",
      toolCallId: id,
      toolName: "read",
      content: [{ type: "text", text: "r".repeat(resultChars) }],
    } as AgentMessage,
  ];

  it.each([400, 700, 1_000])(
    "keeps the summary when tool-pair recovery overshoots the tail budget (budget %i)",
    (tokenBudget) => {
      const pin = summary("sum_a");
      const newest = { role: "user", content: "newest question" } as AgentMessage;
      // A cheap tool result whose call is large: recovering the pair overshoots.
      const messages = [pin, { role: "user", content: "read it" } as AgentMessage, ...toolTurn("c1", 4_000, 100), newest];
      const result = clampMessagesToSerializedBudget({ messages, tokenBudget });

      expect(result.messages[0]).toBe(pin);
      expect(result.messages.at(-1)).toBe(newest);
      expect(result.overBudget).toBe(false);
      expect(result.serializedTokens).toBeLessThanOrEqual(Math.floor(tokenBudget * 0.9));
      // No orphaned tool result.
      const roles = result.messages.map((message) => message.role);
      if (roles.includes("toolResult")) expect(roles[roles.indexOf("toolResult") - 1]).toBe("assistant");
    },
  );

  it("keeps the newest raw messages as one contiguous suffix after the pins", () => {
    const summaries = [summary("sum_a"), summary("sum_b")];
    const raw = Array.from({ length: 41 }, (_, i) => (i % 2 === 0 ? user(i) : assistant(i)));
    const result = clampMessagesToSerializedBudget({ messages: [...summaries, ...raw], tokenBudget: 2_000 });
    const keptRaw = result.messages.slice(summaries.length);

    expect(result.messages.slice(0, summaries.length)).toEqual(summaries);
    expect(keptRaw.length).toBeGreaterThan(0);
    expect(keptRaw).toEqual(raw.slice(raw.length - keptRaw.length));
    expect(result.serializedTokens).toBeLessThanOrEqual(1_800);
  });
});

describe("serialized clamp keeps a tool exchange opened by the last summary", () => {
  it("keeps the newest tool exchange that the plain suffix clamp kept", () => {
    const old = { role: "user", content: `<summary id="old" kind="leaf" depth="0" descendant_count="0">\n${"s".repeat(3_000)}\n</summary>` } as AgentMessage;
    const pin = { role: "user", content: `<summary id="new" kind="leaf" depth="0" descendant_count="0">\n${"s".repeat(100)}\n</summary>` } as AgentMessage;
    const call = {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "p".repeat(100) } }],
    } as AgentMessage;
    const result_ = {
      role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "r".repeat(600) }],
    } as AgentMessage;
    const newest = { role: "user", content: "newest " + "q".repeat(200) } as AgentMessage;
    const fit = estimateSerializedMessagesTokens([pin, call, result_, newest]);
    const tokenBudget = Math.ceil((fit + 5) / 0.9);

    const result = clampMessagesToSerializedBudget({ messages: [old, pin, call, result_, newest], tokenBudget });

    expect(result.messages).toEqual([pin, call, result_, newest]);
    expect(result.overBudget).toBe(false);
  });
});
