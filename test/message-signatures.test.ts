import { describe, expect, it } from "vitest";
import { createBootstrapEntryHash } from "../src/message-signatures.js";

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
