import { Type } from "@sinclair/typebox";
import type { LcmContextEngine } from "../engine.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

/**
 * Agent-triggered LCM compaction tool.
 *
 * Lets an agent proactively compact its conversation context mid-turn
 * when it knows it'll need headroom for subsequent deep-dive tool
 * calls. Closes the gap between "single-call cap protects one tool"
 * and "post-turn auto-compaction kicks in too late" — without that
 * middle layer, an agent chaining 4-5 large tool calls in one turn
 * can hit context_length_exceeded before the runtime has a chance
 * to compact.
 *
 * # When the agent should call this
 *
 * Per the description tag, agents should call lcm_compact when:
 *   - Context usage is &gt;70% AND
 *   - The agent reasonably expects 2+ more tool calls THIS turn AND
 *   - Post-turn compaction won't help (the turn won't end before the
 *     deep-dive is complete)
 *
 * # When the tool refuses (structured reasons)
 *
 * Engine-side gates (checked first via getAgentCompactionGateState):
 *   - engine-unhealthy: LCM migration didn't complete at boot
 *   - below-floor:      context% &lt; reserveFraction (default 50%) — no
 *                       point compacting when context is already roomy
 *
 * Tool-side gates:
 *   - operator-disabled: agentCompactionToolEnabled = false
 *   - capped-this-turn:  exceeded per-window cap (cost / abuse control)
 *
 * # NOT a gate: prompt cache hot/cold state
 *
 * Agent-triggered compaction deliberately bypasses the cache-hot
 * deferral that the AUTOMATIC threshold path consults. The agent
 * calling this tool is making a conscious trade: pay 4× cache cost on
 * the next call vs. fail with context_length_exceeded mid-turn. Gating
 * on cache state would create a paradox — the cache is hot precisely
 * because the agent just used the tools that filled the context, which
 * is the exact moment it needs more room. (The cache-hot protection
 * still applies to AUTOMATIC threshold drains; see
 * `shouldDelayPromptMutatingDeferredCompaction` in engine.ts.)
 *
 * Engine.compact() reasons (mapped to tool-facing enum):
 *   - "compacted"       → success
 *   - "below threshold" / "already under target" / "nothing to compact"
 *                       → noop (no work needed)
 *   - "circuit breaker open" / "provider auth failure"
 *                       → auth-failure
 *   - "session excluded" / "stateless session"
 *                       → session-excluded
 *
 * # Limitations (documented honestly)
 *
 * - Per-window cap is enforced via in-memory counter keyed on
 *   sessionKey + 5-minute window (a proxy for "turn" until openclaw
 *   plumbs turnId through to tool execute). Plugin restart resets
 *   all counters. NOT durable.
 * - No wall-clock timeout. The tool blocks until engine.compact()
 *   completes. Typical 5-30s; worst case ~60-90s for full sweep
 *   with multi-round LLM calls. The agent's host-runtime tool-call
 *   timeout is the actual upper bound.
 * - Pre-existing engine concerns (queue scope, AbortSignal) are
 *   NOT addressed in this MVP — see PR description for the
 *   follow-up scope.
 */

const COMPACTION_WINDOW_MS = 5 * 60 * 1000; // 5 minutes — proxy for "turn"
const DEFAULT_CAP_PER_WINDOW = 2;

/**
 * In-memory counter: sessionKey → { count, firstAt }. Resets when:
 *   - Window (5 min) expires since first call
 *   - Plugin process restarts
 *
 * NOT durable. Acceptable trade-off given (a) per-turn cap is
 * advisory anti-abuse not security, (b) durable persistence would
 * need DB writes per call (overkill), (c) future PR will switch to
 * runId-keyed once openclaw plumbs turnId.
 */
const compactionCallsBySession = new Map<
  string,
  { count: number; firstAt: number }
>();

function checkAndIncrementCounter(
  sessionKey: string,
  capPerWindow: number,
): { allowed: boolean; count: number; resetAtMs: number } {
  const now = Date.now();
  const existing = compactionCallsBySession.get(sessionKey);
  if (!existing || now - existing.firstAt > COMPACTION_WINDOW_MS) {
    compactionCallsBySession.set(sessionKey, { count: 1, firstAt: now });
    return { allowed: true, count: 1, resetAtMs: now + COMPACTION_WINDOW_MS };
  }
  if (existing.count >= capPerWindow) {
    return {
      allowed: false,
      count: existing.count,
      resetAtMs: existing.firstAt + COMPACTION_WINDOW_MS,
    };
  }
  existing.count += 1;
  return {
    allowed: true,
    count: existing.count,
    resetAtMs: existing.firstAt + COMPACTION_WINDOW_MS,
  };
}

