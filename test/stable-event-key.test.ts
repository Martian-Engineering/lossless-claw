import { describe, expect, it } from "vitest";
import { extractStableEventKey } from "../src/stable-event-key.js";

describe("extractStableEventKey", () => {
  it("returns an assistant-response key for assistant messages with responseId", () => {
    const key = extractStableEventKey({
      role: "assistant",
      content: "hi",
      responseId: "r-1",
    } as never);
    expect(key).toBe("assistant-response:r-1");
  });

  it("falls back to response_id for assistant", () => {
    const key = extractStableEventKey({
      role: "assistant",
      content: "hi",
      response_id: "r-2",
    } as never);
    expect(key).toBe("assistant-response:r-2");
  });

  it("returns a tool-result key for provider-unique toolCallIds", () => {
    expect(
      extractStableEventKey({
        role: "tool",
        content: "ok",
        toolCallId: "toolu_01Y9u9D2Vrv7VdWeLPvHUfwU",
      } as never),
    ).toBe("tool-result:toolu_01Y9u9D2Vrv7VdWeLPvHUfwU");
    expect(
      extractStableEventKey({
        role: "toolResult",
        content: "ok",
        toolCallId: "call_9WAWztsl7y7GR4dDUMm9eUAr",
      } as never),
    ).toBe("tool-result:call_9WAWztsl7y7GR4dDUMm9eUAr");
  });

  it("returns null for recurrent model-authored counter ids (Kimi K3 name:N pattern)", () => {
    // These ids recur across turns; using them as global stable keys silently
    // drops DISTINCT events (2026-08-02 incident). They must fall back to the
    // content/adjacency-bound dedup paths instead.
    expect(
      extractStableEventKey({ role: "tool", content: "(no output)", toolCallId: "exec:101" } as never),
    ).toBeNull();
    expect(
      extractStableEventKey({ role: "toolResult", content: "ok", toolCallId: "read:92" } as never),
    ).toBeNull();
    expect(
      extractStableEventKey({ role: "tool", content: "ok", toolCallId: "web_search:45" } as never),
    ).toBeNull();
  });

  it("returns null for unproven short or dash-shaped tool ids", () => {
    expect(
      extractStableEventKey({ role: "tool", content: "ok", toolCallId: "call-001" } as never),
    ).toBeNull();
    expect(
      extractStableEventKey({ role: "tool", content: "ok", toolCallId: "call_1" } as never),
    ).toBeNull();
  });

  it("returns a tool-result key using toolUseId fallback for tool messages when provider-unique", () => {
    const key = extractStableEventKey({
      role: "tool",
      content: "ok",
      toolUseId: "toolu_01XkkPwLiXaNDMNmTGgNzma4",
    } as never);
    expect(key).toBe("tool-result:toolu_01XkkPwLiXaNDMNmTGgNzma4");
  });

  it("returns a tool-result key when top-level and block ids agree and are provider-unique", () => {
    const key = extractStableEventKey({
      role: "toolResult",
      toolCallId: "toolu_01Xe9eNfegbyW44MtSfQHnJF",
      content: [{ type: "tool_result", tool_use_id: "toolu_01Xe9eNfegbyW44MtSfQHnJF", output: "ok" }],
    } as never);
    expect(key).toBe("tool-result:toolu_01Xe9eNfegbyW44MtSfQHnJF");
  });

  it("returns null for aggregate tool-result messages", () => {
    const key = extractStableEventKey({
      role: "toolResult",
      toolCallId: "call-1",
      content: [
        { type: "tool_result", tool_use_id: "call-1", output: "old" },
        { type: "tool_result", tool_use_id: "call-2", output: "new" },
      ],
    } as never);
    expect(key).toBeNull();
  });

  it("returns null when top-level and block tool ids conflict", () => {
    const key = extractStableEventKey({
      role: "toolResult",
      toolCallId: "call-top",
      content: [{ type: "tool_result", tool_use_id: "call-block", output: "ok" }],
    } as never);
    expect(key).toBeNull();
  });

  it("returns null for user message without responseId or toolCallId", () => {
    expect(extractStableEventKey({ role: "user", content: "hi" } as never)).toBeNull();
  });

  it("returns null for user message with timestamp but no responseId/toolCallId", () => {
    expect(
      extractStableEventKey({
        role: "user",
        content: "hi",
        timestamp: 1_700_000_000_000,
      } as never),
    ).toBeNull();
  });
});
