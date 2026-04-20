import { describe, expect, it } from "vitest";
import {
  sanitizeToolUseResultPairing,
  stripTrailingEmptyAssistantPrefill,
} from "../src/transcript-repair.js";

describe("sanitizeToolUseResultPairing", () => {
  it("moves OpenAI reasoning blocks before function_call blocks", () => {
    const repaired = sanitizeToolUseResultPairing([
      {
        role: "assistant",
        content: [
          { type: "function_call", call_id: "fc_1", name: "bash", arguments: '{"cmd":"pwd"}' },
          { type: "reasoning", text: "Need tool output first." },
        ],
      },
    ]);

    const assistant = repaired[0] as { content?: Array<{ type?: string }> };
    expect(assistant.content?.map((block) => block.type)).toEqual(["reasoning", "function_call"]);
  });

  it("preserves interleaved reasoning when an assistant turn has multiple function calls", () => {
    const repaired = sanitizeToolUseResultPairing([
      {
        role: "assistant",
        content: [
          { type: "function_call", call_id: "fc_1", name: "bash", arguments: '{"cmd":"pwd"}' },
          { type: "reasoning", text: "Reasoning for the second call." },
          { type: "function_call", call_id: "fc_2", name: "bash", arguments: '{"cmd":"ls"}' },
        ],
      },
    ]);

    const assistant = repaired[0] as {
      content?: Array<{ type?: string; call_id?: string; text?: string }>;
    };
    expect(assistant.content).toEqual([
      { type: "function_call", call_id: "fc_1", name: "bash", arguments: '{"cmd":"pwd"}' },
      { type: "reasoning", text: "Reasoning for the second call." },
      { type: "function_call", call_id: "fc_2", name: "bash", arguments: '{"cmd":"ls"}' },
    ]);
  });

  it("creates deterministic synthetic tool results for missing calls", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_missing", name: "update_plan", input: { step: "x" } }],
      },
    ];

    const first = sanitizeToolUseResultPairing(messages);
    const second = sanitizeToolUseResultPairing(messages);

    expect(first).toEqual(second);
    expect(first[1]).toEqual({
      role: "toolResult",
      toolCallId: "call_missing",
      toolName: "update_plan",
      content: [
        {
          type: "text",
          text: "[lossless-claw] missing tool result in session history; inserted synthetic error result for transcript repair.",
        },
      ],
      isError: true,
    });
  });
});

describe("stripTrailingEmptyAssistantPrefill", () => {
  it("drops a trailing assistant message with empty-array content", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [] },
    ];
    const out = stripTrailingEmptyAssistantPrefill(messages);
    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe("user");
  });

  it("drops a trailing assistant message with undefined content", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant" },
    ];
    const out = stripTrailingEmptyAssistantPrefill(messages);
    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe("user");
  });

  it("drops a trailing assistant message with an empty string content", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: "   " },
    ];
    const out = stripTrailingEmptyAssistantPrefill(messages);
    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe("user");
  });

  it("keeps a trailing assistant message with real content", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];
    const out = stripTrailingEmptyAssistantPrefill(messages);
    expect(out).toHaveLength(2);
    expect(out[1]?.role).toBe("assistant");
  });

  it("keeps a trailing user message even if empty", () => {
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "done" }] },
      { role: "user", content: [] },
    ];
    const out = stripTrailingEmptyAssistantPrefill(messages);
    expect(out).toHaveLength(2);
    expect(out[1]?.role).toBe("user");
  });

  it("is a no-op on an empty list", () => {
    const out = stripTrailingEmptyAssistantPrefill([]);
    expect(out).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [] },
    ];
    const snapshot = JSON.parse(JSON.stringify(messages));
    stripTrailingEmptyAssistantPrefill(messages);
    expect(messages).toEqual(snapshot);
  });
});
