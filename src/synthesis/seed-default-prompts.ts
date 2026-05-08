/**
 * Seed default prompts into `lcm_prompt_registry` at boot.
 *
 * Without this, `dispatchSynthesis` (D.02) and `lcm_synthesize_around` (cycle-2)
 * return `missing_prompt` errors on every call because the registry is empty.
 * This was caught by the smoke-test in `scripts/v41-synthesize-around-smoke.mjs`:
 * the migration created the table but no row insertion ever happened in
 * production. Tests passed because they each `registerPrompt(...)` manually.
 *
 * The prompts seeded here come from architecture-v4.1.md §12 (Appendix A).
 * Idempotent: skips registration for any (memory_type, tier_label, pass_kind)
 * triple that already has an active prompt.
 *
 * Called from the migration ratchet so it runs once at boot. Safe to re-run;
 * existing prompts (from operator overrides) are NEVER overwritten.
 */

import type { DatabaseSync } from "node:sqlite";

function randomSuffix(): string {
  // Match the pattern used by registerPrompt — short hex slug for uniqueness.
  // Uses node:crypto via Math.random for portability since we're inside a tx.
  return Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
}

interface SeedPromptDef {
  memoryType: string;
  tierLabel: string | null;
  passKind: string;
  template: string;
  modelRecommendation?: string | null;
  notes?: string;
}

/**
 * Default prompts from architecture-v4.1.md §12.
 *
 * Conventions:
 *   - `{{source_text}}` substitution placeholder used by dispatchSynthesis
 *     for the source bundle (leaves concatenated, or condensed-summary
 *     bundle, depending on tier).
 *   - `{{tier}}` substitutes the tier name (daily / weekly / monthly / etc).
 *   - `{{memory_type}}` substitutes the memory type (episodic-condensed /
 *     yearly-synthesis / etc).
 *   - `{{draft}}`, `{{candidate_summary}}`, and `{{source_leaves}}` are used
 *     by the verify-fidelity and best-of-N judge passes.
 *
 * Wave-9 Agent #2/#7 P1 fix: removed `{{date_range}}` and `{{target_length}}`
 * placeholders that were declared in this docstring but NOT substituted by
 * `renderPrompt` in dispatch.ts. The seeded prompts no longer reference
 * those placeholders directly; if a caller wants to inject date-range
 * context, they bake it into `sourceText` (or pre-render the template
 * before calling dispatch). Same class as Final.review.3 Loop 4 Bug 4.2.
 *
 * The exact substitution syntax is enforced by dispatchSynthesis; this seed
 * uses placeholders matching the test fixtures. If dispatch ever changes the
 * substitution syntax, update this file in lockstep.
 */
