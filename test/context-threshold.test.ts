// Unit tests for the extracted context-threshold override resolver and the
// shared runtime model-metadata extraction it consumes.
import { describe, expect, it } from "vitest";
import {
  ContextThresholdResolver,
  persistedContextThresholdOverride,
  reconcilePersistedContextThreshold,
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
      {
        match: { model: "openai/gpt-5.5" },
        contextThreshold: 0.3,
        leafChunkTokens: 12000,
      },
    ]);
    expect(
      resolver.resolve({ runtime: readRuntimeModelContext({ provider: "openai", model: "gpt-5.5" }) }),
    ).toMatchObject({
      contextThreshold: 0.3,
      source: "override",
      ruleIndex: 0,
      leafChunkTokens: 12000,
    });
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
        contextFreshTailCount: 16,
        contextLeafChunkTokens: 12000,
      }),
    ).toMatchObject({
      contextThreshold: 0.1,
      source: "override",
      freshTailCount: 16,
      leafChunkTokens: 12000,
      reason: "persisted deferred threshold debt",
    });
    expect(
      persistedContextThresholdOverride({
        contextThreshold: 0.5,
        contextThresholdSource: "global",
        contextFreshTailCount: null,
        contextLeafChunkTokens: null,
      }),
    ).toMatchObject({ contextThreshold: 0.5, source: "global" });
  });

  it("returns undefined when no threshold was persisted", () => {
    expect(
      persistedContextThresholdOverride({
        contextThreshold: null,
        contextThresholdSource: null,
        contextFreshTailCount: null,
        contextLeafChunkTokens: null,
      }),
    ).toBeUndefined();
  });
});

