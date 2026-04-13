import { describe, expect, it } from "vitest";

import { resolveEffectiveReasoning } from "../src/plugin/index.js";
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
    getApiKey: async () => "test-key",
    requireApiKey: async () => "test-key",
    parseAgentSessionKey: () => null,
    isSubagentSessionKey: () => false,
    normalizeAgentId: (id?: string) => id ?? "main",
    buildSubagentSystemPrompt: () => "",
    readLatestAssistantReply: () => undefined,
    resolveAgentDir: () => "/tmp/lcm-test",
    resolveSessionIdFromSessionKey: async () => undefined,
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

describe("resolveEffectiveReasoning", () => {
  it("prefers an explicit reasoning setting over the supported-model default", () => {
    expect(
      resolveEffectiveReasoning({
        reasoning: "high",
        reasoningIfSupported: "low",
        modelSupportsReasoning: true,
      }),
    ).toBe("high");
  });

  it("only applies the default when the model supports reasoning", () => {
    expect(
      resolveEffectiveReasoning({
        reasoning: undefined,
        reasoningIfSupported: "low",
        modelSupportsReasoning: true,
      }),
    ).toBe("low");

    expect(
      resolveEffectiveReasoning({
        reasoning: undefined,
        reasoningIfSupported: "low",
        modelSupportsReasoning: false,
      }),
    ).toBeUndefined();
  });
});

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
});
