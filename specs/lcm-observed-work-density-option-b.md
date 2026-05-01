# LCM Observed Work Density — Option B

Date: 2026-04-28
Status: Recommended PR16 direction
Related: `lcm-tracker-task-bridge-pr16-architecture-2026-04-28.md`

## Thesis

Option B avoids creating a second task system. Instead, LCM exposes an **observed work-density ledger** over conversation evidence.

The system should help agents answer:

- How much work happened in this period?
- Which task-like items appear completed?
- Which appear unfinished?
- Which are ambiguous and need deeper inspection?
- How confident is the system, and what evidence supports that?

The key distinction:

> LCM does not own tasks. LCM observes work signals in conversation history.

## Product goal

When a user asks, “What did we get done yesterday?” or “Where are we on this sprint?”, the agent should be able to report progress density without pretending extracted items are authoritative task records.

Example UX:

```text
Observed work density for yesterday:

Total observed work items: 18
Completed: 11
Unfinished: 5
Ambiguous: 2

Top unfinished:
1. Fix PR #14 review comments — evidence: sum_a, sum_b
2. Add tracker watermark tests — evidence: sum_c
3. Re-run PR stack validation — evidence: sum_d
4. Update architecture doc with adversarial review — evidence: sum_e
5. Decide task bridge policy — evidence: sum_f

Completed highlights:
1. Daily rollup tests passed
2. PR #15 updated with debug gating
3. Tarzan/Indigo config repaired

Confidence: medium-high
Note: observed from LCM summaries; not authoritative task state.
Recommended dive: expand summaries sum_a/sum_b for PR #14 status.
```

## Vocabulary

Use “observed work,” not “tasks,” for LCM-owned data.

Recommended labels:

- `observed_work_item`
- `observed_completed`
- `observed_unfinished`
- `observed_ambiguous`
- `decision_recorded`
- `dismissed`

Avoid authoritative labels in PR16:

- `task_open`
- `task_done`
- `accepted`
- `assigned`
- `committed`

## Data model sketch

