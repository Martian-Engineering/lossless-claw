/**
 * Pre-call `needsCompact` gate for LCM tools.
 *
 * # What this is
 *
 * Implements the negotiated middle-ground architecture (Wave-14):
 * before a big tool runs, estimate its result size; if (current +
 * estimated) / budget > REFUSAL_THRESHOLD, refuse with structured
 * `{ok: false, needsCompact: true, ...}` so the agent can call
 * lcm_compact then retry. Without this layer, the agent has to
 * proactively monitor context and compact preemptively — too much
 * cognitive load.
 *
 * # Threshold derivation
 *
 * REFUSAL_THRESHOLD = 0.92 (calibrated from real DB sampling, Wave-14
 * Agent A). With 200K context × 0.05 cushion (the 0.95 alternative)
 * = 10K headroom — but every tool's hard cap IS up to MAX_RESULT_TOKENS
 * (default 10K, operator-tunable via `LCM_TOOL_RESULT_TOKEN_BUDGET`).
 * A single capped call leaves zero margin. 0.92 → 16K headroom = one
 * full-cap call + agent's own response (at the default cap).
 *
 * # Tools that use this
 *
 * - lcm_grep (all modes — including the merged `mode='semantic'` post Wave-12 SA)
 * - lcm_describe (most important — biggest blow-up risk)
 * - lcm_synthesize_around (Wave-12 audit W2A1: previously skipped; the
 *   "self-protecting via 50K source cap" reasoning covered SOURCE input
 *   bounds, not OUTPUT — and the markdown response is 4K-8K tokens of
 *   LLM-generated rollup that flowed past the cache silently. Fixed.)
 * - lcm_expand_query (sub-agent path; uniform behavior)
 * - lcm_get_entity / lcm_search_entities (uniform; rarely trips)
 *
 * Skipped:
 * - lcm_compact (status response, ~100 tokens; on success it CLEARS the
 *   cache via noteSuccessfulCompact so the next call re-bootstraps from
 *   the post-compact ground truth)
 * - lcm_expand (sub-agent only; has its own grant ledger)
 */

export const REFUSAL_THRESHOLD = 0.92;

/**
 * Per-tool result-token estimator. Math from Wave-14 Agent C
 * (calibrated against actual format strings + Agent A's live-DB
 * distributions). Capped at MAX_RESULT_TOKENS (default 10_000 tokens /
 * ~40K chars; operator-tunable via `LCM_TOOL_RESULT_TOKEN_BUDGET`).
 * Wave-12 audit W1A1 #2: the cap now tracks the env knob instead of
 * being hard-coded at 10_000 — previously, raising the env from 10K
 * to e.g. 30K let tools emit 30K but the estimator still capped its
 * projection at 10K, drifting needsCompact decisions low (refusals
 * missed when they should fire).
 * Confidence per tool varies from ~88-95%.
 */
