/**
 * Synthesis dispatch — LCM v4.1 §3 / Group D.
 *
 * Per-tier model + pass-strategy assignment. Given a synthesis request
 * (tier label + memory type + input content), this module:
 *
 *   1. Looks up the active prompt template from lcm_prompt_registry
 *      via the helpers in `prompt-registry.ts` (D.01).
 *
 *   2. Picks the right model + pass strategy for the tier:
 *      - daily   → single-pass, mini model
 *      - weekly  → single-pass, mid model
 *      - monthly → single-pass + verify-fidelity (hallucination check),
 *                  premium model
 *      - yearly  → best-of-N (N=3) + judge, premium model with thinking
 *      - custom/filtered (ad-hoc cache builds) → single-pass, mid model
 *
 *   3. Calls the injected `llmCall(model, prompt) → text` for each pass.
 *      The caller wires this to the existing pi-ai infrastructure in
 *      production; tests inject a deterministic mock.
 *
 *   4. Records each pass to lcm_synthesis_audit (started → completed/
 *      failed status transition with latency + cost telemetry).
 *
 *   5. Returns the final synthesized text + telemetry. Caller decides
 *      whether to write to summaries.content (cold rewrites) or to
 *      lcm_synthesis_cache (ad-hoc/filtered/yearly).
 *
 * Why this module is OUTSIDE the existing `summarize.ts` / pi-ai flow:
 * the existing summarizer is geared toward per-leaf compaction (called
 * inline by the gateway compactor). v4.1 synthesis is a worker-side
 * cold rewrite — different tier-aware model selection, different
 * verification logic, different cache surface. Keeping them separate
 * prevents regression in the hot path.
 *
 * Why we DON'T do critique-revise multi-pass: literature consensus is
 * that critique-revise underperforms single-pass for summarization
 * (architecture-v4.1 §3 + §11). We use:
 *   - Single-pass for daily/weekly (just summarize)
 *   - Single + verify-fidelity for monthly (summarize, then ask
 *     a separate model "does this contain claims not in source?")
 *   - Best-of-N + judge for yearly (run summarize 3× independently,
 *     then a judge prompt picks the best)
 */

import type { DatabaseSync } from "node:sqlite";
import {
  getActivePrompt,
  type MemoryType,
  type PassKind,
  type PromptRecord,
} from "./prompt-registry.js";

export type TierLabel =
  | "daily"
  | "weekly"
  | "monthly"
  | "yearly"
  | "custom"
  | "filtered";

/** Per-tier model recommendation. Override via prompt's
 *  model_recommendation field if a specific tier+memory_type combo
 *  needs a different default. */
export const DEFAULT_MODEL_BY_TIER: Record<TierLabel, string> = {
  daily: "claude-haiku-4-5",
  weekly: "claude-sonnet-4-5",
  monthly: "claude-opus-4-7",
  yearly: "claude-opus-4-7-thinking",
  custom: "claude-sonnet-4-5",
  filtered: "claude-sonnet-4-5",
};

/** Pass strategy per tier. The synthesis flow runs the listed passes
 *  in order. */
export const PASS_STRATEGY_BY_TIER: Record<TierLabel, PassKind[]> = {
  daily: ["single"],
  weekly: ["single"],
  monthly: ["single", "verify_fidelity"],
  yearly: ["best_of_n_judge"], // expanded to N=3 single-pass + 1 judge inside dispatch
  custom: ["single"],
  filtered: ["single"],
};

export interface LlmCallArgs {
  model: string;
  /** The fully-rendered prompt text (template + substitutions). */
  prompt: string;
  /** For audit: which pass the call is part of. */
  passKind: PassKind;
  /** Optional max output tokens (caller may have a budget). */
  maxOutputTokens?: number;
}

