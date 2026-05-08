/**
 * Per-session token-state cache for LCM tools.
 *
 * # Why this exists
 *
 * `OpenClawPluginToolContext` doesn't expose live token state to plugin
 * tool factories today (Wave-14 research confirmed; see lossless-claw#472,
 * openclaw#68930). But every LLM call fires `llm_output` with a `usage`
 * payload that includes input/cacheRead/cacheWrite token counts.
 *
 * This module:
 *   1. Subscribes to `llm_output` and caches the latest token state per
 *      session_key. Cached value is the GROUND TRUTH from the runtime —
 *      reflects what the LLM actually saw as input on that call.
 *   2. Exposes a tool-side helper for the additive per-tool self-update
 *      pattern: tools call `accumulateTokens(sessionKey, n)` after they
 *      compute their result. This keeps the cache monotonically increasing
 *      WITHIN a single iteration's tool batch (where parallel tool calls
 *      from one LLM response would otherwise all see the same stale value).
 *   3. Provides a `getRuntimeContext(sessionKey)` accessor that tool
 *      factories can wire into their `getRuntimeContext?` callback.
 *
 * # Failure mode (one-iteration lag)
 *
 * llm_output fires AFTER each LLM response. So the very first tool batch
 * of a turn sees no cached value (until the first LLM response lands).
 * In practice the first iteration of a turn always has llm_output fire
 * before any tool runs, so this is rarely visible — but tools must
 * tolerate `undefined` from `getRuntimeContext()` and skip token-aware
 * logic in that case.
 *
 * # Drift mitigation
 *
 * The per-tool additive update is an ESTIMATE (chars/4). When the next
 * llm_output fires, the cache snaps back to ground truth. Per-iteration
 * drift is bounded by the iteration's tool batch size. Cross-iteration
 * drift is reset on each LLM response.
 *
 * # Replacement when openclaw ships getTokenState
 *
 * Once openclaw lands the proper SDK accessor (proposed: `getTokenState?`
 * on `OpenClawPluginToolContext`), this module's role shrinks to a
 * fallback for older openclaw versions. The hook subscription becomes
 * legacy code; the per-tool self-update stays as a lag-protection layer
 * within iterations.
 *
 * # Public surface contract (Wave-12 retro N1)
 *
 * Tools MAY import named lifecycle hooks from this module — currently
 * `getRuntimeContext`, `inferTokenBudget`, `noteSuccessfulCompact`. They
 * MUST NOT reach into the underlying `tokensBySession` map directly. If
 * a tool needs a new lifecycle event (e.g. a future `noteCompactionMidpoint`),
 * add a named exported function here and document its semantics; do not
 * push the cache-management concern into the tool.
 *
 * `lcm_compact` is the first tool to import a lifecycle hook directly
 * (`noteSuccessfulCompact`). Future cache-aware tools should follow the
 * same pattern.
 */

export interface TokenSnapshot {
  /** input + cacheRead + cacheWrite from last observed model call (or accumulated tool results). */
  currentTokenCount: number;
  /** Active model's effective context budget; undefined if not derivable. */
  tokenBudget?: number;
  /** ms timestamp of the last llm_output that anchored the value. */
  anchorAt: number;
  /** ms timestamp of the last tool self-update or anchor. */
  lastUpdateAt: number;
  /** Source of the last update: 'llm_output' (ground truth) or 'tool-self-report' (estimate). */
  lastUpdateSource: "llm_output" | "tool-self-report";
}

const tokensBySession = new Map<string, TokenSnapshot>();

/**
 * Record the ground-truth state from an llm_output event.
 * Called by the plugin's hook handler at registration time.
 */
