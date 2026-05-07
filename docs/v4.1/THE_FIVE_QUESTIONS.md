# The 5 Questions — LCM's Definition of Done

**Status**: Durable test artifact. Every feature added to LCM must demonstrate it serves at least one question type. Features that don't serve any question type — or that duplicate an existing answer without improving it — get cut.

**Authority**: This document is the gate for what ships in LCM. If you're proposing a new tool, capability, worker, or schema change, you must show which question type(s) it serves and how it scores against existing tools that serve the same type.

---

## The Goal (one line)

**Agent remembers everything forever (lossless), can bring anything back as needed, like a real person with continuity of memory.**

---

## The Five Questions

A real person with continuity of memory can answer 5 types of questions about their past. These are LCM's job:

### A. Time-anchored
> "What did we work on yesterday / last week / in March?"

The agent recalls a specific time window. Not a pre-built rollup; a fresh narrative built from the actual leaves in that window.

### B. Topic-anchored
> "Have we ever discussed X?" / "What work has been done on Y?"

The agent recalls by meaning, across all of time, including paraphrases. "Merge mess" should find "rebase blew up." Not just keyword search.

### C. Verbatim
> "What exactly did Eva say about Z?" / "Quote me the original wording of the decision."

The agent returns original text without LLM paraphrase. Critical for citation, legal review, "show the user what they said," and any case where the literal wording matters.

### D. Pattern-anchored
> "How do I rebuild the gateway?" (procedure) / "What's the history of project X?" (entity) / "What themes have we worked on this month?" (theme)

The agent recalls recurring entities the system has detected automatically. This is the "real person notices patterns" capability.

