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
  place. Entry-id anchoring also survives post-ingest content rewriting
  (tool-result externalization) — *but not the way the original draft of
  this spec claimed*: the host implements content rewriting as copy-on-write
  re-append under **new** entry ids (see Phase 5), so the surviving anchor
  is the unchanged prefix, and the rewritten suffix heals via stale-id
  adoption rather than id equality.
- *(Adjusted during implementation.)* Repeated content arriving under fresh
  entry ids is imported as genuine traffic instead of tripping the
  user-role replay-flood guard — the host's SessionManager declared them new
  entries, and true replays (same ids) are skipped exactly. The import cap
  still bounds id-bearing imports as a sanity limit. *(Refined in Phase 5:
  when the identity-matched original's entry id has left the leaf path, the
  fresh id is a host re-issue for the same message and is adopted, not
  imported; only repeats whose originals are still live import as new.)*

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

### Phase 5 — Leaf-path reconciliation and stale-id adoption

Added after auditing the *actual* host source (see the corrected addendum
below): entry ids identify tree **nodes**, not logical messages. The host
implements every history edit — the `rewriteTranscriptEntries` hook this
plugin's transcript GC calls, the host's own oversized-tool-result
truncation, and gateway chat edits — as copy-on-write: it branches at the
first replaced entry's parent and re-appends the whole active suffix as new
entries with freshly generated ids. The replaced entries stay in the file
as an abandoned branch, and the internal old→new id map is not returned to
the caller. Without countermeasures, the re-issued ids read as "genuine new
traffic" and the suffix re-imports as content duplicates — with the flood
guard intentionally disabled for id-bearing imports.

- **Leaf-path reading.** `readLeafPathMessages` now walks the `parentId`
  chain from the file's last entry (the host's leaf) when every line
  carries an envelope id, so abandoned branches are invisible to
  reconciliation. A mid-file `parentId: null` reached from the leaf is a
  genuine root (host `resetLeaf`). Id-less cohorts, dangling parents,
  cycles, and JSON-array files keep the legacy flatten behavior.
- **Stale-id adoption.** A missing leaf-path entry that fails NULL-id
  adoption next looks for an identity-matched row whose stored entry id has
  left the leaf path — a row stranded by a host rewrite — and re-stamps it
  with the re-issued id instead of importing a duplicate
  (`adoptStaleTranscriptEntryId`). Runs in both the entry-id reconcile loop
  and the no-anchor new-epoch import (declared rollovers, path-mismatch
  rotations, compaction successors).
- **No-anchor replay block scoped to id-less traffic.** A fully id-bearing
  no-anchor batch resolves identity overlaps exactly via adoption, so the
  content replay-overlap block (which would freeze a rewritten epoch with
  ≥ 3 identical kept messages) applies only to id-less batches. Adoption
  reports `hasOverlap` so the checkpoint refreshes instead of re-entering
  the slow path every turn.
- **Known gap (accepted).** An entry whose *content* was replaced (the
  externalized stub itself) matches no identity and imports as a new row —
  one row per actually-replaced entry, bounded by the import cap. Closing
  it exactly requires the host to return its old→new id map from
  `rewriteTranscriptEntries` (it already builds one); deferred by decision.

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
- [x] Phase 5 — leaf-path reading + stale-id adoption for host
  copy-on-write rewrites

## Addendum: what the host source settles (post-implementation)

The four phases above are deliberately additive — a strangler-fig pattern
that routes id-bearing traffic onto exact paths while keeping every legacy
path bit-for-bit intact (`src/` ended at +992/−286). The open question was
how much of the legacy machinery is genuinely required by the host versus
retained out of caution.

> **Correction (2026-06-10).** The first draft of this addendum audited
> `SessionManager` from `@earendil-works/pi-coding-agent`. OpenClaw no
> longer uses that package — the transcript writer is the in-tree embedded
> harness (`openclaw/src/agents/sessions/session-manager.ts` and
> `src/agents/embedded-agent-runner/`), forked from pi and format-identical
> (v3, same entry types) *today*, but evolving independently. A sweep of
> 920 live session files confirmed: all v3, every message line id-bearing,
> zero JSON-array files. The behavioral claims below were re-verified
> against the embedded source; the one the original audit got wrong —
> id stability under content rewrites — is what Phase 5 fixes. The plugin's
> last two runtime uses of the pi `SessionManager` (rotate, GC entry-id
> mapping) were replaced with the plugin's own read-only parser
> (`readLeafPathRawEntries`), and `@earendil-works/*` moved to
> devDependencies — pi's `SessionManager.open` migrates and rewrites v1/v2
> or empty files as a side effect, and the pi package no longer tracks the
> host's in-tree format. Tests still write fixtures through it while the
> formats remain identical.

