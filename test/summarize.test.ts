import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLcmSummarizeFromLegacyParams } from "../src/summarize.js";
import type { LcmDependencies } from "../src/types.js";

function makeDeps(overrides?: Partial<LcmDependencies>): LcmDependencies {
  return {
    config: {
      enabled: true,
      databasePath: ":memory:",
      contextThreshold: 0.75,
      freshTailCount: 8,
      leafMinFanout: 8,
      condensedMinFanout: 4,
      condensedMinFanoutHard: 2,
      incrementalMaxDepth: 0,
      leafChunkTokens: 20_000,
      leafTargetTokens: 600,
      condensedTargetTokens: 900,
      maxExpandTokens: 120,
      largeFileTokenThreshold: 25_000,
      largeFileSummaryProvider: "",
      largeFileSummaryModel: "",
      autocompactDisabled: false,
      timezone: "UTC",
      pruneHeartbeatOk: false,
    },
    complete: vi.fn(async () => ({
      content: [{ type: "text", text: "summary output" }],
    })),
    callGateway: vi.fn(async () => ({})),
    resolveModel: vi.fn(() => ({
      provider: "anthropic",
      model: "claude-opus-4-5",
    })),
    getApiKey: vi.fn(() => "test-api-key"),
    requireApiKey: vi.fn(() => "test-api-key"),
    parseAgentSessionKey: vi.fn(() => null),
    isSubagentSessionKey: vi.fn(() => false),
    normalizeAgentId: vi.fn(() => "main"),
    buildSubagentSystemPrompt: vi.fn(() => ""),
    readLatestAssistantReply: vi.fn(() => undefined),
    resolveAgentDir: vi.fn(() => "/tmp/openclaw-agent"),
    resolveSessionIdFromSessionKey: vi.fn(async () => undefined),
    agentLaneSubagent: "subagent",
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    ...overrides,
  } as LcmDependencies;
}

