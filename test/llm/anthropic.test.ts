import { describe, it, expect, vi } from "vitest";
import { createAnthropicSummarizer } from "../../src/llm/anthropic.js";

describe("createAnthropicSummarizer", () => {
  it("calls Anthropic and returns text", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "Summary." }],
    });
    const summarizer = createAnthropicSummarizer({
      model: "claude-haiku-4-5-20251001", apiKey: "sk-test",
      _clientOverride: { messages: { create: mockCreate } } as any,
    });
    const result = await summarizer("Conversation text", false, { isCondensed: false });
    expect(result).toBe("Summary.");
    expect(mockCreate).toHaveBeenCalledOnce();
    const args = mockCreate.mock.calls[0][0];
    expect(args.model).toBe("claude-haiku-4-5-20251001");
    expect(args.max_tokens).toBe(1024);
    expect(args.system).toBeDefined();
  });

  it("retries once on empty content, then returns", async () => {
    const mockCreate = vi.fn()
      .mockResolvedValueOnce({ content: [] })
      .mockResolvedValueOnce({ content: [{ type: "text", text: "Retry." }] });
    const summarizer = createAnthropicSummarizer({
      model: "claude-haiku-4-5-20251001", apiKey: "sk-test",
      _clientOverride: { messages: { create: mockCreate } } as any,
    });
    expect(await summarizer("text", false)).toBe("Retry.");
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("throws immediately on 401 auth error", async () => {
    const err = Object.assign(new Error("auth"), { status: 401 });
    const mockCreate = vi.fn().mockRejectedValue(err);
    const summarizer = createAnthropicSummarizer({
      model: "claude-haiku-4-5-20251001", apiKey: "bad",
      _clientOverride: { messages: { create: mockCreate } } as any,
    });
    await expect(summarizer("text", false)).rejects.toThrow("auth");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("retries 3 times on 429 rate limit then throws", async () => {
    const err = Object.assign(new Error("rate limited"), { status: 429 });
    const mockCreate = vi.fn().mockRejectedValue(err);
    const summarizer = createAnthropicSummarizer({
      model: "claude-haiku-4-5-20251001", apiKey: "sk-test",
      _clientOverride: { messages: { create: mockCreate } } as any,
      _retryDelayMs: 0,
    });
    await expect(summarizer("text", false)).rejects.toThrow("rate limited");
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });
});
