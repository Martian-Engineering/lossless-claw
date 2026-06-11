/**
 * Scoped context-threshold override resolution.
 *
 * Operators can configure `contextThresholdOverrides` rules that pick a
 * different compaction threshold per runtime context: exact model id,
 * model context-window range, and session-key glob. This module owns rule
 * matching, specificity ranking, and the resolved-threshold descriptor the
 * engine threads through compaction calls and deferred maintenance debt.
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
  };
}

/** Format the resolved-threshold fields shared by all selection log lines. */
export function describeResolvedContextThreshold(resolved: ResolvedContextThreshold): string {
  return (
    `threshold=${resolved.contextThreshold} source=${resolved.source}` +
    ` ruleIndex=${resolved.ruleIndex ?? "none"} ruleName=${resolved.ruleName ?? "none"}` +
    ` specificity=${resolved.specificity} model=${resolved.modelRef ?? "none"}` +
    ` modelContextWindow=${resolved.modelContextWindow ?? "none"}` +
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
    };
  }
}
