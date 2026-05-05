import { describe, expect, it } from "vitest";
import { isEmptyMessageContent } from "../src/assembler.js";

/**
 * Regression coverage for the asymmetric empty-content filter.
 *
 * Before the fix `cleanedEntries` only dropped empty content for `assistant`
 * messages, so an empty-array `user` or `toolResult` produced upstream during
 * incremental compaction would survive the assemble pass and hit Bedrock's
 * Converse validator with the literal wording:
 *
 *   `The content field in the Message object at messages.0 is empty.
 *    Add a ContentBlock object to the content field and try again.`
 *
 * The unified helper now drops empty-content for any role, while preserving
 * the existing assistant-only thinking-only / blank-text guards.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// isEmptyMessageContent — shared empty / null / undefined handling
// ═══════════════════════════════════════════════════════════════════════════════

describe("isEmptyMessageContent — universal empties", () => {
  it("returns true when message is null-like", () => {
    expect(isEmptyMessageContent(null as unknown as { content?: unknown })).toBe(true);
    expect(isEmptyMessageContent(undefined as unknown as { content?: unknown })).toBe(true);
  });

  it.each(["user", "assistant", "toolResult"])(
    "returns true for role=%s with content === undefined",
    (role) => {
      expect(isEmptyMessageContent({ role, content: undefined })).toBe(true);
    },
  );

  it.each(["user", "assistant", "toolResult"])(
    "returns true for role=%s with content === null",
    (role) => {
      expect(isEmptyMessageContent({ role, content: null })).toBe(true);
    },
  );

  it.each(["user", "assistant", "toolResult"])(
    "returns true for role=%s with content === [] (the production failure shape)",
    (role) => {
      expect(isEmptyMessageContent({ role, content: [] })).toBe(true);
    },
  );

  it.each(["user", "assistant", "toolResult"])(
    "returns true for role=%s with content === '' (empty string)",
    (role) => {
      expect(isEmptyMessageContent({ role, content: "" })).toBe(true);
    },
  );

  it.each(["user", "assistant", "toolResult"])(
    "returns true for role=%s with whitespace-only string content",
    (role) => {
      expect(isEmptyMessageContent({ role, content: "   \n\t  " })).toBe(true);
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// isEmptyMessageContent — non-empty shapes are preserved across roles
// ═══════════════════════════════════════════════════════════════════════════════

describe("isEmptyMessageContent — non-empty shapes", () => {
  it.each(["user", "assistant", "toolResult"])(
    "returns false for role=%s with a single non-empty text block",
    (role) => {
      expect(
        isEmptyMessageContent({
          role,
          content: [{ type: "text", text: "hello" }],
        }),
      ).toBe(false);
    },
  );

  it("returns false for user role with non-empty string content", () => {
    expect(isEmptyMessageContent({ role: "user", content: "ping" })).toBe(false);
  });

  it("returns false for assistant role with a tool_use block", () => {
    expect(
      isEmptyMessageContent({
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "read", input: { path: "x" } }],
      }),
    ).toBe(false);
  });

  it("returns false for toolResult with the synthetic transcript-repair placeholder shape", () => {
    expect(
      isEmptyMessageContent({
        role: "toolResult",
        content: [
          {
            type: "text",
            text: "[lossless-claw] missing tool result in session history; inserted synthetic error result for transcript repair.",
          },
        ],
      }),
    ).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// isEmptyMessageContent — assistant-specific guards remain in place
// ═══════════════════════════════════════════════════════════════════════════════

describe("isEmptyMessageContent — assistant-only guards", () => {
  it("returns true for assistant content that is thinking-only", () => {
    expect(
      isEmptyMessageContent({
        role: "assistant",
        content: [
          { type: "thinking", text: "internal reasoning" },
          { type: "redacted_thinking", text: "[redacted]" },
          { type: "reasoning", text: "more reasoning" },
        ],
      }),
    ).toBe(true);
  });

  it("returns true for assistant content that is blank-text-only", () => {
    expect(
      isEmptyMessageContent({
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "   " },
        ],
      }),
    ).toBe(true);
  });

  it("returns false for user content that happens to look like a thinking block", () => {
    // The thinking-only / blank-text guards are deliberately scoped to the
    // assistant role: thinking blocks are stripped downstream only on the
    // assistant side. User-authored content that mentions "thinking" should
    // never be treated as empty.
    expect(
      isEmptyMessageContent({
        role: "user",
        content: [{ type: "thinking", text: "user-supplied raw text" }],
      }),
    ).toBe(false);
  });

  it("returns false for assistant content that mixes thinking and a real text block", () => {
    expect(
      isEmptyMessageContent({
        role: "assistant",
        content: [
          { type: "thinking", text: "internal" },
          { type: "text", text: "Here is the answer." },
        ],
      }),
    ).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Regression: the exact production failure shape
// ═══════════════════════════════════════════════════════════════════════════════

describe("Bedrock 'messages.0 is empty' regression", () => {
  it("drops a user message with content === [] when run through a filter that uses isEmptyMessageContent", () => {
    const messages = [
      { role: "user", content: [] },
      { role: "user", content: [{ type: "text", text: "real question" }] },
    ];

    const cleaned = messages.filter((m) => !isEmptyMessageContent(m));

    expect(cleaned).toHaveLength(1);
    expect(cleaned[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "real question" }],
    });
  });

  it("drops a toolResult with content === [] (sanitize will re-pair with a synthetic result)", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "x" } }],
      },
      { role: "toolResult", toolCallId: "call_1", content: [] },
    ];

    const cleaned = messages.filter((m) => !isEmptyMessageContent(m));

    expect(cleaned).toHaveLength(1);
    expect(cleaned[0]?.role).toBe("assistant");
  });
});