### Confirmed: entry ids are unconditional in the current format

`appendMessage` always writes `{type:"message", id, parentId, timestamp,
message}` with a generated id (8-hex with full-UUID fallback in the
embedded `SessionManager`; other host writer paths use full UUIDs — ids
are opaque strings either way), and the session header always carries an
id (v3 format). No code path writes an id-less message line. For any
transcript the current host writes, the entry-id path covers 100% of
traffic.

### Corrected: entry ids are node ids, not message ids

The original audit concluded entry ids were stable identities. They are —
for *appends*. Every history edit is copy-on-write: the host re-appends
the active suffix under new ids (`transcript-rewrite.ts`), used by this
plugin's own transcript GC, by the host's oversized-tool-result
truncation, and by gateway chat edits. `v1→v2` migration likewise
regenerates every id. Compaction-successor rotation, corruption recovery,
and `v2→v3` migration preserve entry ids (corruption recovery and
rotation re-issue the *header* id only). Phase 5 exists because of this
distinction.

### Confirmed: two "legacy" paths are load-bearing host behavior

1. **Deferred flush is by design.** `SessionManager._persist` buffers every
   entry in memory until the first *assistant* message exists, then writes
   the whole file at once. Every new session therefore passes through a
   window where the transcript file does not exist on disk. The
   missing-file → runtime-array persistence fallback (and Phase 2's
   covered-frontier alignment) is **permanent architecture**, not a
   transitional compatibility shim. This also retroactively explains the
   flush-lag regression fixture that forced the Phase 2 adjustment, and is
   a plausible contributor to several historical dual-source bugs.
2. **Same-path rewrites are real host events.** `setSessionFile` rewrites
   the file in place on version migration, recreates corrupted/empty files
   with a *new* header id, and `_rewriteFile` serves branch/compaction
   operations. Phase 3's header-id rollover detection maps to actual host
   behavior; the rewrite/shrink handling cannot be deleted, only kept in
   its declared form.

### Confirmed: the id-less cohort is real but aging

v1 session files had no entry ids; `migrateV1ToV2` adds them when the host
next loads the file (and `_rewriteFile`s it). LCM can read not-yet-migrated
v1 files directly (startup scans, resumed archives), so the content-anchor
machinery is needed for exactly that cohort until it ages out. The
JSON-array transcript format, by contrast, is written by nothing in the
current host — its origin predates this repo's squashed import history —
and is a deletion candidate pending a maintainer decision.

### Discovery: sessions are trees, not logs

Entries carry `parentId`; `branch()` / `resetLeaf()` create alternate paths
within the same append-only file. `readLeafPathMessages` historically
flattened *all* branches in file order, so LCM imported messages from
abandoned branches — a plausible source of "duplicate-ish content"
incidents independent of replay, and the amplifier that turned host
copy-on-write rewrites into duplicate imports. Phase 5 made the function
live up to its name: it follows the actual leaf path whenever the file has
full id coverage.

### Revised deletion picture

| Component | Verdict from host source |
|---|---|
| Runtime-array fallback + covered alignment | Keep permanently — deferred flush guarantees file-less turns |
| Header-id rollover, entry-id checkpoints | Keep — maps to real `_rewriteFile`/migration events |
| Content anchor scan + occurrence counting | Keep until v1 files age out, then delete |
| JSON-array parsing | Deletable — nothing writes it today (needs maintainer decision) |
| Timestamp-flood guards | Demote — only protect file-less-window runtime ingests now |
| `deduplicateAfterTurnBatch` oversized/suffix heuristics | Likely collapsible into the alignment helper; scoped to the file-less window |
| No-anchor replay-overlap block + prefix drop | Id-less traffic only as of Phase 5 — id-bearing batches resolve overlaps exactly via adoption |
| Flatten-in-file-order transcript reading | Fallback only as of Phase 5 — leaf-path walk covers all full-id-coverage files |

Net: the "require entry ids and delete the legacy stack" option is smaller
than the pre-audit estimate, because the host's deferred-flush design makes
the dual-source problem permanent. The code that remains, remains because
the host architecture demands it — not because behavior preservation was
assumed.
