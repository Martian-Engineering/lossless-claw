# Transcript Reconciliation by Entry ID

**Status:** In progress
**Date:** 2026-06-10
**Scope:** `lossless-claw` plugin (no OpenClaw runtime changes required)
**Priority:** High

## Problem

Transcript reconciliation — the logic that keeps the LCM SQLite store in sync
with the OpenClaw session JSONL file — is the source of most recent
regressions (#591, #640, #649, #659, #685, #706, #835, #837, #840, #846, the
replay-flood guards, role-aware thresholds, ambiguous-rollover handling). Of
the last 30 commits touching `engine.ts`, at least 12 are reconciliation
fixes, and several of those patch problems created by earlier fixes (#837
fixes a freeze introduced by #649's fail-closed guard, which itself patched a
hole left by #591's flood guard).

The complexity is not accidental sprawl; it is forced by two foundational
decisions:

### 1. Lossy message identity

Reconciliation identifies messages by content: `role + "\0" + content`
(`messageIdentity`), with a non-unique `identity_hash` index, and the
checkpoint anchor (`createBootstrapEntryHash`) is likewise a SHA-256 of
`{role, content}`. Content identity cannot distinguish "this transcript line
was replayed" from "a new message that happens to be identical" — which is
common traffic (empty tool results, heartbeat acks, repeated outputs within
the same second, since `datetime('now')` has 1-second granularity).

Meanwhile, every transcript JSONL entry carries a stable envelope:

```json
{ "type": "message", "id": "…", "parentId": "…", "timestamp": "…", "message": { "role": "…", "content": […] } }
```

`extractCanonicalBootstrapMessage` strips that envelope at parse time and
keeps only `entry.message`. The exact information the guard stack tries to
reconstruct heuristically is discarded before reconciliation begins.

Because identity is ambiguous and writes are not idempotent (no uniqueness
constraint on messages), every code path must *prove* non-duplication before
inserting. Failure in one direction is silent duplication (replay floods);
failure in the other is a frozen conversation that never compacts. The result
is a stack of at least eight independent, incident-calibrated thresholds:

| Guard | Threshold |
|---|---|
| Replay-overlap block (no-anchor import) | ≥ max(3, 50% of batch) |
| No-anchor import cap | max(20% of DB, 50) messages |
| Timestamp-flood, user role | 3 per (conversation, second) |
| Timestamp-flood, internal roles | 32 per (conversation, identity, second) |
| Bootstrap replay prefix minimum | 3 messages |
| Tail-anchor continuity proof | 3-message contiguous suffix match |
| Delivery-only transcript detection | ≤ 4 messages matching `delivery-mirror\|config-audit` |
| Heartbeat detection | literal `"heartbeat_ok"` / `"heartbeat.md"` markers |

None of these are derived from anything; each is a calibration against a past
incident, so each new traffic shape becomes a new regression.

Notably, the codebase already half-trusts stable IDs:
`filterPersistedRawIdReplayBatch` and `countActiveCrossConversationRawIdMatches`
extract raw event IDs from `message_parts.metadata` and make drop decisions on
exact ID matches. They are used as yet another heuristic layer rather than as
the primary identity.

### 2. Two competing ingestion sources

Both the transcript file (via `reconcileTranscriptTailForAfterTurn`) and the
runtime `afterTurn` messages array (via `deduplicateAfterTurnBatch` →
`ingestBatch`) persist messages, and each carries its own dedup stack that
must reason about the other's output. The code itself states the transcript
is authoritative by `afterTurn` time ("The transcript has the complete turn by
this point"). The runtime-array pipeline exists for the cases where the
transcript is missing or unreadable, but it runs unconditionally, so the
aligned-tail/oversized/suffix-fallback heuristics in
`deduplicateAfterTurnBatch` are load-bearing on every turn.

### 3. Epochs are inferred, not declared

Path-mismatch, same-path-shrink, no-anchor, and ambiguous-rollover detection
are heuristic proxies for "the transcript was rewritten, rotated, or forked."
The transcript's session header line (`{"type":"session","id":…,
"parentSession":…}`) declares this directly and is currently only consulted
for `parentSession`.

### 4. Mechanism, policy, and logging are interleaved

`reconcileSessionTail` computes the transcript/DB diff *and* applies caps,
blocks, and filters *and* logs, across ~10 return sites that must each set
`hasOverlap` / `blockedByImportCap` / `blockedReason` correctly; the caller
re-derives "unsafe to advance" from flag combinations. The decision logic
cannot be tested without the full engine harness.

## Design

Promote the transcript entry ID from "heuristic #9" to the primary message
identity, make storage idempotent on it, and let the guard stack demote from
correctness-critical to telemetry. Work proceeds in four phases, each landing
independently with tests green.

### Phase 1 — Idempotent writes keyed on transcript entry ID

- Parsing keeps the JSONL envelope. A new `src/transcript.ts` module owns
  transcript reading/parsing (moved out of `engine.ts`) and attaches envelope
  metadata (`id`, `parentId`, `timestamp`) to each parsed message via a
  symbol-keyed property (survives object spread; invisible to
  `JSON.stringify`). Helpers: `attachTranscriptEntryMeta`,
  `getTranscriptEntryMeta`, `getTranscriptEntryId`.
- Schema: `messages.transcript_entry_id TEXT` (additive `ALTER`, idempotent)
  plus a **partial unique index**
  `messages_conv_entry_unique_idx ON messages(conversation_id,
  transcript_entry_id) WHERE transcript_entry_id IS NOT NULL`. Legacy rows
  stay NULL and are unaffected.
- `ingestSingle` extracts the entry ID from the message's transcript metadata.
  If a row with the same `(conversation_id, transcript_entry_id)` exists, the
  ingest is skipped *before* any side effects (parts, context items, FTS,
  large-file interception). The unique index backstops races.
- Behavior of all existing guards is unchanged in this phase; the entry-ID
  check simply runs first. Messages without entry IDs (runtime-array ingest,
  array-mode session files, host formats without envelopes) behave exactly as
  before.

**Effect:** replaying a transcript region becomes a no-op by construction for
any host that writes entry IDs. Flood guards stop being the only line of
defense.

### Phase 2 — Transcript as the single persistence source in `afterTurn`

- `TranscriptReconcileResult` gains `transcriptCovered: boolean` — true only
  when the reconcile path actually read the transcript to EOF (append-only
  fast path with successful parse, or slow-path full re-read that found
  overlap / imported). The missing-file and unreadable-file fallbacks that
  return `hasOverlap: true` to "allow live afterTurn persistence" set it
  false.
- In `afterTurn`: when `transcriptCovered` is true, the runtime messages
  array is **not** persisted (the transcript reconcile already imported the
  turn; if the host flushed the transcript late, the next turn's append-only
  read imports the remainder idempotently). When false, the existing
  runtime-array path runs unchanged.
- `deduplicateAfterTurnBatch` and its oversized/suffix fallbacks remain for
  the not-covered fallback path only, and are no longer load-bearing on the
  common path.

**Effect:** on the common path there is exactly one writer. The
dual-pipeline dedup heuristics stop running every turn.

### Phase 3 — Declared epochs and exact checkpoints

- `src/transcript.ts` parses the session header line and exposes
  `readTranscriptHeader(sessionFile)` → `{ sessionHeaderId, parentSession }`.
- `conversation_bootstrap_state` gains `session_header_id TEXT` and
  `last_processed_entry_id TEXT` (additive ALTERs).
- `refreshBootstrapState` records the header ID and the entry ID of the last
  processed entry alongside the existing size/mtime/offset/content-hash.
- Reconcile decision order becomes:
  1. Header ID present on both sides and **equal** → same epoch. Append-only
     by offset is valid when the file grew; the entry-ID at the checkpoint
     boundary is the exact anchor (content-hash anchor retained as legacy
     fallback).
  2. Header IDs **differ** → declared epoch change (rewrite/rotation), no
     heuristics: full re-read, import by entry-ID set difference
     (idempotent via Phase 1), refresh checkpoint. Import caps remain as
     sanity bounds only.
  3. Header ID absent (legacy/array-mode transcripts) → existing heuristic
     reason taxonomy unchanged.
- Entry-ID set-difference import: for transcripts where (nearly) all entries
  carry IDs, `reconcileSessionTail` skips the backward anchor scan and
  occurrence counting entirely — one batched query for which IDs already
  exist, then import the missing ones in order.

**Effect:** rewritten/rotated transcripts are recognized exactly instead of
inferred; the anchor scan, occurrence counting, and the per-process file-stat
memo cache become legacy-only paths.

### Phase 4 — Pure reconciliation planner

- New `src/reconcile-plan.ts` exposes a pure function:

  ```ts
  planTranscriptImport(params: {
    entries: TranscriptEntry[];
    existingEntryIds: ReadonlySet<string>;
    checkpoint: { sessionHeaderId: string | null; lastProcessedEntryId: string | null } | null;
    transcriptHeaderId: string | null;
  }): {
    decision: "append" | "epoch-rollover" | "legacy-heuristics" | "noop";
    toImport: TranscriptEntry[];
    reason: string;
  }
  ```

  No IO, no logging, no store access — unit-testable without the engine.
- `reconcileSessionTail` consults the planner first; only the
  `legacy-heuristics` decision falls through to the existing content-identity
  machinery.
- Transcript reading/parsing fully lives in `src/transcript.ts`;
  `engine.ts` shrinks accordingly.

## What stays

- Bootstrap token budget and fork bounding (`trimBootstrapMessagesToBudget`,
  `fork_bounded`).
- Rotate-coverage ordering (reconcile before rotate compaction).
- Heartbeat filtering — but as *storage policy* ("do we want these rows?")
  rather than a correctness guard.
- The timestamp-flood guard and import caps — demoted to sanity
  bounds/telemetry for entry-ID traffic, still primary for ID-less traffic.

## Risks and mitigations

- **ID-less transcripts.** Array-mode session files and bare
  `{role, content}` JSONL lines have no envelope. Every phase treats entry
  IDs as optional; the content-identity path remains as the explicit
  fallback.
- **Legacy rows.** Existing DB rows have `transcript_entry_id = NULL`. No
  backfill is attempted; the partial unique index only protects new writes,
  which is sufficient — duplicates of legacy rows are still caught by the
  (unchanged) content-identity guards until those regions age out via
  compaction/rotation.
- **Transcript flush lag (Phase 2).** If a host fires `afterTurn` before
  flushing the final assistant message, that message is imported on the next
  turn's append-only read instead. Ordering by `seq` is preserved;
  compaction-threshold evaluation may lag one turn. If a host is found that
  never flushes, `transcriptCovered` is false there and the runtime path
  still applies.
- **Duplicate entry IDs within one file.** The unique index makes the second
  occurrence a skip; this matches the semantics of a replayed line.

## Phase status

- [x] Phase 1 — envelope-preserving parser, `transcript_entry_id` column +
  partial unique index, entry-ID idempotent ingest
- [ ] Phase 2 — `transcriptCovered` gating; runtime array persists only as
  fallback
- [ ] Phase 3 — session-header epochs, entry-ID checkpoints, set-difference
  import
- [ ] Phase 4 — pure `planTranscriptImport` planner + `src/transcript.ts`
  extraction
