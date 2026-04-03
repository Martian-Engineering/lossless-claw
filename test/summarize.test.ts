import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLcmSummarizeFromLegacyParams,
  LcmProviderAuthError,
  type LcmSummarizeFn,
} from "../src/summarize.js";
import type { LcmDependencies } from "../src/types.js";

async function createSummarizeFn(
  params: Parameters<typeof createLcmSummarizeFromLegacyParams>[0],
): Promise<LcmSummarizeFn | undefined> {
  const result = await createLcmSummarizeFromLegacyParams(params);
  return result?.fn;
}

function makeDeps(overrides?: Partial<LcmDependencies>): LcmDependencies {
  return {
    config: {
      enabled: true,
      databasePath: ":memory:",
      ignoreSessionPatterns: [],
      statelessSessionPatterns: [],
      skipStatelessSessions: true,
      contextThreshold: 0.75,
      freshTailCount: 8,
      newSessionRetainDepth: 2,
      leafMinFanout: 8,
      condensedMinFanout: 4,
      condensedMinFanoutHard: 2,
      incrementalMaxDepth: 0,
      leafChunkTokens: 20_000,
      leafTargetTokens: 600,
      condensedTargetTokens: 900,
      maxExpandTokens: 120,
      largeFileTokenThreshold: 25_000,
      summaryProvider: "",
      summaryModel: "",
      largeFileSummaryProvider: "",
      largeFileSummaryModel: "",
      timezone: "UTC",
      pruneHeartbeatOk: false,
      summaryMaxOverageFactor: 3,
    },
    complete: vi.fn(async () => ({
      content: [{ type: "text", text: "summary output" }],
    })),
    callGateway: vi.fn(async () => ({})),
    resolveModel: vi.fn(() => ({
      provider: "anthropic",
      model: "claude-opus-4-5",
    })),
    getApiKey: vi.fn(async () => "test-api-key"),
    requireApiKey: vi.fn(async () => "test-api-key"),
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
    vi.unstubAllEnvs();
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

  it("plugin summaryProvider alone (no summaryModel) is ignored and falls back to legacy provider", async () => {
    const deps = makeDeps();

    await createLcmSummarizeFromLegacyParams({
      deps,
      legacyParams: {
        provider: "anthropic",
        model: "claude-opus-4-5",
        config: {
          plugins: {
            entries: {
              "lossless-claw": { config: { summaryProvider: "openai-resp" } },
            },
          },
        },
      },
    });

    expect(vi.mocked(deps.resolveModel)).toHaveBeenCalledWith("claude-opus-4-5", "anthropic");
  });

  it("prefers env summaryModel over plugin config and compaction model", async () => {
    vi.stubEnv("LCM_SUMMARY_MODEL", "gpt-4o-mini");
    vi.stubEnv("LCM_SUMMARY_PROVIDER", "openai-resp");
    const deps = makeDeps();

    await createLcmSummarizeFromLegacyParams({
      deps,
      legacyParams: {
        provider: "anthropic",
        model: "claude-opus-4-5",
        config: {
          agents: {
            defaults: {
              compaction: {
                model: "openai-resp/gpt-4.1-mini",
              },
            },
          },
          plugins: {
            entries: {
              "lossless-claw": { config: { summaryModel: "gpt-4.1", summaryProvider: "qiniu" } },
            },
          },
        },
      },
    });

    expect(vi.mocked(deps.resolveModel)).toHaveBeenCalledWith("gpt-4o-mini", "openai-resp");
  });

  it("prefers plugin summaryModel over compaction model when env vars are absent", async () => {
    const deps = makeDeps();

    await createLcmSummarizeFromLegacyParams({
      deps,
      legacyParams: {
        provider: "anthropic",
        model: "claude-opus-4-5",
        config: {
          agents: {
            defaults: {
              compaction: {
                model: "openai-resp/gpt-4.1-mini",
              },
            },
          },
          plugins: {
            entries: {
              "lossless-claw": { config: { summaryModel: "gpt-4.1", summaryProvider: "qiniu" } },
            },
          },
        },
      },
    });

    expect(vi.mocked(deps.resolveModel)).toHaveBeenCalledWith("gpt-4.1", "qiniu");
  });

  it("prefers env summaryModel over compaction model and session model", async () => {
    vi.stubEnv("LCM_SUMMARY_MODEL", "gpt-4o-mini");
    vi.stubEnv("LCM_SUMMARY_PROVIDER", "openai-resp");
    const deps = makeDeps();

    await createLcmSummarizeFromLegacyParams({
      deps,
      legacyParams: {
        provider: "anthropic",
        model: "claude-opus-4-5",
        config: {
          agents: {
            defaults: {
              compaction: {
                model: "openai-resp/gpt-4.1-mini",
              },
            },
          },
        },
      },
    });

    expect(vi.mocked(deps.resolveModel)).toHaveBeenCalledWith("gpt-4o-mini", "openai-resp");
  });

  it("uses OpenClaw compaction model before session model", async () => {
    const deps = makeDeps();

    await createLcmSummarizeFromLegacyParams({
      deps,
      legacyParams: {
        provider: "anthropic",
        model: "claude-opus-4-5",
        config: {
          agents: {
            defaults: {
              compaction: {
                model: "openai-resp/gpt-4.1-mini",
              },
            },
          },
        },
      },
    });

    expect(vi.mocked(deps.resolveModel)).toHaveBeenCalledWith("openai-resp/gpt-4.1-mini", undefined);
  });

  it("uses OpenClaw default model before the runtime session model when no summary override exists", async () => {
    const deps = makeDeps({
      resolveModel: vi.fn((modelRef?: string, providerHint?: string) => {
        if (modelRef === "anthropic/claude-sonnet-4-6") {
          return { provider: "anthropic", model: "claude-sonnet-4-6" };
        }
        if (modelRef === "gpt-5.4") {
          return { provider: providerHint ?? "openai-codex", model: "gpt-5.4" };
        }
        throw new Error(`unexpected modelRef: ${String(modelRef)}`);
      }),
      complete: vi.fn(async () => ({
        content: [{ type: "text", text: "summary output" }],
      })),
    });

    const summarize = await createSummarizeFn({
      deps,
      legacyParams: {
        provider: "openai-codex",
        model: "gpt-5.4",
        config: {
          agents: {
            defaults: {
              model: "anthropic/claude-sonnet-4-6",
            },
          },
        },
      },
    });

    await summarize!("hello world", false);

    expect(vi.mocked(deps.complete)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.complete).mock.calls[0]?.[0]).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
  });

  it("supports compaction model objects with primary", async () => {
    const deps = makeDeps();

    await createLcmSummarizeFromLegacyParams({
      deps,
      legacyParams: {
        provider: "anthropic",
        model: "claude-opus-4-5",
        config: {
          agents: {
            defaults: {
              compaction: {
                model: { primary: "openai-resp/gpt-4.1-mini" },
              },
            },
          },
        },
      },
    });

    expect(vi.mocked(deps.resolveModel)).toHaveBeenCalledWith("openai-resp/gpt-4.1-mini", undefined);
  });

  it("plugin summaryModel without provider and no slash emits warning but still resolves", async () => {
    const deps = makeDeps();

    await createLcmSummarizeFromLegacyParams({
      deps,
      legacyParams: {
        provider: "anthropic",
        model: "claude-opus-4-5",
        config: {
          plugins: {
            entries: {
              "lossless-claw": { config: { summaryModel: "gpt-4o-mini" } },
            },
          },
        },
      },
    });

    expect(vi.mocked(deps.resolveModel)).toHaveBeenCalledWith("gpt-4o-mini", "anthropic");
    expect(vi.mocked(deps.log.warn)).toHaveBeenCalledWith(expect.stringContaining("gpt-4o-mini"));
  });

  it("env summaryModel without summaryProvider falls back to the legacy provider hint", async () => {
    vi.stubEnv("LCM_SUMMARY_MODEL", "gpt-4o-mini");
    const deps = makeDeps();

    await createLcmSummarizeFromLegacyParams({
      deps,
      legacyParams: {
        provider: "openai-resp",
        model: "gpt-5.4",
      },
    });

    expect(vi.mocked(deps.resolveModel)).toHaveBeenCalledWith("gpt-4o-mini", "openai-resp");
    expect(vi.mocked(deps.log.warn)).toHaveBeenCalledWith(expect.stringContaining("gpt-4o-mini"));
  });

  it("falls back to legacy providerHint when no summary overrides exist", async () => {
    const deps = makeDeps();

    await createLcmSummarizeFromLegacyParams({
      deps,
      legacyParams: {
        provider: "anthropic",
        model: "claude-opus-4-5",
      },
    });

    expect(vi.mocked(deps.resolveModel)).toHaveBeenCalledWith("claude-opus-4-5", "anthropic");
  });

  it("builds distinct normal vs aggressive prompts", async () => {
    const deps = makeDeps();

    const summarize = await createSummarizeFn({
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
    const systemPrompt = completeMock.mock.calls[0]?.[0]?.system as string | undefined;

    expect(normalPrompt).toContain("Normal summary policy:");
    expect(aggressivePrompt).toContain("Aggressive summary policy:");
    expect(normalPrompt).toContain("Keep implementation caveats.");
    expect(systemPrompt).toContain("context-compaction summarization engine");

    const normalMaxTokens = Number(completeMock.mock.calls[0]?.[0]?.maxTokens ?? 0);
    const aggressiveMaxTokens = Number(completeMock.mock.calls[1]?.[0]?.maxTokens ?? 0);
    expect(aggressiveMaxTokens).toBeLessThan(normalMaxTokens);
    expect(completeMock.mock.calls[0]?.[0]?.temperature).toBeUndefined();
    expect(completeMock.mock.calls[1]?.[0]?.temperature).toBeUndefined();
  });

  it("honors configured leafTargetTokens for normal leaf summaries", async () => {
    const deps = makeDeps();
    deps.config.leafTargetTokens = 2400;

    const summarize = await createSummarizeFn({
      deps,
      legacyParams: {
        provider: "anthropic",
        model: "claude-opus-4-5",
      },
    });

    await summarize!("A".repeat(40_000), false);

    const completeMock = vi.mocked(deps.complete);
    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(completeMock.mock.calls[0]?.[0]?.maxTokens).toBe(2400);
    const prompt = completeMock.mock.calls[0]?.[0]?.messages?.[0]?.content as string;
    expect(prompt).toContain("Target length: about 2400 tokens or less.");
  });

  it("uses condensed prompt mode for condensed summaries", async () => {
    const deps = makeDeps();
    const summarize = await createSummarizeFn({
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
      getApiKey: vi.fn(async () => "resolved-api-key"),
    });

    const summarize = await createSummarizeFn({
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

  it("passes authProfileId through to getApiKey", async () => {
    const deps = makeDeps({
      getApiKey: vi.fn(() => "resolved-api-key"),
    });

    const summarize = await createSummarizeFn({
      deps,
      legacyParams: {
        provider: "anthropic",
        model: "claude-opus-4-5",
        authProfileId: "profile-123",
      },
    });

    await summarize!("Summary input");

    expect(vi.mocked(deps.getApiKey)).toHaveBeenCalledWith("anthropic", "claude-opus-4-5", {
      profileId: "profile-123",
    });
  });

  it("does not inherit runtime authProfileId when plugin summary provider/model are explicit", async () => {
    const deps = makeDeps({
      resolveModel: vi.fn(() => ({
        provider: "kimi-coding",
        model: "k2p5",
      })),
      getApiKey: vi.fn(async () => "resolved-api-key"),
    });
    const runtimeConfig = {
      plugins: {
        entries: {
          "lossless-claw": {
            config: {
              summaryProvider: "kimi-coding",
              summaryModel: "k2p5",
            },
          },
        },
      },
    };

    const summarize = await createSummarizeFn({
      deps,
      legacyParams: {
        provider: "openai-codex",
        model: "gpt-5.4",
        authProfileId: "openai-codex:default",
        config: runtimeConfig,
      },
    });

    await summarize!("Summary input");

    expect(vi.mocked(deps.resolveModel)).toHaveBeenCalledWith("k2p5", "kimi-coding");

    const getApiKeyOptions = vi.mocked(deps.getApiKey).mock.calls[0]?.[2];
    expect(getApiKeyOptions?.runtimeConfig).toBe(runtimeConfig);
    expect(getApiKeyOptions?.profileId).toBeUndefined();

    const completeArgs = vi.mocked(deps.complete).mock.calls[0]?.[0];
    expect(completeArgs?.provider).toBe("kimi-coding");
    expect(completeArgs?.model).toBe("k2p5");
    expect(completeArgs?.authProfileId).toBeUndefined();
  });

  it("falls back deterministically when model returns empty summary output after retry", async () => {
    const deps = makeDeps({
      complete: vi.fn(async () => ({
        content: [],
      })),
    });

    const summarize = await createSummarizeFn({
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

  it("falls back deterministically when the initial summarizer call times out", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const deps = makeDeps({
        complete: vi.fn(
          () =>
            new Promise(() => {
              // Intentionally unresolved to exercise the timeout fallback path.
            }),
        ),
      });

      const summarizeResult = await createLcmSummarizeFromLegacyParams({
        deps,
        legacyParams: {
          provider: "anthropic",
          model: "claude-opus-4-5",
        },
      });
      const summarize = summarizeResult?.fn;

      vi.useFakeTimers();
      const summaryPromise = summarize!("A".repeat(12_000), false);
      await vi.advanceTimersByTimeAsync(60_000);
      const summary = await summaryPromise;

      expect(vi.mocked(deps.complete)).toHaveBeenCalledTimes(1);
      expect(summary).toContain("[LCM fallback summary; truncated for context management]");
      expect(vi.getTimerCount()).toBe(0);

      const diagnostics = [
        ...consoleWarn.mock.calls.flatMap((call) => call.map((entry) => String(entry))),
        ...consoleError.mock.calls.flatMap((call) => call.map((entry) => String(entry))),
      ].join(" ");
      expect(diagnostics).toContain("summarizer timed out");
      expect(diagnostics).toContain("timeout=60000ms");
      expect(diagnostics).toContain("source=fallback");
    } finally {
      consoleWarn.mockRestore();
      consoleError.mockRestore();
      vi.useRealTimers();
    }
  });

  it("clears the summarizer timeout timer after a successful completion", async () => {
    try {
      const deps = makeDeps();
      const summarizeResult = await createLcmSummarizeFromLegacyParams({
        deps,
        legacyParams: {
          provider: "anthropic",
          model: "claude-opus-4-5",
        },
      });
      const summarize = summarizeResult?.fn;

      vi.useFakeTimers();
      const summary = await summarize!("Summary input", false);

      expect(summary).toBe("summary output");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores reasoning summary blocks when assistant output text is present", async () => {
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

    const summarize = await createSummarizeFn({
      deps,
      legacyParams: {
        provider: "openai",
        model: "gpt-5.3-codex",
      },
    });

    const summary = await summarize!("Input segment");

    expect(summary).toBe("Final condensed summary.");
    expect(summary).not.toContain("Reasoning summary line.");
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

      const summarize = await createSummarizeFn({
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
      expect(diagnostics).toContain("content_preview=");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not treat thinking-only completions as summary content", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const deps = makeDeps({
        resolveModel: vi.fn(() => ({
          provider: "openai",
          model: "gpt-5-mini",
        })),
        complete: vi.fn(async () => ({
          content: [{ type: "thinking", thinking: "Need to plan the summary first." }],
        })),
      });

      const summarize = await createSummarizeFn({
        deps,
        legacyParams: {
          provider: "openai",
          model: "gpt-5-mini",
        },
      });

      const summary = await summarize!("F".repeat(8_000), false);

      expect(summary).toContain("[LCM fallback summary; truncated for context management]");
      expect(vi.mocked(deps.complete)).toHaveBeenCalledTimes(2);

      const diagnostics = consoleError.mock.calls
        .flatMap((call) => call.map((entry) => String(entry)))
        .join(" ");
      expect(diagnostics).toContain("block_types=thinking");
      expect(diagnostics).toContain("empty normalized summary on first attempt");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("drops thinking blocks when a completion also contains text output", async () => {
    const deps = makeDeps({
      resolveModel: vi.fn(() => ({
        provider: "openai",
        model: "gpt-5-mini",
      })),
      complete: vi.fn(async () => ({
        content: [
          { type: "thinking", thinking: "Need to inspect the message chronology." },
          { type: "output_text", text: "User fixed summary normalization regression." },
        ],
      })),
    });

    const summarize = await createSummarizeFn({
      deps,
      legacyParams: {
        provider: "openai",
        model: "gpt-5-mini",
      },
    });

    const summary = await summarize!("G".repeat(4_000), false);

    expect(summary).toBe("User fixed summary normalization regression.");
    expect(summary).not.toContain("Need to inspect the message chronology.");
    expect(vi.mocked(deps.complete)).toHaveBeenCalledTimes(1);
  });

  // --- Empty-summary hardening: focused tests ---

  describe("empty-summary retry and diagnostics", () => {
    it("does not enter conservative retry/fallback when the provider returns an auth error envelope", async () => {
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const deps = makeDeps({
          resolveModel: vi.fn(() => ({
            provider: "openai-codex",
            model: "gpt-5.4",
          })),
          complete: vi.fn(async () => ({
            content: [],
            error: {
              kind: "provider_auth",
              statusCode: 401,
              message: "Missing required scope: model.request",
            },
          })),
        });

        const result = await createLcmSummarizeFromLegacyParams({
          deps,
          legacyParams: { provider: "openai-codex", model: "gpt-5.4" },
        });

        await expect(result!.fn("A".repeat(8_000), false)).rejects.toBeInstanceOf(
          LcmProviderAuthError,
        );
        expect(vi.mocked(deps.complete)).toHaveBeenCalledTimes(2);

        const warningText = consoleWarn.mock.calls.flatMap((call) => call.map(String)).join(" ");
        expect(warningText).toContain("provider auth error (401 / missing model.request scope)");
        expect(warningText).toContain("Check that the configured summaryProvider has valid API credentials.");
        expect(warningText).toContain("Current: openai-codex/gpt-5.4");
        expect(warningText).toContain("summarizer auth retry");

        const errorText = consoleError.mock.calls.flatMap((call) => call.map(String)).join(" ");
        expect(errorText).not.toContain("retrying with conservative settings");
        expect(errorText).not.toContain("falling back to truncation");
      } finally {
        consoleWarn.mockRestore();
        consoleError.mockRestore();
      }
    });

    it("does not enter conservative retry/fallback when the completion call throws an auth error", async () => {
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const deps = makeDeps({
          resolveModel: vi.fn(() => ({
            provider: "openai-codex",
            model: "gpt-5.4",
          })),
          complete: vi.fn(async () => {
            throw {
              statusCode: 401,
              error: {
                code: "insufficient_scope",
                message: "Missing required scope: model.request",
              },
            };
          }),
        });

        const result = await createLcmSummarizeFromLegacyParams({
          deps,
          legacyParams: { provider: "openai-codex", model: "gpt-5.4" },
        });

        await expect(result!.fn("B".repeat(8_000), false)).rejects.toBeInstanceOf(
          LcmProviderAuthError,
        );
        expect(vi.mocked(deps.complete)).toHaveBeenCalledTimes(2);

        const warningText = consoleWarn.mock.calls.flatMap((call) => call.map(String)).join(" ");
        expect(warningText).toContain("provider auth error (401 / missing model.request scope)");
        expect(warningText).toContain("Current: openai-codex/gpt-5.4");
        expect(warningText).toContain("summarizer auth retry");

        const errorText = consoleError.mock.calls.flatMap((call) => call.map(String)).join(" ");
        expect(errorText).not.toContain("summarizer call failed");
        expect(errorText).not.toContain("retrying with conservative settings");
      } finally {
        consoleWarn.mockRestore();
        consoleError.mockRestore();
      }
    });

    it("still detects auth failures nested under a top-level data envelope", async () => {
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const deps = makeDeps({
          resolveModel: vi.fn(() => ({
            provider: "openai-codex",
            model: "gpt-5.4",
          })),
          complete: vi.fn(async () => ({
            content: [],
            data: {
              statusCode: 401,
              message: "Missing required scope: model.request",
            },
          })),
        });

        const result = await createLcmSummarizeFromLegacyParams({
          deps,
          legacyParams: { provider: "openai-codex", model: "gpt-5.4" },
        });

        await expect(result!.fn("C".repeat(8_000), false)).rejects.toBeInstanceOf(
          LcmProviderAuthError,
        );
        expect(vi.mocked(deps.complete)).toHaveBeenCalledTimes(2);

        const warningText = consoleWarn.mock.calls.flatMap((call) => call.map(String)).join(" ");
        expect(warningText).toContain("provider auth error (401 / missing model.request scope)");
      } finally {
        consoleWarn.mockRestore();
      }
    });

    it("does not misclassify response-envelope summary text as an auth error", async () => {
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const deps = makeDeps({
          complete: vi.fn(async () => ({
            content: [],
            response: {
              text: "Summary of a debugging session about 401 invalid api key failures.",
            },
          })),
        });

        const summarize = await createSummarizeFn({
          deps,
          legacyParams: { provider: "anthropic", model: "claude-opus-4-5" },
        });

        const summary = await summarize!("D".repeat(8_000), false);

        expect(summary).toBe("Summary of a debugging session about 401 invalid api key failures.");
        expect(vi.mocked(deps.complete)).toHaveBeenCalledTimes(1);
        expect(consoleWarn).not.toHaveBeenCalled();
      } finally {
        consoleWarn.mockRestore();
      }
    });

    it("does not misclassify message-envelope summary text as an auth error", async () => {
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const deps = makeDeps({
          complete: vi.fn(async () => ({
            content: [],
            message: {
              text: "Conversation summary: the team fixed an unauthorized error caused by a stale token.",
            },
          })),
        });

        const summarize = await createSummarizeFn({
          deps,
          legacyParams: { provider: "anthropic", model: "claude-opus-4-5" },
        });

        const summary = await summarize!("E".repeat(8_000), false);

        expect(summary).toBe(
          "Conversation summary: the team fixed an unauthorized error caused by a stale token.",
        );
        expect(vi.mocked(deps.complete)).toHaveBeenCalledTimes(1);
        expect(consoleWarn).not.toHaveBeenCalled();
      } finally {
        consoleWarn.mockRestore();
      }
    });

    it("falls back to the next resolved model when the preferred model fails auth", async () => {
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const deps = makeDeps({
          resolveModel: vi.fn((modelRef?: string, providerHint?: string) => {
            if (modelRef === "gpt-5.4") {
              return { provider: providerHint ?? "openai-codex", model: "gpt-5.4" };
            }
            if (modelRef === "anthropic/claude-sonnet-4-6") {
              return { provider: "anthropic", model: "claude-sonnet-4-6" };
            }
            throw new Error(`unexpected modelRef: ${String(modelRef)}`);
          }),
          complete: vi.fn(async ({ provider }: { provider?: string }) => {
            if (provider === "openai-codex") {
              return {
                content: [],
                error: {
                  kind: "provider_auth",
                  statusCode: 401,
                  message: "Missing required scope: model.request",
                },
              };
            }
            return {
              content: [{ type: "text", text: "Recovered summary from fallback model." }],
            };
          }),
        });

        const summarize = await createSummarizeFn({
          deps,
          legacyParams: {
            provider: "openai-codex",
            model: "gpt-5.4",
            config: {
              plugins: {
                entries: {
                  "lossless-claw": {
                    config: {
                      summaryProvider: "openai-codex",
                      summaryModel: "gpt-5.4",
                    },
                  },
                },
              },
              agents: {
                defaults: {
                  model: "anthropic/claude-sonnet-4-6",
                },
              },
            },
          },
        });

        const summary = await summarize!("A".repeat(8_000), false);

        expect(summary).toBe("Recovered summary from fallback model.");
        expect(vi.mocked(deps.complete)).toHaveBeenCalledTimes(3);
        expect(vi.mocked(deps.complete).mock.calls[0]?.[0]).toMatchObject({
          provider: "openai-codex",
          model: "gpt-5.4",
        });
        expect(vi.mocked(deps.complete).mock.calls[1]?.[0]).toMatchObject({
          provider: "openai-codex",
          model: "gpt-5.4",
        });
        expect(vi.mocked(deps.complete).mock.calls[2]?.[0]).toMatchObject({
          provider: "anthropic",
          model: "claude-sonnet-4-6",
        });

        const warningText = consoleWarn.mock.calls.flatMap((call) => call.map(String)).join(" ");
        expect(warningText).toContain("summarizer auth fallback");
        expect(warningText).toContain("retrying with anthropic/claude-sonnet-4-6");
      } finally {
        consoleWarn.mockRestore();
      }
    });

    it("falls back to the next resolved model when retry also returns an empty overloaded response", async () => {
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const deps = makeDeps({
          resolveModel: vi.fn((modelRef?: string, providerHint?: string) => {
            if (modelRef === "anthropic/claude-opus-4-6") {
              return { provider: "anthropic", model: "claude-opus-4-6" };
            }
            if (modelRef === "gpt-5.4") {
              return { provider: providerHint ?? "openai-codex", model: "gpt-5.4" };
            }
            throw new Error(`unexpected modelRef: ${String(modelRef)}`);
          }),
          complete: vi
            .fn()
            .mockResolvedValueOnce({
              content: [],
              errorMessage: JSON.stringify({
                type: "error",
                error: { type: "api_error", message: "Internal server error" },
              }),
            })
            .mockResolvedValueOnce({
              content: [],
              errorMessage: JSON.stringify({
                type: "error",
                error: { type: "overloaded_error", message: "Overloaded" },
              }),
            })
            .mockResolvedValueOnce({
              content: [{ type: "text", text: "Recovered summary from fallback candidate." }],
            }),
        });

        const summarize = await createSummarizeFn({
          deps,
          legacyParams: {
            provider: "openai-codex",
            model: "gpt-5.4",
            config: {
              agents: {
                defaults: {
                  compaction: {
                    model: "anthropic/claude-opus-4-6",
                  },
                  model: {
                    primary: "openai-codex/gpt-5.4",
                  },
                },
              },
            },
          },
        });

        const summary = await summarize!("A".repeat(8_000), false);

        expect(summary).toBe("Recovered summary from fallback candidate.");
        expect(vi.mocked(deps.complete)).toHaveBeenCalledTimes(3);
        expect(vi.mocked(deps.complete).mock.calls[0]?.[0]).toMatchObject({
          provider: "anthropic",
          model: "claude-opus-4-6",
        });
        expect(vi.mocked(deps.complete).mock.calls[1]?.[0]).toMatchObject({
          provider: "anthropic",
          model: "claude-opus-4-6",
          reasoning: "low",
        });
        expect(vi.mocked(deps.complete).mock.calls[2]?.[0]).toMatchObject({
          provider: "openai-codex",
          model: "gpt-5.4",
        });

        const warningText = consoleWarn.mock.calls.flatMap((call) => call.map(String)).join(" ");
        expect(warningText).toContain("retrying with openai-codex/gpt-5.4");
        expect(warningText).toContain("retry also returned empty summary");

        const errorText = consoleError.mock.calls.flatMap((call) => call.map(String)).join(" ");
        expect(errorText).not.toContain("falling back to truncation");
      } finally {
        consoleWarn.mockRestore();
        consoleError.mockRestore();
      }
    });

    it("retries the same model with direct credentials before falling back to another provider", async () => {
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const deps = makeDeps({
          resolveModel: vi.fn((modelRef?: string, providerHint?: string) => {
            if (modelRef === "gpt-5.4") {
              return { provider: providerHint ?? "openai-codex", model: "gpt-5.4" };
            }
            if (modelRef === "anthropic/claude-sonnet-4-6") {
              return { provider: "anthropic", model: "claude-sonnet-4-6" };
            }
            throw new Error(`unexpected modelRef: ${String(modelRef)}`);
          }),
          getApiKey: vi.fn(
            async (
              _provider: string,
              _model: string,
              options?: { skipModelAuth?: boolean },
            ) => (options?.skipModelAuth ? "direct-key" : "scoped-token"),
          ),
          complete: vi.fn(async ({ provider, apiKey }: { provider?: string; apiKey?: string }) => {
            if (provider === "openai-codex" && apiKey === "scoped-token") {
              return {
                content: [],
                error: {
                  kind: "provider_auth",
                  statusCode: 401,
                  message: "Missing required scope: model.request",
                },
              };
            }
            if (provider === "openai-codex" && apiKey === "direct-key") {
              return {
                content: [{ type: "text", text: "Recovered summary from direct credentials." }],
              };
            }
            return {
              content: [{ type: "text", text: "Should not hit provider fallback." }],
            };
          }),
        });

        const summarize = await createSummarizeFn({
          deps,
          legacyParams: {
            provider: "openai-codex",
            model: "gpt-5.4",
            config: {
              plugins: {
                entries: {
                  "lossless-claw": {
                    config: {
                      summaryProvider: "openai-codex",
                      summaryModel: "gpt-5.4",
                    },
                  },
                },
              },
              agents: {
                defaults: {
                  model: "anthropic/claude-sonnet-4-6",
                },
              },
            },
          },
        });

        const summary = await summarize!("A".repeat(8_000), false);

        expect(summary).toBe("Recovered summary from direct credentials.");
        expect(vi.mocked(deps.getApiKey)).toHaveBeenNthCalledWith(1, "openai-codex", "gpt-5.4", {
          profileId: undefined,
          agentDir: undefined,
          runtimeConfig: {
            plugins: {
              entries: {
                "lossless-claw": {
                  config: {
                    summaryProvider: "openai-codex",
                    summaryModel: "gpt-5.4",
                  },
                },
              },
            },
            agents: {
              defaults: {
                model: "anthropic/claude-sonnet-4-6",
              },
            },
          },
        });
        expect(vi.mocked(deps.getApiKey)).toHaveBeenNthCalledWith(2, "openai-codex", "gpt-5.4", {
          profileId: undefined,
          agentDir: undefined,
          runtimeConfig: {
            plugins: {
              entries: {
                "lossless-claw": {
                  config: {
                    summaryProvider: "openai-codex",
                    summaryModel: "gpt-5.4",
                  },
                },
              },
            },
            agents: {
              defaults: {
                model: "anthropic/claude-sonnet-4-6",
              },
            },
          },
          skipModelAuth: true,
        });
        expect(vi.mocked(deps.complete)).toHaveBeenCalledTimes(2);
        expect(vi.mocked(deps.complete).mock.calls[0]?.[0]).toMatchObject({
          provider: "openai-codex",
          model: "gpt-5.4",
          apiKey: "scoped-token",
        });
        expect(vi.mocked(deps.complete).mock.calls[1]?.[0]).toMatchObject({
          provider: "openai-codex",
          model: "gpt-5.4",
          apiKey: "direct-key",
        });

        const warningText = consoleWarn.mock.calls.flatMap((call) => call.map(String)).join(" ");
        expect(warningText).toContain("summarizer auth retry");
        expect(warningText).toContain("without runtime.modelAuth credentials");
        expect(warningText).not.toContain("retrying with anthropic/claude-sonnet-4-6");
      } finally {
        consoleWarn.mockRestore();
      }
    });

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

        const summarize = await createSummarizeFn({
          deps,
          legacyParams: { provider: "openai", model: "gpt-5.3-codex" },
        });

        const summary = await summarize!("A".repeat(8_000), false);

        // Retry should have succeeded — no fallback truncation marker.
        expect(summary).toBe("Recovered summary from retry.");
        expect(vi.mocked(deps.complete)).toHaveBeenCalledTimes(2);

        // Retry call should use conservative settings.
        const retryArgs = vi.mocked(deps.complete).mock.calls[1]?.[0];
        expect(retryArgs?.temperature).toBeUndefined();
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

        const summarize = await createSummarizeFn({
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
        expect(diagnostics).toContain('"type":"tool_use"');
      } finally {
        consoleError.mockRestore();
      }
    });

    it("retries when a non-empty summary comes from an incomplete top-level response", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        let callCount = 0;
        const deps = makeDeps({
          resolveModel: vi.fn(() => ({
            provider: "openai",
            model: "gpt-5-mini",
          })),
          complete: vi.fn(async () => {
            callCount += 1;
            if (callCount === 1) {
              return {
                content: [{ type: "text", text: "Partial summary from incomplete response." }],
                status: "incomplete",
                incomplete_details: { reason: "max_output_tokens" },
              };
            }
            return { content: [{ type: "text", text: "Recovered summary after incomplete retry." }] };
          }),
        });

        const summarize = await createSummarizeFn({
          deps,
          legacyParams: { provider: "openai", model: "gpt-5-mini" },
        });

        const summary = await summarize!("A".repeat(8_000), false);

        expect(summary).toBe("Recovered summary after incomplete retry.");
        expect(vi.mocked(deps.complete)).toHaveBeenCalledTimes(2);
        expect(vi.mocked(deps.complete).mock.calls[1]?.[0]?.reasoning).toBe("low");

        const diagnostics = consoleError.mock.calls
          .flatMap((call) => call.map((entry) => String(entry)))
          .join(" ");
        expect(diagnostics).toContain("incomplete summary response on first attempt");
        expect(diagnostics).toContain("response.status=incomplete");
        expect(diagnostics).toContain("response.reason=max_output_tokens");
      } finally {
        consoleError.mockRestore();
      }
    });

    it("retries when an incomplete message block still carries text output", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        let callCount = 0;
        const deps = makeDeps({
          resolveModel: vi.fn(() => ({
            provider: "openai",
            model: "gpt-5-mini",
          })),
          complete: vi.fn(async () => {
            callCount += 1;
            if (callCount === 1) {
              return {
                content: [
                  {
                    type: "message",
                    status: "incomplete",
                    incomplete_details: { reason: "max_output_tokens" },
                    content: [{ type: "output_text", text: "Partial text hidden in incomplete item." }],
                  },
                ],
              };
            }
            return { content: [{ type: "text", text: "Recovered summary from incomplete item retry." }] };
          }),
        });

        const summarize = await createSummarizeFn({
          deps,
          legacyParams: { provider: "openai", model: "gpt-5-mini" },
        });

        const summary = await summarize!("B".repeat(8_000), false);

        expect(summary).toBe("Recovered summary from incomplete item retry.");
        expect(vi.mocked(deps.complete)).toHaveBeenCalledTimes(2);

        const diagnostics = consoleError.mock.calls
          .flatMap((call) => call.map((entry) => String(entry)))
          .join(" ");
        expect(diagnostics).toContain("response.content[0].status=incomplete");
        expect(diagnostics).toContain("response.content[0].reason=max_output_tokens");
      } finally {
        consoleError.mockRestore();
      }
    });

    it("falls back gracefully when retry throws an exception", async () => {
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
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

        const summarize = await createSummarizeFn({
          deps,
          legacyParams: { provider: "openai", model: "gpt-5.3-codex" },
        });

        const longInput = "C".repeat(10_000);
        const summary = await summarize!(longInput, false);

        // Retry threw → deterministic fallback.
        expect(summary).toContain("[LCM fallback summary; truncated for context management]");

        const diagnostics = consoleWarn.mock.calls
          .flatMap((c) => c.map(String))
          .join(" ");
        expect(diagnostics).toContain("retry failed");
        expect(diagnostics).toContain("rate limit exceeded");
      } finally {
        consoleWarn.mockRestore();
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
            provider: "openai-codex",
            model: "gpt-5.3-codex-20260101",
            request_provider: "openai-codex",
            request_model: "gpt-5.3-codex",
            request_api: "openai-codex-responses",
            request_reasoning: "low",
            request_has_system: "true",
            request_temperature: "(omitted)",
            request_temperature_sent: "false",
            usage: {
              prompt_tokens: 500,
              completion_tokens: 0,
              total_tokens: 500,
              input: 500,
              output: 0,
            },
            stopReason: "stop",
            errorMessage: "upstream timeout while acquiring provider connection",
            error: { code: "provider_timeout", retriable: true },
          })),
        });

        const summarize = await createSummarizeFn({
          deps,
          legacyParams: { provider: "openai", model: "gpt-5.3-codex" },
        });

        await summarize!("D".repeat(8_000), false);

        const diagnostics = consoleError.mock.calls
          .flatMap((c) => c.map(String))
          .join(" ");
        // First-attempt diagnostics should contain envelope metadata.
        expect(diagnostics).toContain("id=req_abc123");
        expect(diagnostics).toContain("resp_provider=openai-codex");
        expect(diagnostics).toContain("resp_model=gpt-5.3-codex-20260101");
        expect(diagnostics).toContain("request_api=openai-codex-responses");
        expect(diagnostics).toContain("request_reasoning=low");
        expect(diagnostics).toContain("request_has_system=true");
        expect(diagnostics).toContain("request_temperature=(omitted)");
        expect(diagnostics).toContain("request_temperature_sent=false");
        expect(diagnostics).toContain("completion_tokens=0");
        expect(diagnostics).toContain("input=500");
        expect(diagnostics).toContain("finish=stop");
        expect(diagnostics).toContain("error_message=upstream timeout");
        expect(diagnostics).toContain("error_preview=");
      } finally {
        consoleError.mockRestore();
      }
    });

    it("redacts sensitive keys from diagnostic content previews", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const deps = makeDeps({
          resolveModel: vi.fn(() => ({
            provider: "openai",
            model: "gpt-5.3-codex",
          })),
          complete: vi.fn(async () => ({
            content: [
              {
                type: "tool_use",
                name: "http",
                input: { authorization: "Bearer super-secret-token", body: "x".repeat(1500) },
              },
            ],
          })),
        });

        const summarize = await createSummarizeFn({
          deps,
          legacyParams: { provider: "openai", model: "gpt-5.3-codex" },
        });

        await summarize!("E".repeat(8_000), false);

        const diagnostics = consoleError.mock.calls
          .flatMap((call) => call.map((entry) => String(entry)))
          .join(" ");
        expect(diagnostics).toContain("content_preview=");
        expect(diagnostics).toContain('"authorization":"[redacted]"');
        expect(diagnostics).not.toContain("super-secret-token");
        expect(diagnostics).toContain("[truncated:");
      } finally {
        consoleError.mockRestore();
      }
    });

    it("does not retry when Anthropic provider returns a valid summary", async () => {
      const deps = makeDeps({
        // Default makeDeps uses anthropic + returns valid text — no retry expected.
      });

      const summarize = await createSummarizeFn({
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

        const summarize = await createSummarizeFn({
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

        const summarize = await createSummarizeFn({
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

        const summarize = await createSummarizeFn({
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

        const summarize = await createSummarizeFn({
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

      const summarize = await createSummarizeFn({
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
