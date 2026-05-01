---
title: "LCM upstream PR stack handoff"
type: handoff
created: 2026-04-29
status: active
tags: [lossless-claw, lcm, upstream-prs, handoff, merge-readiness]
related:
  - docs/audits/HANDOFF-lcm-scenario-flows-2026-04-29.md
  - docs/audits/PROMPT-lcm-followup-agent-516-518-2026-04-29.md
  - https://github.com/Martian-Engineering/lossless-claw/pull/516
  - https://github.com/Martian-Engineering/lossless-claw/pull/517
  - https://github.com/Martian-Engineering/lossless-claw/pull/518
  - https://github.com/Martian-Engineering/lossless-claw/pull/516#issuecomment-4338689635
---

# LCM upstream PR stack handoff

This is the maintainer/agent handoff for the upstream lossless-claw LCM stack.

Canonical repository:

- <https://github.com/Martian-Engineering/lossless-claw>

Canonical upstream PR stack:

- #516 temporal `lcm_recent` rollups: <https://github.com/Martian-Engineering/lossless-claw/pull/516>
- #517 observed work density: <https://github.com/Martian-Engineering/lossless-claw/pull/517>
- #518 experimental task bridge suggestions: <https://github.com/Martian-Engineering/lossless-claw/pull/518>

Scenario-flow package:

- Repo doc: `docs/audits/HANDOFF-lcm-scenario-flows-2026-04-29.md`
- Upstream PR comment: <https://github.com/Martian-Engineering/lossless-claw/pull/516#issuecomment-4338689635>

Follow-up agent prompt:

- `docs/audits/PROMPT-lcm-followup-agent-516-518-2026-04-29.md`

## Stack intent

The stack turns lossless-claw from keyword/summary recall into a temporal evidence layer without making it an authoritative task system.

Layer responsibilities:

1. `lcm_recent` answers **what happened in this time window?**
2. `lcm_work_density` answers **what does conversation evidence suggest is done, unfinished, or ambiguous?**
3. Task bridge suggestions answer **would you like to review or convert evidence into an explicit task action?**

Authority boundaries:

- LCM is evidence/recap/provenance.
- GitHub owns PR/issue truth.
- OpenClaw task systems own commitments and task state.
- Cortex owns curated durable semantic memory.

## PR #516: temporal spine

Purpose:

- Add daily, weekly, and monthly temporal rollups.
- Add `lcm_recent` for time-window recap.
- Add deterministic local-time/sub-day window handling.
- Add `lcm_rollup_debug` as opt-in operator/debug tooling.

Must remain true:

- `lcm_recent` is read-only.
- Missing or stale rollups return explicit degraded/missing coverage.
- Rollup writes happen through maintenance/admin build paths.
- Exact commands, paths, timestamps, root causes, and shipped/decided claims require `lcm_describe`, `lcm_expand`, or `lcm_expand_query`.
- Sub-day questions must use bounded leaf-summary fallback when needed, not whole-day precision theater.

Completion criteria:

- Daily build idempotence covered.
- Weekly/monthly source coverage covered.
- Stale/invalidation propagation covered.
- Invalid dates and DST-gap local times covered.
- Source IDs hidden unless requested where applicable.
- Copilot review threads resolved or demonstrably stale.

## PR #517: observed work density

Purpose:

- Add an advisory observed-work read model over LCM evidence.
- Add `lcm_work_density` for "what got done?", "what is unfinished?", and "what is ambiguous?" style questions.

Allowed vocabulary:

- `observed_completed`
- `observed_unfinished`
- `observed_ambiguous`
- `decision_recorded`
- `dismissed`

Must remain true:

- Read-only tool behavior.
- Source IDs hidden by default.
- No OpenClaw task writes.
- No Cortex sync.
- No reminders or wakes.
- No default cross-conversation behavior.
- Automatic extraction remains follow-up work unless explicitly implemented as conservative, provenance-backed processing.

Completion criteria:

- Density counts covered.
- Period filtering covered.
- Source redaction covered.
- State preservation covered.
- Tool output clearly says observed evidence, not authoritative task state.

## PR #518: experimental task bridge suggestions

Purpose:

- Add inert task-bridge suggestion storage for future reviewed task workflows.

Allowed:

- suggestion records,
- pending/accepted/rejected/dismissed/expired review states,
- source IDs/confidence/rationale,
- optional links to observed-work items.

Forbidden:

- registered default runtime tool,
- automatic suggestion generation from raw evidence,
- direct OpenClaw task writes,
- automatic task creation,
- automatic task closure,
- notifications/reminders,
- default-on bridge behavior.

Completion criteria:

- Suggestion persistence covered.
- Review-state updates covered.
- Source/rationale/confidence validation covered.
- Tests prove no external task table/write behavior.

## Scenario coverage

The stack should support or honestly defer these flows:

1. "What did we get done yesterday?"
   - #516 + #517 should support this with recap plus observed work density.

2. "What's blocked right now?"
   - #517 should surface observed blockers/risks/follow-ups; external systems verify truth.

3. "Where are we on upstream PRs?"
   - GitHub first, then LCM context and observed unfinished cleanup.

4. "What happened yesterday 4-8pm?"
   - #516 should use sub-day `lcm_recent`/bounded fallback and avoid whole-day proof claims.

5. "Should we create tasks from unfinished things?"
   - #517 surfaces candidates; #518 stores inert suggestions; real task writes require explicit external approval.

6. Missing week/month rollup.
   - #516 returns degraded/missing response; build path is explicit.

## Follow-up PRs

Recommended follow-ups after #516-#518:

- Conservative observed-work extraction from new summaries/rollups into `lcm_observed_work_items`.
- Tracker-style blocker/open-item queries inside `lcm_work_density`.
- Additional sub-day parser/window hardening if reviewers want it split out.
- Public-fork cleanup after old branch ideas/review notes are represented upstream.

Do not merge old tracker/task branches as-is. Salvage the ideas into observed-work vocabulary with provenance and confidence.

## Fresh-checkout verification rule

Because these branches have moved across machines, future work should start from fresh upstream-based checkouts under `/Volumes/LEXAR/repos`.

Before editing, verify:

```bash
git show -s --format=%H HEAD
git show -s --format=%T HEAD
gh pr view <PR> --repo Martian-Engineering/lossless-claw --json headRefOid
gh api repos/Martian-Engineering/lossless-claw/git/commits/<HEAD_SHA> --jq .tree.sha
```

Proceed only when the fresh checkout commit and tree match the upstream PR head.

## Validation commands

Run from the relevant fresh checkout:

```bash
npm test
npm run build
git diff --check
git status --short
```

Focused checks:

```bash
# PR #516
npm test -- --run test/rollup-store-builder.test.ts test/plugin-prompt-hook.test.ts

# PR #517
npm test -- --run test/observed-work-store.test.ts test/plugin-prompt-hook.test.ts

# PR #518
npm test -- --run test/task-bridge-suggestion-store.test.ts test/observed-work-store.test.ts
```

Final GitHub check:

```bash
for n in 516 517 518; do
  gh pr view "$n" --repo Martian-Engineering/lossless-claw \
    --json title,headRefName,headRefOid,mergeable,reviewDecision,statusCheckRollup,updatedAt,url
  gh pr checks "$n" --repo Martian-Engineering/lossless-claw
done
```

## Remaining caveat

`lcm_recent` is recap/window entry, not proof. Exact claims must be verified with source inspection or expansion before being presented as facts.
