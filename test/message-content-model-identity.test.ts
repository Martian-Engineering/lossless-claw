import { describe, expect, it } from "vitest";
import { buildMessageParts } from "../src/message-content.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";

function partMetadata(part: { metadata?: string | null }): Record<string, unknown> {
  return JSON.parse(part.metadata ?? "{}") as Record<string, unknown>;
}

describe("buildMessageParts model identity persistence", () => {
  it("stores assistant provider/api/model/responseModel in ordinal-0 part metadata", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reasoning text", thinkingSignature: "reasoning_content" },
        { type: "text", text: "visible answer" },
      ],
      provider: "xiaomi",
      api: "anthropic-messages",
      model: "kimi-k3",
      responseModel: "kimi-k3",
    } as unknown as AgentMessage;

    const parts = buildMessageParts({
      sessionId: "session-1",
      message,
      fallbackContent: "visible answer",
    });

    expect(parts.length).toBe(2);
    expect(partMetadata(parts[0]!)).toMatchObject({
      modelProvider: "xiaomi",
      modelApi: "anthropic-messages",
      modelId: "kimi-k3",
      responseModelId: "kimi-k3",
    });
    const laterMetadata = partMetadata(parts[1]!);
    expect(laterMetadata).not.toHaveProperty("modelProvider");
    expect(laterMetadata).not.toHaveProperty("modelId");
  });

  it("stores identity for string-content assistant messages", () => {
    const message = {
      role: "assistant",
      content: "plain text reply",
      provider: "anthropic",
      api: "anthropic-messages",
      model: "claude-opus-4-6",
    } as unknown as AgentMessage;

    const parts = buildMessageParts({
      sessionId: "session-1",
      message,
      fallbackContent: "plain text reply",
    });

    expect(parts.length).toBe(1);
    expect(partMetadata(parts[0]!)).toMatchObject({
      modelProvider: "anthropic",
      modelApi: "anthropic-messages",
      modelId: "claude-opus-4-6",
    });
    expect(partMetadata(parts[0]!)).not.toHaveProperty("responseModelId");
  });

  it("does not store identity fields for non-assistant messages", () => {
    const message = {
      role: "user",
      content: "hello",
      provider: "anthropic",
      model: "claude-opus-4-6",
    } as unknown as AgentMessage;

    const parts = buildMessageParts({
      sessionId: "session-1",
      message,
      fallbackContent: "hello",
    });

    expect(parts.length).toBe(1);
    const metadata = partMetadata(parts[0]!);
    expect(metadata).not.toHaveProperty("modelProvider");
    expect(metadata).not.toHaveProperty("modelApi");
    expect(metadata).not.toHaveProperty("modelId");
  });

  it("omits identity keys entirely when the assistant message carries none", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "legacy shape" }],
    } as unknown as AgentMessage;

    const parts = buildMessageParts({
      sessionId: "session-1",
      message,
      fallbackContent: "legacy shape",
    });

    expect(parts.length).toBe(1);
    const metadata = partMetadata(parts[0]!);
    expect(metadata).not.toHaveProperty("modelProvider");
    expect(metadata).not.toHaveProperty("modelApi");
    expect(metadata).not.toHaveProperty("modelId");
    expect(metadata).not.toHaveProperty("responseModelId");
  });
});

describe("partial identity gating (host requires provider+api+model)", () => {
  it("does not store identity when only responseModel is present", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reasoning", thinkingSignature: "reasoning_content" },
        { type: "text", text: "answer" },
      ],
      responseModel: "kimi-k3",
    } as unknown as AgentMessage;

    const parts = buildMessageParts({
      sessionId: "session-1",
      message,
      fallbackContent: "answer",
    });

    const metadata = partMetadata(parts[0]!);
    expect(metadata).not.toHaveProperty("modelProvider");
    expect(metadata).not.toHaveProperty("modelApi");
    expect(metadata).not.toHaveProperty("modelId");
    expect(metadata).not.toHaveProperty("responseModelId");
  });

  it("does not store identity when api is missing (host same-model check would fail)", () => {
    const message = {
      role: "assistant",
      content: "text",
      provider: "xiaomi",
      model: "kimi-k3",
    } as unknown as AgentMessage;

    const parts = buildMessageParts({
      sessionId: "session-1",
      message,
      fallbackContent: "text",
    });

    const metadata = partMetadata(parts[0]!);
    expect(metadata).not.toHaveProperty("modelProvider");
    expect(metadata).not.toHaveProperty("modelId");
  });

  it("stores identity when provider+api+model are all present without responseModel", () => {
    const message = {
      role: "assistant",
      content: "text",
      provider: "xiaomi",
      api: "anthropic-messages",
      model: "kimi-k3",
    } as unknown as AgentMessage;

    const parts = buildMessageParts({
      sessionId: "session-1",
      message,
      fallbackContent: "text",
    });

    expect(partMetadata(parts[0]!)).toMatchObject({
      modelProvider: "xiaomi",
      modelApi: "anthropic-messages",
      modelId: "kimi-k3",
    });
  });
});