const DEFAULT_PROMPTS: SeedPromptDef[] = [
  // ── Episodic-leaf (single, all tiers) ────────────────────────────────
  {
    memoryType: "episodic-leaf",
    tierLabel: null,
    passKind: "single",
    template: `You are a meticulous summarizer for a lossless memory system.

Summarize the following messages from a conversation. Capture:
- All decisions made or reversed
- Concrete actions taken (with file paths, commit SHAs, PR numbers when present)
- Open questions and blockers
- Entities mentioned (people, projects, tools, concepts)
- Time markers (when relevant)

Style:
- Compact but complete. No filler.
- Use original terminology — do not rename entities or paraphrase technical terms.
- Bullet structure where useful; prose where bullets would over-fragment.
- Include any verbatim quotes that preserve key intent.

Length: target 800-1500 tokens. Hard cap 4000 tokens.

CONVERSATION:
{{source_text}}

SUMMARY:`,
    notes: "v4.1 §12 default — episodic leaf summarizer. Override with operator runtime if customized.",
  },

  // ── Episodic-condensed (single, daily) ───────────────────────────────
  {
    memoryType: "episodic-condensed",
    tierLabel: "daily",
    passKind: "single",
    template: `You are a meticulous summarizer condensing leaf-level summaries into a daily summary.

Input is N leaf summaries from a single day. Produce a daily summary that:
- Preserves every distinct decision (reference original leaf IDs in citations)
- Preserves every concrete action (file paths, PRs, commits) — DO NOT abstract these away
- Identifies recurring themes and patterns
- Notes any contradictions across leaves (if leaf A says X then leaf B says Y, surface both)
- Preserves Eva's actual phrasing where it captures nuance

Citations: include source leaf IDs in [bracket] notation after each major claim.

Length: target 1500-2500 tokens.

LEAF SUMMARIES:
{{source_text}}

DAILY SUMMARY:`,
    notes: "v4.1 §12 default — daily condensed.",
  },

  // ── Episodic-condensed (single, weekly) ──────────────────────────────
  {
    memoryType: "episodic-condensed",
    tierLabel: "weekly",
    passKind: "single",
    template: `You are a meticulous summarizer condensing daily summaries into a weekly summary.

Input is 7 (or fewer) daily summaries from a single week. Produce a weekly summary that:
- Preserves every distinct decision (reference original daily IDs in citations)
- Preserves every concrete action (file paths, PRs, commits) — DO NOT abstract these away
- Identifies recurring themes and patterns
- Notes any contradictions across days
- Preserves Eva's actual phrasing where it captures nuance

Citations: include source daily IDs in [bracket] notation after each major claim.

Length: target 2500-4000 tokens.

DAILY SUMMARIES:
{{source_text}}

WEEKLY SUMMARY:`,
    notes: "v4.1 §12 default — weekly condensed.",
  },

  // ── Episodic-condensed (single, monthly) ─────────────────────────────
  {
    memoryType: "episodic-condensed",
    tierLabel: "monthly",
    passKind: "single",
    template: `You are a meticulous summarizer condensing weekly summaries into a monthly summary.

Input is 4-5 weekly summaries from a single month. Produce a monthly summary that:
- Preserves every distinct decision (reference original weekly IDs in citations)
- Preserves every concrete action (file paths, PRs, commits) — DO NOT abstract these away
- Identifies the month's overarching themes (3-5 max)
- Notes any contradictions across weeks
- Preserves Eva's actual phrasing where it captures nuance

Citations: include source weekly IDs in [bracket] notation after each major claim.

Length: target 4000-6000 tokens.

WEEKLY SUMMARIES:
{{source_text}}

MONTHLY SUMMARY:`,
    notes: "v4.1 §12 default — monthly condensed (followed by verify_fidelity pass).",
  },

  // ── Episodic-condensed verify_fidelity (monthly only) ────────────────
  {
    memoryType: "episodic-condensed",
    tierLabel: "monthly",
    passKind: "verify_fidelity",
    template: `You are a fidelity checker. The DRAFT summary below was condensed from SOURCE leaves.
Your ONLY job: identify any claim in the DRAFT not supported by the SOURCE.

DO NOT:
- Suggest things that are "missing" — that's not your job
- Suggest improvements to phrasing or completeness
- Add new content

DO:
- Extract each factual claim from the DRAFT
- For each claim: cite the SOURCE passage that supports it (if any)
- For unsupported claims: list them as \`UNSUPPORTED: <claim>\`

If all claims are supported: respond \`OK: all <N> claims grounded\`.

DRAFT:
{{draft}}

SOURCE:
{{source_leaves}}

FIDELITY REPORT:`,
    notes: "v4.1 §12 default — monthly verify_fidelity (catches hallucinations only, NOT a critique-revise).",
  },

  // ── Episodic-yearly best_of_n (yearly only) ──────────────────────────
  // Note: tier_label='yearly' is used by dispatchSynthesis for tier=yearly;
  // memoryType='episodic-yearly' (not 'episodic-condensed') matches §12.
  {
    memoryType: "episodic-yearly",
    tierLabel: "yearly",
    passKind: "single",
    template: `You are synthesizing a YEAR of memory into a single durable summary that will be read for years to come.

Input: 12 monthly condensed summaries spanning the year.

Your output is one synthesis. We will generate 3 such syntheses in parallel (different random seeds) and a separate judge will pick the best. So: synthesize boldly, prioritize narrative coherence, do not hedge.

Capture:
- The year's overarching themes (3-5 max)
- Major decisions and their rationale
- Major shifts in approach (what we tried, what worked, what we abandoned)
- Recurring people and their roles (Eva, Andrew, key collaborators)
- Concrete artifacts produced (PRs, projects, repos)
- The year's "shape" — was it growth, recovery, exploration, scaling?

Length: target 5000-8000 tokens.

MONTHLIES:
{{source_text}}

YEAR SYNTHESIS:`,
    notes: "v4.1 §12 default — yearly single-candidate (one of 3 in best_of_n).",
  },

  // ── Episodic-yearly judge (best_of_n_judge pass) ─────────────────────
  {
    memoryType: "episodic-yearly",
    tierLabel: "yearly",
    passKind: "best_of_n_judge",
    template: `You are picking the best of N candidate yearly summaries.

Each candidate synthesizes the same source material. Pick the one that:
- Best captures the year's major themes (NOT a recitation of every event)
- Maintains factual accuracy with the source monthlies
- Reads as coherent narrative, not a bulleted list
- Preserves Eva's voice and terminology
- Will be useful when read 2+ years from now

Source monthlies for verification:
{{source_text}}

Candidates:
{{candidates}}

VERDICT:
- Winner: <0-indexed integer>
- Reasoning: <2-3 sentences>
- Concerns about winner: <any factual issues to flag>`,
    notes: "v4.1 §12 default — yearly best_of_n judge. Output format: 'Winner: N\\nReasoning: ...\\nConcerns: ...'",
  },

  // ── Custom (single) — used by lcm_synthesize_around ──────────────────
  {
    memoryType: "episodic-condensed",
    tierLabel: "custom",
    passKind: "single",
    template: `You are condensing a set of leaf summaries into a coherent narrative for an agent's memory pass.

The leaves below were selected by the agent based on a query or a time window. Produce a single synthesized summary that:
- Captures the major decisions and actions across these leaves
- Preserves concrete details (file paths, PRs, commits, commands) — do NOT abstract them away
- Identifies any recurring themes
- Notes any contradictions across leaves (if leaf A says X then leaf B says Y, surface both)
- Preserves Eva's actual phrasing where it captures nuance

Citations: include source leaf IDs in [bracket] notation after each major claim where helpful.

Length: target 1500-3000 tokens.

LEAF SUMMARIES:
{{source_text}}

SYNTHESIZED MEMORY PASS:`,
    notes:
      "v4.1 §12 default — custom tier, used by lcm_synthesize_around for both time and semantic windows.",
  },

  // ── Filtered (single) — used by lcm_synthesize_around when grep-filtered ─
  {
    memoryType: "episodic-condensed",
    tierLabel: "filtered",
    passKind: "single",
    template: `You are condensing a set of leaf summaries that were filtered by an agent grep query.

The leaves below all matched the grep filter. Produce a synthesized summary that:
- Captures what the matched leaves have in common (and any divergences)
- Preserves concrete details (file paths, PRs, commits, commands)
- Identifies any patterns specific to the filter context
- Notes contradictions across leaves where present

Citations: include source leaf IDs in [bracket] notation where helpful.

Length: target 1000-2500 tokens.

FILTERED LEAF SUMMARIES:
{{source_text}}

SYNTHESIZED FILTER PASS:`,
    notes: "v4.1 §12 default — filtered tier, used when source set came from grep filter.",
  },

  // ── Procedural-extract ───────────────────────────────────────────────
  {
    memoryType: "procedural-extract",
    tierLabel: null,
    passKind: "single",
    template: `You are extracting a recurring procedure from a cluster of leaf summaries.

Input: leaves that an embedding-clustering algorithm grouped together. They MAY describe the same procedure performed at different times, OR they may not — your job is to determine which.

For the cluster:
- Determine: does this represent a single coherent procedure? (is_procedure: true/false)
- If yes:
  - Name the procedure (canonical form, lowercase, hyphen-separated, e.g. "gateway-rebuild")
  - List the steps in order (what gets done, in what sequence)
  - Confidence (0-1): how certain that this IS a recurring procedure vs noise

LEAVES:
{{source_text}}

OUTPUT (JSON):
{
  "is_procedure": <bool>,
  "name": <string|null>,
  "steps": [<string>, ...],
  "confidence": <0-1>
}`,
    notes: "v4.1 §12 default — procedural extraction. Output strict JSON.",
  },

  // ── Prospective-extract ──────────────────────────────────────────────
  // REMOVED in first-principles pass (2026-05-06). Intentions feature was
  // cut entirely (zero producer/consumer/agent tools). Prompt + schema
  // preserved in deferred-features draft PR (#616).

  // ── Entity-extract ───────────────────────────────────────────────────
  {
    memoryType: "entity-extract",
    tierLabel: null,
    passKind: "single",
    template: `You are extracting named entities from a leaf summary.

Entities to extract:
- People (Eva, Andrew, named collaborators)
- Projects (electric-sheep, lossless-claw, etc.)
- PRs (PR #1873, #74796, etc.)
- Commits (SHA fragments)
- Files (paths, AGENTS.md, etc.)
- Tools/services (openclaw-gateway, Voyage, etc.)
- Concepts (LCM, session_key, compaction, etc.)
- Config flags, error codes, agent IDs (R-XXX), bug numbers
- Anything else that is a NAMED THING (not a generic noun)

For each entity:
- text: the surface form as it appears
- type: one of the above categories OR a freeform new type
- span_start, span_end: character offsets in the leaf

LEAF:
{{source_text}}

OUTPUT (JSON array):
[{
  "text": <string>,
  "type": <string>,
  "span_start": <int>,
  "span_end": <int>
}, ...]`,
    notes: "v4.1 §12 default — entity extraction. Output strict JSON array.",
  },
];

