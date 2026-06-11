// Unit tests for the extracted context-threshold override resolver and the
// shared runtime model-metadata extraction it consumes.
import { describe, expect, it } from "vitest";
import {
  ContextThresholdResolver,
  persistedContextThresholdOverride,
} from "../src/context-threshold.js";
import { readRuntimeModelContext } from "../src/runtime-model.js";

describe("readRuntimeModelContext", () => {
  it("extracts provider, model, and modelRef from a runtime bag", () => {
    expect(readRuntimeModelContext({ provider: "openai", model: "gpt-5.5" })).toEqual({
      provider: "openai",
      model: "gpt-5.5",
      modelRef: "openai/gpt-5.5",
    });
  });

  it("keeps an already-qualified model id as the modelRef", () => {
    expect(readRuntimeModelContext({ provider: "openai", model: "openai/gpt-5.5" })).toEqual({
      provider: "openai",
      model: "openai/gpt-5.5",
      modelRef: "openai/gpt-5.5",
    });
  });

  it("supports alternate provider/model key spellings", () => {
    expect(readRuntimeModelContext({ providerId: "anthropic", modelId: "claude-fable-5" })).toEqual({
      provider: "anthropic",
      model: "claude-fable-5",
      modelRef: "anthropic/claude-fable-5",
    });
  });

  it("probes the known context-window key spellings", () => {
    for (const key of [
      "modelContextWindow",
      "modelContextWindowTokens",
      "contextWindow",
      "contextWindowTokens",
      "maxContextTokens",
      "contextWindowMax",
    ]) {
      expect(readRuntimeModelContext({ [key]: 200_000 })).toEqual({
        modelContextWindow: 200_000,
      });
    }
  });

  it("prefers earlier bags over later ones", () => {
    expect(
      readRuntimeModelContext(
        { model: "gpt-5.5", contextWindow: 400_000 },
        { provider: "legacy", model: "old-model", modelContextWindow: 200_000 },
      ),
    ).toEqual({
      provider: "legacy",
      model: "gpt-5.5",
      modelRef: "legacy/gpt-5.5",
      modelContextWindow: 400_000,
    });
  });

  it("ignores invalid context-window values and missing bags", () => {
    expect(readRuntimeModelContext(undefined, { modelContextWindow: -1 })).toEqual({});
    expect(readRuntimeModelContext({ modelContextWindow: Number.NaN })).toEqual({});
    expect(readRuntimeModelContext()).toEqual({});
  });
});

