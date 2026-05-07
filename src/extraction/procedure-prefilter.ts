/**
 * Procedure pre-filter — LCM v4.1 §6.2 Group E.
 *
 * Heuristic gate before procedure clustering. Most leaves are conversational
 * exchange — only a small fraction look like procedure definitions. We
 * pre-filter to avoid running ml-hclust over the entire corpus on every
 * tick.
 *
 * Why STRUCTURAL pre-filter (not FTS verb regex):
 *
 *   FTS verb regex ("when X happens, do Y" patterns) was the v4 spec but
 *   surfaced as a 3-agent-convergent finding in adversarial review:
 *   imperative-verb regexes have huge false-positive rate on conversational
 *   text and miss many real procedures expressed without imperative verbs
 *   (e.g., "the deploy script runs migration then spec then mocha").
 *
 *   Structural pre-filter looks at the SHAPE of the leaf instead:
 *
 *     1. Numbered step lists: leaves containing 3+ lines starting with
 *        "1.", "2.", ... or "Step 1", "Step 2", ... or "1)", "(1)", etc.
 *
 *     2. Command invocations: leaves containing 2+ shell-command-shaped
 *        lines (`$ <command>`, `❯ <command>`, ``` blocks with shell, etc.)
 *
 *     3. Explicit "how to" markers: leaves with phrases like
 *        "how to <verb>", "the <noun> process is", "to <verb>, you need to",
 *        "procedure for", "steps to", "playbook for".
 *
 *   These three structural signals compose with OR: any one of them
 *   admits the leaf to clustering. Clustering then groups similar
 *   procedure-shaped leaves together; the LLM-judge confidence (>0.9)
 *   is what actually decides whether a cluster becomes an active
 *   `lcm_procedures` row (≥8 occurrences threshold per architecture).
 *
 * This module is PURE — no DB, no LLM, no async. Caller queries
 * candidate leaves elsewhere; this module just decides which ones to
 * pass to clustering.
 */

export interface PrefilterResult {
  /** Whether this leaf is a candidate for procedure clustering. */
  isCandidate: boolean;
  /** Which signal(s) fired. Empty if isCandidate=false. */
  signals: ProcedureSignal[];
  /** Strength score 0..1 (sum of signal weights, capped). For ranking
   *  / threshold tuning later. */
  score: number;
}

export type ProcedureSignal =
  | "numbered-steps"
  | "command-block"
  | "how-to-marker";

/**
 * Pre-filter a single leaf content. Returns a PrefilterResult; caller
 * decides whether `isCandidate=true` rows enter the clustering pass.
 */
export function prefilterContent(content: string): PrefilterResult {
  if (!content || typeof content !== "string") {
    return { isCandidate: false, signals: [], score: 0 };
  }
  const signals: ProcedureSignal[] = [];
  let score = 0;

  if (hasNumberedSteps(content)) {
    signals.push("numbered-steps");
    score += 0.4;
  }
  if (hasCommandBlock(content)) {
    signals.push("command-block");
    score += 0.4;
  }
  if (hasHowToMarker(content)) {
    signals.push("how-to-marker");
    score += 0.3;
  }

  // Cap at 1.0 (max practical value)
  score = Math.min(score, 1);
  return { isCandidate: signals.length > 0, signals, score };
}

/**
 * Numbered step heuristic: at least 3 STRICTLY-SEQUENTIAL numbered
 * list items (1, 2, 3 — not 1, 1, 1 nor 1, 5, 8).
 *
 * Group E adversarial Gap 5 fix: previously we accepted "non-decreasing"
 * which trips on numbered citations ("[1] Smith ... [2] Jones ...") and
 * action-item lists ("1. Bob ... 2. Alice ... 3. Carol" which are
 * meeting notes, not procedures).
 *
 * Now requires `n+1` after `n` AND that the numbers start near 1
 * (start ≤ 2 for tolerance of "0. setup" prefixes).
 */