export function recordLlmOutput(params: {
  sessionKey: string;
  usage: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  tokenBudget?: number;
}): void {
  const { sessionKey, usage } = params;
  if (!sessionKey) return;
  // Match LCM's existing logic at engine.ts:1262-1266 — input + cacheRead + cacheWrite.
  // Output tokens are the LLM's response, not part of context budget.
  const currentTokenCount =
    (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  const now = Date.now();
  tokensBySession.set(sessionKey, {
    currentTokenCount,
    tokenBudget: params.tokenBudget,
    anchorAt: now,
    lastUpdateAt: now,
    lastUpdateSource: "llm_output",
  });
}

/**
 * Tool-side: add the tool's result-size contribution to the cache.
 * Called by each tool's execute() after computing its result.
 *
 * This handles the parallel-tool-call case where the LLM emits multiple
 * tool calls in one response — openclaw runs them sequentially but all
 * between the same two llm_output events, so without this the second+
 * tool sees stale state.
 *
 * Estimate is `Math.ceil(resultBytes / 4)`. Drift is bounded by the
 * iteration's tool batch size and reset on the next llm_output.
 */
export function accumulateToolResultTokens(
  sessionKey: string,
  resultText: string,
): void {
  if (!sessionKey || !resultText) return;
  const existing = tokensBySession.get(sessionKey);
  if (!existing) return;  // no anchor yet; skip — first llm_output will set it
  const addedTokens = Math.ceil(resultText.length / 4);
  tokensBySession.set(sessionKey, {
    ...existing,
    currentTokenCount: existing.currentTokenCount + addedTokens,
    lastUpdateAt: Date.now(),
    lastUpdateSource: "tool-self-report",
  });
}

/**
 * Tool-factory accessor. Each tool factory registers
 * `getRuntimeContext: () => getRuntimeContext(ctx.sessionKey)`.
 * Tools call this at execute() time to read the latest cached value.
 *
 * Returns undefined fields when no llm_output has fired yet for this
 * session. Tools should tolerate this and skip token-aware logic.
 */
export function getRuntimeContext(sessionKey: string | undefined): {
  currentTokenCount?: number;
  tokenBudget?: number;
  lastUpdateAt?: number;
  lastUpdateSource?: "llm_output" | "tool-self-report";
} {
  if (!sessionKey) return {};
  const snapshot = tokensBySession.get(sessionKey);
  if (!snapshot) return {};
  return {
    currentTokenCount: snapshot.currentTokenCount,
    tokenBudget: snapshot.tokenBudget,
    lastUpdateAt: snapshot.lastUpdateAt,
    lastUpdateSource: snapshot.lastUpdateSource,
  };
}

/** Test-only — reset the cache between tests. */
export function __resetTokenStateForTesting(): void {
  tokensBySession.clear();
}

/**
 * Wave-12 audit (W2A1 P0 #1): post-compact cache reset.
 *
 * After a successful `lcm_compact` the engine's actual context drops
 * dramatically (e.g. 184K → 70K). The token-state cache, however, still
 * carries the pre-compact value until the NEXT `llm_output` event fires.
 * Without this hook, the very next wrapped tool's `evaluateNeedsCompactGate`
 * runs against the stale 184K and refuses spuriously — exactly what
 * compact was meant to prevent. Worst case: agent loops compact→refuse
 * →compact until the per-window cap (2/5min) blocks further attempts.
 *
 * Strategy: clear the cache entry. The next wrapped tool call sees no
 * snapshot → `evaluateNeedsCompactGate` bypasses (its documented behavior
 * when telemetry is missing) → tool runs → `tapResultForTokenAccounting`
 * recreates the entry with the size of the new result (small).
 * Subsequent calls accumulate normally; on the next `llm_output` we snap
 * back to ground truth.
 *
 * This is conservative — it temporarily disables the gate for one or
 * two tool calls until the next llm_output. That trade is correct here:
 * the alternative (stale-cache spurious refusal) is observably worse.
 */
export function noteSuccessfulCompact(sessionKey: string | undefined): void {
  if (!sessionKey) return;
  tokensBySession.delete(sessionKey);
}

/**
 * Convenience helper used by tools to wrap their result emissions:
 * extracts the rendered text and calls accumulateToolResultTokens.
 * Tools call this on every return path (success + error) so the cache
 * stays accurate across mixed outcomes.
 *
 * Returns the input result unchanged so callers can `return tapResult(sessionKey, jsonResult(...))`.
 */
export function tapResultForTokenAccounting<
  T extends { content?: Array<{ type?: string; text?: string }> },
>(sessionKey: string | undefined, result: T): T {
  if (!sessionKey) return result;
  const first = result.content?.[0];
  const text = first && first.type === "text" && typeof first.text === "string" ? first.text : "";
  if (text) accumulateToolResultTokens(sessionKey, text);
  return result;
}

/**
 * Best-effort token-budget inference from a model identifier. Returns
 * undefined when the model isn't recognized — caller falls back to
 * config (`config.maxAssemblyTokenBudget`) or skips the budget check.
 *
 * Used when llm_output doesn't carry an explicit budget; we infer from
 * provider/model. Not authoritative — the openclaw runtime's own
 * `tokenBudget` (passed to engine.afterTurn / engine.compact) is the
 * canonical source. This is just a convenience for the hook handler.
 */
export function inferTokenBudget(
  provider: string | undefined,
  model: string | undefined,
): number | undefined {
  const ref = `${provider ?? ""}/${model ?? ""}`.toLowerCase();

  // 1M-context tier (most-specific match first)
  if (ref.includes("opus-4-7") || ref.includes("opus-4-6") || ref.includes("opus-4-5")) {
    return 1_000_000;
  }
  if (ref.includes("gpt-5.4") || ref.includes("gpt-5.5")) {
    // OpenAI Codex 1M context tier
    return 1_000_000;
  }
  // Gemini 1.5/2.x — 1M default; matches actual context window for the family.
  if (ref.includes("gemini-1.5") || ref.includes("gemini-2")) {
    return 1_000_000;
  }
  // Anthropic 200K family (claude 3.x, sonnet/haiku-4.x)
  if (ref.includes("sonnet-4-5") || ref.includes("sonnet-4-6")) {
    return 200_000;
  }
  if (ref.includes("haiku")) {
    return 200_000;
  }
  if (ref.includes("claude-3-5") || ref.includes("claude-3-7") || ref.includes("claude-3.5") || ref.includes("claude-3.7") || ref.includes("claude-sonnet")) {
    return 200_000;
  }
  // 128K-context tier — gpt-4o family, o1 family.
  if (ref.includes("gpt-4o") || ref.includes("o1-")) {
    return 128_000;
  }
  // 32K floor for small-context legacy GPT-4 + unknown providers.
  // Wave-12 retro M1: was a uniform 200K — too generous for sub-200K
  // models (gate stayed silent until projected context was 6× over real
  // budget). Per-provider defaults match each family's actual context
  // window more closely. Unknown / Ollama / Mistral / OpenRouter all
  // fall through to the 32K floor (smallest common context across
  // self-hosted + niche-cloud setups). Operators on larger models with
  // an unrecognized name should explicitly set tokenBudget via runtime
  // config, OR via env var `LCM_DEFAULT_TOKEN_BUDGET` (escape hatch).
  if (ref.includes("gpt-4")) {
    return 32_000;
  }
  // Env-driven escape hatch for unknown providers.
  const envOverride = process.env.LCM_DEFAULT_TOKEN_BUDGET?.trim();
  if (envOverride) {
    const parsed = Number.parseInt(envOverride, 10);
    if (Number.isFinite(parsed) && parsed >= 8_000 && parsed <= 2_000_000) {
      return parsed;
    }
  }
  return 32_000;
}
