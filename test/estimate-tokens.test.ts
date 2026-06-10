import { describe, it, expect } from "vitest";
import {
  estimateSerializedMessageTokens,
  estimateSerializedMessagesTokens,
  estimateTokens,
} from "../src/estimate-tokens.js";

describe("estimateTokens", () => {
  it("estimates ASCII text at ~0.25 tokens/char", () => {
    expect(estimateTokens("Hello world")).toBe(3); // 11 chars × 0.25 = 2.75 → 3
  });

  it("estimates CJK Han at ~1.5 tokens/char", () => {
    expect(estimateTokens("你好世界")).toBe(6); // 4 chars × 1.5 = 6
  });

  it("estimates Hiragana at ~1.5 tokens/char", () => {
    expect(estimateTokens("こんにちは")).toBe(8); // 5 chars × 1.5 = 7.5 → 8
  });

  it("estimates Katakana at ~1.5 tokens/char", () => {
    expect(estimateTokens("カタカナ")).toBe(6); // 4 chars × 1.5 = 6
  });

  it("estimates Hangul at ~1.5 tokens/char", () => {
    expect(estimateTokens("안녕하세요")).toBe(8); // 5 chars × 1.5 = 7.5 → 8
  });

  it("estimates emoji at ~2 tokens/char", () => {
    expect(estimateTokens("🔥🎉💯")).toBe(6); // 3 emoji × 2 = 6
  });

  it("handles mixed CJK + ASCII + emoji", () => {
    const result = estimateTokens("Hello 你好 🔥");
    // 5 ASCII (1.25) + space (0.25) + 2 Han (3) + space (0.25) + emoji (2) = 6.75 → 7
    expect(result).toBe(7);
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("estimates CJK Extension B characters", () => {
    // 𠮷 (U+20BB7, CJK Extension B)
    expect(estimateTokens("𠮷")).toBe(2); // supplementary plane CJK → 1.5 → 2
  });

  it("estimates fullwidth forms at ~1.5 tokens/char", () => {
    expect(estimateTokens("ＡＢＣ")).toBe(5); // 3 fullwidth × 1.5 = 4.5 → 5
  });

  it("estimates CJK punctuation at ~1.5 tokens/char", () => {
    expect(estimateTokens("、。！")).toBe(5); // 3 chars × 1.5 = 4.5 → 5
  });
});

describe("estimateSerializedMessageTokens", () => {
  it("counts structured tool payloads that text-only estimates miss", () => {
    // Codex-era mirrored tool result: payload duplicated across `content`
    // and `text` plus identifier spam. A text-only estimate sees only the
    // `text` field; the serialized estimate must see the whole structure.
    const payload = "x".repeat(12_000);
    const message = {
      role: "toolResult",
      toolCallId: "call_0123456789",
      toolName: "exec",
      content: [
        {
          type: "toolResult",
          id: "call_0123456789",
          toolCallId: "call_0123456789",
          toolUseId: "call_0123456789",
          tool_use_id: "call_0123456789",
          content: payload,
          text: payload,
        },
      ],
      timestamp: 1781035270000,
    };
    const serialized = estimateSerializedMessageTokens(message);
    const textOnly = estimateTokens(payload);
    // Both payload copies plus envelope must count: at least ~2x text-only.
    expect(serialized).toBeGreaterThan(textOnly * 1.9);
  });

  it("counts assistant tool-call arguments with no text blocks", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_1",
          name: "write_file",
          arguments: { path: "/tmp/file", body: "y".repeat(8_000) },
        },
      ],
    };
    expect(estimateSerializedMessageTokens(message)).toBeGreaterThan(2_000);
  });

  it("substitutes a fixed cost for embedded base64 payloads", () => {
    const base64 = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=".repeat(2_000); // ~74k chars
    const message = {
      role: "user",
      content: [{ type: "image", data: base64 }],
    };
    const estimate = estimateSerializedMessageTokens(message);
    // Full-length counting would be ~18.5k tokens; the fixed substitution
    // keeps it near the per-part cost plus envelope.
    expect(estimate).toBeLessThan(2_500);
    expect(estimate).toBeGreaterThan(1_500);
  });

  it("substitutes a fixed cost for data: URLs", () => {
    const dataUrl = `data:image/png;base64,${"A".repeat(50_000)}`;
    const message = { role: "user", content: [{ type: "image", image: dataUrl }] };
    expect(estimateSerializedMessageTokens(message)).toBeLessThan(2_500);
  });

  it("counts base64 embedded in text fields in full (not substituted)", () => {
    // Base64/hex inside tool-result TEXT is tokenized per character at the
    // model boundary; only image/document source fields get the fixed cost.
    const base64Text = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0".repeat(2_200); // ~80k chars
    const message = {
      role: "toolResult",
      content: [{ type: "text", text: base64Text }],
    };
    expect(estimateSerializedMessageTokens(message)).toBeGreaterThan(15_000);
  });

  it("counts repeated shared block references in full", () => {
    const block = { type: "text", text: "shared block ".repeat(100) };
    const shared = { role: "user", content: [block, block] };
    const distinct = {
      role: "user",
      content: [
        { type: "text", text: "shared block ".repeat(100) },
        { type: "text", text: "shared block ".repeat(100) },
      ],
    };
    const sharedEstimate = estimateSerializedMessageTokens(shared);
    const distinctEstimate = estimateSerializedMessageTokens(distinct);
    expect(Math.abs(sharedEstimate - distinctEstimate)).toBeLessThan(5);
  });

  it("does not substitute ordinary long prose", () => {
    const prose = ("The quick brown fox jumps over the lazy dog. ").repeat(200); // ~9k chars
    const message = { role: "user", content: prose };
    const estimate = estimateSerializedMessageTokens(message);
    expect(estimate).toBeGreaterThan(2_000); // counted in full, not substituted
  });

  it("survives circular references without throwing", () => {
    const message: Record<string, unknown> = { role: "user", content: "hello" };
    message.self = message;
    expect(() => estimateSerializedMessageTokens(message)).not.toThrow();
    expect(estimateSerializedMessageTokens(message)).toBeGreaterThan(0);
  });

  it("sums across message lists", () => {
    const message = { role: "user", content: "hello world" };
    const single = estimateSerializedMessageTokens(message);
    expect(estimateSerializedMessagesTokens([message, message])).toBe(single * 2);
  });
});