**Coverage status**: Entity recall ships in v4.1 via `lcm_get_entity` + `lcm_search_entities`. Procedure mining and theme consolidation were CUT from this PR (preserved in deferred-features draft #616 with explicit cost/scope estimates). Until those ship, procedure / theme questions fall back through `lcm_grep --mode hybrid` (good for paraphrastic procedure recall) and `lcm_synthesize_around window_kind="period"` (good for theme-of-the-month queries).

### E. Drilldown
> "Where did this come from?" / "Show me the source of the claim that Y."

The agent traces from a synthesized summary or claim back to the original source. Essential for trust — the agent should be able to cite, not just assert.

---

## Acceptance Criteria for New Features

Before adding any tool, capability, worker, or schema change to LCM, demonstrate:

1. **Which question type(s) it serves** (A, B, C, D, E — pick ≥1).
2. **The concrete agent query it improves over existing tools** — write the query out; explain how the existing tool falls short and how the new feature succeeds.
3. **Why it's a NEW tool, not a CAPABILITY of an existing tool** — if it could be a `mode=` parameter on an existing tool, prefer that. More tools ≠ better agent usage.
4. **Whether it works without operator action** — if the answer is "only useful after operator runs X," the feature is half-shipped. Either ship the auto-tick or cut the feature.

---

## Test Cases (the gating set)

Every PR that touches LCM must show how it affects each test case below. PRs that improve tests pass; PRs that regress them must justify the trade-off.

### Type A — Time-anchored (5/5 PRIMARY: lcm_synthesize_around)

- **A1**: "What did we ship to PR #613 yesterday?"
- **A2**: "What did Eva and I work on last Monday afternoon?"
- **A3**: "Give me a recap of everything from the week of April 26-May 2."
- **A4**: "What was happening around the time the rebase fix landed (commit `1081067476`)?"
- **A5**: "Show me the work we did between the v2026.4.24 cut and the race-fix commit."

### Type B — Topic-anchored (5/5 PRIMARY: lcm_grep --mode hybrid + lcm_semantic_recall)

- **B1**: "Have we ever discussed worker_threads heartbeat isolation?"
- **B2**: "What work has been done on hybrid search rerank?"
- **B3**: "Have we hit a race condition like this empty-plan-body one before?"
- **B4**: "What have we said about Voyage rate limiting?"
- **B5**: "Did we ever debate whether to keep lcm_recent or replace it?"

### Type C — Verbatim (5/5 PRIMARY: lcm_grep --mode verbatim, NEW)

- **C1**: "What exactly did Eva say about why she rejected `lcm_recent`?"
- **C2**: "Quote me the original wording of the decision to throw out rollups."
- **C3**: "Show me Eva's exact words from the operator-VM customer escalation."
- **C4**: "What was the literal error message we got from the backfill autostart pre-flight failure?"
- **C5**: "Quote the original commit message for the empty-plan-body race fix (`1081067476`)."

### Type D — Pattern-anchored (2/5 PRIMARY entity sub-cases; 3/5 fallback)

PRIMARY (entity): `lcm_get_entity` + `lcm_search_entities`
- **D2**: "What's the history of conversations with the operator-VM customer?" (entity)
- **D4**: "Tell me about all the work I've done with Voyage." (entity)

FALLBACK (theme/procedure sub-cases — preserved in draft PR #616 for future cycle):
- **D1**: "What's the standard procedure for rebuilding the gateway?" (procedure → fallback via `lcm_grep --mode hybrid`)
- **D3**: "What themes have dominated this month?" (theme → fallback via `lcm_synthesize_around` window=month)
- **D5**: "What's the standard procedure when a pre-commit hook fails mid-amend?" (procedure → fallback via `lcm_grep --mode hybrid`)

### Type E — Drilldown (5/5 PRIMARY: lcm_describe + lcm_expand_query)

- **E1**: "Where did the +52.5pp recall claim come from? Show me the source."
- **E2**: "This synthesized summary mentions a 'pivot from upstream/main' — show me the original conversation."
- **E3**: "lcm_get_entity('Voyage') showed 47 mentions — drill into the most recent 5 to see context."
- **E4**: "Show me the source leaves for this synthesis."
- **E5**: "The yearly synthesis claims 'Eva approved the disable smarter-claw step' — find the source leaf."

For Type E with main-agent access (no sub-agent delegation needed), use `lcm_describe` with the new `expandChildren=true` or `expandMessages=true` flags (one-hop, capped at 20). For deeper traversal, fall back to `lcm_expand_query` (which delegates to a sub-agent).

### Type F — Discovery / browse (NEW 2026-05-08, addresses reach-for gap)

The original 25 scenarios assumed the user already knows the canonical entity names, specific PRs, exact commits. Real users often DON'T know — they need to browse first to discover what's there. These scenarios exercise the catalog-discovery use case the previous tests missed.

- **F1**: "What kinds of entities have come up in our conversations?" (catalog-type browse — should reach for `lcm_search_entities` with no `entityType` filter, then summarize the type distribution)
- **F2**: "I'm looking for that customer — the one with the VM issues, can't remember the exact name." (fuzzy-name lookup — should reach for `lcm_search_entities { query: 'VM', mode: 'like' }`)
- **F3**: "Give me a vague summary of what I've been working on lately — don't need specifics." (cost-cheap exploration — could reach for `lcm_semantic_recall` with `summaryKinds: ['condensed']` for breadth, OR `lcm_synthesize_around` period='last-7-days')
- **F4**: "What PRs have we discussed?" (entity_type filter — `lcm_search_entities { entityType: 'pr_number' }`)
- **F5**: "Find anything similar to 'lock TTL' in spirit, doesn't have to be precise — I just want to see related discussions." (paraphrastic exploration without keyword precision — `lcm_semantic_recall` niche, OR `lcm_grep mode='semantic'`)

These five fill a gap the original 25 didn't exercise: scenarios where the user genuinely doesn't have the canonical handle and needs to browse/discover first. They specifically test whether `lcm_search_entities` and `lcm_semantic_recall` are reachable when the question shape favors them.

**Note**: F-scenarios are exploratory tests, not yet baked into `scripts/v41-qa-runner.mjs`. Use them in reach-for analysis to validate description-level discoverability.

### Coverage summary

22/25 test cases have PRIMARY tool coverage. The 3 D-pattern theme/procedure sub-cases (D1, D3, D5) have adequate-fallback coverage. Themes consolidation worker + procedure mining worker are preserved in draft PR #616 for a focused future-cycle PR.

**Live-harness verification (2026-05-06)**: 5 parallel Sonnet subagents ran the 25 cases against Eva's snapshot DB. Pre-fix result: 14/25 high confidence + 8/25 degraded UX + 3/25 broken. Post-Wave-1 + Wave-2 fixes: 30/30 cases pass on the QA runner (`scripts/v41-qa-runner.mjs --suite full`), at ~$0.11 cost per run. The QA runner's 30-case suite is a superset (the 25 from this doc + 5 new-feature regression checks for P1–P7 fixes). See `docs/v4.1/HARNESS_REPORT_2026-05-06.md` for the bug-by-bug audit trail.

---

## What this is NOT

- **Not a roadmap.** This document doesn't say what to build next. It says what to test against when you propose anything.
- **Not negotiable per-PR.** A reviewer who wants to add `lcm_factcheck` must justify it against these 5 questions, not "because the spec said so."
- **Not exhaustive.** If the goal evolves (e.g., "agent should also DO things, not just remember"), this document gets revised — but the revision is its own decision, not made implicitly via PR.

---

## Operator scenarios (Eva's actual use)

Concrete situations Eva hits regularly that map to the 5 questions:

| Eva's scenario | Question type |
|---|---|
| Catching up on yesterday's work after a break | A |
| "We hit a race condition like this before — what was the fix?" | B |
| "Quote what I said about why we rejected lcm_recent" (for the PR description) | C |
| "What's the current standard procedure for rebuilding the gateway?" | D (procedure) |
| "What's the history of conversations with the operator-VM customer?" | D (entity) |
| "What themes have dominated this month?" | D (theme) |
| "Where did this synthesis claim come from? Show me the source leaves." | E |

If LCM can't answer these for Eva, LCM has failed at its job. If LCM can answer these for Eva but the agent doesn't know which tool to use, the surface is too complicated.

---

**Last updated**: 2026-05-06 (initial version, v4.1 first-principles pass).