describe("createLcmSummarizeFromLegacyParams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns undefined when model resolution fails", async () => {
    const deps = makeDeps({
      resolveModel: vi.fn(() => {
        throw new Error("no model");
      }),
    });

    await expect(
      createLcmSummarizeFromLegacyParams({
        deps,
        legacyParams: {
          provider: "anthropic",
          model: "claude-opus-4-5",
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("builds distinct normal vs aggressive prompts", async () => {
    const deps = makeDeps();

    const summarize = await createLcmSummarizeFromLegacyParams({
      deps,
      legacyParams: {
        provider: "anthropic",
        model: "claude-opus-4-5",
      },
      customInstructions: "Keep implementation caveats.",
    });

    expect(summarize).toBeTypeOf("function");

    await summarize!("A".repeat(8_000), false);
    await summarize!("A".repeat(8_000), true);

    const completeMock = vi.mocked(deps.complete);
    expect(completeMock).toHaveBeenCalledTimes(2);

    const normalPrompt = completeMock.mock.calls[0]?.[0]?.messages?.[0]?.content as string;
    const aggressivePrompt = completeMock.mock.calls[1]?.[0]?.messages?.[0]?.content as string;

    expect(normalPrompt).toContain("Normal summary policy:");
    expect(aggressivePrompt).toContain("Aggressive summary policy:");
    expect(normalPrompt).toContain("Keep implementation caveats.");

    const normalMaxTokens = Number(completeMock.mock.calls[0]?.[0]?.maxTokens ?? 0);
    const aggressiveMaxTokens = Number(completeMock.mock.calls[1]?.[0]?.maxTokens ?? 0);
    expect(aggressiveMaxTokens).toBeLessThan(normalMaxTokens);
    expect(completeMock.mock.calls[1]?.[0]?.temperature).toBe(0.1);
  });

  it("uses condensed prompt mode for condensed summaries", async () => {
    const deps = makeDeps();
    const summarize = await createLcmSummarizeFromLegacyParams({
      deps,
      legacyParams: {
        provider: "anthropic",
        model: "claude-opus-4-5",
      },
    });

    await summarize!("A".repeat(8_000), false, { isCondensed: true });

    const completeMock = vi.mocked(deps.complete);
    expect(completeMock).toHaveBeenCalledTimes(1);
    const prompt = completeMock.mock.calls[0]?.[0]?.messages?.[0]?.content as string;
    const requestOptions = completeMock.mock.calls[0]?.[0] as {
      reasoning?: "high" | "medium" | "low";
    };

    expect(prompt).toContain("<conversation_to_condense>");
    expect(requestOptions.reasoning).toBeUndefined();
  });

  it("passes resolved API key to completion calls", async () => {
    const deps = makeDeps({
      getApiKey: vi.fn(() => "resolved-api-key"),
    });

    const summarize = await createLcmSummarizeFromLegacyParams({
      deps,
      legacyParams: {
        provider: "anthropic",
        model: "claude-opus-4-5",
      },
    });

    await summarize!("Summary input");

    const completeMock = vi.mocked(deps.complete);
    expect(completeMock.mock.calls[0]?.[0]?.apiKey).toBe("resolved-api-key");
  });

  it("falls back deterministically when model returns empty summary output after retry", async () => {
    const deps = makeDeps({
      complete: vi.fn(async () => ({
        content: [],
      })),
    });

    const summarize = await createLcmSummarizeFromLegacyParams({
      deps,
      legacyParams: {
        provider: "anthropic",
        model: "claude-opus-4-5",
      },
    });

    const longInput = "A".repeat(12_000);
    const summary = await summarize!(longInput, false);

    // Should have called complete twice: original + retry.
    const completeMock = vi.mocked(deps.complete);
    expect(completeMock).toHaveBeenCalledTimes(2);

    expect(summary.length).toBeGreaterThan(0);
    expect(summary).toContain("[LCM fallback summary; truncated for context management]");
  });

  it("normalizes OpenAI output_text and reasoning summary blocks", async () => {
    const deps = makeDeps({
      resolveModel: vi.fn(() => ({
        provider: "openai",
        model: "gpt-5.3-codex",
      })),
      complete: vi.fn(async () => ({
        content: [
          {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "Reasoning summary line." }],
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Final condensed summary." }],
          },
        ],
      })),
    });

    const summarize = await createLcmSummarizeFromLegacyParams({
      deps,
      legacyParams: {
        provider: "openai",
        model: "gpt-5.3-codex",
      },
    });

    const summary = await summarize!("Input segment");

    expect(summary).toContain("Reasoning summary line.");
    expect(summary).toContain("Final condensed summary.");
  });

  it("logs provider/model/block diagnostics when normalized summary is empty", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const deps = makeDeps({
        resolveModel: vi.fn(() => ({
          provider: "openai",
          model: "gpt-5.3-codex",
        })),
        complete: vi.fn(async () => ({
          content: [{ type: "reasoning" }],
        })),
      });

      const summarize = await createLcmSummarizeFromLegacyParams({
        deps,
        legacyParams: {
          provider: "openai",
          model: "gpt-5.3-codex",
        },
      });

      const summary = await summarize!("A".repeat(12_000));
      expect(summary).toContain("[LCM fallback summary; truncated for context management]");

      const diagnostics = consoleError.mock.calls
        .flatMap((call) => call.map((entry) => String(entry)))
        .join(" ");
      expect(diagnostics).toContain("provider=openai");
      expect(diagnostics).toContain("model=gpt-5.3-codex");
      expect(diagnostics).toContain("block_types=reasoning");
    } finally {
      consoleError.mockRestore();
    }
  });

  // --- Empty-summary hardening: focused tests ---

  describe("empty-summary retry and diagnostics", () => {
    it("retries with conservative settings when first attempt returns empty content array", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        let callCount = 0;
        const deps = makeDeps({
          resolveModel: vi.fn(() => ({
            provider: "openai",
            model: "gpt-5.3-codex",
          })),
          complete: vi.fn(async () => {
            callCount++;
            if (callCount === 1) {
              // First call returns empty content array.
              return { content: [] };
            }
            // Retry succeeds with a valid text block.
            return { content: [{ type: "text", text: "Recovered summary from retry." }] };
          }),
        });

        const summarize = await createLcmSummarizeFromLegacyParams({
          deps,
          legacyParams: { provider: "openai", model: "gpt-5.3-codex" },
        });

        const summary = await summarize!("A".repeat(8_000), false);

        // Retry should have succeeded — no fallback truncation marker.
        expect(summary).toBe("Recovered summary from retry.");
        expect(vi.mocked(deps.complete)).toHaveBeenCalledTimes(2);

        // Retry call should use conservative settings.
        const retryArgs = vi.mocked(deps.complete).mock.calls[1]?.[0];
        expect(retryArgs?.temperature).toBe(0.05);
        expect(retryArgs?.reasoning).toBe("low");

        // Should log the retry-succeeded diagnostic.
        const diagnostics = consoleError.mock.calls
          .flatMap((c) => c.map(String))
          .join(" ");
        expect(diagnostics).toContain("retry succeeded");
      } finally {
        consoleError.mockRestore();
      }
    });

    it("falls back to truncation when retry also returns empty for non-text-only blocks", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const deps = makeDeps({
          resolveModel: vi.fn(() => ({
            provider: "openai",
            model: "openai-codex",
          })),
          // Both attempts return only tool_use blocks — no extractable text.
          complete: vi.fn(async () => ({
            content: [
              { type: "tool_use", id: "tu_1", name: "bash", input: { cmd: "ls" } },
            ],
          })),
        });

        const summarize = await createLcmSummarizeFromLegacyParams({
          deps,
          legacyParams: { provider: "openai", model: "openai-codex" },
        });

        const longInput = "B".repeat(10_000);
        const summary = await summarize!(longInput, false);

        // Both calls fail → deterministic fallback.
        expect(vi.mocked(deps.complete)).toHaveBeenCalledTimes(2);
        expect(summary).toContain("[LCM fallback summary; truncated for context management]");

        // Diagnostics should mention both first-attempt and retry failure.
        const diagnostics = consoleError.mock.calls
          .flatMap((c) => c.map(String))
          .join(" ");
        expect(diagnostics).toContain("empty normalized summary on first attempt");
        expect(diagnostics).toContain("retry also returned empty summary");
        expect(diagnostics).toContain("block_types=tool_use");
      } finally {
        consoleError.mockRestore();
      }
    });

    it("falls back gracefully when retry throws an exception", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        let callCount = 0;
        const deps = makeDeps({
          resolveModel: vi.fn(() => ({
            provider: "openai",
            model: "gpt-5.3-codex",
          })),
          complete: vi.fn(async () => {
            callCount++;
            if (callCount === 1) {
              return { content: [] };
            }
            throw new Error("rate limit exceeded");
          }),
        });

        const summarize = await createLcmSummarizeFromLegacyParams({
          deps,
          legacyParams: { provider: "openai", model: "gpt-5.3-codex" },
        });

        const longInput = "C".repeat(10_000);
        const summary = await summarize!(longInput, false);

        // Retry threw → deterministic fallback.
        expect(summary).toContain("[LCM fallback summary; truncated for context management]");

        const diagnostics = consoleError.mock.calls
          .flatMap((c) => c.map(String))
          .join(" ");
        expect(diagnostics).toContain("retry failed");
        expect(diagnostics).toContain("rate limit exceeded");
      } finally {
        consoleError.mockRestore();
      }
    });

    it("logs response envelope metadata (request-id, usage) in diagnostics", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const deps = makeDeps({
          resolveModel: vi.fn(() => ({
            provider: "openai",
            model: "gpt-5.3-codex",
          })),
          // Return a response with metadata fields alongside empty content.
          complete: vi.fn(async () => ({
            content: [],
            id: "req_abc123",
            model: "gpt-5.3-codex-20260101",
            usage: {
              prompt_tokens: 500,
              completion_tokens: 0,
              total_tokens: 500,
            },
            finish_reason: "stop",
          })),
        });

        const summarize = await createLcmSummarizeFromLegacyParams({
          deps,
          legacyParams: { provider: "openai", model: "gpt-5.3-codex" },
        });

        await summarize!("D".repeat(8_000), false);

        const diagnostics = consoleError.mock.calls
          .flatMap((c) => c.map(String))
          .join(" ");
        // First-attempt diagnostics should contain envelope metadata.
        expect(diagnostics).toContain("id=req_abc123");
        expect(diagnostics).toContain("resp_model=gpt-5.3-codex-20260101");
        expect(diagnostics).toContain("completion_tokens=0");
        expect(diagnostics).toContain("finish=stop");
      } finally {
        consoleError.mockRestore();
      }
    });

    it("does not retry when Anthropic provider returns a valid summary", async () => {
      const deps = makeDeps({
        // Default makeDeps uses anthropic + returns valid text — no retry expected.
      });

      const summarize = await createLcmSummarizeFromLegacyParams({
        deps,
        legacyParams: { provider: "anthropic", model: "claude-opus-4-5" },
      });

      const summary = await summarize!("Some conversation text", false);

      expect(summary).toBe("summary output");
      // Only the single original call — no retry.
      expect(vi.mocked(deps.complete)).toHaveBeenCalledTimes(1);
    });
  });

  // --- Envelope-aware extraction tests ---

  describe("envelope-aware summary extraction", () => {
    it("recovers summary from top-level output_text when content is empty", async () => {
      // OpenAI Responses API provides a convenience `output_text` field at the
      // response envelope level that concatenates all output_text parts.
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const deps = makeDeps({
          resolveModel: vi.fn(() => ({
            provider: "openai",
            model: "gpt-5.3-codex",
          })),
          complete: vi.fn(async () => ({
            content: [],
            output_text: "Summary recovered from envelope output_text.",
          })),
        });

        const summarize = await createLcmSummarizeFromLegacyParams({
          deps,
          legacyParams: { provider: "openai", model: "gpt-5.3-codex" },
        });

        const summary = await summarize!("A".repeat(8_000), false);

        // Should recover from envelope without retry.
        expect(summary).toBe("Summary recovered from envelope output_text.");
        expect(vi.mocked(deps.complete)).toHaveBeenCalledTimes(1);

        const diagnostics = consoleError.mock.calls
          .flatMap((c) => c.map(String))
          .join(" ");
        expect(diagnostics).toContain("source=envelope");
        expect(diagnostics).toContain("recovered summary from response envelope");
        // Should NOT contain retry-related messages.
        expect(diagnostics).not.toContain("retrying with conservative settings");
      } finally {
        consoleError.mockRestore();
      }
    });

    it("recovers summary from Response.output array when content is empty", async () => {
      // OpenAI Responses API: content=[] but Response.output contains a
      // message item with output_text parts (heterogeneous output array).
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const deps = makeDeps({
          resolveModel: vi.fn(() => ({
            provider: "openai",
            model: "openai-codex",
          })),
          complete: vi.fn(async () => ({
            content: [],
            output: [
              {
                type: "message",
                role: "assistant",
                content: [
                  { type: "output_text", text: "Summary from output message." },
                ],
              },
            ],
          })),
        });

        const summarize = await createLcmSummarizeFromLegacyParams({
          deps,
          legacyParams: { provider: "openai", model: "openai-codex" },
        });

        const summary = await summarize!("B".repeat(8_000), false);

        expect(summary).toBe("Summary from output message.");
        expect(vi.mocked(deps.complete)).toHaveBeenCalledTimes(1);

        const diagnostics = consoleError.mock.calls
          .flatMap((c) => c.map(String))
          .join(" ");
        expect(diagnostics).toContain("source=envelope");
      } finally {
        consoleError.mockRestore();
      }
    });

    it("recovers from envelope when content has reasoning-only blocks", async () => {
      // content has reasoning blocks with no extractable text, but Response.output
      // contains the actual assistant message alongside the reasoning.
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const deps = makeDeps({
          resolveModel: vi.fn(() => ({
            provider: "openai",
            model: "gpt-5.3-codex",
          })),
          complete: vi.fn(async () => ({
            content: [{ type: "reasoning" }],
            output: [
              { type: "reasoning", summary: [] },
              {
                type: "message",
                role: "assistant",
                content: [
                  { type: "output_text", text: "Actual summary after reasoning." },
                ],
              },
            ],
          })),
        });

        const summarize = await createLcmSummarizeFromLegacyParams({
          deps,
          legacyParams: { provider: "openai", model: "gpt-5.3-codex" },
        });

        const summary = await summarize!("C".repeat(8_000), false);

        expect(summary).toBe("Actual summary after reasoning.");
        expect(vi.mocked(deps.complete)).toHaveBeenCalledTimes(1);

        const diagnostics = consoleError.mock.calls
          .flatMap((c) => c.map(String))
          .join(" ");
        expect(diagnostics).toContain("source=envelope");
        expect(diagnostics).not.toContain("retrying");
      } finally {
        consoleError.mockRestore();
      }
    });

    it("proceeds to retry when envelope also has no extractable text", async () => {
      // Both content and envelope have only tool-call items — no text anywhere.
      // Envelope extraction fails, so retry should fire.
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const deps = makeDeps({
          resolveModel: vi.fn(() => ({
            provider: "openai",
            model: "openai-codex",
          })),
          complete: vi.fn(async () => ({
            content: [],
            output: [
              { type: "function_call", name: "run_code", call_id: "fc_1" },
            ],
          })),
        });

        const summarize = await createLcmSummarizeFromLegacyParams({
          deps,
          legacyParams: { provider: "openai", model: "openai-codex" },
        });

        const longInput = "D".repeat(10_000);
        const summary = await summarize!(longInput, false);

        // Envelope also empty → should retry (2 calls) → fallback.
        expect(vi.mocked(deps.complete)).toHaveBeenCalledTimes(2);
        expect(summary).toContain("[LCM fallback summary; truncated for context management]");

        const diagnostics = consoleError.mock.calls
          .flatMap((c) => c.map(String))
          .join(" ");
        // Should NOT contain envelope recovery.
        expect(diagnostics).not.toContain("source=envelope");
        // Should contain retry path.
        expect(diagnostics).toContain("retrying with conservative settings");
      } finally {
        consoleError.mockRestore();
      }
    });

    it("deduplicates text found in both content and envelope output", async () => {
      // Edge case: content has reasoning.summary with text, AND the same text
      // appears in output. Content normalization finds it, so envelope is never
      // tried. Verify no duplication and no envelope path.
      const deps = makeDeps({
        resolveModel: vi.fn(() => ({
          provider: "openai",
          model: "gpt-5.3-codex",
        })),
        complete: vi.fn(async () => ({
          content: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Deduplicated summary." }],
            },
          ],
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Deduplicated summary." }],
            },
          ],
          output_text: "Deduplicated summary.",
        })),
      });

      const summarize = await createLcmSummarizeFromLegacyParams({
        deps,
        legacyParams: { provider: "openai", model: "gpt-5.3-codex" },
      });

      const summary = await summarize!("E".repeat(4_000), false);

      // Content normalization succeeds — envelope never tried.
      expect(summary).toBe("Deduplicated summary.");
      expect(vi.mocked(deps.complete)).toHaveBeenCalledTimes(1);
    });
  });
});
