import { describe, expect, it } from "vitest";
import { sanitizeToolUseResultPairing } from "../src/transcript-repair.js";

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
