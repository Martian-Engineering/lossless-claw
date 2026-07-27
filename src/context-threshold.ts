/**
 * Scoped context-threshold override resolution.
 *
 * Operators can configure `contextThresholdOverrides` rules that pick a
 * different compaction policy per runtime context: exact model id, model
 * context-window range, and session-key glob. This module owns rule matching,
 * specificity ranking, and the resolved-threshold descriptor the engine
 * threads through compaction calls and deferred maintenance debt.
 */
import type { ContextThresholdOverride } from "./db/config.js";
import type { RuntimeModelContext } from "./runtime-model.js";
import { compileSessionPattern } from "./session-patterns.js";

export type ResolvedContextThreshold = {
  contextThreshold: number;
  source: "global" | "override";
  /** Human-readable match summary for threshold-selection log lines. */
  reason: string;
  ruleIndex?: number;
  ruleName?: string;
  specificity: number;
  modelRef?: string;
  modelContextWindow?: number;
  /** freshTailCount from a matching override rule, if set. */
  freshTailCount?: number;
  /** leafChunkTokens from a matching override rule, if set. */
  leafChunkTokens?: number;
};

type CompiledOverrideRule = {
  rule: ContextThresholdOverride;
  index: number;
  specificity: number;
  /** Precompiled session glob, present iff the rule has a sessionPattern. */
  sessionPattern?: RegExp;
};

// Specificity ranks competing matches: an exact model id beats a session
// pattern, which beats context-window range bounds. Ties resolve to the
// earliest rule in config order.
function ruleSpecificity(rule: ContextThresholdOverride): number {
  let score = 0;
  if (rule.match.model) {
    score += 100;
  }
  if (rule.match.sessionPattern) {
    score += 50;
  }
  if (rule.match.modelContextWindowMin !== undefined) {
    score += 20;
  }
  if (rule.match.modelContextWindowMax !== undefined) {
    score += 20;
  }
  return score;
}