/**
 * Idempotent — only inserts a prompt if no row exists at all for the
 * (memory_type, tier_label, pass_kind) triple. Operator-registered prompts
 * (which would have version > 1 or active=1) are NEVER overwritten.
 *
 * Implemented with raw INSERT (NOT registerPrompt) so it can run INSIDE
 * the outer migration transaction without nested-BEGIN error. Migration
 * runs all steps inside a single tx; opening another with BEGIN IMMEDIATE
 * inside it would fail with "cannot start a transaction within a transaction".
 *
 * Returns the count of newly-seeded prompts.
 */
export function seedDefaultPrompts(db: DatabaseSync): { seeded: number; skipped: number } {
  let seeded = 0;
  let skipped = 0;

  // Pre-compile statements outside the loop for speed.
  const checkTierEq = db.prepare(
    `SELECT prompt_id FROM lcm_prompt_registry
       WHERE memory_type = ? AND tier_label = ? AND pass_kind = ?
       LIMIT 1`,
  );
  const checkTierNull = db.prepare(
    `SELECT prompt_id FROM lcm_prompt_registry
       WHERE memory_type = ? AND tier_label IS NULL AND pass_kind = ?
       LIMIT 1`,
  );
  const insertStmt = db.prepare(
    `INSERT INTO lcm_prompt_registry
       (prompt_id, memory_type, tier_label, pass_kind, version, template,
        model_recommendation, active, bundle_version, notes)
     VALUES (?, ?, ?, ?, 1, ?, ?, 1, 1, ?)`,
  );

  for (const def of DEFAULT_PROMPTS) {
    // Check if any row (active or archived) exists for this triple.
    const existing =
      def.tierLabel === null
        ? (checkTierNull.get(def.memoryType, def.passKind) as { prompt_id: string } | undefined)
        : (checkTierEq.get(def.memoryType, def.tierLabel, def.passKind) as
            | { prompt_id: string }
            | undefined);

    if (existing) {
      skipped++;
      continue;
    }

    // No existing prompt — insert v1 directly (raw INSERT, no nested tx).
    const promptId = `prompt_${def.memoryType}_${def.tierLabel ?? "any"}_${def.passKind}_v1_${randomSuffix()}`;
    insertStmt.run(
      promptId,
      def.memoryType,
      def.tierLabel,
      def.passKind,
      def.template,
      def.modelRecommendation ?? null,
      def.notes ?? "v4.1 §12 default seed",
    );
    seeded++;
  }

  return { seeded, skipped };
}
