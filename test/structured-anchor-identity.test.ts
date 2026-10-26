import { describe, it, expect } from "vitest";
import { structuredPartsIdentity, toolProvenanceIdentity } from "../src/structured-anchor-identity.js";
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
  it("ignores model affinity when replaying legacy structured parts", () => {
    const message = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call", name: "bash", arguments: { command: "pwd" } }],
    } as AgentMessage;
    const legacyParts = buildMessageParts({ sessionId: "s", message, fallbackContent: "" });
    const replayParts = buildMessageParts({
      sessionId: "s",
      fallbackContent: "",
      message: {
        ...message,
        provider: "provider",
        api: "api",
        model: "requested-model",
        responseModel: "resolved-model",
      } as AgentMessage,
    });

    // Exercise the actual persisted metadata, including the resolved model id.
    expect(JSON.parse(replayParts[0]!.metadata!)).toMatchObject({
      responseModelId: "resolved-model",
    });
    expect(structuredPartsIdentity(replayParts)).toBe(structuredPartsIdentity(legacyParts));
  });

  it.each([
    { label: "tool name", toolCallId: "call", changed: { toolName: "read" } },
    { label: "error flag", toolCallId: "call", changed: { isError: true } },
    { label: "tool name without a call id", toolCallId: undefined, changed: { toolName: "read" } },
    { label: "error flag without a call id", toolCallId: undefined, changed: { isError: true } },
  ])("distinguishes string result $label stored only in metadata", ({ toolCallId, changed }) => {
    const message = {
      role: "toolResult",
      content: "same output",
      toolCallId,
      toolName: "bash",
      isError: false,
    };
    const stored = buildMessageParts({ sessionId: "s", fallbackContent: "", message });
    const incoming = buildMessageParts({
      sessionId: "s", fallbackContent: "", message: { ...message, ...changed },
    });
    expect(stored[0]).toMatchObject({ partType: "text", textContent: "same output" });
    expect(stored[0]!.toolCallId).toBeUndefined();
    expect(stored[0]!.toolName).toBeUndefined();
    const metadata = JSON.parse(stored[0]!.metadata!);
    expect(metadata).toMatchObject({ toolName: "bash", isError: false });
    expect(metadata.toolCallId).toBe(toolCallId);
    expect(structuredPartsIdentity(stored)).not.toBeNull();
    expect(structuredPartsIdentity(incoming)).not.toBe(structuredPartsIdentity(stored));
    expect(structuredPartsIdentity(buildMessageParts({
      sessionId: "other", fallbackContent: "", message: { ...message },
    }))).toBe(structuredPartsIdentity(stored));
  });

  it("ignores model affinity on metadata-only tool provenance but keeps plain text unstructured", () => {
    const message = { role: "assistant", content: "same text" };
    const modelIdentity = {
      provider: "provider", api: "api", model: "requested-model", responseModel: "resolved-model",
    };
    const build = (message: AgentMessage) =>
      buildMessageParts({ sessionId: "s", fallbackContent: "", message });
    expect(structuredPartsIdentity(build(message))).toBeNull();
    expect(structuredPartsIdentity(build({ ...message, ...modelIdentity }))).toBeNull();
    const tool = { ...message, toolCallId: "call", toolName: "bash", isError: false };
    expect(structuredPartsIdentity(build(tool))).not.toBeNull();
    expect(structuredPartsIdentity(build({ ...tool, ...modelIdentity }))).toBe(
      structuredPartsIdentity(build(tool)),
    );
  });

  it.each([
    { label: "without an envelope id", envelopeId: undefined },
    { label: "overriding an envelope id", envelopeId: "envelope-call" },
  ])("keeps authored text-block call ids $label", ({ envelopeId }) => {
    const build = (id: string, alias: "tool_call_id" | "toolCallId" = "tool_call_id") =>
      buildMessageParts({
        sessionId: "s",
        fallbackContent: "same output",
        message: {
          role: "toolResult",
          toolCallId: envelopeId,
          content: [{ type: "text", text: "same output", [alias]: id }],
        },
      });
    const original = build("exec:101");
    expect(original[0]!.toolCallId).toBe("exec:101");
    expect(toolProvenanceIdentity(build("exec:101"))).toBe(toolProvenanceIdentity(original));
    expect(toolProvenanceIdentity(build("exec:101", "toolCallId"))).toBe(
      toolProvenanceIdentity(original),
    );
    expect(toolProvenanceIdentity(build("exec:102"))).not.toBe(toolProvenanceIdentity(original));
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