// All matchers within a rule AND together; a rule with no satisfied
// requirement fails. Window-range matchers require explicit runtime window
// metadata — the token budget is never used as a proxy.
function ruleMatches(params: {
  compiled: CompiledOverrideRule;
  sessionKey?: string;
  runtime: RuntimeModelContext;
}): boolean {
  const { rule, sessionPattern } = params.compiled;
  const runtime = params.runtime;

  if (rule.match.model) {
    const normalizedRuleModel = rule.match.model.trim();
    const candidates = [runtime.modelRef, runtime.model].filter(
      (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
    );
    if (!candidates.includes(normalizedRuleModel)) {
      return false;
    }
  }

  if (sessionPattern) {
    const sessionKey = params.sessionKey?.trim();
    if (!sessionKey || !sessionPattern.test(sessionKey)) {
      return false;
    }
  }

  if (
    rule.match.modelContextWindowMin !== undefined ||
    rule.match.modelContextWindowMax !== undefined
  ) {
    if (runtime.modelContextWindow === undefined) {
      return false;
    }
    if (
      rule.match.modelContextWindowMin !== undefined &&
      runtime.modelContextWindow < rule.match.modelContextWindowMin
    ) {
      return false;
    }
    if (
      rule.match.modelContextWindowMax !== undefined &&
      runtime.modelContextWindow > rule.match.modelContextWindowMax
    ) {
      return false;
    }
  }

  return true;
}

// Like ruleMatches, but a matcher whose runtime metadata is absent counts as
// potentially satisfiable instead of failed. Backs the staleness check on
// persisted deferred-maintenance thresholds: a background drain often lacks
// model metadata, so "no rule could match even as a wildcard" is the only
// safe proof that a persisted override no longer originates from live config.
function rulePossiblyMatches(params: {
  compiled: CompiledOverrideRule;
  sessionKey?: string;
  runtime: RuntimeModelContext;
}): boolean {
  const { rule, sessionPattern } = params.compiled;
  const runtime = params.runtime;

  if (rule.match.model) {
    const normalizedRuleModel = rule.match.model.trim();
    const candidates = [runtime.modelRef, runtime.model].filter(
      (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
    );
    if (candidates.length > 0 && !candidates.includes(normalizedRuleModel)) {
      return false;
    }
  }

  if (sessionPattern) {
    const sessionKey = params.sessionKey?.trim();
    if (sessionKey && !sessionPattern.test(sessionKey)) {
      return false;
    }
  }

  if (runtime.modelContextWindow !== undefined) {
    if (
      rule.match.modelContextWindowMin !== undefined &&
      runtime.modelContextWindow < rule.match.modelContextWindowMin
    ) {
      return false;
    }
    if (
      rule.match.modelContextWindowMax !== undefined &&
      runtime.modelContextWindow > rule.match.modelContextWindowMax
    ) {
      return false;
    }
  }

  return true;
}

// Whether a rule's configured payload could have produced the persisted
// resolution. The threshold must match exactly; the sizing fields must match
// wherever the row recorded them. A row without a recorded sizing field
// predates those columns (legacy schema), so an absent value means
// "not recorded", never "recorded as absent" — it cannot count against the
// rule, and the engine's runtime fill-in covers it on the kept path.
function rulePayloadProduces(
  rule: ContextThresholdOverride,
  persisted: Pick<
    ResolvedContextThreshold,
    "contextThreshold" | "freshTailCount" | "leafChunkTokens"
  >,
): boolean {
  if (rule.contextThreshold !== persisted.contextThreshold) {
    return false;
  }
  if (
    persisted.freshTailCount !== undefined &&
    rule.freshTailCount !== persisted.freshTailCount
  ) {
    return false;
  }
  if (
    persisted.leafChunkTokens !== undefined &&
    rule.leafChunkTokens !== persisted.leafChunkTokens
  ) {
    return false;
  }
  return true;
}

// Summarize which matchers selected the winning rule for log lines.
function describeRuleMatch(
  rule: ContextThresholdOverride,
  runtime: RuntimeModelContext,
): string {
  const parts: string[] = [];
  if (rule.match.model) {
    parts.push(`model=${rule.match.model}`);
  }
  if (rule.match.modelContextWindowMin !== undefined) {
    parts.push(`modelContextWindow>=${rule.match.modelContextWindowMin}`);
  }
  if (rule.match.modelContextWindowMax !== undefined) {
    parts.push(`modelContextWindow<=${rule.match.modelContextWindowMax}`);
  }
  if (rule.match.sessionPattern) {
    parts.push(`sessionPattern=${rule.match.sessionPattern}`);
  }
  if (runtime.modelContextWindow !== undefined) {
    parts.push(`resolvedModelContextWindow=${runtime.modelContextWindow}`);
  }
  return parts.join(",");
}

/**
 * Rehydrate a resolved threshold persisted on a deferred maintenance debt
 * row, so a background drain reuses the threshold that triggered the debt
 * instead of re-resolving against possibly absent runtime metadata.
 */
export function persistedContextThresholdOverride(maintenance: {
  contextThreshold: number | null;
  contextThresholdSource: "global" | "override" | null;
  contextFreshTailCount: number | null;
  contextLeafChunkTokens: number | null;
}): ResolvedContextThreshold | undefined {
  if (
    typeof maintenance.contextThreshold !== "number" ||
    !Number.isFinite(maintenance.contextThreshold)
  ) {
    return undefined;
  }
  return {
    contextThreshold: maintenance.contextThreshold,
    source: maintenance.contextThresholdSource === "override" ? "override" : "global",
    specificity: 0,
    reason: "persisted deferred threshold debt",
    ...(typeof maintenance.contextFreshTailCount === "number" &&
    Number.isFinite(maintenance.contextFreshTailCount) &&
    maintenance.contextFreshTailCount > 0
      ? { freshTailCount: Math.floor(maintenance.contextFreshTailCount) }
      : {}),
    ...(typeof maintenance.contextLeafChunkTokens === "number" &&
    Number.isFinite(maintenance.contextLeafChunkTokens) &&
    maintenance.contextLeafChunkTokens > 0
      ? { leafChunkTokens: Math.floor(maintenance.contextLeafChunkTokens) }
      : {}),
  };
}

/**
 * Decide which threshold a deferred-maintenance drain should honour: the one
 * persisted with the debt row, or a fresh resolution against live config.
 * The persisted value protects drains that lack the runtime metadata which
 * originally selected an override; it stays authoritative only while live
 * config could still plausibly produce it. A persisted override with no
 * plausibly-matching rule that could produce its payload, and a persisted
 * global that diverges from the configured global, are provably stale (the
 * config changed after the row was written) and are superseded so a dead
 * experiment value cannot wedge compaction forever.
 */
export function reconcilePersistedContextThreshold(params: {
  persisted: ResolvedContextThreshold | undefined;
  live: ResolvedContextThreshold;
  anyRuleCouldProducePersisted: boolean;
}): { resolved: ResolvedContextThreshold; supersededStalePersisted: boolean } {
  const { persisted, live } = params;
  if (!persisted) {
    return { resolved: live, supersededStalePersisted: false };
  }
  if (persisted.source === "override") {
    if (params.anyRuleCouldProducePersisted) {
      return { resolved: persisted, supersededStalePersisted: false };
    }
    return { resolved: live, supersededStalePersisted: true };
  }
  if (live.source === "override" || live.contextThreshold !== persisted.contextThreshold) {
    return { resolved: live, supersededStalePersisted: true };
  }
  return { resolved: persisted, supersededStalePersisted: false };
}

/** Format the resolved-threshold fields shared by all selection log lines. */
export function describeResolvedContextThreshold(resolved: ResolvedContextThreshold): string {
  return (
    `threshold=${resolved.contextThreshold} source=${resolved.source}` +
    ` ruleIndex=${resolved.ruleIndex ?? "none"} ruleName=${resolved.ruleName ?? "none"}` +
    ` specificity=${resolved.specificity} model=${resolved.modelRef ?? "none"}` +
    ` modelContextWindow=${resolved.modelContextWindow ?? "none"}` +
    ` freshTailCount=${resolved.freshTailCount ?? "none"}` +
    ` leafChunkTokens=${resolved.leafChunkTokens ?? "none"}` +
    ` reason=${resolved.reason.replaceAll(" ", "_")}`
  );
}

/**
 * Resolves the effective compaction threshold for a runtime context from the
 * configured override rules, falling back to the global `contextThreshold`.
 * Rules are validated by config parsing and compiled once at construction.
 */
export class ContextThresholdResolver {
  private readonly rules: CompiledOverrideRule[];

  constructor(
    private readonly globalThreshold: number,
    overrides: ContextThresholdOverride[] = [],
  ) {
    this.rules = overrides.map((rule, index) => ({
      rule,
      index,
      specificity: ruleSpecificity(rule),
      ...(rule.match.sessionPattern
        ? { sessionPattern: compileSessionPattern(rule.match.sessionPattern) }
        : {}),
    }));
  }

  /** Pick the highest-specificity matching rule (earliest wins ties). */
  resolve(params: {
    sessionKey?: string;
    runtime: RuntimeModelContext;
  }): ResolvedContextThreshold {
    const runtime = params.runtime;
    let best: CompiledOverrideRule | undefined;
    for (const compiled of this.rules) {
      if (!ruleMatches({ compiled, sessionKey: params.sessionKey, runtime })) {
        continue;
      }
      if (!best || compiled.specificity > best.specificity) {
        best = compiled;
      }
    }

    const runtimeFields = {
      ...(runtime.modelRef ? { modelRef: runtime.modelRef } : {}),
      ...(runtime.modelContextWindow !== undefined
        ? { modelContextWindow: runtime.modelContextWindow }
        : {}),
    };

    if (!best) {
      return {
        contextThreshold: this.globalThreshold,
        source: "global",
        reason: "no_override_matched",
        specificity: 0,
        ...runtimeFields,
      };
    }

    return {
      contextThreshold: best.rule.contextThreshold,
      source: "override",
      ruleIndex: best.index,
      ...(best.rule.name ? { ruleName: best.rule.name } : {}),
      reason: describeRuleMatch(best.rule, runtime),
      specificity: best.specificity,
      ...runtimeFields,
      ...(best.rule.freshTailCount !== undefined
        ? { freshTailCount: best.rule.freshTailCount }
        : {}),
      ...(best.rule.leafChunkTokens !== undefined
        ? { leafChunkTokens: best.rule.leafChunkTokens }
        : {}),
    };
  }

  /**
   * Whether any configured rule could have produced the persisted resolution:
   * the rule must both plausibly match this context (matchers whose runtime
   * metadata is absent count as satisfiable) and carry a payload that yields
   * the persisted threshold and recorded sizing. A rule that merely might
   * match is not enough — an unrelated surviving override must not keep a
   * removed rule's stale value alive. Backs the stale check in
   * {@link reconcilePersistedContextThreshold}.
   */
  couldAnyRuleProduce(params: {
    sessionKey?: string;
    runtime: RuntimeModelContext;
    persisted: Pick<
      ResolvedContextThreshold,
      "contextThreshold" | "freshTailCount" | "leafChunkTokens"
    >;
  }): boolean {
    return this.rules.some(
      (compiled) =>
        rulePossiblyMatches({ compiled, sessionKey: params.sessionKey, runtime: params.runtime }) &&
        rulePayloadProduces(compiled.rule, params.persisted),
    );
  }
}
