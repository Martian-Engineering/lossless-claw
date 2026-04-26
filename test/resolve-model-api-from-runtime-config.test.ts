import { describe, expect, it } from "vitest";
import { resolveModelApiFromRuntimeConfig } from "../index.js";

describe("resolveModelApiFromRuntimeConfig", () => {
  const config = {
    models: {
      providers: {
        "openai-codex": {
          baseUrl: "https://api.openai.com/v1",
          models: [
            { id: "gpt-5.4-mini", api: "openai-completions" },
            { id: "gpt-4o", api: "openai-completions" },
          ],
        },
        codex: {
          baseUrl: "https://chatgpt.com/backend-api/v1",
          models: [{ id: "gpt-5.4-mini", api: "openai-codex-responses" }],
        },
        "no-api": {
          models: [{ id: "some-model" }],
        },
      },
    },
  };

  it("returns model-level api when declared", () => {
    expect(resolveModelApiFromRuntimeConfig(config, "openai-codex", "gpt-5.4-mini")).toBe(
      "openai-completions",
    );
  });

  it("differentiates same model id across providers", () => {
    expect(resolveModelApiFromRuntimeConfig(config, "codex", "gpt-5.4-mini")).toBe(
      "openai-codex-responses",
    );
  });

  it("matches provider id case-insensitively", () => {
    expect(resolveModelApiFromRuntimeConfig(config, "OpenAI-Codex", "gpt-5.4-mini")).toBe(
      "openai-completions",
    );
  });

  it("returns undefined when model has no api declared", () => {
    expect(resolveModelApiFromRuntimeConfig(config, "no-api", "some-model")).toBeUndefined();
  });

  it("returns undefined when model id is unknown for provider", () => {
    expect(resolveModelApiFromRuntimeConfig(config, "openai-codex", "missing")).toBeUndefined();
  });

  it("returns undefined when provider is unknown", () => {
    expect(resolveModelApiFromRuntimeConfig(config, "missing", "any")).toBeUndefined();
  });

  it("returns undefined when runtime config is malformed", () => {
    expect(resolveModelApiFromRuntimeConfig(undefined, "openai-codex", "gpt-5.4-mini")).toBeUndefined();
    expect(resolveModelApiFromRuntimeConfig(null, "openai-codex", "gpt-5.4-mini")).toBeUndefined();
    expect(resolveModelApiFromRuntimeConfig({}, "openai-codex", "gpt-5.4-mini")).toBeUndefined();
    expect(
      resolveModelApiFromRuntimeConfig({ models: { providers: "bad" } }, "openai-codex", "x"),
    ).toBeUndefined();
  });
});
