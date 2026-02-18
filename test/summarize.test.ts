import { completeSimple } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getApiKeyForModel } from "../../agents/model-auth.js";
import { resolveModel } from "../../agents/pi-embedded-runner/model.js";
import { resolveCopilotApiToken } from "../../providers/github-copilot-token.js";
import { createLcmSummarizeFromLegacyParams } from "./summarize.js";

vi.mock("@mariozechner/pi-ai", () => ({
  completeSimple: vi.fn(),
}));

vi.mock("../../agents/agent-paths.js", () => ({
  resolveOpenClawAgentDir: vi.fn(() => "/tmp/openclaw-agent"),
}));

vi.mock("../../agents/model-auth.js", () => ({
  getApiKeyForModel: vi.fn(async () => ({
    apiKey: "test-api-key",
    mode: "api-key",
    source: "test",
  })),
  requireApiKey: vi.fn((auth: { apiKey?: string }, provider: string) => {
    if (auth.apiKey?.trim()) {
      return auth.apiKey;
    }
    throw new Error(`No API key resolved for provider ${provider}`);
  }),
}));

vi.mock("../../agents/pi-embedded-runner/model.js", () => ({
  resolveModel: vi.fn(() => ({
    model: {
      id: "claude-opus-4-5",
      provider: "anthropic",
      api: "messages",
      contextWindow: 200_000,
      maxTokens: 8_000,
    },
    error: null,
    authStorage: {},
    modelRegistry: {},
  })),
}));

vi.mock("../../providers/github-copilot-token.js", () => ({
  resolveCopilotApiToken: vi.fn(async () => ({ token: "copilot-runtime-token" })),
}));

const mockedCompleteSimple = vi.mocked(completeSimple);
const mockedGetApiKeyForModel = vi.mocked(getApiKeyForModel);
const mockedResolveModel = vi.mocked(resolveModel);
const mockedResolveCopilotApiToken = vi.mocked(resolveCopilotApiToken);

describe("createLcmSummarizeFromLegacyParams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedCompleteSimple.mockResolvedValue({
      content: [{ type: "text", text: "summary output" }],
    } as never);
    mockedResolveModel.mockReturnValue({
      model: {
        id: "claude-opus-4-5",
        provider: "anthropic",
        api: "messages",
        contextWindow: 200_000,
        maxTokens: 8_000,
      } as never,
      error: null,
      authStorage: {} as never,
      modelRegistry: {} as never,
    });
    mockedGetApiKeyForModel.mockResolvedValue({
      apiKey: "test-api-key",
      mode: "api-key",
      source: "test",
    });
    mockedResolveCopilotApiToken.mockResolvedValue({ token: "copilot-runtime-token" });
  });

  it("returns undefined when provider/model are missing", async () => {
    await expect(
      createLcmSummarizeFromLegacyParams({
        legacyParams: {
          provider: "anthropic",
        },
      }),
    ).resolves.toBeUndefined();

    expect(mockedResolveModel).not.toHaveBeenCalled();
    expect(mockedCompleteSimple).not.toHaveBeenCalled();
  });

  it("builds distinct normal vs aggressive prompts", async () => {
    const summarize = await createLcmSummarizeFromLegacyParams({
      legacyParams: {
        provider: "anthropic",
        model: "claude-opus-4-5",
      },
      customInstructions: "Keep implementation caveats.",
    });

    expect(summarize).toBeTypeOf("function");

    await summarize!("A".repeat(8_000), false);
    await summarize!("A".repeat(8_000), true);

    expect(mockedCompleteSimple).toHaveBeenCalledTimes(2);

    const normalPrompt = mockedCompleteSimple.mock.calls[0]?.[1]?.messages?.[0]?.content as string;
    const aggressivePrompt = mockedCompleteSimple.mock.calls[1]?.[1]?.messages?.[0]
      ?.content as string;

    expect(normalPrompt).toContain("Normal summary policy:");
    expect(aggressivePrompt).toContain("Aggressive summary policy:");
    expect(normalPrompt).toContain("Keep implementation caveats.");

    const normalMaxTokens = Number(mockedCompleteSimple.mock.calls[0]?.[2]?.maxTokens ?? 0);
    const aggressiveMaxTokens = Number(mockedCompleteSimple.mock.calls[1]?.[2]?.maxTokens ?? 0);
    expect(aggressiveMaxTokens).toBeLessThan(normalMaxTokens);
    expect(mockedCompleteSimple.mock.calls[1]?.[2]?.temperature).toBe(0.1);
  });

  it("does not pass reasoning overrides for condensed summaries", async () => {
    const summarize = await createLcmSummarizeFromLegacyParams({
      legacyParams: {
        provider: "anthropic",
        model: "claude-opus-4-5",
      },
    });

    await summarize!("A".repeat(8_000), false, { isCondensed: true });

    expect(mockedCompleteSimple).toHaveBeenCalledTimes(1);
    const prompt = mockedCompleteSimple.mock.calls[0]?.[1]?.messages?.[0]?.content as string;
    const requestOptions = mockedCompleteSimple.mock.calls[0]?.[2] as {
      reasoning?: "high" | "medium" | "low";
    };

    expect(prompt).toContain("<conversation_to_condense>");
    expect(requestOptions.reasoning).toBeUndefined();
  });

  it("resolves and uses copilot runtime token when provider is github-copilot", async () => {
    mockedResolveModel.mockReturnValue({
      model: {
        id: "gpt-5.3-codex",
        provider: "github-copilot",
        api: "openai-codex-responses",
        contextWindow: 128_000,
        maxTokens: 8_000,
      } as never,
      error: null,
      authStorage: {} as never,
      modelRegistry: {} as never,
    });
    mockedGetApiKeyForModel.mockResolvedValue({
      apiKey: "gh-token",
      mode: "token",
      source: "profile:copilot",
    });

    const summarize = await createLcmSummarizeFromLegacyParams({
      legacyParams: {
        provider: "github-copilot",
        model: "gpt-5.3-codex",
      },
    });

    await summarize!("Copilot summary input");

    expect(mockedResolveCopilotApiToken).toHaveBeenCalledWith({ githubToken: "gh-token" });
    expect(mockedCompleteSimple.mock.calls[0]?.[2]?.apiKey).toBe("copilot-runtime-token");
  });

  it("falls back deterministically when model returns empty summary output", async () => {
    mockedCompleteSimple.mockResolvedValue({
      content: [],
    } as never);

    const summarize = await createLcmSummarizeFromLegacyParams({
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
});
