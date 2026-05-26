/**
 * Worker LLM call adapter — LCM v4.1 cycle-2.
 *
 * Wraps the existing `deps.complete` (CompleteFn) with the surfaces that
 * worker tasks need: entity extraction, procedure judging, theme naming,
 * synthesis. Reuses model resolution + auth from the existing
 * summarizer's plumbing — no new credential plumbing.
 *
 * Why a separate module: the existing `createLcmSummarizeFromLegacyParams`
 * (src/summarize.ts) is structured around per-leaf compaction (target
 * tokens, mode='aggressive', isCondensed flag). Worker tasks need
 * arbitrary prompts → text. Wrapping `deps.complete` directly is
 * simpler than coercing the summarizer signature.
 *
 * The Group D synthesis dispatch already accepts an `LlmCall` injection
 * — we just need to construct one from the plugin's deps.
 */

import type { LcmDependencies } from "../types.js";
import type { LlmCall, LlmCallArgs, LlmCallResult } from "../synthesis/dispatch.js";

export interface WorkerLlmConfig {
  deps: LcmDependencies;
  /** Default model for worker LLM calls (overridden per-call by dispatch). */
  defaultModel?: string;
  /** Per-attempt timeout in ms. Default 60_000. */
  timeoutMs?: number;
  /**
   * Auth-profile override. If unset, uses the summarizer's resolution
   * chain. Operator-specific (probably unused for v4.1 first cut).
   */
  authProfileId?: string;
  /** Working dir for credential resolution. */
  agentDir?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
// Reads LCM_SUMMARY_MODEL env (operator's chosen default; matches the
// leaf-summarizer convention in summarize.ts) with a 'gpt-5.4-mini'
// fallback if env unset.
const DEFAULT_MODEL = process.env.LCM_SUMMARY_MODEL?.trim() || "gpt-5.4-mini";

/**
 * Build an `LlmCall` from the plugin's deps. The returned function is
 * suitable for injection into `dispatchSynthesis()` (Group D) or any
 * other worker that needs a generic LLM call surface.
 *
 * Latency is measured around the call. Cost is NOT computed (we don't
 * have a token-cost calculator wired); audit cost_usd_cents stays
 * undefined → recorded as NULL.
 */
export function createWorkerLlmCall(config: WorkerLlmConfig): LlmCall {
  const { deps } = config;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = deps.log;

  return async (args: LlmCallArgs): Promise<LlmCallResult> => {
    const startedAt = Date.now();
    const modelRef = args.model || config.defaultModel || DEFAULT_MODEL;
    // Resolve model via plugin's resolver. Falls back to legacy
    // env-driven defaults if resolveModel returns empty.
    const resolved = deps.resolveModel?.(modelRef);
    const provider = resolved?.provider;
    const model = resolved?.model ?? modelRef;

    // Run with timeout — worker task budget is hard-capped so a stuck
    // LLM doesn't block the worker loop's heartbeat.
    let response: Awaited<ReturnType<typeof deps.complete>>;
    try {
      response = await withTimeout(
        deps.complete({
          provider,
          model,
          system:
            "You are a worker process for the LCM (Lossless Context Management) plugin. " +
            "You handle structured tasks like entity extraction, procedure judging, theme naming, " +
            "and synthesis. Follow the user prompt's exact contract — output formats matter for " +
            "downstream parsing.",
          messages: [{ role: "user", content: args.prompt }],
          maxTokens: args.maxOutputTokens ?? 1024,
          // Reasoning hint: low for short-output tasks (judges, names),
          // medium for longer (synthesis). Heuristic from prompt size.
          reasoningIfSupported: args.passKind === "best_of_n_judge" ? "low" : "medium",
        }),
        timeoutMs,
        `worker-llm:${args.passKind}:${model}`,
      );
    } catch (e) {
      // Re-throw to dispatch — it logs an audit row + rethrows as
      // SynthesisDispatchError("llm_failure"). We don't catch here.
      log.warn(
        `[worker-llm] LLM call failed (model=${model} passKind=${args.passKind}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      throw e;
    }

    // CompletionResult has a `text` field per the existing summarizer.
    // Be defensive: if response shape is malformed, surface a clear
    // error rather than returning an empty string.
    const text = extractText(response);
    if (text === null) {
      throw new Error(
        `[worker-llm] LLM response had no text content (provider=${provider} model=${model})`,
      );
    }

    const latencyMs = Date.now() - startedAt;
    // Wave-9 TS-tightening: route through `unknown` because
    // CompletionResult's runtime shape may include a `model` field
    // (some pi-ai providers populate it; the typed surface doesn't
    // expose it). Cast through unknown to satisfy strict overlap, then
    // narrow with typeof.
    const responseModel = (response as unknown as { model?: unknown }).model;
    const actualModelName = typeof responseModel === "string" ? responseModel : model;
    return {
      output: text,
      latencyMs,
      // costCents intentionally undefined — no token-cost calculator wired
      actualModel: actualModelName,
    };
  };
}

// ---------- internals ----------

function extractText(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const r = response as Record<string, unknown>;
  // Most-common shape from pi-ai
  if (typeof r.text === "string") return r.text;
  // Fallback shapes (defensive)
  if (typeof r.content === "string") return r.content;
  if (Array.isArray(r.content)) {
    const parts = r.content
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object" && "text" in c && typeof c.text === "string") {
          return c.text;
        }
        return "";
      })
      .filter(Boolean);
    if (parts.length > 0) return parts.join("\n");
  }
  return null;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[worker-llm] timeout after ${timeoutMs}ms (${label})`));
    }, timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}
