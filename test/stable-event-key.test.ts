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

  it("returns a millisecond event key when only timestamp is available", () => {
    const key = extractStableEventKey(
      { role: "user", content: "hi", timestamp: 1_700_000_000_123 } as never,
      conversationId,
    );
    expect(key).toBe("user-event:42:user:1700000000123");
  });

  it("returns null when no stable identity is available", () => {
    expect(
      extractStableEventKey({ role: "user", content: "hi" } as never, conversationId),
    ).toBeNull();
  });

  it("scopes timestamp keys per conversation", () => {
    const a = extractStableEventKey(
      { role: "user", content: "hi", timestamp: 1 } as never,
      1,
    );
    const b = extractStableEventKey(
      { role: "user", content: "hi", timestamp: 1 } as never,
      2,
    );
    expect(a).not.toBe(b);
  });

  it("parses ISO string timestamps into the same millisecond key", () => {
    const key = extractStableEventKey(
      { role: "user", content: "hi", timestamp: "2023-11-14T22:13:20.123Z" } as never,
      conversationId,
    );
    expect(key).toBe("user-event:42:user:1700000000123");
  });

  it("returns a tool-result key using toolUseId fallback for tool messages", () => {
    const key = extractStableEventKey(
      { role: "tool", content: "ok", toolUseId: "call-x" } as never,
      conversationId,
    );
    expect(key).toBe("tool-result:call-x");
  });

  it("ignores string timestamps that fail to parse", () => {
    expect(
      extractStableEventKey(
        { role: "user", content: "hi", timestamp: "not-a-date" } as never,
        conversationId,
      ),
    ).toBeNull();
  });
});