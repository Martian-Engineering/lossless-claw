#!/usr/bin/env node
/**
 * v3 lcm_recent rollup vs v4.1 lcm_synthesize_around — structural comparison.
 *
 * USAGE:
 *   node scripts/v41-vs-rollup-comparison.mjs
 *
 * What it does:
 *   - Picks 5 most-recent v3 rollups (where summarizer_model='concatenation-v1')
 *   - For each, computes the underlying compression ratio (source → rollup)
 *   - Counts how many leaves contributed to each rollup
 *   - Reports head + tail of one rollup so we can see the "concatenated leaves" reality
 *   - Computes what v4.1 would do INSTEAD: keep raw leaves (no rollup), embed each
 *     for semantic-recall, and offer lcm_synthesize_around as an on-demand call.
 *
 * Read-only against ~/.openclaw/lcm.db. Safe to run anytime.
 *
 * Output is markdown-formatted for direct paste into a PR comment.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SRC = process.env.LCM_HARNESS_SRC_DB ?? join(homedir(), ".openclaw", "lcm.db");

if (!existsSync(SRC)) {
  console.error(`[err] DB not found: ${SRC}`);
  process.exit(1);
}

const db = new DatabaseSync(SRC, { readOnly: true });

// Pick 5 daily rollups from corpus (most recent), only ones with concatenation-v1 (the v3 approach we're replacing)
const rollups = db
  .prepare(
    `
  SELECT
    rollup_id,
    conversation_id,
    period_start,
    period_end,
    source_message_count,
    source_token_count,
    token_count AS rollup_token_count,
    json_array_length(source_summary_ids) AS num_source_summaries,
    summarizer_model,
    length(content) AS content_chars,
    content
  FROM lcm_rollups
  WHERE period_kind='day' AND summarizer_model='concatenation-v1'
  ORDER BY period_start DESC
  LIMIT 5
`,
  )
  .all();

console.log("# v3 lcm_recent rollup vs v4.1 lcm_synthesize_around — what changes\n");
console.log("Read-only inspection of `~/.openclaw/lcm.db` showing what the v3 rollup approach produced");
console.log("on Eva's corpus. The v4.1 alternative for the same time window is described per row.\n");

console.log("## v3 rollups (currently in the DB; built by `concatenation-v1`)\n");
console.log("| Day | Conv | Source msgs | Source tokens | Rollup tokens | Compression | Source summaries |");
console.log("|---|---|---|---|---|---|---|");

for (const r of rollups) {
  const day = r.period_start.slice(0, 10);
  const compression = r.source_token_count > 0 ? (r.source_token_count / r.rollup_token_count).toFixed(1) : "n/a";
  console.log(
    `| ${day} | ${r.conversation_id} | ${r.source_message_count.toLocaleString()} | ${r.source_token_count.toLocaleString()} | ${r.rollup_token_count.toLocaleString()} | ${compression}× | ${r.num_source_summaries} |`,
  );
}

const target = rollups[0];
console.log(`\n## Sample: \`${target.rollup_id}\` (${target.period_start.slice(0, 10)}, conv ${target.conversation_id})\n`);
console.log("**Head (first 600 chars of the v3 rollup):**\n");
console.log("```");
console.log(target.content.slice(0, 600));
console.log("```\n");

console.log("**Tail (last 600 chars):**\n");
console.log("```");
console.log(target.content.slice(-600));
console.log("```\n");

console.log("Note `summarizer_model='concatenation-v1'` — there was no LLM call. The rollup is literally");
console.log("the concatenated `content` of the source summaries with `## Activity Timeline` headers slapped on.");
console.log("This is what we mean by \"compression of compression\": each source summary was already a leaf-level");
console.log("compression of raw messages; the rollup compresses those compressions further by truncating, with");
console.log("no model call to *understand* the content.\n");

// Count what v4.1 would have done with the same window: zero rollups stored, leaves embedded for retrieval
const day = target.period_start;
const dayEnd = target.period_end;
const leavesForWindow = db
  .prepare(
    `
  SELECT COUNT(*) AS cnt, COALESCE(SUM(token_count), 0) AS total_tokens
  FROM summaries
  WHERE conversation_id = ?
    AND kind = 'leaf'
    AND latest_at >= ?
    AND latest_at < ?
`,
  )
  .get(target.conversation_id, day, dayEnd);

console.log(`## What v4.1 does for the same window (${day.slice(0, 10)}, conv ${target.conversation_id})\n`);
console.log("**Storage:** 0 rollup rows. The raw leaves stay in `summaries` (lossless bedrock).");
console.log(`**Leaves in this window:** ${leavesForWindow.cnt} leaves, ${leavesForWindow.total_tokens?.toLocaleString() ?? 0} tokens total.`);
console.log("");
console.log("**Retrieval:**");
console.log(
  "- Each leaf gets a Voyage embedding → `lcm_semantic_recall(\"any topic\")` finds it across the whole corpus, not just this window.",
);
console.log(
  "- `lcm_grep --mode hybrid` does FTS5 + semantic + Voyage rerank merge. Eva's eval showed +52.5pp recall on paraphrastic queries vs FTS-only.",
);
console.log("");
console.log("**On-demand synthesis (when the agent or user asks for the day):**");
console.log(
  '- `lcm_synthesize_around({ window_kind: "time", anchor: "2026-05-04", scope: "day" })` runs synthesis NOW',
);
console.log("  against the actual leaves above. Tier dispatch: `daily` → haiku-4-5 single-pass.");
console.log("- If a leaf gets suppressed in between, the next call automatically excludes it (suppression cascade).");
console.log("- If the operator changes the daily prompt, the next call uses the new prompt without re-rolling.");
console.log("");
console.log("**Cost comparison:**");
console.log("- v3 concatenation-v1: $0 per build (no LLM call) but produces lossy repetitive output that the agent");
console.log("  can't ask topic-indexed questions against.");
console.log(
  "- v4.1 daily synthesis: ~$0.005 per call (haiku) — only paid when the user/agent actually asks for that window.",
);
console.log(
  "- v4.1 backfill embedding: ~$1 one-time for the entire 4187-leaf corpus, ~$0.0001 per new leaf (voyage-3-lite).",
);
console.log("");

// Suppress / hard-forget capability — only v4.1 has this
console.log("## Hard-forget capability (only in v4.1)\n");
console.log("v3 rollups: deleting a leaf leaves the rollup unchanged (the leaf's text was concatenated in;");
console.log("no way to know which substring to remove). The leaf's ghost lives forever in every rollup that");
console.log("touched it.\n");
console.log("v4.1: `runPurge(leafIds, reason)` flips `summaries.suppressed_at` and `messages.suppressed_at`.");
console.log("From that single flip, cascade triggers (7 read paths) make the leaf invisible everywhere.");
console.log("Parent condensed summaries get `contains_suppressed_leaves=1` so the next idle pass rebuilds them clean.");
console.log("The next `lcm_synthesize_around` call automatically excludes the suppressed leaf.\n");

console.log("---\n");
console.log("## Summary\n");
console.log("| Property | v3 (`lcm_recent` + concatenation-v1) | v4.1 (`lcm_synthesize_around` + embeddings) |");
console.log("|---|---|---|");
console.log("| Storage | Pre-built rollup rows | Raw leaves (lossless) |");
console.log("| Build cost | $0 per build, but built nightly | $0 until called |");
console.log("| Per-call cost | $0 (read pre-built) | $0.005 (haiku) - $5 (yearly opus-thinking) |");
console.log("| LLM used? | No (concatenation only) | Yes (per-tier model dispatch) |");
console.log("| Cross-time topic search | Not supported | `lcm_semantic_recall`, `lcm_grep --mode hybrid` |");
console.log("| Hard-forget | Not supported | `runPurge` cascades through 7 read paths |");
console.log("| Re-prompt without re-roll | Not supported | Yes — new prompt = new synthesis on next call |");

db.close();