export interface LlmCallResult {
  /** Generated text. */
  output: string;
  /** Latency observed by the caller (used for audit). */
  latencyMs: number;
  /** USD cents (rounded), if known. Used for audit + telemetry. */
  costCents?: number;
  /** Override the model name we record (e.g. fallback chain triggered). */
  actualModel?: string;
}

/** Caller-supplied LLM call. Tests inject a deterministic mock. */
export type LlmCall = (args: LlmCallArgs) => Promise<LlmCallResult>;

export interface SynthesizeRequest {
  tier: TierLabel;
  memoryType: MemoryType;
  /** Input content to synthesize (e.g. concat of leaf contents). */
  sourceText: string;
  /**
   * Either targetSummaryId (rewriting an existing summaries row) OR
   * targetCacheId (writing to lcm_synthesis_cache). REQUIRED — the
   * lcm_synthesis_audit table has CHECK (target_summary_id IS NOT NULL
   * OR target_cache_id IS NOT NULL); passing neither throws
   * SynthesisDispatchError("missing_target") up-front rather than
   * deferring to a confusing CHECK violation mid-pass.
   *
   * (Group D adversarial Gap 1 fix: previous docstring claimed dry-run
   * was supported via skipping the audit row; the implementation
   * always inserted, so dry-run requests crashed with a raw SQLite
   * error before any LLM call.)
   */
  targetSummaryId?: string;
  targetCacheId?: string;
  /**
   * Pass-session ID — groups multiple audit rows for one synthesis
   * pass (e.g., the 3 best-of-N attempts + the judge call all share
   * a pass_session_id).
   */
  passSessionId: string;
  /**
   * Override default model for this tier. Useful for A/B tests.
   */
  modelOverride?: string;
  /**
   * Override the prompt's model_recommendation chain. By default the
   * prompt's model_recommendation > tier default. Setting this
   * forces a specific model regardless.
   */
  forceModel?: boolean;
  /** Best-of-N count for yearly tier. Default 3. */
  bestOfN?: number;
}

export interface SynthesizeResult {
  /** Final synthesized text. */
  output: string;
  /** Active prompt used for the primary single-pass. */
  primaryPromptId: string;
  /** Audit rows written. Caller may use audit_ids to back-reference. */
  auditIds: string[];
  /** Total latency across all passes. */
  totalLatencyMs: number;
  /** Total USD cents across all passes (sum of per-call costs). */
  totalCostCents: number;
  /** True if the verify-fidelity pass flagged hallucinations (monthly tier). */
  hallucinationFlagged?: boolean;
  /** Best-of-N detail (yearly tier only). */
  bestOfN?: {
    n: number;
    /** Index of the candidate the judge picked. */
    selectedIndex: number;
    /** All candidate outputs, in order. */
    candidates: string[];
    /**
     * Wave-5 P2 fix: when caller-requested bestOfN exceeds the hard cap
     * (5), the value used is clamped. Surface BOTH the requested + used
     * values so callers can see the clamp + audit cost decisions.
     */
    requested?: number;
    capped?: boolean;
  };
}

export class SynthesisDispatchError extends Error {
  constructor(
    public readonly kind:
      | "missing_prompt"
      | "missing_target"
      | "llm_failure"
      | "judge_failure"
      | "audit_insert_failure",
    message: string,
  ) {
    super(message);
    this.name = "SynthesisDispatchError";
  }
}

/**
 * Dispatch a synthesis request. See module docs for full pipeline.
 *
 * Throws {@link SynthesisDispatchError} on:
 *   - missing_prompt: no active prompt registered for (memoryType, tier, single|judge)
 *   - llm_failure: caller's llmCall threw (re-thrown after writing failed audit row)
 *   - judge_failure: yearly tier's judge call returned malformed output
 *
 * Returns SynthesisResult with primary output + telemetry.
 */