describe("ContextThresholdResolver", () => {
  it("falls back to the global threshold when no rules are configured", () => {
    const resolver = new ContextThresholdResolver(0.75);
    expect(resolver.resolve({ runtime: {} })).toMatchObject({
      contextThreshold: 0.75,
      source: "global",
      reason: "no_override_matched",
      specificity: 0,
    });
  });

  it("matches an exact model id against modelRef or bare model", () => {
    const resolver = new ContextThresholdResolver(0.75, [
      { match: { model: "openai/gpt-5.5" }, contextThreshold: 0.3 },
    ]);
    expect(
      resolver.resolve({ runtime: readRuntimeModelContext({ provider: "openai", model: "gpt-5.5" }) }),
    ).toMatchObject({ contextThreshold: 0.3, source: "override", ruleIndex: 0 });
    expect(
      resolver.resolve({ runtime: readRuntimeModelContext({ model: "openai/gpt-5.5" }) }),
    ).toMatchObject({ contextThreshold: 0.3, source: "override" });
    expect(
      resolver.resolve({ runtime: readRuntimeModelContext({ model: "gpt-5.5" }) }),
    ).toMatchObject({ contextThreshold: 0.75, source: "global" });
  });

  it("matches session-key globs with precompiled patterns", () => {
    const resolver = new ContextThresholdResolver(0.75, [
      { name: "telegram", match: { sessionPattern: "agent:*:telegram:**" }, contextThreshold: 0.3 },
    ]);
    expect(
      resolver.resolve({ sessionKey: "agent:main:telegram:group:123", runtime: {} }),
    ).toMatchObject({ contextThreshold: 0.3, source: "override", ruleName: "telegram" });
    expect(
      resolver.resolve({ sessionKey: "agent:main:discord:group:123", runtime: {} }),
    ).toMatchObject({ contextThreshold: 0.75, source: "global" });
    expect(resolver.resolve({ runtime: {} })).toMatchObject({ source: "global" });
  });

  it("requires explicit window metadata for window-range rules", () => {
    const resolver = new ContextThresholdResolver(0.75, [
      { match: { modelContextWindowMax: 250_000 }, contextThreshold: 0.1 },
    ]);
    // No runtime window: the rule must not match, even if a token budget exists.
    expect(resolver.resolve({ runtime: {} })).toMatchObject({ source: "global" });
    expect(
      resolver.resolve({ runtime: { modelContextWindow: 200_000 } }),
    ).toMatchObject({ contextThreshold: 0.1, source: "override" });
    expect(
      resolver.resolve({ runtime: { modelContextWindow: 400_000 } }),
    ).toMatchObject({ source: "global" });
  });

  it("ANDs all matchers within a rule", () => {
    const resolver = new ContextThresholdResolver(0.75, [
      {
        match: { model: "openai/gpt-5.5", sessionPattern: "agent:*:telegram:**" },
        contextThreshold: 0.2,
      },
    ]);
    const runtime = readRuntimeModelContext({ provider: "openai", model: "gpt-5.5" });
    expect(
      resolver.resolve({ sessionKey: "agent:main:telegram:group:1", runtime }),
    ).toMatchObject({ contextThreshold: 0.2, source: "override" });
    expect(
      resolver.resolve({ sessionKey: "agent:main:discord:group:1", runtime }),
    ).toMatchObject({ source: "global" });
    expect(
      resolver.resolve({ sessionKey: "agent:main:telegram:group:1", runtime: {} }),
    ).toMatchObject({ source: "global" });
  });

  it("picks the highest-specificity match, breaking ties by config order", () => {
    const resolver = new ContextThresholdResolver(0.75, [
      { name: "window", match: { modelContextWindowMin: 100_000 }, contextThreshold: 0.5 },
      { name: "model", match: { model: "openai/gpt-5.5" }, contextThreshold: 0.2 },
      { name: "window-dup", match: { modelContextWindowMin: 100_000 }, contextThreshold: 0.4 },
    ]);
    const runtime = readRuntimeModelContext({
      provider: "openai",
      model: "gpt-5.5",
      modelContextWindow: 400_000,
    });
    // Exact model (100) outranks window bounds (20).
    expect(resolver.resolve({ runtime })).toMatchObject({
      contextThreshold: 0.2,
      ruleName: "model",
      specificity: 100,
    });
    // Without the model rule matching, the earliest equal-specificity rule wins.
    expect(
      resolver.resolve({ runtime: { modelContextWindow: 400_000 } }),
    ).toMatchObject({ contextThreshold: 0.5, ruleName: "window", ruleIndex: 0 });
  });

  it("reports the winning rule's matchers in the reason", () => {
    const resolver = new ContextThresholdResolver(0.75, [
      {
        name: "small-windows",
        match: { modelContextWindowMax: 250_000 },
        contextThreshold: 0.1,
      },
    ]);
    const resolved = resolver.resolve({ runtime: { modelContextWindow: 200_000 } });
    expect(resolved.reason).toBe(
      "modelContextWindow<=250000,resolvedModelContextWindow=200000",
    );
    expect(resolved.modelContextWindow).toBe(200_000);
  });
});

describe("persistedContextThresholdOverride", () => {
  it("rehydrates a threshold persisted on a maintenance debt row", () => {
    expect(
      persistedContextThresholdOverride({
        contextThreshold: 0.1,
        contextThresholdSource: "override",
      }),
    ).toMatchObject({
      contextThreshold: 0.1,
      source: "override",
      reason: "persisted deferred threshold debt",
    });
    expect(
      persistedContextThresholdOverride({
        contextThreshold: 0.5,
        contextThresholdSource: "global",
      }),
    ).toMatchObject({ contextThreshold: 0.5, source: "global" });
  });

  it("returns undefined when no threshold was persisted", () => {
    expect(
      persistedContextThresholdOverride({ contextThreshold: null, contextThresholdSource: null }),
    ).toBeUndefined();
  });
});