export function estimateResultTokens(
  toolName: string,
  params: Record<string, unknown>,
): number {
  // Pulled from result-budget.ts so this estimator and per-tool
  // MAX_RESULT_CHARS truncation share one knob.
  const HARD_CAP_TOKENS = MAX_RESULT_TOKENS;
  const limit = typeof params.limit === "number" ? params.limit : 20;
  const charsPerToken = 4;

  switch (toolName) {
    case "lcm_grep": {
      const mode = (params.mode as string) ?? "regex";
      switch (mode) {
        case "regex":
        case "full_text": {
          // ~200 chars header + ~200 chars/row average (45 fixed + ~150 snippet)
          const chars = 200 + limit * 200;
          return Math.min(HARD_CAP_TOKENS, Math.ceil(chars / charsPerToken));
        }
        case "hybrid": {
          // +30 chars/row for provenance + score
          const chars = 250 + limit * 230;
          return Math.min(HARD_CAP_TOKENS, Math.ceil(chars / charsPerToken));
        }
        case "semantic": {
          // +50 chars header (Voyage model + confidence)
          const chars = 350 + limit * 215;
          return Math.min(HARD_CAP_TOKENS, Math.ceil(chars / charsPerToken));
        }
        case "verbatim": {
          // hard cap 20 results, full message rows; tool messages p95 = 7721 chars
          // Estimate conservatively per row: 600-2400 tokens (avg ~1000 tokens)
          const cap = Math.min(20, limit);
          const charsTypical = 70 + cap * 2_400;  // assistant median bias
          return Math.min(HARD_CAP_TOKENS, Math.ceil(charsTypical / charsPerToken));
        }
      }
      return 1500;
    }

    // Wave-12 consolidation SA: lcm_semantic_recall removed; its
    // estimator coefficient (250 + limit * 215) folded into lcm_grep's
    // mode='semantic' branch above. Estimate parity preserved.

    case "lcm_describe": {
      // Base: ~5 subtree nodes × 250 chars + ~3200 chars summary content + 350 header
      let chars = 350 + 5 * 250 + 3_200;
      if (params.expandChildren) {
        const k = (params.expandChildrenLimit as number | undefined) ?? 20;
        // Wave-12 reviewer F2 calibration: live-DB validation showed
        // typical condensed summaries are ~2000 tokens (8000 chars), and
        // the corpus DAG is flat parent-of-1 so most expandChildren calls
        // emit 0-1 child, not 20. Original 4075 char/child estimate
        // (assumed 1000-token leaves) was 2× too high for typical leaves
        // AND the 20× multiplier rarely binds. Calibrated against
        // /tmp/validation-f2-f5-f6.md: 5/5 condensed targets emit ≤1
        // child of ~2K tokens (8000 chars). Keep the k multiplier so
        // agents requesting larger limits still see proportional
        // estimate, but anchor to actual single-child cost.
        chars += k * 2_000;
      }
      if (params.expandMessages) {
        const k = (params.expandMessagesLimit as number | undefined) ?? 20;
        // Wave-12 reviewer F2 calibration: live-DB validation showed
        // real expandMessages=20 emits 2,551–3,604 tokens (median ~140
        // tokens/msg = ~560 chars/msg), not the original 600-tokens/msg
        // assumption (2400 chars/msg). Estimator was ~4× too high.
        // Recalibrated to ~600 chars/msg (150 tokens) which hits p90 of
        // the observed distribution.
        chars += k * 600;
      }
      // Note: lcm_describe has NO MAX_RESULT_CHARS cap today — the cap below
      // is enforced by us so estimator stays consistent. Tool itself returns
      // whatever the subtree+expansion is; agent's needsCompact pre-check
      // is the protection.
      return Math.min(HARD_CAP_TOKENS, Math.ceil(chars / charsPerToken));
    }

    case "lcm_get_entity": {
      const k = (params.mentionLimit as number | undefined) ?? 20;
      const chars = 250 + k * 110;
      return Math.min(HARD_CAP_TOKENS, Math.ceil(chars / charsPerToken));
    }

    case "lcm_search_entities": {
      const chars = 420 + limit * 85;
      return Math.min(HARD_CAP_TOKENS, Math.ceil(chars / charsPerToken));
    }

    case "lcm_expand_query": {
      const maxTokens =
        typeof params.maxTokens === "number" ? params.maxTokens : 2_000;
      // answer up to maxTokens, plus ~500 chars envelope
      return Math.min(HARD_CAP_TOKENS, maxTokens + 200);
    }

    case "lcm_compact":
      // Status response only (~10 fields, longest note ~250 chars).
      return 150;

    case "lcm_synthesize_around":
      // Wave-12 audit W2A1: lcm_synthesize_around is now wrapped by
      // runWithTokenGate so this estimate IS consulted. Output is the
      // synthesized markdown rollup. Wave-12 retro review (L1) flagged
      // a self-contradiction with this file's docstring ("4K-8K tokens
      // of LLM-generated rollup"). Picked 6_000 (midpoint of the
      // docstring range) — conservative under-estimate for typical
      // synthesis, matches what the file's docstring documents. The
      // 50K source-input cap is separate; we estimate OUTPUT here.
      return 6_000;

    default:
      return 1_000;  // unknown tool — small default
  }
}

/**
 * Evaluate the gate for a tool call. Returns `null` if the tool should
 * proceed normally (no gate fired); otherwise returns a structured
 * refusal payload that the tool returns DIRECTLY to the agent.
 *
 * If `currentTokenCount` or `tokenBudget` is undefined (no llm_output
 * has fired yet), the gate is BYPASSED and returns null — tools run
 * normally. This is a conservative default: missing telemetry shouldn't
 * cause refusals.
 */
