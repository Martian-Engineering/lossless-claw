import { describe, expect, it } from "vitest";
import {
  collectLosslessRuntimeLlmModelRefs,
  collectLosslessSubagentModelRefs,
  legacyConfigRules,
  normalizeCompatibilityConfig,
} from "../doctor-contract-api.js";

describe("doctor contract runtime LLM compatibility", () => {
  it("repairs summaryModel policy while preserving Lossless config", () => {
    const cfg = {
      plugins: {
        entries: {
          "lossless-claw": {
            enabled: true,
            config: {
              enabled: true,
              summaryModel: "openai-codex/gpt-5.5",
              contextThreshold: 0.42,
            },
          },
        },
      },
    };

    const mutation = normalizeCompatibilityConfig({ cfg });

    expect(mutation.config.plugins.entries["lossless-claw"].config).toEqual({
      enabled: true,
      summaryModel: "openai-codex/gpt-5.5",
      contextThreshold: 0.42,
    });
    expect(mutation.config.plugins.entries["lossless-claw"].llm).toEqual({
      allowModelOverride: true,
      allowedModels: ["openai-codex/gpt-5.5"],
    });
    expect(mutation.config.plugins.entries["lossless-claw"].llm).not.toHaveProperty(
      "allowAgentIdOverride",
    );
    expect(mutation.changes.join("\n")).toContain(
      "Added plugins.entries.lossless-claw.llm.allowedModels entries",
    );
  });

  it("merges required models with existing allowedModels", () => {
    const cfg = {
      plugins: {
        entries: {
          "lossless-claw": {
            config: {
              summaryModel: "openai-codex/gpt-5.5",
              largeFileSummaryProvider: "anthropic",
              largeFileSummaryModel: "claude-sonnet-4-6",
              fallbackProviders: [{ provider: "openai", model: "gpt-4.1-mini" }],
            },
            llm: {
              allowModelOverride: true,
              allowedModels: ["anthropic/claude-opus-4-6"],
            },
          },
        },
      },
    };

    const mutation = normalizeCompatibilityConfig({ cfg });

    expect(mutation.config.plugins.entries["lossless-claw"].llm.allowedModels).toEqual([
      "anthropic/claude-opus-4-6",
      "openai-codex/gpt-5.5",
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-4.1-mini",
    ]);
    expect(mutation.config.plugins.entries["lossless-claw"].llm).not.toHaveProperty(
      "allowAgentIdOverride",
    );
  });

  it("warns when configured summary models are not covered by llm policy", () => {
    const cfg = {
      plugins: {
        entries: {
          "lossless-claw": {
            config: {
              summaryModel: "openai-codex/gpt-5.5",
            },
          },
        },
      },
    };

    const summaryRule = legacyConfigRules.find((rule) => rule.path.at(-1) === "summaryModel");

    expect(summaryRule?.match?.("openai-codex/gpt-5.5", cfg)).toBe(true);
  });

  it("repairs expansionModel subagent policy while preserving Lossless config", () => {
    const cfg = {
      plugins: {
        entries: {
          "lossless-claw": {
            enabled: true,
            config: {
              enabled: true,
              expansionModel: "openai/gpt-5.4-mini",
              delegationTimeoutMs: 300000,
            },
          },
        },
      },
    };

    const mutation = normalizeCompatibilityConfig({ cfg });

    expect(mutation.config.plugins.entries["lossless-claw"].config).toEqual({
      enabled: true,
      expansionModel: "openai/gpt-5.4-mini",
      delegationTimeoutMs: 300000,
    });
    expect(mutation.config.plugins.entries["lossless-claw"].subagent).toEqual({
      allowModelOverride: true,
      allowedModels: ["openai/gpt-5.4-mini"],
    });
    expect(mutation.config.plugins.entries["lossless-claw"]).not.toHaveProperty("llm");
    expect(mutation.changes.join("\n")).toContain(
      "Added plugins.entries.lossless-claw.subagent.allowedModels entries",
    );
  });

  it("warns when configured expansion models are not covered by subagent policy", () => {
    const cfg = {
      plugins: {
        entries: {
          "lossless-claw": {
            config: {
              expansionModel: "openai/gpt-5.4-mini",
            },
          },
        },
      },
    };

    const expansionRule = legacyConfigRules.find((rule) => rule.path.at(-1) === "expansionModel");

    expect(expansionRule?.match?.("openai/gpt-5.4-mini", cfg)).toBe(true);
  });

  it("treats wildcard allowedModels as covering configured summary and expansion models", () => {
    const cfg = {
      plugins: {
        entries: {
          "lossless-claw": {
            config: {
              summaryModel: "openai-codex/gpt-5.5",
              expansionModel: "openai/gpt-5.4-mini",
            },
            llm: {
              allowModelOverride: true,
              allowedModels: ["*"],
            },
            subagent: {
              allowModelOverride: true,
              allowedModels: ["*"],
            },
          },
        },
      },
    };

    const summaryRule = legacyConfigRules.find((rule) => rule.path.at(-1) === "summaryModel");
    const expansionRule = legacyConfigRules.find((rule) => rule.path.at(-1) === "expansionModel");
    const mutation = normalizeCompatibilityConfig({ cfg });

    expect(summaryRule?.match?.("openai-codex/gpt-5.5", cfg)).toBe(false);
    expect(expansionRule?.match?.("openai/gpt-5.4-mini", cfg)).toBe(false);
    expect(mutation.changes).toEqual([]);
    expect(mutation.config.plugins.entries["lossless-claw"].llm.allowedModels).toEqual(["*"]);
    expect(mutation.config.plugins.entries["lossless-claw"].subagent.allowedModels).toEqual(["*"]);
  });

  it("prefers explicit fallback provider over slash-parsed provider in model", () => {
    const result = collectLosslessRuntimeLlmModelRefs({
      plugins: {
        entries: {
          "lossless-claw": {
            config: {
              fallbackProviders: [
                { provider: "openrouter", model: "anthropic/claude-sonnet-4-6" },
              ],
            },
          },
        },
      },
    });

    expect(result.modelRefs).toEqual([
      {
        field: "fallbackProviders",
        modelRef: "openrouter/anthropic/claude-sonnet-4-6",
        configPath: "plugins.entries.lossless-claw.config.fallbackProviders[0]",
      },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it("does not combine summaryProvider with provider-prefixed summaryModel", () => {
    const result = collectLosslessRuntimeLlmModelRefs({
      plugins: {
        entries: {
          "lossless-claw": {
            config: {
              summaryProvider: "openrouter",
              summaryModel: "anthropic/claude-sonnet-4-6",
            },
          },
        },
      },
    });

    expect(result.modelRefs).toEqual([
      {
        field: "summaryModel",
        modelRef: "anthropic/claude-sonnet-4-6",
        configPath: "plugins.entries.lossless-claw.config.summaryModel",
      },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it("reports bare fallback models as skipped instead of inventing refs", () => {
    const result = collectLosslessRuntimeLlmModelRefs({
      plugins: {
        entries: {
          "lossless-claw": {
            config: {
              fallbackProviders: [{ provider: "openai" }],
            },
          },
        },
      },
    });

    expect(result.modelRefs).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("provider and model");
  });

  it("reports bare expansion models as skipped instead of inventing refs", () => {
    const result = collectLosslessSubagentModelRefs({
      plugins: {
        entries: {
          "lossless-claw": {
            config: {
              expansionModel: "gpt-5.4-mini",
            },
          },
        },
      },
    });

    expect(result.modelRefs).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("bare model without a provider");
  });
});