describe("ContextThresholdResolver.couldAnyRuleProduce", () => {
  const persistedTenth = { contextThreshold: 0.1 };

  it("is false when no rules are configured", () => {
    const resolver = new ContextThresholdResolver(0.75, []);
    expect(resolver.couldAnyRuleProduce({ runtime: {}, persisted: persistedTenth })).toBe(false);
  });

  it("treats absent window metadata as satisfiable for window-range rules", () => {
    const resolver = new ContextThresholdResolver(0.75, [
      { match: { modelContextWindowMax: 250_000 }, contextThreshold: 0.1 },
    ]);
    expect(resolver.couldAnyRuleProduce({ runtime: {}, persisted: persistedTenth })).toBe(true);
    expect(
      resolver.couldAnyRuleProduce({
        runtime: { modelContextWindow: 500_000 },
        persisted: persistedTenth,
      }),
    ).toBe(false);
  });

  it("rejects on a known session key that fails the rule's session pattern", () => {
    const resolver = new ContextThresholdResolver(0.75, [
      { match: { sessionPattern: "agent:alpha:**" }, contextThreshold: 0.1 },
    ]);
    expect(
      resolver.couldAnyRuleProduce({
        sessionKey: "agent:beta:main",
        runtime: {},
        persisted: persistedTenth,
      }),
    ).toBe(false);
    expect(
      resolver.couldAnyRuleProduce({
        sessionKey: "agent:alpha:main",
        runtime: {},
        persisted: persistedTenth,
      }),
    ).toBe(true);
    expect(resolver.couldAnyRuleProduce({ runtime: {}, persisted: persistedTenth })).toBe(true);
  });

  it("rejects on present model metadata that fails the rule's model matcher", () => {
    const resolver = new ContextThresholdResolver(0.75, [
      { match: { model: "openai/gpt-5.5" }, contextThreshold: 0.1 },
    ]);
    expect(
      resolver.couldAnyRuleProduce({
        runtime: { model: "claude", modelRef: "anthropic/claude" },
        persisted: persistedTenth,
      }),
    ).toBe(false);
    expect(resolver.couldAnyRuleProduce({ runtime: {}, persisted: persistedTenth })).toBe(true);
  });

  it("rejects a plausibly-matching rule whose threshold differs from the persisted value", () => {
    const resolver = new ContextThresholdResolver(0.75, [
      { match: { modelContextWindowMax: 250_000 }, contextThreshold: 0.4 },
    ]);
    expect(
      resolver.couldAnyRuleProduce({ runtime: {}, persisted: { contextThreshold: 0.1 } }),
    ).toBe(false);
  });

  it("requires recorded sizing fields to match the rule's payload", () => {
    const resolver = new ContextThresholdResolver(0.75, [
      {
        match: { modelContextWindowMax: 250_000 },
        contextThreshold: 0.1,
        freshTailCount: 16,
        leafChunkTokens: 12_000,
      },
    ]);
    expect(
      resolver.couldAnyRuleProduce({
        runtime: {},
        persisted: { contextThreshold: 0.1, freshTailCount: 16, leafChunkTokens: 12_000 },
      }),
    ).toBe(true);
    expect(
      resolver.couldAnyRuleProduce({
        runtime: {},
        persisted: { contextThreshold: 0.1, freshTailCount: 8, leafChunkTokens: 12_000 },
      }),
    ).toBe(false);
    expect(
      resolver.couldAnyRuleProduce({
        runtime: {},
        persisted: { contextThreshold: 0.1, freshTailCount: 16, leafChunkTokens: 9_000 },
      }),
    ).toBe(false);
  });

  it("treats sizing the row never recorded as producible by a sizing-carrying rule", () => {
    // Rows written before the sizing columns existed persist only the
    // threshold; an absent field means "not recorded", not "recorded absent".
    const resolver = new ContextThresholdResolver(0.75, [
      {
        match: { modelContextWindowMax: 250_000 },
        contextThreshold: 0.1,
        freshTailCount: 16,
      },
    ]);
    expect(
      resolver.couldAnyRuleProduce({ runtime: {}, persisted: { contextThreshold: 0.1 } }),
    ).toBe(true);
  });

  it("requires one rule to both plausibly match and produce the payload", () => {
    const resolver = new ContextThresholdResolver(0.75, [
      { match: { modelContextWindowMax: 250_000 }, contextThreshold: 0.4 },
      { match: { sessionPattern: "agent:alpha:**" }, contextThreshold: 0.1 },
    ]);
    expect(
      resolver.couldAnyRuleProduce({ runtime: {}, persisted: { contextThreshold: 0.1 } }),
    ).toBe(true);
    // A session key that fails the producing rule's pattern leaves only the
    // wrong-threshold rule standing: matching and producing must not be
    // satisfied by two different rules.
    expect(
      resolver.couldAnyRuleProduce({
        sessionKey: "agent:beta:main",
        runtime: {},
        persisted: { contextThreshold: 0.1 },
      }),
    ).toBe(false);
  });
});

