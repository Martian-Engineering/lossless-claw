// buildMessageParts empty-content tool-result fallback — unit coverage.
//
// Complements the ingest→assemble regression in
// test/empty-content-tool-result-parts.test.ts with focused unit checks:
//   - exactly which empty-array shapes gain the fallback part (role-gated)
//   - pairing identity / isError preserved in metadata
//   - the fallback part routes through toolResultBlockFromPart (never raw
//     passthrough → a phantom toolCall block)
//   - createLiveCoverageSignature is stable across the live transcript shape
//     and the assembled DB round-trip shape (prevents double-emitting the
//     live message next to the assembled row)
//   - unchanged behavior for ≥1-part shapes and empty user/assistant shapes
import { describe, expect, it } from "vitest";
import {
  blockFromPart,
  contentFromParts,
  isEmptyMessageContent,
} from "../src/assembler.js";
import {
  buildMessageParts,
  normalizeMessageContentForStorage,
  toSyntheticMessagePartRecord,
} from "../src/message-content.js";
import { createLiveCoverageSignature } from "../src/message-signatures.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";

function makeEmptyResult(overrides: Record<string, unknown> = {}): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "update_plan",
    content: [],
    ...overrides,
  } as unknown as AgentMessage;
}

function partsOf(message: AgentMessage, fallbackContent = "") {
  return buildMessageParts({ sessionId: "test", message, fallbackContent });
}

describe("buildMessageParts empty-content tool-result fallback", () => {
  it("rejects oversized details that were not externalized before persistence", () => {
    const message = makeEmptyResult({
      details: { payload: "x".repeat(65_537) },
    });

    expect(() => partsOf(message)).toThrow(
      "Oversized empty tool-result details must be externalized before persistence",
    );
  });

  it("emits one fallback part carrying pairing identity", () => {
    const parts = partsOf(makeEmptyResult());
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      partType: "tool",
      ordinal: 0,
      textContent: " ",
      toolCallId: "call_1",
      toolName: "update_plan",
    });
    const metadata = JSON.parse(parts[0]!.metadata!);
    expect(metadata).toMatchObject({
      originalRole: "toolResult",
      toolCallId: "call_1",
      toolName: "update_plan",
      emptyContentFallback: true,
    });
  });

  it("preserves top-level isError in fallback metadata", () => {
    const parts = partsOf(makeEmptyResult({ isError: true }));
    expect(parts).toHaveLength(1);
    const metadata = JSON.parse(parts[0]!.metadata!);
    expect(metadata.isError).toBe(true);
    const pickIsError = JSON.parse(parts[0]!.metadata!) as { isError?: boolean };
    expect(pickIsError.isError).toBe(true);
  });

  it("handles the raw 'tool' role shape", () => {
    const parts = partsOf({
      role: "tool",
      toolCallId: "call_t",
      toolName: "some_tool",
      content: [],
    } as unknown as AgentMessage);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.toolCallId).toBe("call_t");
    // The fallback always identifies as toolResult so blockFromPart routes
    // through toolResultBlockFromPart (not toolCallBlockFromPart).
    expect(JSON.parse(parts[0]!.metadata!)).toMatchObject({
      originalRole: "toolResult",
      rawType: "tool_result",
      emptyContentFallback: true,
    });
  });

  it("handles callid-less tool rows via the legacy zero-part path (assembly demotes)", () => {
    // No pairing id: a fallback part would rehydrate into an assistant message
    // carrying a tool_result block with no tool_use_id — malformed provider
    // input. ID-less empty rows keep the legacy zero-part behavior (demote
    // to assistant, dropped by the empty-content filter).
    const parts = partsOf({ role: "tool", content: [] } as unknown as AgentMessage);
    expect(parts).toHaveLength(0);
  });

  it("does NOT create parts for genuinely empty assistant messages", () => {
    expect(partsOf({ role: "assistant", content: [] } as AgentMessage)).toHaveLength(0);
  });

  it("does NOT create parts for empty user messages", () => {
    expect(partsOf({ role: "user", content: [] } as AgentMessage)).toHaveLength(0);
  });

  it("does NOT latch onto an id-bearing non-tool message (no phantom toolCalls)", () => {
    // A hypothetical assistant message with empty content and a top-level id
    // must not become a "tool" part: blockFromPart would otherwise emit a
    // phantom toolCall block in the assembled transcript.
    const parts = partsOf({
      role: "assistant",
      id: "some-id",
      content: [],
    } as unknown as AgentMessage);
    expect(parts).toHaveLength(0);
  });

  it("keeps assistant content=[] + reasoning_content unchanged (reasoning part only)", () => {
    const parts = partsOf({
      role: "assistant",
      content: [],
      reasoning_content: "internal thinking",
    } as unknown as AgentMessage);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.partType).toBe("reasoning");
  });

  it("leaves string-content tool results untouched (no fallback part)", () => {
    const parts = partsOf(
      {
        role: "toolResult",
        toolCallId: "call_s",
        content: "Plan updated",
      } as unknown as AgentMessage,
      "Plan updated",
    );
    expect(parts).toHaveLength(1);
    expect(parts[0]!.partType).toBe("text");
    expect(parts[0]!.textContent).toBe("Plan updated");
    expect(JSON.parse(parts[0]!.metadata!).emptyContentFallback).toBeUndefined();
  });

  it("leaves non-empty block-array tool results untouched", () => {
    const parts = partsOf({
      role: "toolResult",
      toolCallId: "call_b",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_b",
          content: [{ type: "text", text: "output text" }],
        },
      ],
    } as unknown as AgentMessage);
    expect(parts).toHaveLength(1);
    expect(JSON.parse(parts[0]!.metadata!).emptyContentFallback).toBeUndefined();
  });
});

