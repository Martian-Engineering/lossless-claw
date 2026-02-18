export type LcmExpansionRoutingIntent = "query_probe" | "explicit_expand";

export type LcmExpansionRoutingAction = "answer_directly" | "expand_shallow" | "delegate_traversal";

export type LcmExpansionTokenRiskLevel = "low" | "moderate" | "high";

export type LcmExpansionRoutingInput = {
  intent: LcmExpansionRoutingIntent;
  query?: string;
  requestedMaxDepth?: number;
  candidateSummaryCount: number;
  tokenCap: number;
  includeMessages?: boolean;
};

export type LcmExpansionRoutingDecision = {
  action: LcmExpansionRoutingAction;
  normalizedMaxDepth: number;
  candidateSummaryCount: number;
  estimatedTokens: number;
  tokenCap: number;
  tokenRiskRatio: number;
  tokenRiskLevel: LcmExpansionTokenRiskLevel;
  indicators: {
    broadTimeRange: boolean;
    multiHopRetrieval: boolean;
  };
  triggers: {
    directByNoCandidates: boolean;
    directByLowComplexityProbe: boolean;
    delegateByDepth: boolean;
    delegateByCandidateCount: boolean;
    delegateByTokenRisk: boolean;
    delegateByBroadTimeRangeAndMultiHop: boolean;
  };
  reasons: string[];
};

export const EXPANSION_ROUTING_THRESHOLDS = {
  defaultDepth: 3,
  minDepth: 1,
  maxDepth: 10,
  directMaxDepth: 2,
  directMaxCandidates: 1,
  moderateTokenRiskRatio: 0.35,
  highTokenRiskRatio: 0.7,
  baseTokensPerSummary: 220,
  includeMessagesTokenMultiplier: 1.9,
  perDepthTokenGrowth: 0.65,
  broadTimeRangeTokenMultiplier: 1.35,
  multiHopTokenMultiplier: 1.25,
  multiHopDepthThreshold: 3,
  multiHopCandidateThreshold: 5,
} as const;

const BROAD_TIME_RANGE_PATTERNS = [
  /\b(last|past)\s+(month|months|quarter|quarters|year|years)\b/i,
  /\b(over|across|throughout)\s+(time|months|quarters|years)\b/i,
  /\b(timeline|chronology|history|long[-\s]?term)\b/i,
  /\bbetween\s+[^.]{0,40}\s+and\s+[^.]{0,40}\b/i,
];

const MULTI_HOP_QUERY_PATTERNS = [
  /\b(root\s+cause|causal\s+chain|chain\s+of\s+events)\b/i,
  /\b(multi[-\s]?hop|multi[-\s]?step|cross[-\s]?summary)\b/i,
  /\bhow\s+did\b.+\blead\s+to\b/i,
];

/** Normalize a requested depth to a deterministic bounded value. */
function normalizeDepth(requestedMaxDepth?: number): number {
  if (typeof requestedMaxDepth !== "number" || !Number.isFinite(requestedMaxDepth)) {
    return EXPANSION_ROUTING_THRESHOLDS.defaultDepth;
  }
  const rounded = Math.trunc(requestedMaxDepth);
  return Math.max(
    EXPANSION_ROUTING_THRESHOLDS.minDepth,
    Math.min(EXPANSION_ROUTING_THRESHOLDS.maxDepth, rounded),
  );
}