export async function dispatchSynthesis(
  db: DatabaseSync,
  llmCall: LlmCall,
  req: SynthesizeRequest,
): Promise<SynthesizeResult> {
  // Group D adversarial Gap 1 fix: validate target up-front. The
  // CHECK constraint on lcm_synthesis_audit would catch this later
  // anyway, but we throw a clear typed error before touching the LLM.
  if (!req.targetSummaryId && !req.targetCacheId) {
    throw new SynthesisDispatchError(
      "missing_target",
      "[synthesis.dispatch] either targetSummaryId or targetCacheId is required " +
        "(lcm_synthesis_audit CHECK constraint requires one of them set)",
    );
  }

  // 1. Look up active prompt for the primary pass
  const tier = req.tier;
  const passKinds = PASS_STRATEGY_BY_TIER[tier];
  const primaryPassKind: PassKind = tier === "yearly" ? "best_of_n_judge" : "single";
  const primaryPrompt = getActivePrompt(db, {
    memoryType: req.memoryType,
    tierLabel: tier,
    passKind: primaryPassKind === "best_of_n_judge" ? "single" : primaryPassKind,
  });
  if (!primaryPrompt) {
    throw new SynthesisDispatchError(
      "missing_prompt",
      `[synthesis.dispatch] no active prompt for (memoryType=${req.memoryType}, tier=${tier}, passKind=single)`,
    );
  }

  const auditIds: string[] = [];
  let totalLatencyMs = 0;
  let totalCostCents = 0;

  // 2. Pick model
  const model = pickModel(req, primaryPrompt);

  // 3. Branch on tier
  if (tier === "yearly") {
    // Wave-4 Auditor #5 P1 fix + Wave-5 P2: hard-cap bestOfN at 5 to
    // prevent unbounded cost (caller passing bestOfN=100 would spend
    // ~$100+ per yearly synthesis call). Surface clamp via `requested`
    // + `capped` fields in the result so callers can see + audit it.
    const HARD_CAP_BEST_OF_N = 5;
    const requestedBestOfN = req.bestOfN ?? 3;
    const cappedBestOfN = Math.max(1, Math.min(HARD_CAP_BEST_OF_N, requestedBestOfN));
    const result = await runBestOfNYearly(db, llmCall, req, primaryPrompt, model, {
      bestOfN: cappedBestOfN,
      auditIds,
      addLatency: (ms) => (totalLatencyMs += ms),
      addCost: (c) => (totalCostCents += c ?? 0),
    });
    if (result.bestOfN) {
      result.bestOfN.requested = requestedBestOfN;
      result.bestOfN.capped = requestedBestOfN > HARD_CAP_BEST_OF_N;
    }
    return result;
  }

  // 4. Standard single-pass (daily/weekly/custom/filtered): one LLM call
  const singlePassPrompt = renderPrompt(primaryPrompt.template, req);
  const singleResult = await runPassWithAudit(
    db,
    llmCall,
    {
      model,
      prompt: singlePassPrompt,
      passKind: "single",
      maxOutputTokens: undefined,
    },
    {
      passSessionId: req.passSessionId,
      promptId: primaryPrompt.promptId,
      targetSummaryId: req.targetSummaryId,
      targetCacheId: req.targetCacheId,
      passInputForAudit: req.sourceText,
    },
  );
  auditIds.push(singleResult.auditId);
  totalLatencyMs += singleResult.latencyMs;
  totalCostCents += singleResult.costCents ?? 0;

  let hallucinationFlagged: boolean | undefined;

  // 5. Optional verify-fidelity pass (monthly tier)
  if (passKinds.includes("verify_fidelity")) {
    const verifyPrompt = getActivePrompt(db, {
      memoryType: req.memoryType,
      tierLabel: tier,
      passKind: "verify_fidelity",
    });
    if (verifyPrompt) {
      const renderedVerify = renderVerifyPrompt(verifyPrompt.template, {
        sourceText: req.sourceText,
        candidateSummary: singleResult.output,
      });
      const verifyResult = await runPassWithAudit(
        db,
        llmCall,
        {
          model,
          prompt: renderedVerify,
          passKind: "verify_fidelity",
          maxOutputTokens: 100,
        },
        {
          passSessionId: req.passSessionId,
          promptId: verifyPrompt.promptId,
          targetSummaryId: req.targetSummaryId,
          targetCacheId: req.targetCacheId,
          passInputForAudit: singleResult.output,
        },
      );
      auditIds.push(verifyResult.auditId);
      totalLatencyMs += verifyResult.latencyMs;
      totalCostCents += verifyResult.costCents ?? 0;
      // The verify prompt's contract is to return `OK` (or `OK: all N
      // claims grounded` per the seeded §12 default) if no hallucinations,
      // or `UNSUPPORTED: <claim>` / `HALLUCINATION: <details>` otherwise.
      // Final.review.3 fix (Loop 4 Bug 4.1): regex was `^OK$` (requires
      // bare OK only), which rejected the seeded `OK: all N claims grounded`
      // contract — every clean monthly synthesis was wrongly flagged as
      // hallucinating. Relaxed to `^OK\b` so "OK" on its own OR followed by
      // a colon/whitespace passes; "OK!" or "OKAY" would still match (close
      // enough for a fidelity-checker — the precision loss is acceptable).
      //
      // Wave-1 Auditor #3 finding #4: anchored at start-of-string only meant
      // any preamble ("Here is the fidelity report:\n\nOK: ...") false-
      // positive flagged. Allow `OK\b` at start-of-string OR start of any
      // line.
      //
      // Wave-4 Auditor #5 P0 fix: the Wave-2 relaxation over-corrected — a
      // response with BOTH "UNSUPPORTED: claim X" AND a stray "OK on the
      // rest" matched the regex and CLEARED the hallucination flag. The
      // verify pass is meant to FLAG hallucinations; this regression let
      // hallucinated monthlies land in the cache as 'ready'. Tighten:
      // require absence of UNSUPPORTED / HALLUCINATION markers AS WELL AS
      // presence of OK\b. Either marker present → flagged.
      const hasNegativeMarker =
        /(?:^|\n)\s*(?:UNSUPPORTED|HALLUCINATION)\s*:/i.test(verifyResult.output);
      const hasOkMarker = /(?:^|\n)\s*OK\b/i.test(verifyResult.output);
      hallucinationFlagged = hasNegativeMarker || !hasOkMarker;
    }
    // If no verify prompt registered, skip silently — caller can decide
    // to enforce its presence via /lcm health.
  }

  return {
    output: singleResult.output,
    primaryPromptId: primaryPrompt.promptId,
    auditIds,
    totalLatencyMs,
    totalCostCents,
    hallucinationFlagged,
  };
}

