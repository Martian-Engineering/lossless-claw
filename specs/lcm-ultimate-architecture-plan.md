---
title: "LCM Ultimate Architecture Plan"
doc_id: "doc-spec-lcm-ultimate-architecture-plan"
doc_type: "spec"
status: "active"
canonical: true
created_at: "2026-04-28T21:35:00Z"
updated_at: "2026-04-29T00:00:00Z"
tags:
  - lossless-claw
  - lcm
  - temporal-memory
  - observed-work
  - task-bridge
---

# LCM Ultimate Architecture Plan

This is the canonical implementation plan for making LCM the temporal memory spine of lossless-claw.

The architecture is three layers:

1. Temporal spine: what happened, when, with bounded evidence and provenance.
2. Observed work density: what conversation evidence suggests is done, blocked, unfinished, or ambiguous.
3. Suggestion-only bridge: reviewed suggestions for task-system actions, never silent automation.

LCM becomes useful by being trustworthy, time-native, and provenance-rich. It must not become a second task system, a fuzzy semantic authority, or a background automation engine.

## Authority Boundaries

LCM owns raw conversation evidence, summaries, temporal rollups, event/window recall, observed-work evidence, provenance, and degraded coverage reporting.

LCM does not own task lifecycle authority, reminders, wakes, Cortex commitments, or automatic task creation/closure.

Cortex may use LCM as evidence. OpenClaw tasks decide and mutate task state. GBrain/docs can synthesize from LCM, but should not contaminate authoritative memory by default.

## Implemented In This Follow-Up

This follow-up implements the pieces that were previously only planned:

- deterministic observed-work extraction from new leaf summaries during maintenance,
- retry-preserving observed-work processing state,
- source-backed observed work rows with conservative observed vocabulary,
- topic/title/rationale filtering for `lcm_work_density`,
- deterministic event observations for primary events, retellings, imports, memory injections, decisions, and operational incidents,
- read-only `lcm_event_search`,
- opt-in inert `lcm_task_suggestions` and `lcm_task_suggestion_review` tools,
- task-bridge source requirements and source redaction by default,
- tests proving no external task table or task write path is used.

## Temporal Spine Contract

`lcm_recent` is a read tool. Reads must not build or rebuild rollups. Missing rollups must return explicit missing or degraded responses. Recaps are not proof for commands, SHAs, paths, timestamps, or causal chains; exact claims require `lcm_describe`, `lcm_expand`, or `lcm_expand_query`.

Rollup writes belong to explicit/admin/maintenance paths. Build outputs must preserve period kind/key, timezone, source coverage, stale status, provenance, and accounting.

## Observed Work Contract

Observed work uses only non-authoritative labels:

- `observed_completed`
- `observed_unfinished`
- `observed_ambiguous`
- `decision_recorded`
- `dismissed`

`lcm_work_density` is read-only. Extraction is deterministic and conservative: it processes new leaf summaries incrementally, requires source evidence, raises confidence only with repeated evidence, and never writes to OpenClaw tasks or Cortex.

## Event Observation Contract

Event observations are cues, not final truth. They separate evidence time from ingest time and label whether a line looks like a primary event, retelling, memory injection, imported history, echo/reference, decision, or operational incident.

`lcm_event_search` is read-only and hides source IDs unless `includeSources=true`. First-occurrence and incident reconstruction claims still require source expansion.

## Task Bridge Contract

The task bridge is an inert suggestion ledger. It may store pending, accepted, rejected, dismissed, or expired review states inside LCM.

It must not:

- create tasks,
- close tasks,
- assign owners,
- write reminders or wakes,
- sync Cortex commitments,
- run by default as an external automation path.

`lcm_task_suggestions` is opt-in via `LCM_TASK_BRIDGE_TOOLS_ENABLED=true` or `taskBridgeToolsEnabled: true`. Preview mode is read-only; record mode writes only pending LCM suggestion rows. `lcm_task_suggestion_review` updates only suggestion review state.

## Scenario Acceptance

The implemented stack supports these flows:

- "What did we get done yesterday?": use `lcm_recent`, then `lcm_work_density`, then expand ambiguous claims.
- "What's blocked right now?": use `lcm_work_density` with unfinished/blocker filters, then expand proof and check external authorities.
- "What happened yesterday 4-8pm?": use sub-day `lcm_recent`; if missing, bounded fallback with explicit coverage.
- "Was this the first time X happened?": use `lcm_event_search({ query, first: true })`, then expand sources before claiming exact first occurrence.
- "Should we create tasks from unfinished things?": use `lcm_work_density`, preview `lcm_task_suggestions`, then require explicit approval in the real task system.

## Remaining Future Work

Future PRs can improve deterministic extraction vocabulary, topic ranking, episode clustering, media/import event modeling, and user-facing task review UX. These remain within the same boundary: evidence first, observed interpretation second, explicit external action last.