function hasNumberedSteps(content: string): boolean {
  const lines = content.split(/\r?\n/);
  // Patterns to recognize a "numbered list line"
  const patterns: RegExp[] = [
    /^\s*(\d+)\.\s+\S/, // "1. foo"
    /^\s*(\d+)\)\s+\S/, // "1) foo"
    /^\s*\((\d+)\)\s+\S/, // "(1) foo"
    /^\s*Step\s+(\d+)[:.\s]/i, // "Step 1: foo"
  ];
  // Walk lines; collect runs of strictly-sequential numbered lines.
  let runStart: number | null = null;
  let lastN = 0;
  let bestRun = 0;
  for (const line of lines) {
    let matched: RegExpMatchArray | null = null;
    for (const re of patterns) {
      matched = line.match(re);
      if (matched) break;
    }
    if (!matched) {
      runStart = null;
      lastN = 0;
      continue;
    }
    const n = parseInt(matched[1], 10);
    if (!Number.isFinite(n) || n <= 0) {
      runStart = null;
      lastN = 0;
      continue;
    }
    if (runStart === null) {
      // Start of a new run — only count if starting at 0/1/2
      if (n <= 2) {
        runStart = n;
        lastN = n;
        bestRun = Math.max(bestRun, 1);
      } else {
        runStart = null;
      }
      continue;
    }
    if (n === lastN + 1) {
      lastN = n;
      bestRun = Math.max(bestRun, lastN - runStart + 1);
    } else {
      // Sequence broke; restart only if this line itself starts at 0/1/2
      if (n <= 2) {
        runStart = n;
        lastN = n;
      } else {
        runStart = null;
        lastN = 0;
      }
    }
  }
  return bestRun >= 3;
}

/**
 * Command-block heuristic: at least 2 shell-command-shaped lines.
 * Detects:
 *   - Lines starting with "$ " (shell prompt)
 *   - Lines starting with "❯ ", "%", "> " (zsh / bash / Windows)
 *   - Inside fenced code blocks with bash/sh/zsh tag
 *   - Lines with very command-like shape (npm/git/pnpm/yarn followed by subcommand)
 */
function hasCommandBlock(content: string): boolean {
  const lines = content.split(/\r?\n/);
  let count = 0;
  // Track whether we're inside a fenced code block of recognized shell type.
  let inShellFence = false;
  for (const raw of lines) {
    const line = raw.trim();
    const fenceOpen = line.match(/^```\s*(bash|sh|zsh|shell|console|terminal)\b/i);
    const fenceClose = line === "```" && inShellFence;
    if (fenceOpen) {
      inShellFence = true;
      continue;
    }
    if (fenceClose) {
      inShellFence = false;
      continue;
    }
    if (inShellFence && line.length > 0) {
      // Any non-empty line inside a shell fence counts.
      count++;
      continue;
    }
    // Inline shell-prompt lines
    if (/^\s*[$❯%]\s+\S/.test(raw) || /^\s*>\s+[a-z]/.test(raw)) {
      count++;
      continue;
    }
    // Common CLI tool invocations (no prompt) — treat as command-shaped
    // if the line STARTS with a recognizable tool name + space + flag/word
    if (
      /^\s*(npm|pnpm|yarn|git|docker|kubectl|terraform|aws|gcloud|az|gh|cargo|python|node|psql|mysql|redis-cli)\s+\S/.test(
        raw,
      )
    ) {
      count++;
    }
  }
  return count >= 2;
}

/**
 * Explicit-marker heuristic: looks for phrases that strongly indicate
 * the leaf is documenting a process / how-to.
 *
 * Conservative — false positives here add up over the whole corpus, so
 * we only fire on phrases that are unambiguous.
 */
function hasHowToMarker(content: string): boolean {
  // Case-insensitive search for unambiguous phrases.
  const lc = content.toLowerCase();
  const markers: string[] = [
    "how to ",
    "the process for ",
    "the procedure for ",
    "the playbook for ",
    "steps to ",
    "to deploy",
    "to install",
    "to set up",
    "to configure",
    "to debug",
    "to migrate",
    "to provision",
    "to set up",
    "in order to ",
    "you need to ",
    "first, ",
    "then, ",
    "finally, ",
  ];
  // Require at least 2 distinct markers to fire — single-marker leaves
  // are too noisy (lots of conversational uses of "first, ...").
  let hits = 0;
  const seen = new Set<string>();
  for (const m of markers) {
    if (lc.includes(m) && !seen.has(m)) {
      hits++;
      seen.add(m);
    }
  }
  return hits >= 2;
}

/**
 * Apply the prefilter to a list of leaf records. Returns ONLY the
 * candidates that should enter the clustering pass.
 */
export function prefilterLeaves<T extends { content: string }>(
  leaves: T[],
): Array<T & { signals: ProcedureSignal[]; score: number }> {
  const out: Array<T & { signals: ProcedureSignal[]; score: number }> = [];
  for (const leaf of leaves) {
    const r = prefilterContent(leaf.content);
    if (r.isCandidate) {
      out.push({ ...leaf, signals: r.signals, score: r.score });
    }
  }
  return out;
}
