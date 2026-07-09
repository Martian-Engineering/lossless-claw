# Pending Summary Maintenance Redesign

Status: architecture notes
Date: 2026-07-09
Incident: Phaedrus topic 683 pending-summary maintenance CPU/RSS spike

## Summary

Pending-summary compaction was designed to prepare hidden summary DAG nodes before
publishing a single canonical context swap. That safety property is still right:
Lossless should not replace live context with partially prepared or stale summary
state.

The current execution loop is too expensive for large conversations. Each
`PendingCompactionCoordinator.runOnce()` rebuilds a full projection snapshot,
hydrates message and summary rows, fingerprints the compactable range, prepares
at most one node, and may rebuild again before publish. `executePendingCompactionCore()`
can then call `runOnce()` repeatedly in one maintenance drain. On a large
conversation this turns one background maintenance task into repeated full
projection walks on the gateway main thread.

The immediate bulk-loading fix reduces the worst N+1 database behavior, but the
better design is to make pending compaction an incremental, resumable job over a
stable base projection.

## Observed Failure Mode

The Phaedrus topic 683 conversation had roughly:

- 1,804 current context items
- 5,113 stored messages
- 2.44M raw message tokens
- an active pending batch spanning most of the compactable prefix
- dozens of hidden pending nodes to prepare before final publish

Profiling showed gateway CPU dominated by Lossless projection and SQLite work:
`buildProjectionSnapshot`, message/summary hydration, projection hashing,
timestamp parsing, SQLite calls, and GC. This was not primarily repeated LLM
summarization of the same raw text. It was repeated rediscovery and verification
of the same large projection while advancing one pending node at a time.

Existing summaries were present. They reduce what needs semantic summarization,
and pending compaction may legitimately build higher-level summaries over them.
They do not currently prevent the coordinator from repeatedly walking and
hashing the whole current projection.

## Existing-Solutions Preflight

This problem is inside Lossless's context projection, summary DAG, and OpenClaw
session-queue contract. A generic cache library or external job runner would not
solve the correctness boundary: the system must know exactly which context
projection a hidden DAG was planned against and when it is safe to publish into
canonical summary tables.

Useful existing patterns to borrow:

- database-backed job checkpoints
- incremental materialized views
- optimistic concurrency with base versions/fingerprints
- time-sliced background workers with explicit progress state

The implementation should remain local to Lossless/OpenClaw unless the host
adds a first-class maintenance scheduler contract.

## Design Goals

1. Preserve lossless safety: never publish hidden summaries over the wrong
   source projection.
2. Avoid rebuilding the full historical projection after every prepared node.
3. Keep foreground turns from waiting on long summary maintenance when only
   transcript consistency is required.
4. Bound background maintenance by wall time, node count, or model-call count.
5. Surface useful progress: planned, ready, running, stale, published, backoff.
6. Keep recovery simple after process restart or worker interruption.

## Non-Goals

- Do not remove pending summaries or return to canonical row mutation before a
  batch is ready.
- Do not weaken stale-batch detection enough to publish across gaps, moved
  ranges, or changed source material.
- Do not make LLM summary calls concurrent for the same session unless the
  session queue and spend guards explicitly support it.
- Do not delete legacy conversation data as part of this redesign.

## Proposed Architecture

### 1. Freeze a Base Projection When Planning

When a pending batch is planned, persist enough base projection metadata to make
later preparation independent of full live projection rebuilds:

- `base_context_version` or equivalent monotonic conversation/context revision,
  if available
- `base_fresh_tail_start_ordinal`
- `base_compactable_start_ordinal`
- `base_compactable_end_ordinal`
- `base_projection_fingerprint`
- per-source ordinal fingerprints already used by planned nodes
- optional compact projection item metadata needed by the planner

The planned pending nodes already carry source fingerprints. The missing piece
is treating the batch's base projection as the preparation source of truth until
publish, rather than asking every `runOnce()` to reconstruct that truth from
scratch.

If Lossless does not have a context revision today, add one near the
`context_items` mutation boundary. It should change when canonical context
membership/order changes, not when hidden pending nodes become ready.

### 2. Prepare Nodes Against the Frozen Batch

Preparation should not require a full current projection snapshot. A worker can:

1. claim the next planned node
2. load only that node's source messages, canonical summaries, or ready pending
   child summaries