// ---------- internals ----------

interface PassAuditCtx {
  passSessionId: string;
  promptId: string;
  targetSummaryId?: string;
  targetCacheId?: string;
  /** Truncated to a manageable length for storage (full input not retained). */
  passInputForAudit: string;
}

interface PassResult {
  auditId: string;
  output: string;
  latencyMs: number;
  costCents?: number;
  actualModel: string;
}

async function runPassWithAudit(
  db: DatabaseSync,
  llmCall: LlmCall,
  llmArgs: LlmCallArgs,
  audit: PassAuditCtx,
): Promise<PassResult> {
  const auditId = `audit_${audit.passSessionId}_${audit.promptId.slice(-6)}_${randomSuffix()}`;
  // Group D adversarial Gap 4 fix: wrap insertAuditRow in try/catch so
  // FK violations (bad target_summary_id) and CHECK violations surface
  // as typed SynthesisDispatchError(audit_insert_failure) instead of
  // raw SQLite errors. Forensic record still attempted; if THAT fails,
  // the typed error tells the caller the LLM was never called.
  try {
    insertAuditRow(db, {
      auditId,
      passSessionId: audit.passSessionId,
      targetSummaryId: audit.targetSummaryId ?? null,
      targetCacheId: audit.targetCacheId ?? null,
      promptId: audit.promptId,
      passKind: llmArgs.passKind,
      passInputTruncated: truncateForAudit(audit.passInputForAudit),
      status: "started",
      modelUsed: llmArgs.model,
    });
  } catch (e: unknown) {
    throw new SynthesisDispatchError(
      "audit_insert_failure",
      `[synthesis.dispatch] failed to insert 'started' audit row (LLM not called): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  let result: LlmCallResult;
  try {
    result = await llmCall(llmArgs);
  } catch (e: unknown) {
    updateAuditRow(db, auditId, {
      status: "failed",
      lastError: e instanceof Error ? e.message : String(e),
    });
    throw new SynthesisDispatchError(
      "llm_failure",
      `[synthesis.dispatch] LLM call failed for pass ${llmArgs.passKind}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  updateAuditRow(db, auditId, {
    status: "completed",
    passOutput: truncateForAudit(result.output),
    modelUsed: result.actualModel ?? llmArgs.model,
    latencyMs: Math.round(result.latencyMs),
    costCents: typeof result.costCents === "number" ? Math.round(result.costCents) : undefined,
  });

  return {
    auditId,
    output: result.output,
    latencyMs: result.latencyMs,
    costCents: result.costCents,
    actualModel: result.actualModel ?? llmArgs.model,
  };
}

interface AuditRowFields {
  auditId: string;
  passSessionId: string;
  targetSummaryId: string | null;
  targetCacheId: string | null;
  promptId: string;
  passKind: PassKind;
  passInputTruncated: string;
  status: "started" | "completed" | "failed";
  modelUsed: string;
}

function insertAuditRow(db: DatabaseSync, row: AuditRowFields): void {
  // CHECK constraint requires at least one of summary_id/cache_id when
  // present (set by caller); we forward both null when neither is set.
  // Schema accepts both null in tests where the CHECK is bypassed by
  // the absence of a real schema (in-memory test DB without FK enforcement
  // would still trigger CHECK — so test code provides one or the other).
  db.prepare(
    `INSERT INTO lcm_synthesis_audit
       (audit_id, pass_session_id, target_summary_id, target_cache_id, prompt_id,
        pass_kind, pass_input_truncated, status, model_used)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.auditId,
    row.passSessionId,
    row.targetSummaryId,
    row.targetCacheId,
    row.promptId,
    row.passKind,
    row.passInputTruncated,
    row.status,
    row.modelUsed,
  );
}

function updateAuditRow(
  db: DatabaseSync,
  auditId: string,
  updates: {
    status?: "started" | "completed" | "failed";
    passOutput?: string;
    modelUsed?: string;
    latencyMs?: number;
    costCents?: number;
    lastError?: string;
  },
): void {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (updates.status !== undefined) {
    sets.push("status = ?");
    args.push(updates.status);
  }
  if (updates.passOutput !== undefined) {
    sets.push("pass_output = ?");
    args.push(updates.passOutput);
  }
  if (updates.modelUsed !== undefined) {
    sets.push("model_used = ?");
    args.push(updates.modelUsed);
  }
  if (updates.latencyMs !== undefined) {
    sets.push("latency_ms = ?");
    args.push(updates.latencyMs);
  }
  if (updates.costCents !== undefined) {
    sets.push("cost_usd_cents = ?");
    args.push(updates.costCents);
  }
  if (updates.lastError !== undefined) {
    sets.push("last_error = ?");
    args.push(updates.lastError);
  }
  if (sets.length === 0) return;
  args.push(auditId);
  db.prepare(`UPDATE lcm_synthesis_audit SET ${sets.join(", ")} WHERE audit_id = ?`).run(...args);
}

async function runBestOfNYearly(
  db: DatabaseSync,
  llmCall: LlmCall,
  req: SynthesizeRequest,
  primaryPrompt: PromptRecord,
  model: string,
  ctx: {
    bestOfN: number;
    auditIds: string[];
    addLatency: (ms: number) => void;
    addCost: (cents: number | undefined) => void;
  },
): Promise<SynthesizeResult> {
  const renderedSingle = renderPrompt(primaryPrompt.template, req);

  // Run N candidates in parallel
  const candidatePromises = Array.from({ length: ctx.bestOfN }).map((_, i) =>
    runPassWithAudit(
      db,
      llmCall,
      {
        model,
        prompt: renderedSingle,
        passKind: "single",
        maxOutputTokens: undefined,
      },
      {
        // Group D adversarial Gap 2 fix: ALL passes in this best-of-N
        // attempt share the same pass_session_id so operators can
        // SELECT WHERE pass_session_id = X to retrieve the full
        // attempt's audit trail. (Previously each candidate had a
        // distinct `_cand${i}` suffix, splattering rows across N+1
        // distinct sessions and breaking the orphan-GC invariant.)
        // Per-candidate disambiguation lives in pass_input_truncated
        // and the (sequential) ran_at timestamps.
        passSessionId: req.passSessionId,
        promptId: primaryPrompt.promptId,
        targetSummaryId: req.targetSummaryId,
        targetCacheId: req.targetCacheId,
        passInputForAudit: req.sourceText,
      },
    ),
  );
  // Wave-7 Auditor #5 P1.1 fix: Promise.allSettled instead of Promise.all
  // so one failed candidate doesn't discard the work of successful peers.
  // Cost: yearly already paid for the successful runs; previous behavior
  // wasted that money. New behavior: collect successes, throw only if
  // ALL fail; judge picks among survivors.
  const settled = await Promise.allSettled(candidatePromises);
  const candidateResults: Array<{
    output: string;
    latencyMs: number;
    costCents: number | undefined;
    auditId: string;
  }> = [];
  const candidateFailures: string[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") {
      candidateResults.push(s.value);
    } else {
      candidateFailures.push(s.reason instanceof Error ? s.reason.message : String(s.reason));
    }
  }
  if (candidateResults.length === 0) {
    // ALL candidates failed — surface all failures
    throw new SynthesisDispatchError(
      "llm_failure",
      `[synthesis.dispatch] all ${ctx.bestOfN} best-of-N candidates failed: ${candidateFailures.join(" | ").slice(0, 600)}`,
    );
  }
  for (const cr of candidateResults) {
    ctx.auditIds.push(cr.auditId);
    ctx.addLatency(cr.latencyMs);
    ctx.addCost(cr.costCents);
  }

  // Wave-7 Auditor #5 P1.2 fix: skip judge entirely when only ONE candidate
  // survived (either bestOfN=1 caller OR N-1 candidates failed). Judge over
  // a single candidate is a foot-gun (judge expected 0..N-1 but only "0"
  // would be valid; many models emit 1-indexed and crash judge_failure).
  // Wave-8 Auditor #2-5 P1 CRITICAL FIX: previously this returned a
  // malformed SynthesizeResult missing required fields (primaryPromptId,
  // auditIds, totalLatencyMs, totalCostCents) — TYPE CONTRACT VIOLATION
  // that would crash callers reading those fields. Now populates all
  // required SynthesizeResult fields from the single survivor.
  if (candidateResults.length === 1) {
    const sole = candidateResults[0]!;
    return {
      output: sole.output,
      primaryPromptId: primaryPrompt.promptId,
      auditIds: ctx.auditIds,
      totalLatencyMs: sole.latencyMs,
      totalCostCents: sole.costCents ?? 0,
      bestOfN: {
        n: 1,
        selectedIndex: 0,
        candidates: [sole.output],
      },
      hallucinationFlagged: undefined,
    };
  }

  // Look up the judge prompt
  const judgePrompt = getActivePrompt(db, {
    memoryType: req.memoryType,
    tierLabel: req.tier,
    passKind: "best_of_n_judge",
  });
  if (!judgePrompt) {
    throw new SynthesisDispatchError(
      "missing_prompt",
      `[synthesis.dispatch] yearly tier requires best_of_n_judge prompt for memoryType=${req.memoryType}, tier=${req.tier}`,
    );
  }

  const renderedJudge = renderJudgePrompt(judgePrompt.template, {
    sourceText: req.sourceText,
    candidates: candidateResults.map((c) => c.output),
  });
  const judgeResult = await runPassWithAudit(
    db,
    llmCall,
    {
      model,
      prompt: renderedJudge,
      passKind: "best_of_n_judge",
      maxOutputTokens: 50,
    },
    {
      // Group D adversarial Gap 2: judge call shares the same
      // pass_session_id as the candidate calls (all part of one
      // best-of-N attempt — operators query by pass_session_id to
      // retrieve the full trail).
      passSessionId: req.passSessionId,
      promptId: judgePrompt.promptId,
      targetSummaryId: req.targetSummaryId,
      targetCacheId: req.targetCacheId,
      passInputForAudit: candidateResults.map((c) => c.output).join("\n---\n"),
    },
  );
  ctx.auditIds.push(judgeResult.auditId);
  ctx.addLatency(judgeResult.latencyMs);
  ctx.addCost(judgeResult.costCents);

  // Parse judge output: expect a number 0..N-1 (the candidate index).
  // Wave-8 Auditor #2-5 D-P1 fix: judge sees only SURVIVORS (post-
  // Promise.allSettled), not the originally-requested N. Pass
  // candidateResults.length so parseJudgeOutput's range check matches
  // the actual choice space. Previously passed ctx.bestOfN — a judge
  // picking index 2 when only 2 survivors existed would have indexed
  // out of bounds (candidateResults[2] === undefined → crash).
  const selectedIndex = parseJudgeOutput(judgeResult.output, candidateResults.length);
  return {
    output: candidateResults[selectedIndex].output,
    primaryPromptId: primaryPrompt.promptId,
    auditIds: ctx.auditIds,
    totalLatencyMs: candidateResults.reduce((acc, r) => acc + r.latencyMs, 0) + judgeResult.latencyMs,
    totalCostCents: candidateResults.reduce((acc, r) => acc + (r.costCents ?? 0), 0) + (judgeResult.costCents ?? 0),
    bestOfN: {
      // Reflect actual N executed (may be < ctx.bestOfN if some failed).
      n: candidateResults.length,
      selectedIndex,
      candidates: candidateResults.map((c) => c.output),
    },
  };
}

function parseJudgeOutput(output: string, n: number): number {
  // Judge prompt contract per §12 seed: outputs `Winner: <0-indexed integer>`
  // potentially preceded by reasoning. Final.review.3 fix (Loop 4 Bug 4.3):
  // the previous regex `/\d+/` matched the FIRST digit anywhere — including
  // "0" from the prompt's "0-indexed" instruction echoed by the model, or
  // a year "2026" appearing in the model's reasoning, or "12 monthlies"
  // count. That made yearly synthesis silently wrong (wrong winner) or hard
  // failure (out-of-range like 2026 or 12 vs N=3).
  //
  // Strategy: prefer the explicit `Winner: N` anchored form. Fall back to
  // "last digit in output" which is more robust (the model's final
  // commitment) than "first digit". Both bounded against N before accept.
  const winnerMatch = output.match(/(?:^|\b)Winner\s*[:\s]\s*(\d+)/im);
  if (winnerMatch) {
    const idx = Number.parseInt(winnerMatch[1]!, 10);
    if (idx >= 0 && idx < n) return idx;
    // Winner: matched but out of range — fall through to last-digit fallback
  }
  // Fallback: last digit anywhere in output (matches model's final answer
  // even without "Winner:" prefix).
  const allDigits = output.match(/\d+/g);
  if (!allDigits || allDigits.length === 0) {
    throw new SynthesisDispatchError(
      "judge_failure",
      `[synthesis.dispatch] judge output didn't contain a digit: ${output.slice(0, 200)}`,
    );
  }
  // Try last → second-to-last → ... → first, accept first one in range.
  for (let i = allDigits.length - 1; i >= 0; i--) {
    const idx = Number.parseInt(allDigits[i]!, 10);
    if (idx >= 0 && idx < n) return idx;
  }
  // No digit in output is in range — surface the FIRST out-of-range one
  // (matches old behavior for backward compat on error message).
  const firstIdx = Number.parseInt(allDigits[0]!, 10);
  throw new SynthesisDispatchError(
    "judge_failure",
    `[synthesis.dispatch] judge picked out-of-range index ${firstIdx} (N=${n}); full output: ${output.slice(0, 200)}`,
  );
}

function pickModel(req: SynthesizeRequest, primaryPrompt: PromptRecord): string {
  // Wave-4 Auditor #5 P1 fix: forceModel without modelOverride was
  // silently no-op (fell through to prompt's modelRecommendation).
  // Now: forceModel without modelOverride forces the tier default,
  // so callers can guarantee "default model regardless of prompt
  // recommendation."
  if (req.forceModel) {
    return req.modelOverride ?? DEFAULT_MODEL_BY_TIER[req.tier];
  }
  if (primaryPrompt.modelRecommendation) return primaryPrompt.modelRecommendation;
  return req.modelOverride ?? DEFAULT_MODEL_BY_TIER[req.tier];
}

function renderPrompt(template: string, req: SynthesizeRequest): string {
  // Template substitution — extremely simple; uses {{source_text}} and
  // {{tier}} placeholders. Caller can use other substitutions by
  // pre-rendering before this call.
  return template
    .replace(/\{\{\s*source_text\s*\}\}/g, req.sourceText)
    .replace(/\{\{\s*tier\s*\}\}/g, req.tier)
    .replace(/\{\{\s*memory_type\s*\}\}/g, req.memoryType);
}

function renderVerifyPrompt(
  template: string,
  args: { sourceText: string; candidateSummary: string },
): string {
  // Final.review.3 fix (Loop 4 Bug 4.2): the seeded §12 verify_fidelity
  // prompt uses `{{draft}}` and `{{source_leaves}}` placeholders (matching
  // architecture-v4.1.md §12 / Appendix A literally). The renderer
  // previously only handled `{{candidate_summary}}` and `{{source_text}}`,
  // so the seeded template was sent verbatim to the LLM with placeholders
  // un-substituted — making the entire monthly verify pass meaningless.
  // We now substitute BOTH the spec-named placeholders AND the dispatch-
  // canonical ones, so either prompt template works.
  return template
    .replace(/\{\{\s*source_text\s*\}\}/g, args.sourceText)
    .replace(/\{\{\s*source_leaves\s*\}\}/g, args.sourceText) // alias to source_text
    .replace(/\{\{\s*candidate_summary\s*\}\}/g, args.candidateSummary)
    .replace(/\{\{\s*draft\s*\}\}/g, args.candidateSummary); // alias to candidate_summary
}

function renderJudgePrompt(
  template: string,
  args: { sourceText: string; candidates: string[] },
): string {
  const candidatesList = args.candidates
    .map((c, i) => `### Candidate ${i}\n\n${c}`)
    .join("\n\n");
  return template
    .replace(/\{\{\s*source_text\s*\}\}/g, args.sourceText)
    .replace(/\{\{\s*candidates\s*\}\}/g, candidatesList);
}

function truncateForAudit(s: string, maxLen = 8000): string {
  return s.length > maxLen ? s.slice(0, maxLen) + "…(truncated)" : s;
}

function randomSuffix(): string {
  return Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0");
}
