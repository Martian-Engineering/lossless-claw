---
title: "Prompt for follow-up agent: LCM PR #516-#518 architecture and follow-up PRs"
type: agent-prompt
created: 2026-04-29
status: active
tags: [lossless-claw, lcm, agent-prompt, upstream-prs, architecture]
related:
  - docs/audits/HANDOFF-lcm-upstream-pr-stack-2026-04-29.md
  - docs/audits/HANDOFF-lcm-scenario-flows-2026-04-29.md
  - https://github.com/Martian-Engineering/lossless-claw/pull/516#issuecomment-4338689635
---

# Prompt for follow-up agent: LCM PR #516-#518 architecture and follow-up PRs

You are taking over the upstream lossless-claw LCM PR stack and adjacent follow-up architecture.

Canonical repo:

- <https://github.com/Martian-Engineering/lossless-claw>

Canonical PR stack:

- #516 temporal `lcm_recent` rollups: <https://github.com/Martian-Engineering/lossless-claw/pull/516>
- #517 observed work density: <https://github.com/Martian-Engineering/lossless-claw/pull/517>
- #518 experimental task bridge suggestions: <https://github.com/Martian-Engineering/lossless-claw/pull/518>

Scenario-flow comment posted on #516:

- <https://github.com/Martian-Engineering/lossless-claw/pull/516#issuecomment-4338689635>

## Read first

1. PR #516 description and diff.
2. PR #517 description and diff.
3. PR #518 description and diff.
4. Scenario-flow comment on #516.
5. This repo's handoff docs:
   - `docs/audits/HANDOFF-lcm-upstream-pr-stack-2026-04-29.md`
   - `docs/audits/HANDOFF-lcm-scenario-flows-2026-04-29.md`
6. The in-repo specs:
   - `specs/lcm-temporal-memory-plan.md`
   - `specs/lcm-observed-work-density-option-b.md`
   - `specs/lcm-task-bridge-option-c-experimental.md`

## Mission

Get the current stack to mergeable, then propose or implement necessary follow-up PRs without expanding the current PRs into an unreviewable blob.

The design goal is an agent memory stack with strict authority boundaries:

1. `lcm_recent` answers: **what happened in this time window?**
2. `lcm_work_density` answers: **what does conversation evidence suggest is done, unfinished, or ambiguous?**
3. Task bridge suggestions answer: **would you like to review or turn this evidence into an explicit task action?**

LCM must not become a second task system or an authoritative project manager.

## Work order

### Phase 1: finish #516 temporal spine

Focus on correctness and reviewability.

Requirements:

- `lcm_recent` reads do not mutate state.
- Missing rollups return explicit degraded/missing responses.
- Rollup writes happen through explicit/admin/maintenance paths only.
- Daily, weekly, and monthly behavior are real and tested.
- Partial coverage is visible.
- Timezone/DST handling rejects invalid/impossible local times instead of guessing.
- Provenance and accounting are present enough to support later observed-work layers.

Add or verify tests for:

- daily build idempotence,
- missing rollup response,
- weekly/monthly source coverage,
- stale/invalidation propagation,
- read-only behavior,
- invalid dates,
- DST-gap local times if sub-day support is included.

If sub-day windows are too much for #516, split them into a follow-up PR.

### Phase 2: finish #517 observed work density

Keep this advisory.

Requirements:

- Use observed vocabulary only: `observed_completed`, `observed_unfinished`, `observed_ambiguous`, `decision_recorded`, `dismissed`.
- Do not use authoritative task words like `task_done`, `task_open`, `accepted`, `assigned`, or `committed` for LCM-owned state.
- `lcm_work_density` must be read-only.
- Sources hidden by default; source IDs only with `includeSources=true` or a debug-like affordance.
- No OpenClaw task writes.
- No Cortex sync.
- No reminders/wakes.
- No default cross-conversation behavior.

Important follow-up architecture:

The highest-value old local idea is tracker/state memory from historic tracker branches:

- persistent blockers,
- open items,
- decisions,
- resolution detection,
- "what's still blocked?" queries.

