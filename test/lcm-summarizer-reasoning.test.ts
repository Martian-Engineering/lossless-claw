import { describe, expect, it } from "vitest";

import { createLcmSummarizeFromLegacyParams } from "../src/summarize.js";

function createDeps(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const deps = {
    config: {
      leafTargetTokens: 128,
      condensedTargetTokens: 128,
    },
    complete: async (params: Record<string, unknown>) => {
      calls.push(params);
      return {
        content: [{ type: "text", text: "Short summary" }],
      };
    },
    callGateway: async () => ({}),
    resolveModel: (modelRef?: string, providerHint?: string) => ({
      provider: providerHint?.trim() || "openrouter",
      model: modelRef?.trim() || "minimax/minimax-m2.7",
    }),
    parseAgentSessionKey: () => null,
    isSubagentSessionKey: () => false,
    normalizeAgentId: (id?: string) => id ?? "main",
    buildSubagentSystemPrompt: () => "",
    readLatestAssistantReply: () => undefined,
    resolveAgentDir: () => "/tmp/lcm-test",
    agentLaneSubagent: "subagent",
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    ...overrides,
  };

  return {
    deps,
    calls,
  };
}

describe("createLcmSummarizeFromLegacyParams", () => {
  it("requests a low default reasoning budget for the initial summarizer call", async () => {
    const { deps, calls } = createDeps();
    const summarizer = await createLcmSummarizeFromLegacyParams({
      deps: deps as never,
      legacyParams: {
        provider: "openrouter",
        model: "minimax/minimax-m2.7",
        config: {},
      },
    });

    expect(summarizer).toBeDefined();
    const summary = await summarizer!.fn("Summarize this conversation.");

    expect(summary).toBe("Short summary");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.reasoning).toBeUndefined();
    expect(calls[0]?.reasoningIfSupported).toBe("low");
  });

  it("keeps the explicit low retry reasoning while preserving the same supported-model default", async () => {
    const { deps, calls } = createDeps({
      complete: async (params: Record<string, unknown>) => {
        calls.push(params);
        if (calls.length === 1) {
          return { content: [] };
        }
        return { content: [{ type: "text", text: "Recovered summary" }] };
      },
    });

    const summarizer = await createLcmSummarizeFromLegacyParams({
      deps: deps as never,
      legacyParams: {
        provider: "openrouter",
        model: "minimax/minimax-m2.7",
        config: {},
      },
    });

    expect(summarizer).toBeDefined();
    const summary = await summarizer!.fn("Summarize this conversation.");

    expect(summary).toBe("Recovered summary");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.reasoning).toBeUndefined();
    expect(calls[0]?.reasoningIfSupported).toBe("low");
    expect(calls[1]?.reasoning).toBe("low");
    expect(calls[1]?.reasoningIfSupported).toBe("low");
  });

  it("asks for reasoning off on both calls when summary thinking is disabled", async () => {
    const { deps, calls } = createDeps({
      config: {
        leafTargetTokens: 128,
        condensedTargetTokens: 128,
        enableSummaryThinking: false,
      },
      complete: async (params: Record<string, unknown>) => {
        calls.push(params);
        if (calls.length === 1) {
          return { content: [] };
        }
        return { content: [{ type: "text", text: "Recovered summary" }] };
      },
    });

    const summarizer = await createLcmSummarizeFromLegacyParams({
      deps: deps as never,
      legacyParams: {
        provider: "openrouter",
        model: "minimax/minimax-m2.7",
        config: {},
      },
    });

    expect(summarizer).toBeDefined();
    const summary = await summarizer!.fn("Summarize this conversation.");

    expect(summary).toBe("Recovered summary");
    expect(calls).toHaveLength(2);
    // An absent effort resolves to "high" host-side, so "disabled" has to be
    // said out loud on both the initial call and the retry.
    expect(calls[0]?.reasoning).toBeUndefined();
    expect(calls[0]?.reasoningIfSupported).toBe("off");
    expect(calls[1]?.reasoning).toBeUndefined();
    expect(calls[1]?.reasoningIfSupported).toBe("off");
  });

  // #944 removed reasoningIfSupported for ollama because sending the field at
  // all is what broke there. "off" is as much a sent field as "low", so the
  // exclusion has to hold in both settings, on the initial call and the retry.
  it("omits the reasoning effort for ollama while summary thinking is enabled", async () => {
    const { deps, calls } = createDeps({
      complete: async (params: Record<string, unknown>) => {
        calls.push(params);
        if (calls.length === 1) {
          return { content: [] };
        }
        return { content: [{ type: "text", text: "Recovered summary" }] };
      },
    });

    const summarizer = await createLcmSummarizeFromLegacyParams({
      deps: deps as never,
      legacyParams: {
        provider: "ollama",
        model: "qwen3:8b",
        config: {},
      },
    });

    expect(summarizer).toBeDefined();
    const summary = await summarizer!.fn("Summarize this conversation.");

    expect(summary).toBe("Recovered summary");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.reasoning).toBeUndefined();
    expect(calls[0]?.reasoningIfSupported).toBeUndefined();
    expect(calls[1]?.reasoning).toBeUndefined();
    expect(calls[1]?.reasoningIfSupported).toBeUndefined();
  });

  it("omits the reasoning effort for ollama when summary thinking is disabled", async () => {
    const { deps, calls } = createDeps({
      config: {
        leafTargetTokens: 128,
        condensedTargetTokens: 128,
        enableSummaryThinking: false,
      },
      complete: async (params: Record<string, unknown>) => {
        calls.push(params);
        if (calls.length === 1) {
          return { content: [] };
        }
        return { content: [{ type: "text", text: "Recovered summary" }] };
      },
    });

    const summarizer = await createLcmSummarizeFromLegacyParams({
      deps: deps as never,
      legacyParams: {
        // Padded and mixed case on purpose: the exclusion is matched on the
        // trimmed, lowercased provider, and that normalization is load-bearing
        // here rather than incidental.
        provider: "  Ollama  ",
        model: "qwen3:8b",
        config: {},
      },
    });

    expect(summarizer).toBeDefined();
    const summary = await summarizer!.fn("Summarize this conversation.");

    expect(summary).toBe("Recovered summary");
    expect(calls).toHaveLength(2);
    // Not "off": the operator disabling summary thinking must not turn the
    // ollama omission into a sent field.
    expect(calls[0]?.reasoning).toBeUndefined();
    expect(calls[0]?.reasoningIfSupported).toBeUndefined();
    expect(calls[1]?.reasoning).toBeUndefined();
    expect(calls[1]?.reasoningIfSupported).toBeUndefined();
  });
});