describe("reconcilePersistedContextThreshold", () => {
  const liveGlobal = {
    contextThreshold: 0.75,
    source: "global" as const,
    reason: "no_override_matched",
    specificity: 0,
  };

  it("uses the live resolution when nothing was persisted", () => {
    const result = reconcilePersistedContextThreshold({
      persisted: undefined,
      live: liveGlobal,
      anyRuleCouldProducePersisted: false,
    });
    expect(result.resolved).toBe(liveGlobal);
    expect(result.supersededStalePersisted).toBe(false);
  });

  it("keeps a persisted override while a configured rule could still produce it", () => {
    const persisted = {
      contextThreshold: 0.1,
      source: "override" as const,
      reason: "persisted deferred threshold debt",
      specificity: 0,
    };
    const result = reconcilePersistedContextThreshold({
      persisted,
      live: liveGlobal,
      anyRuleCouldProducePersisted: true,
    });
    expect(result.resolved).toBe(persisted);
    expect(result.supersededStalePersisted).toBe(false);
  });

  it("supersedes a persisted override when no configured rule could produce it", () => {
    const persisted = {
      contextThreshold: 0.02,
      source: "override" as const,
      reason: "persisted deferred threshold debt",
      specificity: 0,
    };
    const result = reconcilePersistedContextThreshold({
      persisted,
      live: liveGlobal,
      anyRuleCouldProducePersisted: false,
    });
    expect(result.resolved).toBe(liveGlobal);
    expect(result.supersededStalePersisted).toBe(true);
  });

  it("supersedes a persisted override when a known live override selects a conflicting payload", () => {
    const resolver = new ContextThresholdResolver(0.75, [
      {
        match: { modelContextWindowMax: 250_000 },
        contextThreshold: 0.1,
        freshTailCount: 16,
      },
      {
        match: { model: "openai/gpt-5.5" },
        contextThreshold: 0.2,
        freshTailCount: 8,
      },
    ]);
    const runtime = { model: "openai/gpt-5.5" };
    const persisted = {
      contextThreshold: 0.1,
      source: "override" as const,
      reason: "persisted deferred threshold debt",
      specificity: 0,
      freshTailCount: 16,
    };
    const liveOverride = resolver.resolve({ runtime });

    expect(resolver.couldAnyRuleProduce({ runtime, persisted })).toBe(true);
    expect(liveOverride).toMatchObject({
      contextThreshold: 0.2,
      source: "override",
      freshTailCount: 8,
    });
    const result = reconcilePersistedContextThreshold({
      persisted,
      live: liveOverride,
      anyRuleCouldProducePersisted: resolver.couldAnyRuleProduce({ runtime, persisted }),
    });
    expect(result.resolved).toBe(liveOverride);
    expect(result.supersededStalePersisted).toBe(true);
  });

  it("supersedes a persisted global that diverges from the configured global", () => {
    const persisted = {
      contextThreshold: 0.02,
      source: "global" as const,
      reason: "persisted deferred threshold debt",
      specificity: 0,
    };
    const result = reconcilePersistedContextThreshold({
      persisted,
      live: liveGlobal,
      anyRuleCouldProducePersisted: false,
    });
    expect(result.resolved).toBe(liveGlobal);
    expect(result.supersededStalePersisted).toBe(true);
  });

  it("keeps a persisted global equal to the configured global", () => {
    const persisted = {
      contextThreshold: 0.75,
      source: "global" as const,
      reason: "persisted deferred threshold debt",
      specificity: 0,
      freshTailCount: 4,
    };
    const result = reconcilePersistedContextThreshold({
      persisted,
      live: liveGlobal,
      anyRuleCouldProducePersisted: false,
    });
    expect(result.resolved).toBe(persisted);
    expect(result.supersededStalePersisted).toBe(false);
  });

  it("prefers a live override over a persisted global", () => {
    const persisted = {
      contextThreshold: 0.75,
      source: "global" as const,
      reason: "persisted deferred threshold debt",
      specificity: 0,
    };
    const liveOverride = {
      contextThreshold: 0.3,
      source: "override" as const,
      reason: "sessionPattern=agent:alpha:**",
      specificity: 50,
    };
    const result = reconcilePersistedContextThreshold({
      persisted,
      live: liveOverride,
      anyRuleCouldProducePersisted: true,
    });
    expect(result.resolved).toBe(liveOverride);
    expect(result.supersededStalePersisted).toBe(true);
  });

  it("prefers an equal-threshold live override over a persisted global, adopting its payload", () => {
    // The override wins on source even when the thresholds are numerically
    // equal, and the drain adopts the override's sizing over the sizing
    // recorded with the persisted global.
    const persisted = {
      contextThreshold: 0.75,
      source: "global" as const,
      reason: "persisted deferred threshold debt",
      specificity: 0,
      freshTailCount: 4,
    };
    const liveOverride = {
      contextThreshold: 0.75,
      source: "override" as const,
      reason: "sessionPattern=agent:alpha:**",
      specificity: 50,
      freshTailCount: 8,
      leafChunkTokens: 9_000,
    };
    const result = reconcilePersistedContextThreshold({
      persisted,
      live: liveOverride,
      anyRuleCouldProducePersisted: true,
    });
    expect(result.resolved).toBe(liveOverride);
    expect(result.resolved.freshTailCount).toBe(8);
    expect(result.resolved.leafChunkTokens).toBe(9_000);
    expect(result.supersededStalePersisted).toBe(true);
  });
});