export function evaluateNeedsCompactGate(params: {
  toolName: string;
  toolParams: Record<string, unknown>;
  currentTokenCount: number | undefined;
  tokenBudget: number | undefined;
  refusalThreshold?: number;
}): {
  ok: false;
  needsCompact: true;
  reason: "context-overflow-prevention";
  currentRatio: number;
  estimatedResultTokens: number;
  projectedRatio: number;
  note: string;
  suggested_actions: string[];
} | null {
  const threshold = params.refusalThreshold ?? REFUSAL_THRESHOLD;
  const { currentTokenCount, tokenBudget } = params;
  // Bypass when telemetry is missing (early in session, no llm_output yet).
  if (
    typeof currentTokenCount !== "number"
    || !Number.isFinite(currentTokenCount)
    || currentTokenCount < 0
    || typeof tokenBudget !== "number"
    || !Number.isFinite(tokenBudget)
    || tokenBudget <= 0
  ) {
    return null;
  }

  const estimatedResultTokens = estimateResultTokens(
    params.toolName,
    params.toolParams,
  );
  const currentRatio = currentTokenCount / tokenBudget;
  const projectedRatio = (currentTokenCount + estimatedResultTokens) / tokenBudget;

  if (projectedRatio <= threshold) {
    return null;  // safe — let it run
  }

  // Build refusal with concrete suggested actions.
  const suggested: string[] = ["lcm_compact then retry with same params"];
  // Tool-specific narrowing suggestions
  const limit = params.toolParams.limit;
  if (typeof limit === "number" && limit > 5) {
    suggested.push(`retry with limit=${Math.max(5, Math.floor(limit / 2))}`);
  }
  const expandChildrenLimit = params.toolParams.expandChildrenLimit;
  if (typeof expandChildrenLimit === "number" && expandChildrenLimit > 5) {
    suggested.push(`retry with expandChildrenLimit=${Math.max(5, Math.floor(expandChildrenLimit / 2))}`);
  }
  const expandMessagesLimit = params.toolParams.expandMessagesLimit;
  if (typeof expandMessagesLimit === "number" && expandMessagesLimit > 5) {
    suggested.push(`retry with expandMessagesLimit=${Math.max(5, Math.floor(expandMessagesLimit / 2))}`);
  }
  if (params.toolName === "lcm_describe" && params.toolParams.expandChildren && params.toolParams.expandMessages) {
    suggested.push("retry without one of the expand flags (e.g. drop expandMessages, keep expandChildren)");
  }

  return {
    ok: false,
    needsCompact: true,
    reason: "context-overflow-prevention",
    currentRatio: Math.round(currentRatio * 1000) / 1000,
    estimatedResultTokens,
    projectedRatio: Math.round(projectedRatio * 1000) / 1000,
    note: `Serving this call would push context to ${(projectedRatio * 100).toFixed(0)}% of budget (currently at ${(currentRatio * 100).toFixed(0)}%, would add ~${estimatedResultTokens} tokens). Refusing to prevent overflow. Call lcm_compact to free space, then retry — OR narrow params to reduce expected size.`,
    suggested_actions: suggested,
  };
}

/**
 * Wraps a tool's execute function with the Wave-14 token-aware behaviors:
 *   1. Pre-call needsCompact gate (refuses with structured payload if
 *      projected result > REFUSAL_THRESHOLD)
 *   2. Post-call result accumulation into the per-session token cache
 *      (so the next tool call in the same iteration sees accurate
 *      cumulative state)
 *
 * Tools call this from their own execute function:
 *
 *   async execute(toolCallId, params) {
 *     return runWithTokenGate({
 *       toolName: "lcm_grep",
 *       sessionKey: input.sessionKey,
 *       getRuntimeContext: input.getRuntimeContext,
 *       toolParams: params,
 *       inner: async () => {
 *         // ... existing tool body
 *         return jsonResult({...});
 *       },
 *     });
 *   }
 */
import { tapResultForTokenAccounting } from "./token-state.js";
import { jsonResult } from "../tools/common.js";
import { MAX_RESULT_TOKENS } from "./result-budget.js";

export async function runWithTokenGate<
  T extends { content?: Array<{ type?: string; text?: string }> },
>(opts: {
  toolName: string;
  toolParams: Record<string, unknown>;
  sessionKey: string | undefined;
  getRuntimeContext:
    | (() => { currentTokenCount?: number; tokenBudget?: number })
    | undefined;
  inner: () => Promise<T>;
}): Promise<T> {
  const runtimeCtx = opts.getRuntimeContext?.();
  if (runtimeCtx) {
    const refusal = evaluateNeedsCompactGate({
      toolName: opts.toolName,
      toolParams: opts.toolParams,
      currentTokenCount: runtimeCtx.currentTokenCount,
      tokenBudget: runtimeCtx.tokenBudget,
    });
    if (refusal) {
      return tapResultForTokenAccounting(opts.sessionKey, jsonResult(refusal)) as unknown as T;
    }
  }
  // Wave-12 audit (W2A1 P1): catch throws and tap before re-throwing.
  // Without this, every "throw new Error(...)" inside inner() (e.g.
  // "LCM engine is unavailable" — present in 6+ tools, plus 13 throw
  // sites in lcm_expand_query) propagated past the wrapper, skipping
  // tapResultForTokenAccounting entirely. The error message itself
  // costs tokens (the runtime serializes it for the agent), and that
  // cost was silently un-counted, drifting downstream gate decisions
  // low by exactly the size of the error message.
  let result: T;
  try {
    result = await opts.inner();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Tap an error-shaped result so the cache absorbs the size of the
    // error message the runtime will surface. Re-throw so callers can
    // still observe the failure.
    tapResultForTokenAccounting(
      opts.sessionKey,
      jsonResult({ error: `${opts.toolName}: ${msg}` }),
    );
    throw e;
  }
  return tapResultForTokenAccounting(opts.sessionKey, result);
}
