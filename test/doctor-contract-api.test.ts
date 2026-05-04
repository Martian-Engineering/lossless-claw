import { describe, expect, it } from "vitest";
import {
  collectLosslessRuntimeLlmModelRefs,
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
});
