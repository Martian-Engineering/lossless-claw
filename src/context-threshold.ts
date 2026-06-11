/**
 * Context-threshold override resolution: choose the compaction threshold for
 * the current runtime context (model id, model context window, session key)
 * from configured `contextThresholdOverrides`, falling back to the global
 * `contextThreshold`.
 *
 * Match fields inside one rule AND together. When several rules match, the
 * highest-specificity rule wins (exact model > session pattern > context
 * window bounds), with the earliest rule in config order breaking ties.
 */
import type { ContextThresholdOverride } from "./db/config.js";
import type { ConversationCompactionMaintenanceRecord } from "./store/compaction-maintenance-store.js";
import { compileSessionPattern } from "./session-patterns.js";
import {
  extractRuntimeModelContextWindow,
  extractRuntimeModelInfo,
} from "./token-accounting.js";

export type RuntimeThresholdContext = {
  provider?: string;
  model?: string;
  /** Combined `provider/model` ref when the host reports them separately. */
  modelRef?: string;
  modelContextWindow?: number;
};

export type ResolvedContextThreshold = {
  contextThreshold: number;
  source: "global" | "override";
  reason: string;
  ruleIndex?: number;
  ruleName?: string;
  specificity: number;
  modelRef?: string;
  modelContextWindow?: number;
};

/**
 * Read the model identity and context window the host reported for this
 * call. Runtime context wins over legacy compaction params field by field.
 */
export function readRuntimeThresholdContext(params: {
  runtimeContext?: Record<string, unknown>;
  legacyParams?: Record<string, unknown>;
}): RuntimeThresholdContext {
  const fromRuntime = extractRuntimeModelInfo(params.runtimeContext);
  const fromLegacy = extractRuntimeModelInfo(params.legacyParams);
  const provider = fromRuntime.provider ?? fromLegacy.provider;
  const model = fromRuntime.model ?? fromLegacy.model;
  const modelRef =
    model && provider && !model.includes("/") ? `${provider}/${model}` : model;
  const modelContextWindow =
    extractRuntimeModelContextWindow(params.runtimeContext)
    ?? extractRuntimeModelContextWindow(params.legacyParams);
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(modelRef ? { modelRef } : {}),
    ...(modelContextWindow !== undefined ? { modelContextWindow } : {}),
  };
}

/**
 * Reload the threshold persisted with a deferred compaction debt row. The
 * threshold that triggered the debt drives its drain — regardless of source —
 * so a drain without runtime model metadata (or after a config change) stays
 * consistent with the decision that recorded the debt.
 */
export function persistedContextThreshold(
  maintenance: Pick<
    ConversationCompactionMaintenanceRecord,
    "contextThreshold" | "contextThresholdSource"
  >,
): ResolvedContextThreshold | undefined {
  if (
    typeof maintenance.contextThreshold !== "number" ||
    !Number.isFinite(maintenance.contextThreshold) ||
    maintenance.contextThreshold < 0 ||
    maintenance.contextThreshold > 1
  ) {
    return undefined;
  }
  return {
    contextThreshold: maintenance.contextThreshold,
    source: maintenance.contextThresholdSource === "override" ? "override" : "global",
    specificity: 0,
    reason: "persisted_deferred_threshold_debt",
  };
}

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

function describeMatchReason(
  rule: ContextThresholdOverride,
  runtime: RuntimeThresholdContext,
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

type CompiledOverrideRule = {
  rule: ContextThresholdOverride;
  index: number;
  specificity: number;
  sessionPattern?: RegExp;
};

export class ContextThresholdResolver {
  private readonly rules: CompiledOverrideRule[];

  constructor(
    private readonly globalContextThreshold: number,
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

  resolve(params: {
    sessionKey?: string;
    runtimeContext?: Record<string, unknown>;
    legacyParams?: Record<string, unknown>;
  }): ResolvedContextThreshold {
    const runtime = readRuntimeThresholdContext(params);
    let best: CompiledOverrideRule | undefined;
    for (const candidate of this.rules) {
      if (!this.matches(candidate, params.sessionKey, runtime)) {
        continue;
      }
      if (!best || candidate.specificity > best.specificity) {
        best = candidate;
      }
    }

    if (!best) {
      return {
        contextThreshold: this.globalContextThreshold,
        source: "global",
        reason: "no_override_matched",
        specificity: 0,
        ...(runtime.modelRef ? { modelRef: runtime.modelRef } : {}),
        ...(runtime.modelContextWindow !== undefined
          ? { modelContextWindow: runtime.modelContextWindow }
          : {}),
      };
    }

    return {
      contextThreshold: best.rule.contextThreshold,
      source: "override",
      ruleIndex: best.index,
      ...(best.rule.name ? { ruleName: best.rule.name } : {}),
      reason: describeMatchReason(best.rule, runtime),
      specificity: best.specificity,
      ...(runtime.modelRef ? { modelRef: runtime.modelRef } : {}),
      ...(runtime.modelContextWindow !== undefined
        ? { modelContextWindow: runtime.modelContextWindow }
        : {}),
    };
  }

  private matches(
    candidate: CompiledOverrideRule,
    sessionKey: string | undefined,
    runtime: RuntimeThresholdContext,
  ): boolean {
    const { rule } = candidate;
    if (rule.match.model) {
      const ruleModel = rule.match.model.trim();
      if (runtime.modelRef !== ruleModel && runtime.model !== ruleModel) {
        return false;
      }
    }

    if (candidate.sessionPattern) {
      const trimmedKey = sessionKey?.trim();
      if (!trimmedKey || !candidate.sessionPattern.test(trimmedKey)) {
        return false;
      }
    }

    if (
      rule.match.modelContextWindowMin !== undefined ||
      rule.match.modelContextWindowMax !== undefined
    ) {
      // Window bounds need an explicit host-reported window; the token budget
      // is not a substitute because hosts can cap it below the model window.
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
}
