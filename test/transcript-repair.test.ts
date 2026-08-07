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

  it("prefers a later real result over an earlier synthetic repair result", () => {
    const assistant = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_real", name: "read", input: {} }],
    };
    const synthetic = {
      role: "toolResult",
      toolCallId: "call_real",
      toolName: "read",
      content: [
        {
          type: "text",
          text: "[lossless-claw] missing tool result in session history; inserted synthetic error result for transcript repair.",
        },
      ],
      isError: true,
    };
    const real = {
      role: "toolResult",
      toolCallId: "call_real",
      toolName: "read",
      content: [{ type: "text", text: "real output" }],
      isError: false,
    };

    expect(sanitizeToolUseResultPairing([assistant, synthetic, real])).toEqual([
      assistant,
      real,
    ]);
  });

  it("finds real results displaced past a later assistant tool-call turn", () => {
    const callA = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_a", name: "read", input: {} }],
    };
    const callB = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_b", name: "read", input: {} }],
    };
    const resultA = {
      role: "toolResult",
      toolCallId: "call_a",
      toolName: "read",
      content: [{ type: "text", text: "result A" }],
    };
    const resultB = {
      role: "toolResult",
      toolCallId: "call_b",
      toolName: "read",
      content: [{ type: "text", text: "result B" }],
    };

    expect(sanitizeToolUseResultPairing([callA, callB, resultA, resultB])).toEqual([
      callA,
      resultA,
      callB,
      resultB,
    ]);
  });

  it("does not classify a real error containing the repair marker as synthetic", () => {
    const assistant = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_error", name: "read", input: {} }],
    };
    const realError = {
      role: "toolResult",
      toolCallId: "call_error",
      toolName: "read",
      content: [
        {
          type: "text",
          text: "Provider returned [lossless-claw] missing tool result with additional real context.",
        },
      ],
      isError: true,
    };
    const laterReal = {
      role: "toolResult",
      toolCallId: "call_error",
      toolName: "read",
      content: [{ type: "text", text: "later output" }],
      isError: false,
    };

    expect(sanitizeToolUseResultPairing([assistant, realError, laterReal])).toEqual([
      assistant,
      realError,
    ]);
  });

  it("keeps a real result when a synthetic duplicate appears later", () => {
    const assistant = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_first_real", name: "read", input: {} }],
    };
    const real = {
      role: "toolResult",
      toolCallId: "call_first_real",
      toolName: "read",
      content: [{ type: "text", text: "real output" }],
      isError: false,
    };
    const synthetic = {
      role: "toolResult",
      toolCallId: "call_first_real",
      toolName: "read",
      content: [
        {
          type: "text",
          text: "[lossless-claw] missing tool result in session history; inserted synthetic error result for transcript repair.",
        },
      ],
      isError: true,
    };

    expect(sanitizeToolUseResultPairing([assistant, real, synthetic])).toEqual([
      assistant,
      real,
    ]);
  });

  // -- Duplicate assistant tool_use dedup (INC-2026-03-24 class) --

  type Block = { type?: string; id?: string; call_id?: string; name?: string; text?: string };
  type Msg = {
    role: string;
    content?: Block[];
    toolCallId?: string;
    toolName?: string;
    stopReason?: string;
    stop_reason?: string;
  };

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

  it("drops a byte-identical assistant tool_use repeat while the first call is still pending", () => {
    // A pending (not-yet-paired) call repeated byte-identically is a store
    // double-write; the later identical block drops keep-first. Repeats that
    // arrive with their own later result are distinct occurrences — see the
    // recurrent-id occurrence semantics suite below.
    const out = sanitizeToolUseResultPairing<Msg>([
      { role: "assistant", content: [{ type: "toolCall", id: "X", name: "bash" }] },
      { role: "assistant", content: [{ type: "toolCall", id: "X", name: "bash" }] },
      { role: "toolResult", toolCallId: "X", content: [{ type: "text", text: "out-1" }] },
    ]);

    expect(assistantToolUseIds(out)).toEqual(["X"]);
    expect(toolResultIds(out)).toEqual(["X"]);
  });

  it("keeps a repeated id as a fresh occurrence when a pairable later result exists", () => {
    // Occurrence-scoped pairing: the second X call reuses an id whose first
    // occurrence already paired, and a second X result exists for it — the
    // same shape as `pwd` run twice or a store double-write. Prefer emitting
    // both occurrences (recoverable by repair-time dedup) over dropping a
    // possibly-genuine event.
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

    expect(assistantToolUseIds(out).sort()).toEqual(["X", "X", "Y"]);
    expect(toolResultIds(out).sort()).toEqual(["X", "X", "Y"]);
  });

  it("moves a delayed real result before a mixed duplicate and new tool_use turn", () => {
    const out = sanitizeToolUseResultPairing<Msg>([
      { role: "assistant", content: [{ type: "toolCall", id: "X", name: "bash" }] },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "X", name: "bash" },
          { type: "toolCall", id: "Y", name: "grep" },
        ],
      },
      { role: "toolResult", toolCallId: "X", content: [{ type: "text", text: "real X" }] },
      { role: "toolResult", toolCallId: "Y", content: [{ type: "text", text: "real Y" }] },
    ]);

    expect(out).toEqual([
      { role: "assistant", content: [{ type: "toolCall", id: "X", name: "bash" }] },
      { role: "toolResult", toolCallId: "X", content: [{ type: "text", text: "real X" }] },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "Y", name: "grep" }],
      },
      { role: "toolResult", toolCallId: "Y", content: [{ type: "text", text: "real Y" }] },
    ]);
  });

  it("looks past duplicate cascades after a mixed duplicate and new tool_use turn", () => {
    const out = sanitizeToolUseResultPairing<Msg>([
      { role: "assistant", content: [{ type: "toolCall", id: "X", name: "bash" }] },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "X", name: "bash" },
          { type: "toolCall", id: "Y", name: "grep" },
        ],
      },
      { role: "assistant", content: [{ type: "toolCall", id: "Y", name: "grep" }] },
      { role: "toolResult", toolCallId: "X", content: [{ type: "text", text: "real X" }] },
      { role: "toolResult", toolCallId: "Y", content: [{ type: "text", text: "real Y" }] },
    ]);

    expect(out).toEqual([
      { role: "assistant", content: [{ type: "toolCall", id: "X", name: "bash" }] },
      { role: "toolResult", toolCallId: "X", content: [{ type: "text", text: "real X" }] },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "Y", name: "grep" }],
      },
      { role: "toolResult", toolCallId: "Y", content: [{ type: "text", text: "real Y" }] },
    ]);
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

  it("treats snake_case terminal stop reasons as non-pairable", () => {
    const out = sanitizeToolUseResultPairing<Msg>([
      { role: "assistant", stop_reason: "error", content: [{ type: "tool_use", id: "X", name: "bash" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "X", name: "bash" }] },
      { role: "toolResult", toolCallId: "X", content: [{ type: "text", text: "real" }] },
    ]);

    expect(assistantToolUseIds(out)).toEqual(["X"]);
    expect(toolResultIds(out)).toEqual(["X"]);
    expect(out.some((m) => m.stop_reason === "error" && (m.content?.length ?? 0) > 0)).toBe(false);
  });

  it("does not let a stripped terminal assistant turn block a delayed real result", () => {
    const out = sanitizeToolUseResultPairing<Msg>([
      { role: "assistant", content: [{ type: "toolCall", id: "X", name: "bash" }] },
      { role: "assistant", stopReason: "aborted", content: [{ type: "toolCall", id: "Y", name: "bash" }] },
      { role: "toolResult", toolCallId: "X", content: [{ type: "text", text: "real" }] },
    ]);

    expect(out).toEqual([
      { role: "assistant", content: [{ type: "toolCall", id: "X", name: "bash" }] },
      { role: "toolResult", toolCallId: "X", content: [{ type: "text", text: "real" }] },
    ]);
  });

  it("looks past aborted non-pairable tool_use turns for delayed results", () => {
    const out = sanitizeToolUseResultPairing<Msg>([
      { role: "assistant", content: [{ type: "toolCall", id: "A", name: "bash" }] },
      { role: "assistant", stopReason: "aborted", content: [{ type: "toolCall", id: "X", name: "bash" }] },
      { role: "toolResult", toolCallId: "A", content: [{ type: "text", text: "real A" }] },
      { role: "assistant", content: [{ type: "toolCall", id: "X", name: "bash" }] },
      { role: "toolResult", toolCallId: "X", content: [{ type: "text", text: "real X" }] },
    ]);

    expect(out).toEqual([
      { role: "assistant", content: [{ type: "toolCall", id: "A", name: "bash" }] },
      { role: "toolResult", toolCallId: "A", content: [{ type: "text", text: "real A" }] },
      { role: "assistant", content: [{ type: "toolCall", id: "X", name: "bash" }] },
      { role: "toolResult", toolCallId: "X", content: [{ type: "text", text: "real X" }] },
    ]);
  });

  it("drops duplicate assistant turns that become reasoning-only after filtering", () => {
    const out = sanitizeToolUseResultPairing<Msg>([
      { role: "assistant", content: [{ type: "toolCall", id: "X", name: "bash" }] },
      { role: "toolResult", toolCallId: "X", content: [{ type: "text", text: "real" }] },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "stale hidden thought" },
          { type: "toolCall", id: "X", name: "bash" },
        ],
      },
    ]);

    expect(out).toEqual([
      { role: "assistant", content: [{ type: "toolCall", id: "X", name: "bash" }] },
      { role: "toolResult", toolCallId: "X", content: [{ type: "text", text: "real" }] },
    ]);
  });

  it("does not let a duplicate-only assistant turn block a delayed real result", () => {
    const out = sanitizeToolUseResultPairing<Msg>([
      { role: "assistant", content: [{ type: "toolCall", id: "X", name: "bash" }] },
      { role: "assistant", content: [{ type: "toolCall", id: "X", name: "bash" }] },
      { role: "toolResult", toolCallId: "X", content: [{ type: "text", text: "real" }] },
    ]);

    expect(out).toEqual([
      { role: "assistant", content: [{ type: "toolCall", id: "X", name: "bash" }] },
      { role: "toolResult", toolCallId: "X", content: [{ type: "text", text: "real" }] },
    ]);
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
        { role: "assistant", content: [{ type: "toolCall", id: "X", name: "bash" }] },
        { role: "toolResult", toolCallId: "X", content: [{ type: "text", text: "a" }] },
      ],
      { warn: (m) => warnings.push(m) }
    );
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("duplicate assistant tool_use");
  });

  it("logs terminal tool_use removals distinctly from duplicate removals", () => {
    const warnings: string[] = [];
    sanitizeToolUseResultPairing<Msg>(
      [
        { role: "assistant", stopReason: "aborted", content: [{ type: "toolCall", id: "X", name: "bash" }] },
      ],
      { warn: (m) => warnings.push(m) }
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("terminal assistant tool_use");
    expect(warnings[0]).not.toContain("duplicate");
  });

});