3. verify the node's stored source fingerprints against the loaded sources
4. summarize the node
5. mark the node ready

This makes the steady-state unit of work proportional to one node's source
range, not the entire conversation.

For condensed nodes over existing summaries, load the referenced summaries.
For condensed nodes over ready pending children, load those pending nodes. For
leaf nodes, load the source message ids recorded by the planner.

### 3. Revalidate Cheaply Before Publish

Publish is the correctness boundary and still needs live validation. It should
not require a full historical rewalk if the base can be validated cheaply.

Preferred publish check:

1. read the current context revision and compactable frontier
2. if the revision still matches the batch base, publish directly
3. if only tail growth occurred beyond the compactable range, allow extension or
   publish the ready base range
4. if the compactable source range moved, shrank, developed gaps, or any source
   fingerprint changed, mark the batch stale

If no revision exists or the revision is too coarse, fall back to a bounded
range revalidation:

- load context items only for `base_compactable_start_ordinal` through
  `base_compactable_end_ordinal`
- compare ordinals and per-item fingerprints to the batch base
- ignore tail growth outside the base range unless it changes the fresh-tail
  boundary in a way that overlaps the batch

### 4. Separate Foreground Consistency From Long Maintenance

OpenClaw currently has reasons to wait for deferred turn maintenance before the
next same-session turn reads state. That should apply to transcript rewrite and
session-consistency work, not to unbounded summary DAG preparation.

Split maintenance into two classes:

- foreground barrier work: short, must complete before the next turn can safely
  read session state
- background resumable work: pending-summary preparation and other long
  compaction drains

Foreground turns may trigger, observe, or enqueue background compaction, but
should not sit in `reply_operation:queued` while a large pending batch prepares
many hidden nodes.

### 5. Time-Slice Background Drains

`executePendingCompactionCore()` should stop after a small bounded amount of
work and leave durable progress for the next drain. Boundaries can include:

- max prepared nodes
- max LLM summary calls
- max wall-clock milliseconds
- event-loop yield checks
- summary spend guard state

When work remains, return a result that keeps maintenance pending and reschedules
later instead of holding the same active task through a long serial drain.

### 6. Cache Within A Drain, But Do Not Rely On Cache For Correctness

Bulk loading and in-memory maps are useful, especially while the old snapshot
path still exists. A drain-local projection cache can avoid repeated hydration
when multiple checks really do need the same base data.

That cache should be an optimization only. Correctness should come from the
persisted batch base, node source fingerprints, context revision/range
revalidation, and publish transaction.

## Migration Path

1. Keep the current low-risk bulk-loading patch for `buildProjectionSnapshot()`.
2. Add progress/status improvements so operators can see pending/ready/running
   counts and the current compactable range.
3. Add a persisted context revision or equivalent canonical projection version.
4. Persist pending-batch base projection metadata at planning time.
5. Change preparation to load by planned node sources instead of rebuilding the
   whole projection first.
6. Change publish validation to revision/range validation.
7. Split foreground barrier maintenance from background pending-summary drains.
8. Tighten time slicing and reschedule behavior.
9. Remove or narrow the old full-snapshot fallback once tests and migrations
   cover legacy batches.

## Test Plan

Add or update tests for:

- planning records a stable base projection fingerprint/range/revision
- preparing one node does not call full projection snapshot builders
- leaf preparation loads only source message ids for that node
- condensed preparation loads existing summaries or ready pending children only
- publish succeeds when the base revision still matches
- publish succeeds when only tail growth occurs outside the base range
- publish marks stale when source ordinals move, shrink, gap, or fingerprint
  differently inside the base range
- background drains stop after configured node/model-call/wall-time budget
- same-session foreground turns do not wait for long pending-summary preparation
- legacy pending batches without base metadata still use the safe old fallback

## Open Questions

- What is the right canonical context revision source: a column on
  conversations, a row in a metadata table, or a derived max update stamp from
  `context_items`?
- Should tail growth extend the active batch automatically, or should ready base
  ranges publish first and leave suffix planning for a later batch?
- How small should the default background time slice be on gateway hosts?
- Should OpenClaw expose a separate maintenance class for "barrier" versus
  "resumable" plugin work, or should Lossless enforce that distinction itself?