/** Normalize token cap to a positive bounded value for risk computation. */
function normalizeTokenCap(tokenCap: number): number {
  if (!Number.isFinite(tokenCap)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.max(1, Math.trunc(tokenCap));
}

/**
 * Detect broad time-range intent from the user query.
 *
 * This is a deterministic text heuristic used by orchestration policy only;
 * it does not perform retrieval.
 */
export function detectBroadTimeRangeIndicator(query?: string): boolean {
  if (!query) {
    return false;
  }
  const trimmed = query.trim();
  if (!trimmed) {
    return false;
  }

  if (BROAD_TIME_RANGE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return true;
  }

  const years = Array.from(trimmed.matchAll(/\b(?:19|20)\d{2}\b/g), (match) => Number(match[0]));
  if (years.length < 2) {
    return false;
  }

  const earliest = Math.min(...years);
  const latest = Math.max(...years);
  return latest - earliest >= 2;
}

/**
 * Detect whether traversal likely requires multi-hop expansion.
 *
 * Multi-hop is inferred from depth, breadth, and explicit language in the query.
 */
export function detectMultiHopIndicator(input: {
  query?: string;
  requestedMaxDepth?: number;
  candidateSummaryCount: number;
}): boolean {
  const normalizedMaxDepth = normalizeDepth(input.requestedMaxDepth);
  const candidateSummaryCount = Math.max(0, Math.trunc(input.candidateSummaryCount));

  if (normalizedMaxDepth >= EXPANSION_ROUTING_THRESHOLDS.multiHopDepthThreshold) {
    return true;
  }
  if (candidateSummaryCount >= EXPANSION_ROUTING_THRESHOLDS.multiHopCandidateThreshold) {
    return true;
  }
  if (!input.query) {
    return false;
  }

  const trimmed = input.query.trim();
  if (!trimmed) {
    return false;
  }
  return MULTI_HOP_QUERY_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Estimate expansion token volume from traversal characteristics.
 *
 * This deterministic estimate intentionally over-approximates near deep/broad
 * traversals so delegation triggers before hitting hard runtime caps.
 */
export function estimateExpansionTokens(input: {
  requestedMaxDepth?: number;
  candidateSummaryCount: number;
  includeMessages?: boolean;
  broadTimeRangeIndicator?: boolean;
  multiHopIndicator?: boolean;
}): number {
  const normalizedMaxDepth = normalizeDepth(input.requestedMaxDepth);
  const candidateSummaryCount = Math.max(0, Math.trunc(input.candidateSummaryCount));
  if (candidateSummaryCount === 0) {
    return 0;
  }

  const includeMessagesMultiplier = input.includeMessages
    ? EXPANSION_ROUTING_THRESHOLDS.includeMessagesTokenMultiplier
    : 1;
  const depthMultiplier =
    1 + (normalizedMaxDepth - 1) * EXPANSION_ROUTING_THRESHOLDS.perDepthTokenGrowth;
  const timeRangeMultiplier = input.broadTimeRangeIndicator
    ? EXPANSION_ROUTING_THRESHOLDS.broadTimeRangeTokenMultiplier
    : 1;
  const multiHopMultiplier = input.multiHopIndicator
    ? EXPANSION_ROUTING_THRESHOLDS.multiHopTokenMultiplier
    : 1;

  const perSummaryEstimate =
    EXPANSION_ROUTING_THRESHOLDS.baseTokensPerSummary *
    includeMessagesMultiplier *
    depthMultiplier *
    timeRangeMultiplier *
    multiHopMultiplier;

  return Math.max(0, Math.ceil(perSummaryEstimate * candidateSummaryCount));
}

/** Classify token risk level relative to a provided cap. */
export function classifyExpansionTokenRisk(input: { estimatedTokens: number; tokenCap: number }): {
  ratio: number;
  level: LcmExpansionTokenRiskLevel;
} {
  const estimatedTokens = Math.max(0, Math.trunc(input.estimatedTokens));
  const tokenCap = normalizeTokenCap(input.tokenCap);
  const ratio = estimatedTokens / tokenCap;

  if (ratio >= EXPANSION_ROUTING_THRESHOLDS.highTokenRiskRatio) {
    return { ratio, level: "high" };
  }
  if (ratio >= EXPANSION_ROUTING_THRESHOLDS.moderateTokenRiskRatio) {
    return { ratio, level: "moderate" };
  }
  return { ratio, level: "low" };
}

/**
 * Decide deterministic route-vs-delegate policy for LCM expansion orchestration.
 *
 * The decision matrix supports three outcomes:
 * - answer directly (skip expansion)
 * - do shallow/direct expansion
 * - delegate deep traversal to a sub-agent
 */
export function decideLcmExpansionRouting(
  input: LcmExpansionRoutingInput,
): LcmExpansionRoutingDecision {
  const normalizedMaxDepth = normalizeDepth(input.requestedMaxDepth);
  const candidateSummaryCount = Math.max(0, Math.trunc(input.candidateSummaryCount));
  const tokenCap = normalizeTokenCap(input.tokenCap);
  const broadTimeRange = detectBroadTimeRangeIndicator(input.query);
  const multiHopRetrieval = detectMultiHopIndicator({
    query: input.query,
    requestedMaxDepth: normalizedMaxDepth,
    candidateSummaryCount,
  });
  const estimatedTokens = estimateExpansionTokens({
    requestedMaxDepth: normalizedMaxDepth,
    candidateSummaryCount,
    includeMessages: input.includeMessages,
    broadTimeRangeIndicator: broadTimeRange,
    multiHopIndicator: multiHopRetrieval,
  });
  const tokenRisk = classifyExpansionTokenRisk({ estimatedTokens, tokenCap });

  const directByNoCandidates = candidateSummaryCount === 0;
  const directByLowComplexityProbe =
    input.intent === "query_probe" &&
    !directByNoCandidates &&
    normalizedMaxDepth <= EXPANSION_ROUTING_THRESHOLDS.directMaxDepth &&
    candidateSummaryCount <= EXPANSION_ROUTING_THRESHOLDS.directMaxCandidates &&
    tokenRisk.level === "low" &&
    !broadTimeRange &&
    !multiHopRetrieval;

  const delegateByDepth = false;
  const delegateByCandidateCount = false;
  const delegateByTokenRisk = tokenRisk.level === "high";
  const delegateByBroadTimeRangeAndMultiHop = broadTimeRange && multiHopRetrieval;

  const shouldDirect = directByNoCandidates || directByLowComplexityProbe;
  const shouldDelegate =
    !shouldDirect && (delegateByTokenRisk || delegateByBroadTimeRangeAndMultiHop);

  const action: LcmExpansionRoutingAction = shouldDirect
    ? "answer_directly"
    : shouldDelegate
      ? "delegate_traversal"
      : "expand_shallow";

  const reasons: string[] = [];
  if (directByNoCandidates) {
    reasons.push("No candidate summary IDs are available.");
  }
  if (directByLowComplexityProbe) {
    reasons.push("Query probe is low complexity and below retrieval-risk thresholds.");
  }
  if (delegateByTokenRisk) {
    reasons.push(
      `Estimated token risk ratio ${tokenRisk.ratio.toFixed(2)} meets delegate threshold ` +
        `${EXPANSION_ROUTING_THRESHOLDS.highTokenRiskRatio.toFixed(2)}.`,
    );
  }
  if (delegateByBroadTimeRangeAndMultiHop) {
    reasons.push("Broad time-range request combined with multi-hop retrieval indicators.");
  }
  if (action === "expand_shallow") {
    reasons.push("Complexity is bounded; use direct/shallow expansion.");
  }

  return {
    action,
    normalizedMaxDepth,
    candidateSummaryCount,
    estimatedTokens,
    tokenCap,
    tokenRiskRatio: tokenRisk.ratio,
    tokenRiskLevel: tokenRisk.level,
    indicators: {
      broadTimeRange,
      multiHopRetrieval,
    },
    triggers: {
      directByNoCandidates,
      directByLowComplexityProbe,
      delegateByDepth,
      delegateByCandidateCount,
      delegateByTokenRisk,
      delegateByBroadTimeRangeAndMultiHop,
    },
    reasons,
  };
}
