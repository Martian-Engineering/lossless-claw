import { describe, expect, it } from "vitest";
import { sanitizeToolUseResultPairing } from "../src/transcript-repair.js";

describe("sanitizeToolUseResultPairing", () => {
  it("moves OpenAI reasoning blocks before function_call blocks", () => {
    const repaired = sanitizeToolUseResultPairing([
      {
        role: "assistant",
        content: [
          {
            type: "function_call",
            call_id: "fc_1",
            name: "bash",
            arguments: '{"cmd":"pwd"}',
          },
          { type: "reasoning", text: "Need tool output first." },
        ],
      },
    ]);

    const assistant = repaired[0] as { content?: Array<{ type?: string }> };
    expect(assistant.content?.map((block) => block.type)).toEqual([
      "reasoning",
      "function_call",
    ]);
  });

  it("preserves interleaved reasoning when an assistant turn has multiple function calls", () => {
    const repaired = sanitizeToolUseResultPairing([
      {
        role: "assistant",
        content: [
          {
            type: "function_call",
            call_id: "fc_1",
            name: "bash",
            arguments: '{"cmd":"pwd"}',
          },
          { type: "reasoning", text: "Reasoning for the second call." },
          {
            type: "function_call",
            call_id: "fc_2",
            name: "bash",
            arguments: '{"cmd":"ls"}',
          },
        ],
      },
    ]);

    const assistant = repaired[0] as {
      content?: Array<{ type?: string; call_id?: string; text?: string }>;
    };
    expect(assistant.content).toEqual([
      {
        type: "function_call",
        call_id: "fc_1",
        name: "bash",
        arguments: '{"cmd":"pwd"}',
      },
      { type: "reasoning", text: "Reasoning for the second call." },
      {
        type: "function_call",
        call_id: "fc_2",
        name: "bash",
        arguments: '{"cmd":"ls"}',
      },
    ]);
  });

  it("creates deterministic synthetic tool results for missing calls", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_missing",
            name: "update_plan",
            input: { step: "x" },
          },
        ],
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

  it("looks past display-only assistant turns for delayed tool results", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_bridge",
            name: "tool_search_code",
            input: { code: "run" },
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "tool progress" }],
      },
      {
        role: "toolResult",
        toolCallId: "call_bridge",
        toolName: "tool_search_code",
        content: [{ type: "text", text: "real result" }],
      },
    ];

    expect(sanitizeToolUseResultPairing(messages)).toEqual([
      messages[0],
      messages[2],
      messages[1],
    ]);
  });

  // -- Duplicate assistant tool_use dedup (INC-2026-03-24 class) --

  type Block = { type?: string; id?: string; call_id?: string; name?: string; text?: string };
  type Msg = { role: string; content?: Block[]; toolCallId?: string; toolName?: string; stopReason?: string };

  const assistantToolUseIds = (messages: Msg[]): string[] => {
    const ids: string[] = [];
    for (const m of messages) {
      if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (b && (b.type === "toolCall" || b.type === "tool_use") && (b.id ?? b.call_id)) {
          ids.push((b.id ?? b.call_id) as string);
        }
      }
    }
    return ids;
  };
  const toolResultIds = (messages: Msg[]): string[] =>
    messages.filter((m) => m.role === "toolResult" && m.toolCallId).map((m) => m.toolCallId as string);

  it("drops a duplicate assistant tool_use id repeated across two messages", () => {
    const out = sanitizeToolUseResultPairing<Msg>([
      { role: "assistant", content: [{ type: "toolCall", id: "X", name: "bash" }] },
      { role: "toolResult", toolCallId: "X", content: [{ type: "text", text: "out-1" }] },
      { role: "assistant", content: [{ type: "toolCall", id: "X", name: "bash" }] },
      { role: "toolResult", toolCallId: "X", content: [{ type: "text", text: "out-2" }] },
    ]);

    expect(assistantToolUseIds(out)).toEqual(["X"]);
    expect(toolResultIds(out)).toEqual(["X"]);
  });

  it("keeps a distinct tool_use in a later message while dropping the duplicate block", () => {
    const out = sanitizeToolUseResultPairing<Msg>([
      { role: "assistant", content: [{ type: "toolCall", id: "X", name: "bash" }] },
      { role: "toolResult", toolCallId: "X", content: [{ type: "text", text: "x" }] },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "X", name: "bash" },
          { type: "toolCall", id: "Y", name: "grep" },
        ],
      },
      { role: "toolResult", toolCallId: "X", content: [{ type: "text", text: "x-dup" }] },
      { role: "toolResult", toolCallId: "Y", content: [{ type: "text", text: "y" }] },
    ]);

    expect(assistantToolUseIds(out).sort()).toEqual(["X", "Y"]);
    expect(toolResultIds(out).sort()).toEqual(["X", "Y"]);
  });

  it("does not let an aborted turn claim an id that a later valid turn reuses", () => {
    const out = sanitizeToolUseResultPairing<Msg>([
      { role: "assistant", stopReason: "aborted", content: [{ type: "toolCall", id: "X", name: "bash" }] },
      { role: "assistant", content: [{ type: "toolCall", id: "X", name: "bash" }] },
      { role: "toolResult", toolCallId: "X", content: [{ type: "text", text: "real" }] },
    ]);

    expect(assistantToolUseIds(out)).toEqual(["X"]);
    expect(toolResultIds(out)).toEqual(["X"]);
    expect(out.some((m) => m.stopReason === "aborted" && (m.content?.length ?? 0) > 0)).toBe(false);
  });

  it("drops duplicate tool results within a single assistant span", () => {
    const out = sanitizeToolUseResultPairing<Msg>([
      { role: "assistant", content: [{ type: "toolCall", id: "X", name: "bash" }] },
      { role: "toolResult", toolCallId: "X", content: [{ type: "text", text: "first" }] },
      { role: "toolResult", toolCallId: "X", content: [{ type: "text", text: "dup" }] },
    ]);

    expect(toolResultIds(out)).toEqual(["X"]);
    expect(assistantToolUseIds(out)).toEqual(["X"]);
  });

  it("invokes the optional logger when duplicate assistant tool_use blocks are dropped", () => {
    const warnings: string[] = [];
    sanitizeToolUseResultPairing<Msg>(
      [
        { role: "assistant", content: [{ type: "toolCall", id: "X", name: "bash" }] },
        { role: "toolResult", toolCallId: "X", content: [{ type: "text", text: "a" }] },
        { role: "assistant", content: [{ type: "toolCall", id: "X", name: "bash" }] },
        { role: "toolResult", toolCallId: "X", content: [{ type: "text", text: "b" }] },
      ],
      { warn: (m) => warnings.push(m) }
    );
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("duplicate assistant tool_use");
  });

});