describe("sanitizeToolUseResultPairing recurrent-id occurrence semantics", () => {
  type Msg = {
    role: string;
    content?: unknown;
    toolCallId?: string;
    toolUseId?: string;
    toolName?: string;
    stopReason?: string;
    stop_reason?: string;
    isError?: boolean;
  };

  it("keeps identical-args repeats with their own results (`pwd` twice)", () => {
    const out = sanitizeToolUseResultPairing<Msg>([
      { role: "assistant", content: [{ type: "toolCall", id: "exec:7", name: "exec", arguments: { command: "pwd" } }] },
      { role: "toolResult", toolCallId: "exec:7", content: [{ type: "text", text: "/home/jet" }] },
      { role: "assistant", content: [{ type: "toolCall", id: "exec:7", name: "exec", arguments: { command: "pwd" } }] },
      { role: "toolResult", toolCallId: "exec:7", content: [{ type: "text", text: "/home/jet" }] },
    ]);
    expect(out.filter((m) => m.role === "assistant").length).toBe(2);
    expect(out.filter((m) => m.role === "toolResult").length).toBe(2);
    expect(JSON.stringify(out)).not.toContain("missing tool result");
  });

  it("does not let an earlier call steal a result past the next same-id occurrence", () => {
    // [call X(a), call X(b), result X]: the result belongs to the newest
    // pending occurrence; the first call gets a synthetic placeholder instead
    // of stealing the second call's result.
    const out = sanitizeToolUseResultPairing<Msg>([
      { role: "assistant", content: [{ type: "toolCall", id: "exec:9", name: "exec", arguments: { command: "ls /tmp/a" } }] },
      { role: "assistant", content: [{ type: "toolCall", id: "exec:9", name: "exec", arguments: { command: "ls /tmp/b" } }] },
      { role: "toolResult", toolCallId: "exec:9", content: [{ type: "text", text: "real-for-b" }] },
    ]);
    const resultContents = out
      .filter((m) => m.role === "toolResult")
      .map((m) => JSON.stringify(m.content));
    const realIndex = out.findIndex(
      (m) => m.role === "toolResult" && JSON.stringify(m.content).includes("real-for-b"),
    );
    const callBIndex = out.findIndex(
      (m) => m.role === "assistant" && JSON.stringify(m.content).includes("ls /tmp/b"),
    );
    expect(resultContents.length).toBe(2);
    expect(callBIndex).toBeGreaterThanOrEqual(0);
    expect(realIndex).toBe(callBIndex + 1);
    // The first call gets the synthetic placeholder, never the second call's
    // real result.
    expect(resultContents[0]).toContain("missing tool result");
    expect(resultContents[1]).toContain("real-for-b");
  });

  it("reprocesses text-bearing identical recurrent calls instead of swallowing them", () => {
    const out = sanitizeToolUseResultPairing<Msg>([
      { role: "assistant", content: [{ type: "toolCall", id: "exec:11", name: "exec", arguments: { command: "pwd" } }] },
      { role: "toolResult", toolCallId: "exec:11", content: [{ type: "text", text: "/home/jet" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "again:" },
          { type: "toolCall", id: "exec:11", name: "exec", arguments: { command: "pwd" } },
        ],
      },
      { role: "toolResult", toolCallId: "exec:11", content: [{ type: "text", text: "/home/jet" }] },
    ]);
    const texts = JSON.stringify(out);
    expect(out.filter((m) => m.role === "assistant").length).toBe(2);
    expect(out.filter((m) => m.role === "toolResult").length).toBe(2);
    expect(texts).toContain("again:");
    expect(texts).not.toContain("missing tool result");
  });

  it("collapses same-id tool calls within a single assistant turn (keep-first)", () => {
    const out = sanitizeToolUseResultPairing<Msg>([
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "exec:13", name: "exec", arguments: { command: "ls a" } },
          { type: "toolCall", id: "exec:13", name: "exec", arguments: { command: "ls b" } },
        ],
      },
      { role: "toolResult", toolCallId: "exec:13", content: [{ type: "text", text: "ok" }] },
    ]);
    const calls = out
      .filter((m) => m.role === "assistant")
      .flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type?: string }>) : []))
      .filter((b) => b && typeof b.type === "string" && b.type === "toolCall");
    expect(calls.length).toBe(1);
    expect(out.filter((m) => m.role === "toolResult").length).toBe(1);
    expect(JSON.stringify(out)).not.toContain("missing tool result");
  });
});
