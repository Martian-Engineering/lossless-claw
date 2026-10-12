import { describe, expect, it, vi } from "vitest";
import { toStoredMessage, toStoredMessageIdentity } from "../src/message-content.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import * as tokenAccounting from "../src/token-accounting.js";

describe("reconciliation identity work", () => {
  it("preserves persisted identity without token-accounting structured payloads", () => {
    const messages = [
      { role: "user", content: "A user message" },
      { role: "assistant", content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "answer" }] },
      { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "large payload ".repeat(1000) }] },
      { role: "bashExecution", command: "pwd", output: "/workspace" },
    ] as AgentMessage[];
    const expected = messages.map((message) => {
      const { role, content } = toStoredMessage(message);
      return { role, content };
    });
    const estimate = vi.spyOn(tokenAccounting, "estimateContentTokensForRole");
    try {
      expect(messages.map(toStoredMessageIdentity)).toEqual(expected);
      expect(estimate).not.toHaveBeenCalled();
    } finally {
      estimate.mockRestore();
    }
  });
});
