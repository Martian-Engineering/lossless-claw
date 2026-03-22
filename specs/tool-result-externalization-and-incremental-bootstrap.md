# Tool Result Externalization, Transcript GC, and Incremental Bootstrap

**Status:** In progress  
**Date:** 2026-03-20  
**Scope:** `lossless-claw` plugin with small OpenClaw runtime/API support  
**Priority:** High

## Problem

`lossless-claw` bounds model context growth, but long-lived tool-heavy sessions can still grow their active session JSONL without bound.

Without transcript maintenance:

- large `toolResult` payloads remain inline in the active transcript
- restart/bootstrap cost grows with transcript size
- crashes force the same oversized history to be replayed
- LCM compaction helps the model context, but not the hot transcript on disk

The design here addresses three related concerns:

1. externalize oversized tool output into `large_files`
2. GC old transcript entries once their content is safely condensed
3. make bootstrap proportional to transcript deltas instead of full history size

## Current Implementation Status

### Implemented in `lossless-claw`

#### Phase 1: Incremental bootstrap and ingest-time externalization

These pieces are implemented on `main`:

- `large_files` storage with retrieval-friendly `file_...` references
- ingest-time externalization of oversized tool-result payloads
- compact `[LCM Tool Output: ...]` placeholders in stored message content
- `message_parts.metadata` linkage for `externalizedFileId`, `originalByteSize`, and `toolOutputExternalized`
- `conversation_bootstrap_state` persistence
- unchanged-file bootstrap fast path
- append-only tail-import bootstrap fast path
- streaming fallback bootstrap parsing
- constrained FTS indexing for externalized placeholders

Relevant code:

- [engine.ts](/Users/phaedrus/Projects/lossless-claw/src/engine.ts)
- [large-files.ts](/Users/phaedrus/Projects/lossless-claw/src/large-files.ts)
- [summary-store.ts](/Users/phaedrus/Projects/lossless-claw/src/store/summary-store.ts)
- [conversation-store.ts](/Users/phaedrus/Projects/lossless-claw/src/store/conversation-store.ts)

#### Phase 2: Runtime-assisted transcript GC, first pass

This branch adds the first transcript-GC pass:

- `SummaryStore.listTranscriptGcCandidates()` returns summarized tool-result messages that are:
  - already externalized into `large_files`
  - covered by `summary_messages`
  - no longer present as raw `context_items`
- `LcmContextEngine.maintain()` rebuilds compact replacement `toolResult` messages from stored `message_parts`
- transcript rewrite requests are sent through OpenClaw's runtime-owned `rewriteTranscriptEntries()` hook
- alignment is conservative and only proceeds when a candidate can be matched to a unique active transcript entry by `toolCallId`

This intentionally skips ambiguous cases instead of attempting unsafe transcript surgery.

Relevant code:

- [engine.ts](/Users/phaedrus/Projects/lossless-claw/src/engine.ts)
- [assembler.ts](/Users/phaedrus/Projects/lossless-claw/src/assembler.ts)
- [summary-store.ts](/Users/phaedrus/Projects/lossless-claw/src/store/summary-store.ts)

### Implemented in OpenClaw

OpenClaw now provides the runtime support this design needed:

- `ContextEngine.maintain()`
- `runtimeContext.rewriteTranscriptEntries()`
- safe branch-and-reappend transcript rewrites owned by the runtime
- maintenance call sites after bootstrap, successful turns, and compaction

That runtime support landed upstream via OpenClaw PR `#51191`.

## Design

### Proposal A: Tool-result externalization

Oversized tool outputs should live in `large_files`, not inline in ordinary message storage.

Current behavior:

- tool outputs above the configured threshold are stored out-of-line
- LCM persists a compact tool-output placeholder instead of the raw blob
- retrieval remains possible via `file_...` references

### Proposal B: Transcript GC

Once old tool-result content has been safely condensed, the active transcript should no longer retain the giant inline blob.

The first pass uses this eligibility rule:

1. message is a tool-result row in LCM
2. content was already externalized during ingest
3. message is linked through `summary_messages`
4. message is no longer a raw `context_items` entry
5. the active transcript contains a unique matching tool-result entry for the same `toolCallId`

When all of those are true, `maintain()` asks the runtime to replace the active transcript entry with the compact placeholder-backed `toolResult`.

### Proposal C: Incremental bootstrap

Bootstrap should skip or tail-import when the transcript is unchanged or append-only.

Current behavior:

- unchanged transcript: skip bootstrap work
- append-only transcript: ingest only the tail
- suspicious rewrite/truncation: fall back to full streaming reconciliation

## Why This Matters

This work addresses an operational problem, not just a model-context problem.

Benefits:

- active session transcripts stop accumulating unbounded large tool blobs
- restarts become cheaper over time
- crash recovery avoids repeatedly paying for the same oversized raw history
- recall remains intact through `large_files`

## Remaining Work

The implementation is useful now, but it is not the full end state.

### 1. Handle legacy inline oversized tool results

The current transcript-GC pass only rewrites tool results that were already externalized during ingest.

Still needed:

- nominate old oversized inline tool results that predate externalization
- externalize their raw content during maintenance if needed
- then rewrite those transcript entries

### 2. Improve transcript-entry alignment

The current pass aligns transcript entries by unique `toolCallId`.

That is safe, but conservative. It skips cases where:

- the same `toolCallId` appears ambiguously
- the active transcript shape cannot be matched with confidence

Still needed:

- a more robust mapping strategy, or
- additive persistence of stable transcript entry ids

### 3. Tighten eligibility and fresh-tail protection

Today the effective protection rule is "summarized and not still a raw context item".

Still needed:

- an explicit fresh-tail policy
- optional size/noise thresholds for GC
- bounded batch tuning and observability for maintenance passes

### 4. Add end-to-end runtime integration coverage

Focused unit coverage exists for candidate selection and rewrite request generation.

Still needed:

- integration coverage against the real merged OpenClaw maintenance lifecycle
- verification of bootstrap/turn/compaction-triggered rewrites in realistic session files

### 5. Phase 3 preventive hygiene

The current model is still mostly reactive.

Still needed:

- write-time transcript paths that avoid landing giant inline tool blobs in the first place where possible
- optional normalization of repeated low-value progress spam

## Recommendation

Keep the current first pass narrow and safe, and continue Phase 2 with:

1. legacy inline tool-result cleanup
2. stronger transcript-entry identity/alignment
3. end-to-end integration coverage

That sequence preserves correctness while moving steadily toward bounded transcript growth in real long-lived sessions.