Do not merge the old tracker branches as-is. Adapt the idea into the observed-work model, with provenance/confidence and non-authoritative language.

If #517 currently stores/query observed work but does not extract/classify it automatically, keep extraction as a separate follow-up PR for conservative incremental extraction from rollups/leaf summaries.

### Phase 3: keep #518 inert

#518 must remain suggestion-only.

Allowed:

- suggestion storage,
- pending/accepted/rejected/dismissed/expired review states,
- links from suggestions to observed-work items,
- source IDs/confidence/rationale,
- tests proving no external task writes.

Forbidden:

- direct OpenClaw task writes,
- automatic task creation,
- automatic task closure,
- notifications/reminders,
- default-on bridge behavior,
- generation from raw LCM evidence before observed-work confidence exists.

If anything in #518 feels like runtime automation, split it into a later opt-in experiment.

## Follow-up PRs worth proposing

Do not cram these into the current stack unless they are tiny and directly required.

### Follow-up A: conservative observed-work extraction

Purpose: turn rollup/leaf-summary evidence into `lcm_observed_work_items` incrementally.

Requirements:

- process new summaries only,
- preserve state across reruns,
- conservative status transitions,
- resolution detection only when evidence is strong,
- confidence/rationale/source IDs required,
- no task writes.

### Follow-up B: tracker-style blocker/open-item queries

Purpose: salvage the best old tracker-state idea inside the observed-work boundary.

Examples:

- `lcm_work_density({ statuses: ["observed_unfinished"], kinds: ["blocker"] })`
- "what's still blocked?"
- "what was later resolved?"

This may be a tool enhancement or docs/tests around `lcm_work_density`, not necessarily a new tool.

### Follow-up C: sub-day temporal windows

Purpose: support realistic user questions like:

- "what happened yesterday 4-8pm?"
- "what did we do this morning?"
- "what happened in the last 6h?"

Requirements:

- timezone-aware local window conversion,
- DST-gap rejection,
- impossible date rejection,
- no fake sub-day precision from whole-day rollups,
- drill into bounded leaf summaries when needed.

### Follow-up D: local/fork cleanup

Purpose: close or mark superseded old public-fork PRs once upstream coverage is verified.

Likely mapping:

- local #18 -> upstream #516,
- local #16 -> upstream #517,
- local #17 -> upstream #518,
- local #12-#15 -> folded into #516/specs/review notes,
- local #9/#11 -> idea salvaged into observed-work/tracker follow-up,
- local #10 -> episode detection deferred,
- local #4-#8 -> superseded/deferred/cherry-pick only.

Do not delete branches until useful code/review notes are represented upstream or in issues.

## Scenario flows to validate

1. "What did we get done yesterday?"
   - `lcm_recent` -> `lcm_work_density` -> `lcm_expand_query` if ambiguous.

2. "What's blocked right now?"
   - `lcm_work_density` over unfinished/blocker/risk/follow-up items -> expand proof -> live external checks for PRs/tickets/tasks.

3. "Where are we on upstream PRs?"
   - GitHub live check first -> LCM recent/planning context -> observed unfinished cleanup.

4. "What happened yesterday 4-8pm?"
   - sub-day `lcm_recent` if supported -> bounded grep/expand fallback -> never fake precision from day rollup.

5. "Should we create tasks from unfinished things?"
   - `lcm_work_density` -> optional dry-run task suggestions -> explicit user approval -> real task system writes.

6. Missing week/month rollup.
   - `lcm_recent` returns degraded/missing response -> optional best-effort bounded recall -> explicit build path if wanted.

If a code path cannot explain one of these flows cleanly, either adjust the implementation or document that the flow is deferred.

## Validation before reporting done

Run:

```bash
npm test
npm run build
git diff --check
```

Also include focused test names/results for the specific behavior changed.

Report back with:

1. Which PRs changed.
2. Which scenario flows now pass.
3. Which flows are intentionally deferred.
4. Any follow-up PRs recommended.
5. Exact verification commands and results.

## Hard workspace rule

Use Lexar lossless-claw checkouts only. Do not touch `workspace-eva`.
