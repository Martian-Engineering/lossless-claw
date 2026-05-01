---
title: "LCM upstream PR stack scenario flows"
type: handoff-test
created: 2026-04-29
status: active
tags: [lossless-claw, lcm, lcm_recent, observed-work, task-bridge, scenarios, agent-flows]
related:
  - docs/audits/HANDOFF-lcm-upstream-pr-stack-2026-04-29.md
  - docs/audits/PROMPT-lcm-followup-agent-516-518-2026-04-29.md
  - https://github.com/Martian-Engineering/lossless-claw/pull/516
  - https://github.com/Martian-Engineering/lossless-claw/pull/517
  - https://github.com/Martian-Engineering/lossless-claw/pull/518
  - https://github.com/Martian-Engineering/lossless-claw/pull/516#issuecomment-4338689635
---

# LCM upstream PR stack scenario flows

This package pressure-tests the upstream LCM stack against realistic agent workflows. The goal is not only "does the schema exist?" The goal is: when a user asks a natural operational question, which tool should the agent call, what layer owns the answer, when should it escalate, and what must never happen silently?

## Layer model

1. **LCM temporal spine** - PR #516
   - Tool: `lcm_recent`
   - Operator/debug tool: `lcm_rollup_debug`, only when explicitly enabled.
   - Purpose: answer bounded temporal recall questions cheaply and conservatively.

2. **Observed work density** - PR #517
   - Tool: `lcm_work_density`
   - Purpose: summarize work signals from conversation evidence.
   - Authority: advisory only; not tasks.

3. **Task bridge suggestions** - PR #518
   - Current surface: inert suggestion storage only.
   - Purpose: preserve reviewed suggestion records for future task workflows.
   - Authority: suggestion ledger only; no automatic task writes.

4. **Deep recall and proof layer** - existing LCM tools
   - Tools: `lcm_grep`, `lcm_describe`, `lcm_expand`, `lcm_expand_query`.
   - Purpose: discover sources and verify exact claims.

5. **External authority tools**
   - GitHub owns PR/issue truth.
   - OpenClaw task systems own operational commitments.
   - Cortex owns curated durable semantic memory.
   - LCM observations do not supersede those systems.

## Scenario matrix

| Scenario | First tool | Escalation | External truth | Must not do |
| --- | --- | --- | --- | --- |
| What happened yesterday? | `lcm_recent` | `lcm_work_density`, `lcm_expand_query` | None unless PR/task claims appear | Claim authority from observation |
| What got done? | `lcm_work_density` | `lcm_expand_query` | GitHub/tasks if named | Mark tasks done |
| What is blocked? | `lcm_work_density` | `lcm_expand_query` | GitHub/Intercom/tasks | Create tasks silently |
| Where are PRs? | GitHub or `gh` first | `lcm_recent`, `lcm_grep` | GitHub | Trust stale rollup over live PR state |
| Sub-day window | `lcm_recent` | bounded grep/expand | None | Fake precision from a whole-day rollup |
| Missing rollup | `lcm_recent` | grep/expand, explicit build | None | Mutate on read |
| Create task candidates | `lcm_work_density` | future dry-run suggestions | Task system | Direct task write from LCM |
| Local cleanup | GitHub or `gh` first | LCM handoff docs | GitHub | Delete branches before salvage |

## Scenario 1: What did we get done yesterday?

User asks:

> What did we get done yesterday?

Expected flow:

1. Call `lcm_recent({ period: "yesterday" })` for temporal narrative and likely source IDs.
2. Call `lcm_work_density({ period: "yesterday", detailLevel: 1 })` for observed completed/unfinished/ambiguous counts.
3. If work-density output contains ambiguous or high-impact claims, call `lcm_expand_query` over the relevant sources before making strong statements.

Expected answer shape:

```text
Observed work yesterday:
- Completed or likely completed: 11 items
- Still unfinished: 5
- Ambiguous: 2

Highlights:
1. Fleet rollout completed on six healthy VMs.
2. Image-generation default moved fleet-wide.
3. David was isolated as a transport/runtime outlier and ticketed.

Still open:
1. David image POST transport issue - ticketed, not solved.
2. LCM upstream PR stack cleanup/consolidation.

Confidence: medium-high.
Note: observed from LCM summaries, not authoritative task state.
```

Boundary:

- LCM may say "appears completed" or "observed completed."
- LCM must not mark OpenClaw tasks done.
- If the user asks for authoritative task status, query OpenClaw task/TaskFlow/GitHub state.

## Scenario 2: Where are we on upstream LCM PRs?

User asks:

> Where are we on the upstream LCM PRs?

Expected flow:

1. Query GitHub first for canonical state:
   - #516: <https://github.com/Martian-Engineering/lossless-claw/pull/516>
   - #517: <https://github.com/Martian-Engineering/lossless-claw/pull/517>
   - #518: <https://github.com/Martian-Engineering/lossless-claw/pull/518>
2. Use `lcm_recent({ period: "today" })` or `lcm_grep` for recent planning/context.
3. Use `lcm_work_density` only to identify observed unfinished cleanup, not live PR truth.
4. Read handoff/audit artifacts if handoff-quality detail is needed.

Boundary:

- GitHub owns PR state.
- LCM owns "what we discussed/planned."
- Observed work may say "cleanup appears unfinished"; GitHub confirms actual open/closed status.

## Scenario 3: What's blocked right now?

User asks:

> What's blocked right now?

Expected flow:

