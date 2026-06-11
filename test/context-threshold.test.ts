// Unit tests for context-threshold override resolution (src/context-threshold.ts).
import { describe, expect, it } from "vitest";
import {
  ContextThresholdResolver,
  persistedContextThreshold,
  readRuntimeThresholdContext,
} from "../src/context-threshold.js";

describe("readRuntimeThresholdContext", () => {
  it("combines separately reported provider and model into a modelRef", () => {
    const runtime = readRuntimeThresholdContext({
      runtimeContext: { provider: "openai", model: "gpt-5.5" },
    });
    expect(runtime).toMatchObject({
      provider: "openai",
      model: "gpt-5.5",
      modelRef: "openai/gpt-5.5",
    });
  });

  it("keeps an already provider-qualified model id as the modelRef", () => {
    const runtime = readRuntimeThresholdContext({
      runtimeContext: { provider: "openai", model: "openai/gpt-5.5" },
    });
    expect(runtime.modelRef).toBe("openai/gpt-5.5");
  });

  it("prefers runtimeContext over legacy params field by field", () => {
    const runtime = readRuntimeThresholdContext({
      runtimeContext: { model: "gpt-5.5" },
      legacyParams: { provider: "openai", modelContextWindow: 200_000 },
    });
    expect(runtime).toMatchObject({
      provider: "openai",
      model: "gpt-5.5",
      modelContextWindow: 200_000,
    });
  });

  it("reads the model context window from the accepted host keys", () => {
    expect(
      readRuntimeThresholdContext({ runtimeContext: { contextWindow: 1_000_000 } })
        .modelContextWindow,
    ).toBe(1_000_000);
    expect(
      readRuntimeThresholdContext({ runtimeContext: { maxContextTokens: 250_000.7 } })
        .modelContextWindow,
    ).toBe(250_000);
    expect(
      readRuntimeThresholdContext({ runtimeContext: { tokenBudget: 200_000 } })
        .modelContextWindow,
    ).toBeUndefined();
  });
});

