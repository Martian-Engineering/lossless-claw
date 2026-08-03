import { describe, expect, it } from "vitest";
import {
  createBootstrapEntryHash,
  createLiveCoverageSignature,
  createLosslessMessageSignature,
} from "../src/message-signatures.js";
import { stripModelIdentityFromMetadataJson } from "../src/message-content.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";

describe("message bootstrap signatures", () => {
  it("canonicalizes OpenClaw inbound metadata for user bootstrap hashes", () => {
    const first = openClawInboundMetadataContent("telegram-1", "please keep this context");
    const second = openClawInboundMetadataContent("telegram-2", "please keep this context");

    expect(createBootstrapEntryHash({ role: "user", content: first, tokenCount: 1 })).toBe(
      createBootstrapEntryHash({ role: "user", content: second, tokenCount: 1 }),
    );
    expect(createBootstrapEntryHash({ role: "assistant", content: first, tokenCount: 1 })).not.toBe(
      createBootstrapEntryHash({ role: "assistant", content: second, tokenCount: 1 }),
    );
  });
});

describe("createLosslessMessageSignature upgrade parity", () => {
  // Pre-upgrade rows have no identity metadata; post-upgrade live messages do.
  // createLosslessMessageSignature must produce the same signature for both
  // so replay-prefix detection and live-coverage matching still work across
  // the upgrade boundary.
  it("strips model identity metadata so pre/post-upgrade signatures match", () => {
    const preUpgrade = {
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
    } as unknown as AgentMessage;
    const postUpgrade = {
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      provider: "anthropic",
      api: "anthropic-messages",
      model: "claude-opus-4-6",
    } as unknown as AgentMessage;
    expect(createLosslessMessageSignature(preUpgrade)).toBe(
      createLosslessMessageSignature(postUpgrade),
    );
  });

  it("strips provider replay signatures so legacy assembled thinking still matches", () => {
    const legacyAssembled = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reasoning" },
        { type: "text", text: "answer" },
      ],
    } as unknown as AgentMessage;
    const postUpgrade = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reasoning", thinkingSignature: "provider-signature" },
        { type: "text", text: "answer" },
      ],
      provider: "anthropic",
      api: "anthropic-messages",
      model: "claude-opus-4-6",
    } as unknown as AgentMessage;

    expect(createLosslessMessageSignature(legacyAssembled)).toBe(
      createLosslessMessageSignature(postUpgrade),
    );
  });

  it("keeps OpenAI encrypted reasoning payloads in message identity", () => {
    const messageWithSignature = (id: string) =>
      ({
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "",
            thinkingSignature: JSON.stringify({ type: "reasoning", id }),
          },
        ],
      }) as unknown as AgentMessage;

    expect(createLosslessMessageSignature(messageWithSignature("rs_1"))).not.toBe(
      createLosslessMessageSignature(messageWithSignature("rs_2")),
    );
  });

  it("keeps opaque signatures when no thinking text can identify the block", () => {
    const messageWithSignature = (thinkingSignature: string) =>
      ({
        role: "assistant",
        content: [{ type: "thinking", thinking: "", thinkingSignature }],
      }) as unknown as AgentMessage;

    expect(createLosslessMessageSignature(messageWithSignature("opaque-1"))).not.toBe(
      createLosslessMessageSignature(messageWithSignature("opaque-2")),
    );
  });
});

describe("createLiveCoverageSignature upgrade parity", () => {
  it("matches legacy text-only assembly to live text plus reasoning_content", () => {
    const legacyAssembled = {
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
    } as unknown as AgentMessage;
    const postUpgrade = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reasoning", thinkingSignature: "reasoning_content" },
        { type: "text", text: "answer" },
      ],
      provider: "moonshot",
      api: "openai-completions",
      model: "kimi-k3",
    } as unknown as AgentMessage;

    expect(createLiveCoverageSignature(legacyAssembled)).toBe(
      createLiveCoverageSignature(postUpgrade),
    );
  });
});

describe("stripModelIdentityFromMetadataJson", () => {
  it("returns input byte-identical when no identity keys present", () => {
    const metadata = JSON.stringify({ originalRole: "assistant", toolCallId: "c1" });
    expect(stripModelIdentityFromMetadataJson(metadata)).toBe(metadata);
  });
  it("returns null for null/undefined input", () => {
    expect(stripModelIdentityFromMetadataJson(null)).toBe(null);
    expect(stripModelIdentityFromMetadataJson(undefined)).toBe(null);
  });
  it("strips identity keys and preserves remaining key order", () => {
    const withIdentity = JSON.stringify({
      originalRole: "assistant",
      modelProvider: "anthropic",
      modelApi: "anthropic-messages",
      modelId: "claude-opus-4-6",
      toolCallId: "c1",
    });
    const stripped = stripModelIdentityFromMetadataJson(withIdentity);
    expect(stripped).toBe(JSON.stringify({ originalRole: "assistant", toolCallId: "c1" }));
  });
});

function openClawInboundMetadataContent(messageId: string, text: string): string {
  return [
    "Conversation info (untrusted metadata):",
    "```json",
    JSON.stringify({
      chat_id: "telegram:chat-1",
      message_id: messageId,
      timestamp: "2026-06-16T00:00:00.000Z",
    }),
    "```",
    "",
    "Sender (untrusted metadata):",
    "```json",
    JSON.stringify({ name: "Syu" }),
    "```",
    "",
    text,
  ].join("\n");
}
