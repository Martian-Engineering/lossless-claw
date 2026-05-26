/**
 * Shared per-tool result-size budget — Wave-12 audit (W1A1 #2 + W1A8 #3).
 *
 * Single source of truth for the operator-tunable result-token cap. Both
 * per-tool MAX_RESULT_CHARS truncation AND the needs-compact gate's
 * HARD_CAP estimator pull from this module so the two stay in lockstep —
 * raising the cap raises the estimator ceiling automatically (previously
 * the gate underestimated by up to 3× when the operator raised the cap
 * since estimator's HARD_CAP_TOKENS was hard-coded at 10_000).
 *
 * # Resolution precedence (Wave-12 retro A1)
 *
 * `LCM_TOOL_RESULT_TOKEN_BUDGET` env → `LcmConfig.toolResultTokenBudget`
 * (plugin config) → default (10_000 tokens). Standard pattern, matches
 * every other LCM operator-tunable knob (see `src/db/config.ts`'s
 * `resolveLcmConfigWithDiagnostics`).
 *
 * Module load resolves env-only (no config available yet). Plugin init
 * calls `applyResultBudgetConfig(config.toolResultTokenBudget)` AFTER
 * `resolveLcmConfigWithDiagnostics` runs, which can raise the cap if env
 * isn't set but plugin config is. This means env wins over config (ESM
 * bindings are live, so consumers see the post-init value via their
 * `import { MAX_RESULT_CHARS }`).
 *
 * Floor is 2_000 tokens (8K chars) — anything smaller makes most tools
 * useless. Default 10_000 tokens (40K chars) matches the original
 * pre-W1A1 behavior.
 */

const FLOOR_TOKENS = 2_000;
const DEFAULT_TOKENS = 10_000;
const CHARS_PER_TOKEN = 4;

function resolveFromEnv(): number | undefined {
  const raw = process.env.LCM_TOOL_RESULT_TOKEN_BUDGET?.trim();
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function clampToFloor(n: number | undefined): number {
  const tokens = typeof n === "number" && n > 0 ? n : DEFAULT_TOKENS;
  return Math.max(FLOOR_TOKENS, tokens);
}

// Module-load resolution: env-only. Plugin init may raise this via
// applyResultBudgetConfig if env wasn't set but config is.
const envValueAtLoad: number | undefined = resolveFromEnv();
const initialBudget: number = clampToFloor(envValueAtLoad);

/**
 * Resolved token cap. Identity for the estimator's HARD_CAP_TOKENS.
 *
 * `let` is intentional — ESM live bindings let `applyResultBudgetConfig`
 * (called from plugin init after config resolves) update this so consumers
 * with `import { MAX_RESULT_TOKENS }` see the post-init value.
 */
export let MAX_RESULT_TOKENS: number = initialBudget;

/**
 * Per-tool char-truncation cap. Tools loop their accumulator and emit a
 * truncation notice line when crossed. Live binding (see MAX_RESULT_TOKENS).
 */
export let MAX_RESULT_CHARS: number = MAX_RESULT_TOKENS * CHARS_PER_TOKEN;

/**
 * Plugin init hook (Wave-12 retro A1). Called from `src/plugin/index.ts`
 * after `resolveLcmConfigWithDiagnostics` produces the merged config.
 * Updates the live bindings only when env wasn't set (so env wins over
 * plugin config — same pattern as every other LcmConfig field).
 *
 * Idempotent. Safe to call multiple times; no-ops when env is set.
 */
export function applyResultBudgetConfig(
  toolResultTokenBudgetFromConfig: number | undefined,
): void {
  // Env at module-load wins. If env was set, the value at load is
  // already correct; ignore config.
  if (envValueAtLoad !== undefined) return;
  if (
    typeof toolResultTokenBudgetFromConfig === "number" &&
    Number.isFinite(toolResultTokenBudgetFromConfig) &&
    toolResultTokenBudgetFromConfig > 0
  ) {
    MAX_RESULT_TOKENS = clampToFloor(toolResultTokenBudgetFromConfig);
    MAX_RESULT_CHARS = MAX_RESULT_TOKENS * CHARS_PER_TOKEN;
  }
}

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
  return `*(truncated at ~${Math.round(MAX_RESULT_TOKENS)} tokens to protect agent context — ${reasonHint}; raise LCM_TOOL_RESULT_TOKEN_BUDGET env or LcmConfig.toolResultTokenBudget to increase the cap)*`;
}

/**
 * For unit tests: re-resolves from env, ignoring any config-applied
 * overrides. Tests can compare with the live binding to verify
 * applyResultBudgetConfig propagation.
 */
export function __resolveResultTokenBudgetFromEnvForTesting(): number {
  return clampToFloor(resolveFromEnv());
}

/**
 * For unit tests: resets the live bindings back to env-only state. Use in
 * afterEach when a test calls applyResultBudgetConfig.
 */
export function __resetResultBudgetForTesting(): void {
  MAX_RESULT_TOKENS = initialBudget;
  MAX_RESULT_CHARS = MAX_RESULT_TOKENS * CHARS_PER_TOKEN;
}
