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

  it("seeds from pi-ai catalog when mod.getModels is provided; runtime overrides win", () => {
    const mod = {
      getModels: (provider: string): unknown[] => {
        if (provider === "openai") {
          return [
            { id: "gpt-4o", contextWindow: 128_000 },
            { id: "gpt-3.5", contextWindow: 16_000 },
          ];
        }
        return [];
      },
    };
    const resolver = buildModelContextWindowResolver(
      {
        models: {
          providers: {
            openai: {
              // Runtime override for gpt-4o; gpt-3.5 only in catalog.
              models: [{ id: "gpt-4o", contextWindow: 200_000 }],
            },
          },
        },
      },
      mod,
    );
    // Runtime override wins.
    expect(resolver("gpt-4o")).toBe(200_000);
    // Catalog fallback fills the gap.
    expect(resolver("gpt-3.5")).toBe(16_000);
  });

  it("does not throw when mod.getModels throws on unknown provider", () => {
    const mod = {
      getModels: (provider: string): unknown[] => {
        if (provider === "unknown") throw new Error("unknown provider");
        return [];
      },
    };
    expect(() =>
      buildModelContextWindowResolver(
        { models: { providers: { unknown: { models: [] } } } },
        mod,
      ),
    ).not.toThrow();
  });
});
