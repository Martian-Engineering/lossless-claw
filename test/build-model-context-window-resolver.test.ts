import { describe, expect, it } from "vitest";
import { buildModelContextWindowResolver } from "../index.js";

describe("buildModelContextWindowResolver", () => {
  it("returns the configured contextWindow for a model declared in runtimeConfig", () => {
    const resolver = buildModelContextWindowResolver({
      models: {
        providers: {
          openai: {
            models: [
              { id: "gpt-5.4", contextWindow: 200_000 },
              { id: "gpt-4o", contextWindow: 128_000 },
            ],
          },
        },
      },
    });
    expect(resolver("gpt-5.4")).toBe(200_000);
    expect(resolver("gpt-4o")).toBe(128_000);
  });

  it("returns null for a model in catalog without contextWindow", () => {
    const resolver = buildModelContextWindowResolver({
      models: {
        providers: {
          openai: {
            models: [{ id: "gpt-5.4" }, { id: "gpt-4o", contextWindow: 0 }],
          },
        },
      },
    });
    expect(resolver("gpt-5.4")).toBeNull();
    expect(resolver("gpt-4o")).toBeNull();
  });

  it("returns null for an unknown model", () => {
    const resolver = buildModelContextWindowResolver({
      models: {
        providers: {
          openai: { models: [{ id: "gpt-5.4", contextWindow: 200_000 }] },
        },
      },
    });
    expect(resolver("missing-model")).toBeNull();
  });

  it("constructs without error when a provider has no models array", () => {
    const resolver = buildModelContextWindowResolver({
      models: {
        providers: {
          openai: {},
          anthropic: { models: "not-an-array" },
        },
      },
    });
    expect(resolver("gpt-5.4")).toBeNull();
    expect(resolver("claude-sonnet")).toBeNull();
  });

  it("returns null for malformed runtime configs", () => {
    expect(buildModelContextWindowResolver(undefined)("any")).toBeNull();
    expect(buildModelContextWindowResolver(null)("any")).toBeNull();
    expect(buildModelContextWindowResolver({})("any")).toBeNull();
    expect(
      buildModelContextWindowResolver({ models: { providers: "bad" } })("any"),
    ).toBeNull();
  });

  it("trims whitespace from query and entry ids", () => {
    const resolver = buildModelContextWindowResolver({
      models: {
        providers: {
          openai: {
            models: [{ id: "  gpt-5.4  ", contextWindow: 200_000 }],
          },
        },
      },
    });
    expect(resolver("gpt-5.4")).toBe(200_000);
    expect(resolver("  gpt-5.4 ")).toBe(200_000);
  });

  it("returns null for empty model query", () => {
    const resolver = buildModelContextWindowResolver({
      models: { providers: { openai: { models: [{ id: "x", contextWindow: 1 }] } } },
    });
    expect(resolver("")).toBeNull();
    expect(resolver("   ")).toBeNull();
  });

  it("last provider in object iteration order wins for cross-provider id collision (RD-FIX-2 regression)", () => {
    // When the same model id appears under multiple providers, the
    // last-iterated provider's value wins. Object literal own-string-key
    // iteration order is well-defined in JS (insertion order for non-numeric
    // keys), so this is deterministic given a stable runtimeConfig shape.
    const resolver = buildModelContextWindowResolver({
      models: {
        providers: {
          openai: { models: [{ id: "gpt-4o", contextWindow: 128_000 }] },
          "azure-openai": { models: [{ id: "gpt-4o", contextWindow: 64_000 }] },
        },
      },
    });
    expect(resolver("gpt-4o")).toBe(64_000);
  });
});
