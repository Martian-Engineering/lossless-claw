import { describe, it, expect } from "vitest";
import { structuredPartsIdentity } from "../src/structured-anchor-identity.js";
import { buildMessageParts } from "../src/message-content.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";
const parts = (id: string, args: unknown) =>
  buildMessageParts({
    sessionId: "s",
    fallbackContent: "",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id, name: "bash", arguments: args }],
    } as AgentMessage,
  });
describe("structured anchor identity", () => {
  it("distinguishes blank parent calls by provenance and arguments", () => {
    expect(structuredPartsIdentity(parts("a", { x: 1 }))).not.toBe(
      structuredPartsIdentity(parts("b", { x: 1 })),
    );
    expect(structuredPartsIdentity(parts("a", { x: 1 }))).not.toBe(
      structuredPartsIdentity(parts("a", { x: 2 })),
    );
  });
  it("canonicalizes argument object order", () => {
    expect(structuredPartsIdentity(parts("a", { x: 1, y: 2 }))).toBe(
      structuredPartsIdentity(parts("a", { y: 2, x: 1 })),
    );
  });
});

it("distinguishes result payloads with the same call id", () => {
  const result = (text: string) =>
    buildMessageParts({
      sessionId: "s",
      fallbackContent: text,
      message: {
        role: "toolResult",
        toolCallId: "call",
        toolName: "bash",
        content: [{ type: "text", text }],
      } as AgentMessage,
    });
  expect(structuredPartsIdentity(result("first"))).not.toBe(
    structuredPartsIdentity(result("second")),
  );
});

it("distinguishes non-tool structured metadata without raw blocks", () => {
  const file = (name: string) => [
    { partType: "file" as const, ordinal: 0, metadata: JSON.stringify({ fileName: name }) },
  ];
  expect(structuredPartsIdentity(file("a.pdf"))).not.toBe(structuredPartsIdentity(file("b.pdf")));
});