```sql
CREATE TABLE lcm_observed_work_items (
  work_item_id TEXT PRIMARY KEY,
  conversation_id INTEGER NOT NULL,
  owner_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  observed_status TEXT NOT NULL, -- observed_completed | observed_unfinished | observed_ambiguous | decision_recorded | dismissed
  kind TEXT NOT NULL, -- implementation | review | blocker | decision | question | follow_up | test | deploy | research
  confidence REAL NOT NULL DEFAULT 0.5,
  confidence_band TEXT NOT NULL DEFAULT 'medium',
  rationale TEXT,
  topic_key TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  completed_at TEXT,
  completion_confidence REAL,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  source_message_count INTEGER NOT NULL DEFAULT 0,
  source_token_count INTEGER NOT NULL DEFAULT 0,
  authority_source TEXT NOT NULL DEFAULT 'lcm_observed',
  sensitivity TEXT,
  visibility TEXT,
  fingerprint TEXT NOT NULL,
  fingerprint_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Normalize provenance:

```sql
CREATE TABLE lcm_observed_work_sources (
  work_item_id TEXT NOT NULL,
  source_type TEXT NOT NULL, -- summary | rollup
  source_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  evidence_kind TEXT NOT NULL, -- created | reinforced | possible_completion | completed | contradicted | dismissed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (work_item_id, source_type, source_id, evidence_kind)
);
```

Incremental processing state:

```sql
CREATE TABLE lcm_observed_work_state (
  conversation_id INTEGER PRIMARY KEY,
  last_processed_summary_created_at TEXT,
  last_processed_summary_id TEXT,
  pending_rebuild INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## Tool surface

Recommended tool: `lcm_work_density`.

```ts
lcm_work_density({
  conversationId?,
  period?: "today" | "yesterday" | "7d" | "30d" | "date:YYYY-MM-DD" | string,
  topic?,
  statuses?: ["observed_completed", "observed_unfinished", "observed_ambiguous", "decision_recorded", "dismissed"],
  kinds?: string[],
  includeSources?: boolean,
  detailLevel?: 0 | 1 | 2,
  maxOutputTokens?,
  minConfidence?,
  limit?
})
```

## Response contract

```json
{
  "period": "yesterday",
  "density": {
    "totalObserved": 18,
    "completed": 11,
    "unfinished": 5,
    "ambiguous": 2,
    "dismissed": 0
  },
  "topUnfinished": [],
  "completedHighlights": [],
  "ambiguous": [],
  "accounting": {
    "outputTokens": 6000,
    "sourceSummaryTokens": 42000,
    "sourceMessageTokens": 180000,
    "itemsIncluded": 18,
    "itemsOmitted": 0,
    "truncated": false
  },
  "confidence": "medium-high",
  "disclaimer": "Observed from LCM summaries; not authoritative task state.",
  "recommendedDives": []
}
```

## Behavioral rules

1. Never call these authoritative tasks.
2. Always label output as observed/unrefined evidence.
3. Prefer “appears completed” over “completed” unless evidence is explicit.
4. Keep ambiguous completion separate from completed.
5. Default to compact density counts and top items.
6. Require `includeSources=true` for source IDs.
7. Do not create, close, or modify OpenClaw tasks.
8. Do not sync to Cortex commitments/open loops.
9. Process incrementally from new summaries only.
10. Reads must not mutate work-density state.

## Why this is better than a second task system

A second task system would create confusion: agents would need to know whether LCM, Cortex, TaskFlow, cron, GitHub issues, or OpenClaw tasks owns the truth.

Observed work density avoids that. It says:

- “Here is what conversation evidence suggests happened.”
- “Here is what appears undone.”
- “Here is how confident I am.”
- “Here is where to dive deeper.”

This gives agents richer context while preserving authority boundaries.

## PR16 recommendation

PR16 should implement Option B as the default path:

1. Add observed work item/source/state tables.
2. Add incremental extraction from new leaf summaries.
3. Add compact `lcm_work_density` read tool.
4. Add confidence/rationale/accounting.
5. Add tests for density counts, false completions, unfinished item highlighting, ambiguity, and budget caps.
6. Explicitly defer task bridge writes.

---

## Implementation added in this draft

This draft includes the persistence/read model, read-only query tool, and
conservative deterministic extraction from new leaf summaries.

Added files:

- `src/store/observed-work-store.ts`
- `src/observed-work-extractor.ts`
- `src/tools/lcm-work-density-tool.ts`
- `test/observed-work-store.test.ts`
- `test/lcm-ultimate-architecture.test.ts`

Extraction remains deliberately conservative and rule-based. It uses leaf
summary lines as evidence, preserves per-conversation processing watermarks,
raises confidence only with repeated evidence, and records source links for
proof-oriented drilldown.

### Current scaffold behavior

- Creates observed-work tables idempotently during migration.
- Stores observed work items, source links, and per-conversation processing state.
- Processes new leaf summaries during maintenance.
- Exposes `lcm_work_density` as a read-only tool.
- Supports deterministic period filters for `today`, `yesterday`, `7d`, `30d`, `week`, `month`, and `date:YYYY-MM-DD`.
- Returns density counts for a period:
  - total observed
  - completed
  - unfinished
  - ambiguous
  - dismissed
- Returns top unfinished and completed highlights.
- Hides source IDs by default and includes provenance only when `includeSources=true`.
- Includes confidence/disclaimer/accounting metadata.
- Does not create or close tasks.
- Does not sync to Cortex.
- Does not mutate state from reads.

### Review hardening in this branch

- The tables are created in their own idempotent migration steps instead of being folded into unrelated setup SQL.
- `ObservedWorkStore` preserves omitted incremental-state fields on partial updates.
- `lcm_work_density` reads through `LcmContextEngine.getObservedWorkStore()` rather than reaching into private database state.
- Period windows use the shared temporal helper module from the `lcm_recent` stack, so UTC+13/DST date boundaries stay consistent.
- Extraction failures preserve retry state instead of dropping the watermark.

### Explicitly not implemented yet

- LLM classification
- live current-day refresh
- OpenClaw task bridge writes
- Cortex commitments/open-loop sync
- cross-conversation default retrieval
