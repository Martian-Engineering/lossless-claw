import { describe, expect, it } from "vitest";
import { toolCallBlockFromPart, toolResultBlockFromPart, blockFromPart } from "../src/assembler.js";
import type { MessagePartRecord } from "../src/store/conversation-store.js";

/**
 * Helper to build a minimal MessagePartRecord for testing.
 * Only the fields relevant to block assembly are required.
 */
function makePart(overrides: Partial<MessagePartRecord> = {}): MessagePartRecord {
  return {
    partId: "test-part-1",
    messageId: 1,
    sessionId: "test-session",
    partType: "tool",
    ordinal: 0,
    textContent: null,
    toolCallId: null,
    toolName: null,
    toolInput: null,
    toolOutput: null,
    metadata: null,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// toolCallBlockFromPart
// ═══════════════════════════════════════════════════════════════════════════════

describe("toolCallBlockFromPart", () => {
  it("emits 'arguments' for toolCall type (default)", () => {
    const part = makePart({
      toolCallId: "call-123",
      toolName: "read",
      toolInput: '{"path":"SOUL.md"}',
    });
    const block = toolCallBlockFromPart(part) as Record<string, unknown>;

    expect(block.type).toBe("toolCall");
    expect(block.id).toBe("call-123");
    expect(block.name).toBe("read");
    expect(block.arguments).toEqual({ path: "SOUL.md" });
    expect(block).not.toHaveProperty("input");
  });

  it("emits 'arguments' for explicit toolCall rawType", () => {
    const part = makePart({
      toolCallId: "call-456",
      toolName: "exec",
      toolInput: '{"command":"ls"}',
    });
    const block = toolCallBlockFromPart(part, "toolCall") as Record<string, unknown>;

    expect(block.type).toBe("toolCall");
    expect(block.arguments).toEqual({ command: "ls" });
    expect(block).not.toHaveProperty("input");
  });

  it("emits 'arguments' for functionCall rawType", () => {
    const part = makePart({
      toolCallId: "call-789",
      toolName: "bash",
      toolInput: '{"cmd":"pwd"}',
    });
    const block = toolCallBlockFromPart(part, "functionCall") as Record<string, unknown>;

    expect(block.type).toBe("functionCall");
    expect(block.arguments).toEqual({ cmd: "pwd" });
    expect(block).not.toHaveProperty("input");
  });

  it("emits 'arguments' for function_call rawType with call_id", () => {
    const part = makePart({
      toolCallId: "fc_1",
      toolName: "read",
      toolInput: '{"path":"test.md"}',
    });
    const block = toolCallBlockFromPart(part, "function_call") as Record<string, unknown>;

    expect(block.type).toBe("function_call");
    expect(block.call_id).toBe("fc_1");
    expect(block.name).toBe("read");
    expect(block.arguments).toEqual({ path: "test.md" });
    expect(block).not.toHaveProperty("id");
    expect(block).not.toHaveProperty("input");
  });

  it("emits 'input' for tool_use rawType (Anthropic)", () => {
    const part = makePart({
      toolCallId: "toolu_abc",
      toolName: "read",
      toolInput: '{"path":"USER.md"}',
    });
    const block = toolCallBlockFromPart(part, "tool_use") as Record<string, unknown>;

    expect(block.type).toBe("tool_use");
    expect(block.id).toBe("toolu_abc");
    expect(block.name).toBe("read");
    expect(block.input).toEqual({ path: "USER.md" });
    expect(block).not.toHaveProperty("arguments");
  });

  it("emits 'input' for toolUse rawType", () => {
    const part = makePart({
      toolCallId: "toolu_def",
      toolName: "write",
      toolInput: '{"path":"out.txt","content":"hello"}',
    });
    const block = toolCallBlockFromPart(part, "toolUse") as Record<string, unknown>;

    expect(block.type).toBe("toolUse");
    expect(block.input).toEqual({ path: "out.txt", content: "hello" });
    expect(block).not.toHaveProperty("arguments");
  });

  it("emits 'input' for tool-use rawType", () => {
    const part = makePart({
      toolCallId: "id-1",
      toolName: "search",
      toolInput: '{"query":"test"}',
    });
    const block = toolCallBlockFromPart(part, "tool-use") as Record<string, unknown>;

    expect(block.type).toBe("tool-use");
    expect(block.input).toEqual({ query: "test" });
    expect(block).not.toHaveProperty("arguments");
  });

  it("handles string (non-JSON) tool input", () => {
    const part = makePart({
      toolCallId: "call-str",
      toolName: "bash",
      toolInput: "echo hello",
    });
    const block = toolCallBlockFromPart(part) as Record<string, unknown>;

    expect(block.arguments).toBe("echo hello");
  });

  it("omits arguments when toolInput is null", () => {
    const part = makePart({
      toolCallId: "call-nil",
      toolName: "read",
      toolInput: null,
    });
    const block = toolCallBlockFromPart(part) as Record<string, unknown>;

    expect(block).not.toHaveProperty("arguments");
    expect(block).not.toHaveProperty("input");
  });

  it("generates synthetic id when toolCallId is empty string", () => {
    const part = makePart({
      toolCallId: "",
      toolName: "read",
      toolInput: '{"path":"a.txt"}',
    });
    const block = toolCallBlockFromPart(part) as Record<string, unknown>;

    expect(block.id).toBe("toolu_lcm_test-part-1");
    expect(block.name).toBe("read");
  });

  it("generates synthetic id when toolCallId is null", () => {
    const part = makePart({
      toolCallId: null,
      toolName: "read",
      toolInput: '{"path":"a.txt"}',
    });
    const block = toolCallBlockFromPart(part) as Record<string, unknown>;

    expect(block.id).toBe("toolu_lcm_test-part-1");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// toolResultBlockFromPart
// ═══════════════════════════════════════════════════════════════════════════════

describe("toolResultBlockFromPart", () => {
  it("defaults to tool_result type with tool_use_id", () => {
    const part = makePart({
      toolCallId: "toolu_abc",
      toolName: "read",
      toolOutput: '"file contents here"',
    });
    const block = toolResultBlockFromPart(part) as Record<string, unknown>;

    expect(block.type).toBe("tool_result");
    expect(block.tool_use_id).toBe("toolu_abc");
    expect(block.output).toBe("file contents here");
    expect(block.name).toBe("read");
  });

  it("uses function_call_output type with call_id", () => {
    const part = makePart({
      toolCallId: "fc_1",
      toolName: "bash",
      toolOutput: '"ok"',
    });
    const block = toolResultBlockFromPart(part, "function_call_output") as Record<string, unknown>;

    expect(block.type).toBe("function_call_output");
    expect(block.call_id).toBe("fc_1");
    expect(block.output).toBe("ok");
    expect(block).not.toHaveProperty("tool_use_id");
  });

  it("falls back to textContent when toolOutput is null", () => {
    const part = makePart({
      toolCallId: "call-1",
      textContent: "fallback text",
      toolOutput: null,
    });
    const block = toolResultBlockFromPart(part) as Record<string, unknown>;

    expect(block.output).toBe("fallback text");
  });

  it("falls back to empty string when both are null", () => {
    const part = makePart({
      toolCallId: "call-1",
      textContent: null,
      toolOutput: null,
    });
    const block = toolResultBlockFromPart(part) as Record<string, unknown>;

    expect(block.output).toBe("");
  });

  it("preserves raw content when no normalized output columns are present", () => {
    const part = makePart({
      toolCallId: "toolu_content",
      toolName: "read",
      textContent: null,
      toolOutput: null,
    });
    const block = toolResultBlockFromPart(part, "tool_result", {
      type: "tool_result",
      tool_use_id: "toolu_content",
      content: [{ type: "text", text: "command output" }],
    }) as Record<string, unknown>;

    expect(block.type).toBe("tool_result");
    expect(block.tool_use_id).toBe("toolu_content");
    expect(block.content).toEqual([{ type: "text", text: "command output" }]);
    expect(block).not.toHaveProperty("output");
  });

  it("restores externalized plain-text tool results as text blocks", () => {
    const part = makePart({
      partType: "tool",
      toolCallId: "toolu_externalized",
      toolName: "exec",
      textContent: "[LCM Tool Output: file_deadbeef12345678 tool=exec]",
      toolOutput: null,
    });
    const block = toolResultBlockFromPart(part, "tool_result", {
      type: "tool_result",
      text: "[LCM Tool Output: file_deadbeef12345678 tool=exec]",
      externalizedFileId: "file_deadbeef12345678",
      toolOutputExternalized: true,
    }) as Record<string, unknown>;

    expect(block).toEqual({
      type: "text",
      text: "[LCM Tool Output: file_deadbeef12345678 tool=exec]",
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// blockFromPart — integration of the above through the main dispatch
// ═══════════════════════════════════════════════════════════════════════════════

describe("blockFromPart", () => {
  it("routes tool parts with rawType=toolCall through toolCallBlockFromPart", () => {
    const part = makePart({
      partType: "tool",
      toolCallId: "call-1",
      toolName: "read",
      toolInput: '{"path":"SOUL.md"}',
      metadata: JSON.stringify({
        rawType: "toolCall",
        originalRole: "assistant",
        raw: {
          type: "toolCall",
          id: "call-1",
          name: "read",
          arguments: { path: "SOUL.md" },
        },
      }),
    });
    const block = blockFromPart(part) as Record<string, unknown>;

    // Must use "arguments" not "input" — this is the bug we're fixing
    expect(block.type).toBe("toolCall");
    expect(block.arguments).toEqual({ path: "SOUL.md" });
    expect(block).not.toHaveProperty("input");
  });

  it("routes tool parts with rawType=tool_use through toolCallBlockFromPart with input", () => {
    const part = makePart({
      partType: "tool",
      toolCallId: "toolu_1",
      toolName: "read",
      toolInput: '{"path":"USER.md"}',
      metadata: JSON.stringify({
        rawType: "tool_use",
        originalRole: "assistant",
        raw: {
          type: "tool_use",
          id: "toolu_1",
          name: "read",
          input: { path: "USER.md" },
        },
      }),
    });
    const block = blockFromPart(part) as Record<string, unknown>;

    // Anthropic tool_use should use "input"
    expect(block.type).toBe("tool_use");
    expect(block.input).toEqual({ path: "USER.md" });
    expect(block).not.toHaveProperty("arguments");
  });

  it("does NOT return raw block verbatim for tool call types", () => {
    // This tests the blockFromPart guard that prevents the early raw return
    // for tool blocks (which would bypass argument normalization).
    const rawObj = {
      type: "toolCall",
      id: "call-raw",
      name: "read",
      arguments: { path: "test.md" }, // object, not string — would break xAI
    };
    const part = makePart({
      partType: "tool",
      toolCallId: "call-raw",
      toolName: "read",
      toolInput: '{"path":"test.md"}',
      metadata: JSON.stringify({
        rawType: "toolCall",
        originalRole: "assistant",
        raw: rawObj,
      }),
    });
    const block = blockFromPart(part) as Record<string, unknown>;

    // Should go through toolCallBlockFromPart, not return raw
    expect(block.type).toBe("toolCall");
    expect(block.id).toBe("call-raw");
    expect(block.name).toBe("read");
    // arguments should come from toolInput column, not raw
    expect(block.arguments).toEqual({ path: "test.md" });
  });

  it("returns raw block verbatim for non-tool types", () => {
    const rawObj = { type: "custom_block", data: "something" };
    const part = makePart({
      partType: "text",
      metadata: JSON.stringify({ raw: rawObj }),
    });
    const block = blockFromPart(part) as Record<string, unknown>;

    expect(block).toEqual(rawObj);
  });

  it("restores OpenAI reasoning blocks from OpenClaw-normalised format", () => {
    const part = makePart({
      partType: "reasoning",
      metadata: JSON.stringify({
        raw: {
          type: "thinking",
          thinking: "",
          thinkingSignature: JSON.stringify({
            type: "reasoning",
            id: "rs_abc123",
            encrypted_content: "...",
          }),
        },
      }),
    });
    const block = blockFromPart(part) as Record<string, unknown>;

    expect(block.type).toBe("reasoning");
    expect(block.id).toBe("rs_abc123");
  });

  it("routes tool result parts correctly", () => {
    const part = makePart({
      partType: "tool",
      toolCallId: "call-1",
      toolName: "read",
      toolOutput: '"file contents"',
      metadata: JSON.stringify({
        rawType: "function_call_output",
        originalRole: "toolResult",
      }),
    });
    const block = blockFromPart(part) as Record<string, unknown>;

    expect(block.type).toBe("function_call_output");
    expect(block.call_id).toBe("call-1");
    expect(block.output).toBe("file contents");
  });

  it("preserves raw tool_result content when dedicated output columns are empty", () => {
    const part = makePart({
      partType: "tool",
      toolCallId: "call-content",
      toolName: "read",
      toolOutput: null,
      textContent: null,
      metadata: JSON.stringify({
        rawType: "tool_result",
        originalRole: "toolResult",
        raw: {
          type: "tool_result",
          tool_use_id: "call-content",
          content: [{ type: "text", text: "command output" }],
          metadata: { raw: "ignored" },
        },
      }),
    });
    const block = blockFromPart(part) as Record<string, unknown>;

    expect(block.type).toBe("tool_result");
    expect(block.tool_use_id).toBe("call-content");
    expect(block.content).toEqual([{ type: "text", text: "command output" }]);
    expect(block).not.toHaveProperty("metadata");
  });

  it("falls back to text block for text parts without metadata", () => {
    const part = makePart({
      partType: "text",
      textContent: "Hello, world!",
    });
    const block = blockFromPart(part) as Record<string, unknown>;

    expect(block).toEqual({ type: "text", text: "Hello, world!" });
  });

  it("falls back to empty text block for parts with no content", () => {
    const part = makePart({
      partType: "text",
      textContent: null,
    });
    const block = blockFromPart(part) as Record<string, unknown>;

    expect(block).toEqual({ type: "text", text: "" });
  });

  // ─── Regression: #158 — tool call id backfill from metadata.raw ──────────

  it("backfills toolCallId from metadata.raw when DB column is NULL (regression #158)", () => {
    // This is the exact scenario that crashes downstream providers:
    // text-type rows with tool call data only in metadata.raw.
    const part = makePart({
      partType: "text",
      toolCallId: null,
      toolName: null,
      toolInput: null,
      metadata: JSON.stringify({
        rawType: "toolCall",
        originalRole: "assistant",
        raw: {
          type: "toolCall",
          id: "toolu_01114sYtk4SBgj4gPvTmLrzX",
          name: "exec",
          arguments: { command: "ls" },
        },
      }),
    });
    const block = blockFromPart(part) as Record<string, unknown>;

    expect(block.type).toBe("toolCall");
    expect(block.id).toBe("toolu_01114sYtk4SBgj4gPvTmLrzX");
    expect(block.name).toBe("exec");
    expect(block.arguments).toEqual({ command: "ls" });
  });

  it("backfills toolCallId from metadata.raw for tool_use type (regression #158)", () => {
    const part = makePart({
      partType: "text",
      toolCallId: null,
      toolName: null,
      toolInput: null,
      metadata: JSON.stringify({
        rawType: "tool_use",
        originalRole: "assistant",
        raw: {
          type: "tool_use",
          id: "toolu_abc123",
          name: "read",
          input: { path: "USER.md" },
        },
      }),
    });
    const block = blockFromPart(part) as Record<string, unknown>;

    expect(block.type).toBe("tool_use");
    expect(block.id).toBe("toolu_abc123");
    expect(block.name).toBe("read");
  });

  it("backfills toolCallId from metadata.raw.call_id for function_call type", () => {
    const part = makePart({
      partType: "text",
      toolCallId: null,
      toolName: null,
      toolInput: null,
      metadata: JSON.stringify({
        rawType: "function_call",
        originalRole: "assistant",
        raw: {
          type: "function_call",
          call_id: "fc_legacy_123",
          name: "bash",
          arguments: { cmd: "pwd" },
        },
      }),
    });
    const block = blockFromPart(part) as Record<string, unknown>;

    expect(block.type).toBe("function_call");
    expect(block.call_id).toBe("fc_legacy_123");
    expect(block.name).toBe("bash");
    expect(block.arguments).toEqual({ cmd: "pwd" });
  });

  it("prefers DB column over metadata.raw when both are present", () => {
    const part = makePart({
      partType: "text",
      toolCallId: "db-column-id",
      toolName: "db-tool-name",
      metadata: JSON.stringify({
        rawType: "toolCall",
        originalRole: "assistant",
        raw: {
          type: "toolCall",
          id: "raw-id",
          name: "raw-name",
          arguments: { x: 1 },
        },
      }),
    });
    const block = blockFromPart(part) as Record<string, unknown>;

    expect(block.id).toBe("db-column-id");
    expect(block.name).toBe("db-tool-name");
  });

  it("generates synthetic fallback id when neither DB nor raw has an id", () => {
    const part = makePart({
      partType: "text",
      toolCallId: null,
      metadata: JSON.stringify({
        rawType: "toolCall",
        originalRole: "assistant",
        raw: {
          type: "toolCall",
          name: "exec",
          arguments: { command: "ls" },
        },
      }),
    });
    const block = blockFromPart(part) as Record<string, unknown>;

    expect(block.id).toBe("toolu_lcm_test-part-1");
  });
});
