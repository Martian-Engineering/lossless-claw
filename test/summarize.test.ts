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

  it("falls back deterministically when model returns empty summary output", async () => {
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
});
