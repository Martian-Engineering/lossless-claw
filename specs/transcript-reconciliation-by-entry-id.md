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

### Phase 2 — Exact runtime-batch alignment against the covered frontier

- `TranscriptReconcileResult` gains `transcriptCovered: boolean` — true only
  when the reconcile path actually read the transcript to EOF (append-only
  fast path with successful parse, or slow-path full re-read that found
  overlap / imported). The missing-file and unreadable-file fallbacks that
  return `hasOverlap: true` to "allow live afterTurn persistence" set it
  false.
- *(Adjusted during implementation.)* The original plan — skip runtime-array
  persistence entirely when covered — is unsafe: the host can fire
  `afterTurn` before flushing the turn's tail to the transcript, and the
  regression suite encodes that case. Reading the file to EOF proves the DB
  matches the file, not that the file contains the turn.
- Instead, when covered, the runtime batch is reconciled by **exact tail
  alignment** (`alignRuntimeBatchAgainstCoveredFrontier`): because the DB
  tail now provably equals the transcript frontier, either (a) the batch
  aligns fully with the tail — nothing to ingest, (b) a prefix aligns —
  ingest only the flush-lagged remainder, or (c) nothing aligns — ingest all
  if the batch has zero persisted-identity overlap (genuinely unflushed
  turn), otherwise fail closed (stale replay snapshot; the next covered
  transcript read delivers anything real, idempotently).
- Flush-lagged messages persisted from the runtime array carry no entry id;
  when the transcript catches up, the existing identity-overlap guards
  (append-only overlap check + anchor scan) dedupe the catch-up entries.
  This cross-pipeline overlap is why Phase 3's entry-id set-difference
  import must *adopt* identity-matched NULL-entry-id tail rows (stamp the
  entry id onto the matched row) rather than blindly importing every
  missing id.
- `deduplicateAfterTurnBatch` and its oversized/suffix fallbacks remain for
  the not-covered fallback path only.

**Effect:** on the common path the heuristic dedup stack is replaced by one
exact, explainable rule, and every fail-closed outcome is self-healing via
the next turn's idempotent transcript read.

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
- Entry-ID set-difference import: for transcripts where all entries carry
  IDs, `reconcileSessionTail` skips the backward anchor scan and occurrence
  counting entirely (`reconcileSessionTailByEntryIds`) — anchor on the
  checkpoint's `last_processed_entry_id` (or the newest persisted ID), one
  batched existence query for the tail, then import the missing entries in
  order. Missing entries first attempt **adoption**: an identity-matched row
  with a NULL entry id (runtime flush-lag rows, pre-migration data) is
  stamped with the entry id instead of imported, healing legacy rows in
  place. Entry-id anchoring is immune to post-ingest content rewriting
  (tool-result externalization), which defeats content-identity anchors.
- *(Adjusted during implementation.)* Repeated content arriving under fresh
  entry ids is now imported as genuine traffic instead of tripping the
  user-role replay-flood guard — the host's SessionManager declared them new
  entries, and true replays (same ids) are skipped exactly. The import cap
  still bounds id-bearing imports as a sanity limit.

**Effect:** rewritten/rotated transcripts are recognized exactly instead of
inferred; the anchor scan, occurrence counting, and the per-process file-stat
memo cache become legacy-only paths.

### Phase 4 — Pure reconciliation planner

- New `src/reconcile-plan.ts` — no IO, no logging, no store access;
  unit-testable without the engine. *(Adjusted during implementation:
  instead of one monolithic `planTranscriptImport`, the planner is three
  composable pure functions, because the synthetic-heartbeat filter must run
  between candidate selection and the cap check and operates on message
  content the planner does not see.)*
  - `selectEntryIdTail({entryIds, existingEntryIds, lastProcessedEntryId})`
    → `no-id-lineage` | `at-tip` | `tail{anchorIndex, missingIndexes}` —
    the anchor/set-difference core of `reconcileSessionTailByEntryIds`.
  - `resolveEpochRoute({checkpointHeaderId, transcriptHeaderId})` →
    `same-epoch` | `declared-rollover` | `undeclared`.
  - `transcriptImportCap(existingDbCount)` — the single definition of the
    max(20%, 50) sanity bound, replacing three inline copies.
- `reconcileSessionTail` consults the entry-id planner first; only the
  `no-id-lineage` outcome falls through to the existing content-identity
  machinery.
- Transcript reading/parsing fully lives in `src/transcript.ts` (done in
  Phase 1); `engine.ts` shrank accordingly.

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
- [x] Phase 2 — `transcriptCovered` + exact covered-frontier alignment;
  heuristic dedup retained only for uncovered paths
- [x] Phase 3 — session-header epochs, entry-ID checkpoints, set-difference
  import with adoption
- [x] Phase 4 — pure planner functions in `src/reconcile-plan.ts` +
  `src/transcript.ts` extraction
