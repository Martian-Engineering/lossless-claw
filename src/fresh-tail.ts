/**
 * Default token cap for the protected fresh tail.
 *
 * A count-only fresh tail (`freshTailCount`, default 64) can cover most of a
 * tool-heavy conversation, which leaves nothing for compaction to summarize
 * while the prompt stays near its budget. When `freshTailMaxTokens` is unset,
 * the tail is therefore capped at a share of the token budget, but never below
 * a small number of newest messages. The newest user turn stays protected in
 * full either way.
 */

/** Share of the token budget an unconfigured fresh tail may occupy. */
export const DEFAULT_FRESH_TAIL_BUDGET_SHARE = 0.25;

/** Newest messages the default cap always keeps protected. */
export const DEFAULT_FRESH_TAIL_MIN_MESSAGES = 8;

/** Token cap applied while selecting the protected fresh tail. */
export type FreshTailTokenCap = {
  /** Token cap; undefined means the tail is bounded by count only. */
  maxTokens?: number;
  /** Newest messages protected before the token cap applies. */
  minMessages: number;
};

/**
 * Resolve the fresh-tail token cap for one compaction or assembly call.
 *
 * An explicit `freshTailMaxTokens` wins and keeps its historical semantics
 * (at least one message). Otherwise the cap is `DEFAULT_FRESH_TAIL_BUDGET_SHARE`
 * of a finite positive `tokenBudget`, with `DEFAULT_FRESH_TAIL_MIN_MESSAGES`
 * kept regardless. Without a usable budget the tail is count-only.
 */
export function resolveFreshTailTokenCap(
  configuredMaxTokens: number | undefined,
  tokenBudget: number | undefined,
): FreshTailTokenCap {
  if (
    typeof configuredMaxTokens === "number" &&
    Number.isFinite(configuredMaxTokens) &&
    configuredMaxTokens >= 0
  ) {
    return { maxTokens: Math.floor(configuredMaxTokens), minMessages: 1 };
  }
  if (
    typeof tokenBudget !== "number" ||
    !Number.isFinite(tokenBudget) ||
    tokenBudget <= 0 ||
    tokenBudget >= Number.MAX_SAFE_INTEGER
  ) {
    return { minMessages: 1 };
  }
  return {
    maxTokens: Math.floor(tokenBudget * DEFAULT_FRESH_TAIL_BUDGET_SHARE),
    minMessages: DEFAULT_FRESH_TAIL_MIN_MESSAGES,
  };
}

/** Normalize a minimum protected message count to at least one. */
export function normalizeFreshTailMinMessages(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : 1;
}