describe("ContextThresholdResolver", () => {
  it("falls back to the global threshold when no rule matches", () => {
    const resolver = new ContextThresholdResolver(0.75, [
      { match: { model: "openai/gpt-5.5" }, contextThreshold: 0.2 },
    ]);
    const resolved = resolver.resolve({
      runtimeContext: { provider: "anthropic", model: "claude-x" },
    });
    expect(resolved).toMatchObject({
      contextThreshold: 0.75,
      source: "global",
      reason: "no_override_matched",
    });
  });

  it("falls back to the global threshold when no overrides are configured", () => {
    const resolver = new ContextThresholdResolver(0.6);
    expect(resolver.resolve({}).contextThreshold).toBe(0.6);
  });

  it("matches an exact model id against both the bare model and the provider-qualified ref", () => {
    const resolver = new ContextThresholdResolver(0.75, [
      { match: { model: "openai/gpt-5.5" }, contextThreshold: 0.2 },
    ]);
    expect(
      resolver.resolve({ runtimeContext: { provider: "openai", model: "gpt-5.5" } }),
    ).toMatchObject({ contextThreshold: 0.2, source: "override", ruleIndex: 0 });
    expect(
      resolver.resolve({ runtimeContext: { model: "openai/gpt-5.5" } }),
    ).toMatchObject({ contextThreshold: 0.2, source: "override" });
  });

  it("matches session patterns with stateless-session glob semantics", () => {
    const resolver = new ContextThresholdResolver(0.75, [
      {
        name: "telegram",
        match: { sessionPattern: "agent:*:telegram:**" },
        contextThreshold: 0.3,
      },
    ]);
    expect(
      resolver.resolve({ sessionKey: "agent:main:telegram:group:42" }),
    ).toMatchObject({ contextThreshold: 0.3, source: "override", ruleName: "telegram" });
    // `*` must not span colons.
    expect(
      resolver.resolve({ sessionKey: "agent:main:extra:telegram:group:42" }),
    ).toMatchObject({ contextThreshold: 0.75, source: "global" });
    expect(resolver.resolve({})).toMatchObject({ source: "global" });
  });

  it("matches context-window ranges only when the host reports a window", () => {
    const resolver = new ContextThresholdResolver(0.75, [
      { match: { modelContextWindowMin: 300_000, modelContextWindowMax: 900_000 }, contextThreshold: 0.4 },
    ]);
    expect(
      resolver.resolve({ runtimeContext: { modelContextWindow: 500_000 } }),
    ).toMatchObject({ contextThreshold: 0.4, source: "override" });
    expect(
      resolver.resolve({ runtimeContext: { modelContextWindow: 200_000 } }),
    ).toMatchObject({ source: "global" });
    expect(
      resolver.resolve({ runtimeContext: { modelContextWindow: 1_000_000 } }),
    ).toMatchObject({ source: "global" });
    // No reported window: the rule must not match, even though a budget exists.
    expect(
      resolver.resolve({ runtimeContext: { tokenBudget: 500_000 } }),
    ).toMatchObject({ source: "global" });
  });

  it("ANDs all match fields within one rule", () => {
    const resolver = new ContextThresholdResolver(0.75, [
      {
        match: { model: "openai/gpt-5.5", sessionPattern: "agent:*:telegram:**" },
        contextThreshold: 0.35,
      },
    ]);
    expect(
      resolver.resolve({
        sessionKey: "agent:main:telegram:chat",
        runtimeContext: { model: "openai/gpt-5.5" },
      }),
    ).toMatchObject({ contextThreshold: 0.35, source: "override" });
    expect(
      resolver.resolve({
        sessionKey: "agent:main:discord:chat",
        runtimeContext: { model: "openai/gpt-5.5" },
      }),
    ).toMatchObject({ source: "global" });
  });

  it("picks the highest-specificity rule when several match", () => {
    const resolver = new ContextThresholdResolver(0.75, [
      { name: "window", match: { modelContextWindowMin: 100_000 }, contextThreshold: 0.5 },
      { name: "session", match: { sessionPattern: "agent:**" }, contextThreshold: 0.4 },
      { name: "model", match: { model: "openai/gpt-5.5" }, contextThreshold: 0.3 },
    ]);
    const resolved = resolver.resolve({
      sessionKey: "agent:main:chat",
      runtimeContext: { model: "openai/gpt-5.5", modelContextWindow: 400_000 },
    });
    expect(resolved).toMatchObject({
      contextThreshold: 0.3,
      ruleName: "model",
      ruleIndex: 2,
      specificity: 100,
    });
  });

  it("breaks specificity ties by earliest config order", () => {
    const resolver = new ContextThresholdResolver(0.75, [
      { name: "first", match: { sessionPattern: "agent:**" }, contextThreshold: 0.4 },
      { name: "second", match: { sessionPattern: "agent:main:**" }, contextThreshold: 0.5 },
    ]);
    expect(resolver.resolve({ sessionKey: "agent:main:chat" })).toMatchObject({
      ruleName: "first",
      ruleIndex: 0,
      contextThreshold: 0.4,
    });
  });

  it("describes the matched rule and resolved window in the reason", () => {
    const resolver = new ContextThresholdResolver(0.75, [
      { match: { modelContextWindowMin: 900_000 }, contextThreshold: 0.15 },
    ]);
    const resolved = resolver.resolve({
      runtimeContext: { modelContextWindow: 1_000_000 },
    });
    expect(resolved.reason).toBe(
      "modelContextWindow>=900000,resolvedModelContextWindow=1000000",
    );
  });
});

describe("persistedContextThreshold", () => {
  it("returns the persisted threshold and source", () => {
    expect(
      persistedContextThreshold({ contextThreshold: 0.1, contextThresholdSource: "override" }),
    ).toMatchObject({ contextThreshold: 0.1, source: "override" });
    expect(
      persistedContextThreshold({ contextThreshold: 0.75, contextThresholdSource: "global" }),
    ).toMatchObject({ contextThreshold: 0.75, source: "global" });
  });

  it("rejects missing or out-of-range persisted thresholds", () => {
    expect(
      persistedContextThreshold({ contextThreshold: null, contextThresholdSource: null }),
    ).toBeUndefined();
    expect(
      persistedContextThreshold({ contextThreshold: 1.5, contextThresholdSource: "override" }),
    ).toBeUndefined();
  });
});
