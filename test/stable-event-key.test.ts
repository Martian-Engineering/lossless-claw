import { describe, expect, it } from "vitest";
import { extractStableEventKey } from "../src/stable-event-key.js";

const conversationId = 42;

describe("extractStableEventKey", () => {
  it("returns an assistant-response key for assistant messages with responseId", () => {
    const key = extractStableEventKey(
      { role: "assistant", content: "hi", responseId: "r-1" } as never,
      conversationId,
    );
    expect(key).toBe("assistant-response:r-1");
  });

  it("falls back to response_id for assistant", () => {
    const key = extractStableEventKey(
      { role: "assistant", content: "hi", response_id: "r-2" } as never,
      conversationId,
    );
    expect(key).toBe("assistant-response:r-2");
  });

  it("returns a tool-result key for tool/toolResult messages with toolCallId", () => {
    expect(
      extractStableEventKey(
        { role: "tool", content: "ok", toolCallId: "call-1" } as never,
        conversationId,
      ),
    ).toBe("tool-result:call-1");
    expect(
      extractStableEventKey(
        { role: "toolResult", content: "ok", toolCallId: "call-1" } as never,
        conversationId,
      ),
    ).toBe("tool-result:call-1");
  });

  it("returns a tool-result key using toolUseId fallback for tool messages", () => {
    const key = extractStableEventKey(
      { role: "tool", content: "ok", toolUseId: "call-x" } as never,
      conversationId,
    );
    expect(key).toBe("tool-result:call-x");
  });

  it("returns null for user message without responseId or toolCallId", () => {
    // Timestamp-only fallback was removed per PR #1044 review.
    // Messages without responseId or toolCallId return null.
    expect(
      extractStableEventKey({ role: "user", content: "hi" } as never, conversationId),
    ).toBeNull();
  });

  it("returns null for user message with timestamp but no responseId/toolCallId", () => {
    // Timestamp-only fallback was removed per PR #1044 review.
    expect(
      extractStableEventKey(
        { role: "user", content: "hi", timestamp: 1_700_000_000_000 } as never,
        conversationId,
      ),
    ).toBeNull();
  });
});