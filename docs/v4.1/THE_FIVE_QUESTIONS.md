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

The agent recalls recurring entities, procedures, and themes the system has detected automatically. This is the "real person notices patterns" capability.

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

> Note: this section is populated by `agent_3` (scenario-driven feature scoring) — see `/tmp/lossless-claw-upstream/docs/v4.1/FIRST_PRINCIPLES_PLAN.md` for the 25 concrete test queries (5 per type) and the tool × test-case scoring matrix.

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
