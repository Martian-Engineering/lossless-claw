# LCM ↔ OpenClaw Task Bridge — Option C Experimental

Date: 2026-04-28
Status: Work-in-progress potential test feature; opt-in only
Related: Option B observed work density, PR16 tracker/work-density architecture

## Thesis

Option C explores a bridge between LCM observed work signals and OpenClaw's task system. It must not be default-on. It should be treated as an experimental, opt-in feature after observed work density proves useful.

The bridge exists to answer:

- Can observed unfinished work become a suggested OpenClaw task?
- Can observed completion evidence help a user review existing tasks?
- Can agents link conversation evidence to operational task records without silently mutating authority?

## Non-goal

Option C is **not** a second task system and is **not** automatic task automation.

LCM remains evidence/observation. OpenClaw tasks remain operational authority.

## Required gates

Option C should require all of these:

1. Explicit config enablement.
2. Per-call opt-in or user action.
3. No silent task creation.
4. No silent task closure.
5. No reminders/wakes/notifications from LCM evidence alone.
6. Full provenance attached to every suggestion.
7. User/caller-visible confidence and uncertainty.
8. Clear UI copy: “suggested from observed conversation evidence.”

## Example config

```json
{
  "lcmTaskBridge": {
    "enabled": false,
    "mode": "suggest_only",
    "allowCreateSuggestions": true,
    "allowClosureSuggestions": true,
    "allowDirectCreate": false,
    "allowDirectClose": false,
    "minCreateSuggestionConfidence": 0.85,
    "minClosureSuggestionConfidence": 0.95,
    "maxSuggestionsPerConversationPerDay": 5
  }
}
```

`allowDirectCreate` and `allowDirectClose` should remain false until a separate policy/security review.

## Bridge table

```sql
CREATE TABLE lcm_task_bridge_suggestions (
  suggestion_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  task_id TEXT,
  suggestion_kind TEXT NOT NULL, -- create_task | link_task | mark_task_done | mark_task_blocked | add_task_evidence
  status TEXT NOT NULL, -- pending | accepted | rejected | dismissed | expired
  confidence REAL NOT NULL,
  rationale TEXT NOT NULL,
  source_ids TEXT NOT NULL, -- JSON array acceptable for cold suggestion records
  created_by TEXT NOT NULL DEFAULT 'lcm_observed',
  reviewed_by TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

If suggestion volume grows, source IDs should be normalized like Option B's provenance table.

## Tool surface

Possible future tool: `lcm_task_suggestions`.

```ts
lcm_task_suggestions({
  conversationId?,
  period?,
  suggestionKinds?: ["create_task", "link_task", "mark_task_done", "mark_task_blocked", "add_task_evidence"],
  includeSources?: boolean,
  maxSuggestions?,
  minConfidence?,
  dryRun?: true
})
```

Default `dryRun` should be true.

## Suggested flows

### Create-task suggestion

1. `lcm_work_density` identifies repeated high-confidence unfinished blocker.
2. Bridge proposes: “Create OpenClaw task?”
3. User/caller accepts.
4. OpenClaw task is created by task system, not LCM.
5. Bridge records accepted suggestion and link.

### Closure suggestion

1. Existing OpenClaw task is linked to observed work item.
2. LCM later observes strong completion evidence.
3. Bridge proposes: “This task appears completed; review evidence?”
4. User/caller accepts closure.
5. OpenClaw task system marks complete.

### Evidence attachment

1. LCM observes relevant evidence for an existing task.
2. Bridge suggests adding evidence/source link.
3. User/caller accepts or ignores.

## Test mode

Option C should first ship as test-only or operator-only mode:

- generate suggestions
- never apply them
- compare against manually curated task outcomes
- measure false positive / false negative rate
- measure suggestion fatigue
- log accepted/rejected suggestions for calibration

## Evaluation metrics

- suggestion precision
- suggestion recall
- false closure rate
- duplicate suggestion rate
- user acceptance rate
- average suggestions per active day
- task spam complaints
- time saved in sprint recap
- confidence calibration accuracy

## Risks

1. Duplicate task systems.
2. Agents treating LCM observations as task authority.
3. Silent task spam.
4. False closure of tasks.
5. Privacy leakage through aggregated task suggestions.
6. Conflicting Cortex/OpenClaw/LCM state.
7. User trust loss if suggestions feel made up.

## Guardrails

- Use Option B observed work density as input, not raw messages.
- Only propose from high-confidence repeated evidence.
- Always show rationale and sources.
- Require explicit accept/reject.
- Keep direct write APIs disabled by default.
- Add per-day suggestion caps.
- Add dismissal memory.
- Never close tasks automatically.

## Recommendation

Do not include Option C in PR16 default behavior.

File it as a future experimental feature after Option B ships and produces real observed-work-density data. The first implementation should be opt-in, dry-run-first, and suggestion-only.

---

## Implementation scaffold added in this draft

This draft intentionally adds only an inert suggestion store and tests. It does **not** register a tool and does **not** add any task-writing behavior.

Added files:

- `src/store/task-bridge-suggestion-store.ts`
- `test/task-bridge-suggestion-store.test.ts`

The scaffold exists so future maintainers can reason about the persistence boundary without accidentally enabling automation.

### Current scaffold behavior

- Creates `lcm_task_bridge_suggestions` during migration.
- Requires each suggestion to point at an Option B observed-work item.
- Stores suggestion records with explicit status.
- Defaults suggestions to reviewable/pending state.
- Supports accepting/rejecting/dismissing suggestions as records only.
- Requires source IDs, rationale, and confidence between 0 and 1.
- Does not create, link, close, or modify OpenClaw tasks.
- Registers suggestion/review tools only when `taskBridgeToolsEnabled` or
  `LCM_TASK_BRIDGE_TOOLS_ENABLED` explicitly enables them.

### Review hardening in this branch

- The table is created in a separate idempotent migration step after the observed-work tables.
- `work_item_id` is a foreign key to `lcm_observed_work_items`, making this PR explicitly dependent on Option B.
- Suggestion writes normalize duplicate/empty source IDs and reject source-free suggestions.
- Review updates return whether a suggestion existed, so callers do not confuse a missing record with a successful review.

### Explicitly not implemented

- no default-on runtime tool registration
- no direct task writes
- no task closure
- no notifications/reminders
- no default-on config
- no automatic generation from LCM evidence

This PR should remain experimental documentation plus inert scaffolding unless/until Option B observed work density proves useful.