describe("fallback part assembly routing", () => {
  it("rehydrates as a provider-valid text block via the fallback metadata", () => {
    const records = partsOf(makeEmptyResult()).map((part) =>
      toSyntheticMessagePartRecord(part, 1),
    );
    const block = blockFromPart(records[0]!) as Record<string, unknown>;
    // Provider adapters only accept text/image blocks inside toolResult
    // message content — the fallback rehydrates as whitespace text; pairing
    // identity lives on the surrounding message's top-level toolCallId (set
    // from the part by resolveMessageItem), NOT a nested tool_result block.
    expect(block.type).toBe("text");
    expect(block.text).toBe(" ");
    expect(block.tool_use_id).toBeUndefined();
    expect(block.id).toBeUndefined();
    expect(block.call_id).toBeUndefined();
    expect(JSON.stringify(block)).not.toContain("emptyContentFallback");
  });

  it("contentFromParts yields a serializable toolResult content (Anthropic + OpenAI)", () => {
    const records = partsOf(makeEmptyResult()).map((part) =>
      toSyntheticMessagePartRecord(part, 1),
    );
    const content = contentFromParts(records, "toolResult", "");
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("text");
    expect(blocks[0]!.text).toBe(" ");
    // JSON round-trip: no undefined/functions.
    expect(JSON.parse(JSON.stringify(blocks[0]))).toEqual(blocks[0]);
    // Survives the universal empty-content filter.
    expect(isEmptyMessageContent({ role: "toolResult", content })).toBe(false);
  });

  it("normalizeMessageContentForStorage keeps a text block shape", () => {
    const normalized = normalizeMessageContentForStorage({
      message: makeEmptyResult(),
      fallbackContent: "",
    });
    expect(Array.isArray(normalized)).toBe(true);
    const blocks = normalized as Array<Record<string, unknown>>;
    expect(blocks[0]!.type).toBe("text");
    expect(blocks[0]!.tool_use_id).toBeUndefined();
  });
});