const LcmCompactSchema = Type.Object({
  reserveFraction: Type.Optional(
    Type.Number({
      description:
        "Lower bound on (currentTokens / tokenBudget) before compaction is allowed. Range [0.5, 1.0]. Default 0.5: tool refuses to compact if context is already below half-full (no work needed). Tighter values (e.g. 0.7) make the tool only fire on near-full contexts.",
      minimum: 0.5,
      maximum: 1.0,
    }),
  ),
});

/**
 * Map engine.compact() raw reason strings into the tool-facing enum.
 * Engine has 12+ reason strings; the agent doesn't need that fidelity —
 * collapse to a small actionable set.
 */
function mapEngineReason(
  rawReason: string | undefined,
): {
  toolReason:
    | "compacted"
    | "noop"
    | "auth-failure"
    | "session-excluded"
    | "no-conversation"
    | "missing-budget"
    | "partial-compact"
    | "unknown";
  agentNote: string;
} {
  const r = (rawReason ?? "").toLowerCase();
  if (r === "compacted" || r.includes("compaction successful")) {
    return {
      toolReason: "compacted",
      agentNote: "Compaction completed. Next model call sees the compacted view.",
    };
  }
  if (
    r.includes("below threshold")
    || r.includes("already under target")
    || r.includes("nothing to compact")
    || r.includes("already compacted")
  ) {
    return {
      toolReason: "noop",
      agentNote:
        "No compaction was needed — context is already below threshold or has nothing compactable. Continue with your work.",
    };
  }
  if (r.includes("circuit breaker") || r.includes("auth failure")) {
    return {
      toolReason: "auth-failure",
      agentNote:
        "Compaction failed because the summarizer model has lost auth (circuit breaker tripped). Surface this to the user — operator must re-authenticate the summarizer provider.",
    };
  }
  if (r.includes("session excluded") || r.includes("stateless session")) {
    return {
      toolReason: "session-excluded",
      agentNote:
        "This session is excluded from LCM (operator config: ignoreSessionPatterns / statelessSessionPatterns). LCM compaction does not apply here.",
    };
  }
  if (r.includes("no conversation found")) {
    return {
      toolReason: "no-conversation",
      agentNote:
        "No LCM conversation has been recorded for this session yet — nothing to compact. (This typically means it's a fresh session with very little history.)",
    };
  }
  if (r.includes("missing token budget")) {
    return {
      toolReason: "missing-budget",
      agentNote:
        "Compaction needs the host runtime to provide tokenBudget but it wasn't available. Pass currentTokenCount + tokenBudget if calling from automation.",
    };
  }
  if (r.includes("live context still exceeds target") || r.includes("deferred compaction no longer needed")) {
    return {
      toolReason: "partial-compact",
      agentNote:
        "Compaction ran partially — some content was condensed but the context still exceeds the target. May need another call once the cache cools, or rely on post-turn compaction.",
    };
  }
  return {
    toolReason: "unknown",
    agentNote: `Compaction returned an unmapped reason: "${rawReason}". Continue with your work; check the gateway log if this repeats.`,
  };
}

