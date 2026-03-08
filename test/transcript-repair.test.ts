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
});