describe("live-coverage signature stability across DB round-trip", () => {
  it("live empty-content result matches its assembled reconstruction", () => {
    const liveMessage = makeEmptyResult({ toolCallId: "call_0123456789abcdef" });
    const assembled = {
      role: "toolResult",
      toolCallId: "call_0123456789abcdef",
      toolName: "update_plan",
      content: [
        {
          type: "tool_result",
          name: "update_plan",
          output: " ",
          tool_use_id: "call_0123456789abcdef",
        },
      ],
    } as unknown as AgentMessage;
    expect(createLiveCoverageSignature(liveMessage)).toBe(
      createLiveCoverageSignature(assembled),
    );
  });

  it("live empty-content result with tool_use_id block id matches assembly", () => {
    // The live shape carries the tool_result block with tool_use_id but may
    // lack a top-level toolName. The assembled shape has toolName filled in
    // from part metadata. Both have the same provider-unique toolCallId, so
    // the canonical empty-tool-result signature keys on (role, toolCallId)
    // only — toolName is intentionally omitted because it may be present on
    // one representation and absent on the other.
    const liveIded = {
      role: "toolResult",
      toolCallId: "call_0123456789abcdef",
      content: [{ type: "tool_result", tool_use_id: "call_0123456789abcdef", output: "" }],
    } as unknown as AgentMessage;
    const assembled = {
      role: "toolResult",
      toolCallId: "call_0123456789abcdef",
      toolName: "update_plan",
      content: [
        {
          type: "tool_result",
          name: "update_plan",
          output: " ",
          tool_use_id: "call_0123456789abcdef",
        },
      ],
    } as unknown as AgentMessage;
    expect(createLiveCoverageSignature(liveIded)).toBe(
      createLiveCoverageSignature(assembled),
    );
  });

  it.each([
    ["empty string", ""],
    ["empty array", []],
  ])("live tool_result block with %s content matches assembly", (_label, content) => {
    const toolCallId = "call_0123456789abcdef";
    const live = {
      role: "toolResult",
      toolCallId,
      content: [{ type: "tool_result", tool_use_id: toolCallId, content }],
    } as unknown as AgentMessage;
    const assembled = {
      role: "toolResult",
      toolCallId,
      content: [{ type: "text", text: " " }],
    } as unknown as AgentMessage;

    expect(createLiveCoverageSignature(live)).toBe(
      createLiveCoverageSignature(assembled),
    );
  });

  it("canonical empty-result signature refuses recurrent model-authored ids", () => {
    // Kimi K3 `name:N` counters recur across turns: (role, toolCallId) does
    // not identify an event, so recurrent ids must fall back to the full
    // lossless signature (byte-shaped), distinct per representation.
    const liveRecurrent = makeEmptyResult({ toolCallId: "update_plan:7" });
    expect(createLiveCoverageSignature(liveRecurrent)).not.toContain(
      "canonical-empty-tool-result",
    );
    const assembledRecurrent = {
      role: "toolResult",
      toolCallId: "update_plan:7",
      content: [
        { type: "tool_result", output: " ", tool_use_id: "update_plan:7" },
      ],
    } as unknown as AgentMessage;
    expect(createLiveCoverageSignature(assembledRecurrent)).not.toContain(
      "canonical-empty-tool-result",
    );
    expect(
      createLiveCoverageSignature(makeEmptyResult({ toolCallId: "toolu_01CanonicalTestID" })),
    ).toContain("canonical-empty-tool-result");
  });

  it("live empty-content result with NO call id does not signature-collide with an ided row", () => {
    // The id-less result falls back to the full lossless signature (which
    // includes parts metadata) while the ided result canonicalizes to
    // canonical-empty-tool-result — they cannot collide.
    const liveNoId = {
      role: "toolResult",
      content: [{ type: "tool_result", output: "" }],
    } as unknown as AgentMessage;
    const assembledWithId = {
      role: "toolResult",
      toolCallId: "call_1",
      content: [
        { type: "tool_result", name: "update_plan", output: " ", tool_use_id: "call_1" },
      ],
    } as unknown as AgentMessage;
    expect(createLiveCoverageSignature(liveNoId)).not.toBe(
      createLiveCoverageSignature(assembledWithId),
    );
  });

  it("does NOT canonicalize a tool_result block with real content as empty (autoreview P1)", () => {
    // A tool_result block whose structured text extraction is empty (because
    // extractStructuredText skips tool blocks) but whose raw.content carries
    // a real text payload must NOT be canonicalized as an empty result —
    // otherwise coverage dedup would suppress the live representation.
    const liveWithContent = {
      role: "toolResult",
      toolCallId: "call_1",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: [{ type: "text", text: "real output" }],
        },
      ],
    } as unknown as AgentMessage;
    const emptyResult = {
      role: "toolResult",
      toolCallId: "call_1",
      content: [],
    } as unknown as AgentMessage;
    // The content-bearing message must NOT match the empty result's signature.
    expect(createLiveCoverageSignature(liveWithContent)).not.toBe(
      createLiveCoverageSignature(emptyResult),
    );
  });
});