export function createLcmCompactTool(input: {
  deps: LcmDependencies;
  lcm?: LcmContextEngine;
  getLcm?: () => Promise<LcmContextEngine>;
  sessionId?: string;
  sessionKey?: string;
  /**
   * Live runtime-context provider. Wired to `getTokenStateRuntimeContext`
   * in `src/plugin/index.ts` (Wave-14) — pulls the cached current token
   * count + budget populated by the `llm_output` hook handler.
   *
   * Returns undefined fields when no LLM call has fired yet for this
   * session. The tool tolerates undefined and skips token-aware logic
   * (floor check) in that case — equivalent to "operator hasn't wired
   * runtime telemetry yet."
   */
  getRuntimeContext?: () => {
    currentTokenCount?: number;
    tokenBudget?: number;
    /** sessionFile passthrough (deprecated — use deps/runtime resolution). */
    sessionFile?: string;
  };
}): AnyAgentTool {
  return {
    name: "lcm_compact",
    label: "LCM Compact",
    description:
      "PROACTIVELY compact this conversation's LCM context mid-turn to free room for chained tool calls. " +
      "Use sparingly: only when (a) context is already past 70% of budget AND (b) you reasonably expect 2+ more tool calls this turn AND (c) waiting for post-turn auto-compaction is not viable. " +
      "DOES blocking work — typical 5-30s, runs an LLM summarization call. " +
      "REFUSES if: context is below the reserveFraction floor (default 50% — no point compacting when context is roomy), engine migration failed at boot, or you've exceeded 2 calls in the last 5 minutes. " +
      "DOES NOT gate on prompt-cache state — agent-triggered compaction deliberately bypasses cache deferral that the automatic threshold path uses, because the cache is hot precisely when you most need to compact. " +
      "After successful compaction, the next model call will see the compacted view automatically (LCM owns context-engine reassembly between tool calls). " +
      "Returns structured reason on success/failure.",
    parameters: LcmCompactSchema,
    async execute(_toolCallId, params) {
      // Operator opt-in gate (config flag). Always-register pattern:
      // tool surfaces the disabled state to the agent rather than
      // returning "tool not found", so the agent can recommend
      // operator action.
      const cfg = input.deps.config as { agentCompactionToolEnabled?: boolean };
      if (cfg.agentCompactionToolEnabled !== true) {
        return jsonResult({
          ok: false,
          compacted: false,
          reason: "operator-disabled",
          note:
            "lcm_compact is disabled by operator config. To enable, set agentCompactionToolEnabled: true in the lossless-claw plugin config and restart the gateway.",
        });
      }

      const lcm = input.lcm ?? (await input.getLcm?.());
      if (!lcm) {
        return jsonResult({
          ok: false,
          compacted: false,
          reason: "engine-unavailable",
          note: "LCM engine is not available. The plugin may still be initializing — try again on the next turn.",
        });
      }

      const sessionKey = input.sessionKey?.trim() ?? input.sessionId?.trim() ?? "";
      if (!sessionKey) {
        return jsonResult({
          ok: false,
          compacted: false,
          reason: "no-session",
          note: "No session-key was provided to the tool factory; cannot compact.",
        });
      }

      const p = params as { reserveFraction?: number };
      const reserveFraction = (() => {
        const r = p.reserveFraction;
        if (typeof r !== "number" || !Number.isFinite(r)) return 0.5;
        return Math.max(0.5, Math.min(1.0, r));
      })();

      // Live runtime metrics (operator-supplied via getRuntimeContext;
      // optional — gate-state tolerates undefined).
      const runtimeCtx = input.getRuntimeContext?.() ?? {};
      const currentTokenCount = runtimeCtx.currentTokenCount;
      const tokenBudget = runtimeCtx.tokenBudget;

      // Wave-12 reviewer P2 fix: gate FIRST, increment counter AFTER.
      // Previously the per-window cap was burned on every call regardless
      // of whether the engine accepted it — so an agent probing at 30%
      // context (below-floor refusal) burned its 2-call budget without
      // ever running compaction, then was locked out at 80% when it
      // actually needed to compact. Refusals are free; only successful
      // (or attempted) compactions count against the cap.
      const gate = await lcm.getAgentCompactionGateState({
        sessionId: input.sessionId ?? sessionKey,
        sessionKey,
        currentTokenCount,
        tokenBudget,
        reserveFraction,
      });
      if (gate.shouldRefuse) {
        return jsonResult({
          ok: true,  // gate-refusal is "tool ran successfully and refused"
          compacted: false,
          reason: gate.refusalReason,
          note: gate.refusalNote,
          contextRatio: gate.contextRatio,
        });
      }

      // Per-window cap (in-memory; documented limitation). Increment now
      // that gate has accepted — this counts as a real compaction attempt.
      const cap = checkAndIncrementCounter(sessionKey, DEFAULT_CAP_PER_WINDOW);
      if (!cap.allowed) {
        return jsonResult({
          ok: false,
          compacted: false,
          reason: "capped-this-turn",
          note: `Per-window compaction cap reached (${cap.count}/${DEFAULT_CAP_PER_WINDOW} in the last ${Math.round(COMPACTION_WINDOW_MS / 60000)} min). Counter resets at ${new Date(cap.resetAtMs).toISOString()}. Continue with your existing context — chained calls will queue post-turn compaction automatically.`,
          retryAfterIso: new Date(cap.resetAtMs).toISOString(),
        });
      }

      // Run the actual compaction (blocking, no timeout — see header).
      const sessionFile = runtimeCtx.sessionFile ?? "";
      try {
        const result = await lcm.compact({
          sessionId: input.sessionId ?? sessionKey,
          sessionKey,
          sessionFile,
          tokenBudget,
          currentTokenCount,
          force: false, // honors engine-side cache-hot + threshold gates
        });
        const mapped = mapEngineReason(result.reason);
        return jsonResult({
          ok: result.ok,
          compacted: Boolean(result.compacted),
          reason: mapped.toolReason,
          note: mapped.agentNote,
          rawEngineReason: result.reason,
          contextRatio: gate.contextRatio,
          callsThisWindow: cap.count,
          callsRemainingThisWindow: Math.max(0, DEFAULT_CAP_PER_WINDOW - cap.count),
        });
      } catch (e) {
        return jsonResult({
          ok: false,
          compacted: false,
          reason: "exception",
          note: `Compaction threw: ${e instanceof Error ? e.message : String(e)}. Check the gateway log; surface to the user if this repeats.`,
        });
      }
    },
  };
}

/**
 * Test-only helper to reset the per-session counter between tests.
 * Not exported through the package's public surface — accessed via
 * direct module import in test files only.
 */
export function __resetLcmCompactCountersForTesting(): void {
  compactionCallsBySession.clear();
}
