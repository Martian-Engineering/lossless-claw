import { describe, expect, it } from "vitest";
import {
  extractStableEventKey,
  isProviderUniqueToolCallId,
} from "../src/stable-event-key.js";

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

  it("returns a tool-result key for provider-minted toolCallIds", () => {
    const toolCallId = "call_123456789012";
    expect(
      extractStableEventKey({ role: "tool", content: "ok", toolCallId } as never),
    ).toBe(`tool-result:${toolCallId}`);
    expect(
      extractStableEventKey({
        role: "toolResult",
        content: "ok",
        toolCallId: "toolu_123456789012",
      } as never),
    ).toBe("tool-result:toolu_123456789012");
  });

  it("returns a tool-result key using toolUseId fallback for tool messages", () => {
    const key = extractStableEventKey({
      role: "tool",
      content: "ok",
      toolUseId: "call_abcdefghijkl",
    } as never);
    expect(key).toBe("tool-result:call_abcdefghijkl");
  });

  it("returns a tool-result key when top-level and block ids agree", () => {
    const toolCallId = "call_123456789012";
    const key = extractStableEventKey({
      role: "toolResult",
      toolCallId,
      content: [{ type: "tool_result", tool_use_id: toolCallId, output: "ok" }],
    } as never);
    expect(key).toBe(`tool-result:${toolCallId}`);
  });

  it("returns null for aggregate tool-result messages", () => {
    const key = extractStableEventKey({
      role: "toolResult",
      toolCallId: "call_123456789012",
      content: [
        { type: "tool_result", tool_use_id: "call_123456789012", output: "old" },
        { type: "tool_result", tool_use_id: "call_abcdefghijkl", output: "new" },
      ],
    } as never);
    expect(key).toBeNull();
  });

  it("returns null when top-level and block tool ids conflict", () => {
    const key = extractStableEventKey({
      role: "toolResult",
      toolCallId: "call_123456789012",
      content: [{ type: "tool_result", tool_use_id: "call_abcdefghijkl", output: "ok" }],
    } as never);
    expect(key).toBeNull();
  });

  it("rejects recurrent model-authored tool ids as global identities", () => {
    for (const toolCallId of ["exec:101", "update_plan:7", "call-1"]) {
      expect(isProviderUniqueToolCallId(toolCallId)).toBe(false);
      expect(
        extractStableEventKey({ role: "toolResult", content: "same", toolCallId } as never),
      ).toBeNull();
    }
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
