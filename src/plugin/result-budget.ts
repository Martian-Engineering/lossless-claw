/**
 * Shared per-tool result-size budget — Wave-12 audit (W1A1 #2 + W1A8 #3).
 *
 * Single source of truth for the operator-tunable env knob
 * `LCM_TOOL_RESULT_TOKEN_BUDGET` (token cap on any single LCM tool's
 * emitted result). Both per-tool MAX_RESULT_CHARS truncation AND the
 * needs-compact gate's HARD_CAP estimator pull from this module so the
 * two stay in lockstep — raising the env knob now raises the estimator
 * ceiling automatically (previously the gate underestimated by up to
 * 3× when the operator raised the env knob, since estimator's
 * HARD_CAP_TOKENS was hard-coded at 10_000).
 *
 * Floor is 2_000 tokens (8K chars) — anything smaller makes most tools
 * useless. Caller-facing default 10_000 tokens (40K chars) matches the
 * behavior before the W1A1 amendment.
 *
 * Resolved ONCE at module load; env changes during process lifetime
 * have no effect (matches prior lcm-grep-tool behavior; documented).
 *
 * # Wave-12 retro A1 — pattern inconsistency, follow-up planned
 *
 * Every other LCM operator-tunable knob flows through `resolveLcmConfigWithDiagnostics`
 * (src/db/config.ts) which gives env→pluginConfig→default precedence
 * AND surfaces the value in `openclaw.plugin.json` config schema +
 * docs/configuration.md + per-knob diagnostics. `LCM_TOOL_RESULT_TOKEN_BUDGET`
 * is the only LCM env knob bypassing this pattern (read directly here
 * at module load). The Wave-12 retro flagged this as an architectural
 * inconsistency to address in a follow-up PR: promote to `LcmConfig.toolResultTokenBudget`
 * with the standard env→config→default precedence + plugin.json + docs.
 *
 * Until that PR lands, operators can ONLY set this via env, and the
 * value is invisible to `/lcm health` / config diagnostics. New env
 * knobs SHOULD prefer the LcmConfig pattern over adding here.
 */

const FLOOR_TOKENS = 2_000;
const DEFAULT_TOKENS = 10_000;
const CHARS_PER_TOKEN = 4;

function resolveResultTokenBudget(): number {
  const raw = process.env.LCM_TOOL_RESULT_TOKEN_BUDGET?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  const tokens = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOKENS;
  return Math.max(FLOOR_TOKENS, tokens);
}

/**
 * Resolved token cap. Identity for the estimator's HARD_CAP_TOKENS.
 */
export const MAX_RESULT_TOKENS = resolveResultTokenBudget();

/**
 * Per-tool char-truncation cap. Tools loop their accumulator and emit a
 * truncation notice line when crossed.
 */
export const MAX_RESULT_CHARS = MAX_RESULT_TOKENS * CHARS_PER_TOKEN;

/**
 * Standardized truncation-notice line for tools to emit when they cap.
 * `reasonHint` is a short verb phrase (e.g. "narrow query, lower limit")
 * that's tool-specific. Formatted to mirror the message style established
 * by lcm_grep so agents see consistent guidance across tools.
 *
 * # Wave-12 retro N3 — agent-facing contract
 *
 * The output prose of this function is NOW PART OF THE AGENT-FACING
 * CONTRACT. The regex `truncated at ~\d+ tokens to protect agent context`
 * is pinned by tests (test/v41-tool-budget-guardrail.test.ts +
 * test/v41-adversarial-output-bounds.test.ts) and is also documented to
 * agents in tool descriptions (`src/tools/lcm-grep-tool.ts` line ~208).
 *
 * Cosmetic edits to this string ("~10000 tokens" → "10K tokens" etc.)
 * will silently break the test regex AND will surprise agents that may
 * be regex-matching the prose for "did this tool truncate?" detection.
 * Don't edit this string for cosmetic reasons; if the wording needs to
 * change, update the regex pins simultaneously.
 */
export function truncationNotice(reasonHint: string): string {
  return `*(truncated at ~${Math.round(MAX_RESULT_TOKENS)} tokens to protect agent context — ${reasonHint}; raise LCM_TOOL_RESULT_TOKEN_BUDGET env to increase the cap)*`;
}

/**
 * For unit tests that need to verify env-knob propagation. Module-level
 * consts are captured at load — exposing this helper lets tests assert the
 * resolution math without importing the env-load itself.
 */
export function __resolveResultTokenBudgetForTesting(): number {
  return resolveResultTokenBudget();
}