1. Call `lcm_work_density({ period: "7d", statuses: ["observed_unfinished", "observed_ambiguous"], kinds: ["blocker", "risk", "follow_up"], detailLevel: 2 })`.
2. For high-impact blockers, call `lcm_expand_query` to answer: "What evidence says this is blocked? Was it later resolved?"
3. If the blocker maps to a PR, issue, ticket, or task, query that external authority live.

Boundary:

- LCM surfaces observed blockers.
- It must not create reminders or tasks unless the user explicitly asks and an external task system performs the write.

## Scenario 4: What happened yesterday between 4 and 8pm?

User asks:

> What happened yesterday from 4 to 8pm?

Expected flow:

1. Call `lcm_recent({ period: "yesterday 4-8pm" })`.
2. If the precise sub-day rollup is missing, use bounded leaf-summary fallback for that window.
3. If exact causal chain or command output is needed, call `lcm_expand_query` on candidate sources.

Boundary:

- Convert local time to UTC safely.
- Reject impossible dates and nonexistent local wall-clock times.
- Do not answer from a whole-day rollup as if it proves a sub-day window.

## Scenario 5: Make me a handoff for the next agent

User asks:

> Make me a handoff for the agent taking over this work.

Expected flow:

1. Call `lcm_recent({ period: "today" })` for compact current context.
2. Call `lcm_work_density({ period: "today", detailLevel: 2 })` to find completed/open/ambiguous work.
3. Check GitHub live for PR truth.
4. Read repo artifacts such as this document, the upstream-stack handoff, and the follow-up prompt.
5. Produce a handoff artifact, not only chat prose.

Expected artifact sections:

- Canonical upstream PRs and order.
- What is already done.
- What is still open.
- What must not be changed.
- Patch sequence.
- Validation checklist.
- Local cleanup plan.
- Copy-paste agent prompt.

## Scenario 6: Should we create tasks for these unfinished things?

User asks:

> Should we make tasks from the unfinished items?

Expected flow:

1. Call `lcm_work_density({ period: "7d", statuses: ["observed_unfinished"], includeSources: true, minConfidence: 0.8 })`.
2. In a future opt-in bridge, generate dry-run suggestions only.
3. Present suggestions for user review.
4. Only after explicit user approval, let the real task system create or update tasks.

Boundary:

- LCM suggests.
- User approves.
- Task system writes.
- LCM never silently writes tasks.

## Scenario 7: Missing rollup or cold start

User asks:

> What happened this week?

Expected flow:

1. Call `lcm_recent({ period: "week" })`.
2. If the week rollup is missing:
   - report degraded coverage,
   - optionally use bounded `lcm_grep`/`lcm_expand_query`,
   - optionally suggest an explicit rollup build path.
3. Never build during a read call.

Boundary:

- Reads do not mutate.
- Build is explicit maintenance/admin behavior.

## Scenario 8: Did we already file this upstream?

User asks:

> Did we already file this upstream, or is it only local?

Expected flow:

1. Search upstream GitHub issues/PRs live.
2. Search local/fork PRs live.
3. Use `lcm_grep` or handoff docs for remembered discussion.
4. Use `lcm_work_density` only to identify observed cleanup items, not truth.

Boundary:

- GitHub owns "filed upstream."
- LCM only remembers the plan and evidence.

## Scenario 9: What should I read first?

User or agent asks:

> I'm taking over. What should I read first?

Expected reading order:

1. `docs/audits/HANDOFF-lcm-upstream-pr-stack-2026-04-29.md`
2. `docs/audits/HANDOFF-lcm-scenario-flows-2026-04-29.md`
3. `docs/audits/PROMPT-lcm-followup-agent-516-518-2026-04-29.md`
4. `specs/lcm-temporal-memory-plan.md`
5. `specs/lcm-observed-work-density-option-b.md`
6. `specs/lcm-task-bridge-option-c-experimental.md`
7. Upstream PRs #516, #517, and #518.

## Scenario 10: How does this avoid becoming a second memory/task brain?

Expected answer:

```text
The stack separates three questions:

1. When did something happen?
   - LCM temporal spine: lcm_recent.

2. What does conversation evidence suggest is done/unfinished?
   - Observed work density: lcm_work_density.
   - Advisory only.

3. Should this become an operational task?
   - OpenClaw task system / TaskFlow, optionally assisted by inert suggestions.
   - Requires explicit acceptance.

LCM never becomes the authority for tasks. It provides evidence and summaries.
```

Implementation implication:

- Tool outputs and docs must consistently use "observed," "appears," "evidence," and "confidence," not authoritative task language.

## Resulting PR pressure

PR #516 must provide:

- read-only `lcm_recent`,
- explicit degraded/missing rollup response,
- explicit maintenance/admin rollup build path,
- daily/weekly/monthly real builders,
- provenance and coverage accounting,
- timezone/DST-safe windows.

PR #517 must provide:

- observed-work storage and read tool,
- non-authoritative status vocabulary,
- confidence/rationale/provenance,
- source redaction by default,
- no read mutation,
- no sync to Cortex or tasks.

PR #518 must provide:

- suggestion storage only,
- review states: pending/accepted/rejected/dismissed/expired,
- source IDs and confidence,
- tests proving no OpenClaw task writes,
- no registered write tool by default.

## Final takeaway

The stack works if each layer answers one narrow question:

- **LCM recent:** What happened in this time window?
- **Observed work density:** What does the evidence suggest is done or unfinished?
- **Task bridge suggestions:** Would you like to turn this evidence into an explicit task action?

If any layer silently mutates the next layer, the architecture fails.
