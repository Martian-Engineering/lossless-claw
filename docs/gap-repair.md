# Historical transcript-gap recovery (draft)

## Normal user workflow: another session, no Gateway shutdown

From an **authorized command sender in a different session**:

1. Run `/lossless doctor gaps 341` (`/lcm` is the alias). The preview discovers exact recoverable spans using the host's existing branch-safe **visible-message delta** API. No transcript export, shell, database path, or operator-supplied evidence packet is needed. It shows recovered message/gap counts, unresolved claims, the host-observed budget, and warns that summary rebuilding can incur model cost.
2. Run the exact `/lossless doctor apply gaps 341 <preview-token>` command displayed by that preview. The token expires after ten minutes and is one-use, bound to the target, sender, invoking session, exact source packet and target state. `confirm-offline` is deliberately not an alias for this confirmation.
3. Receive success or a content-free refusal in the invoking session. Gateway remains running. The target is unlocked in a finally block. No normal-user restart or console step exists.

Same-session invocation is refused by both stable session key and runtime session ID. Missing trusted sender/session identity, host history capability, or an observed explicit target budget fails closed. After plugin reload, a target must complete a normal assembled turn before its allowance is known. The existing minimum host version is unchanged: this uses the already-required visible-transcript and engine lifecycle interfaces, not a new host API; optional behavior is capability-checked, not inferred from a version string.

### Coordination and publication

- A gate shared by engines on the database handle fences the complete LCM lifecycle, including ingestion, assembly, compaction, commit/after-turn, reset/end and native summary doctor repair. Maintenance waits up to 30 seconds for an observed admitted turn and in-flight operations to drain. New target assembly cannot jump the pending writer. A busy target returns a retryable refusal rather than asking the user to pause delivery manually.
- Already-admitted work can finish; new LCM work waits during recovery. Waiting calls time out after five minutes rather than waiting forever. Host transcripts remain host-owned; this plugin does not cancel generation, remove inbound messages or claim ownership of the host delivery queue. If an older turn needs another assembly while maintenance is pending, the bounded maintenance attempt may refuse and let it continue.
- Other sessions on the same runtime handle remain usable while recovery is prepared. Only one online repair runs per database. The connection factory temporarily promotes its lifetime lease to exclusive ownership, refusing extra local handles or participating remote-process owners. This is not a global database shutdown and does not close/recreate retained engines. Raw SQLite tools, old uninstrumented binaries and same-account interference remain outside cooperative fencing, as with the existing doctor surface.
- A dedicated worker creates and verifies a private file-backed backup and performs preparation/integrity scans off Gateway's event loop. Model requests are relayed to the invoking command's normal host-owned summarizer; no credentials or host tools are passed to the worker. Preparation has a five-minute deadline; termination cannot publish a partial repair. The backup is retained under a uniquely created owner-only directory next to the LCM database. A conservative free-space preflight reserves capacity for a full backup and preparation copy plus growth. Backup failure or insufficient storage aborts recovery. The backup is a coherent checkpoint, not a safe post-resumption whole-file rollback: restoring it later could erase other sessions' writes. There is no automatic full-database restore.
- Recovery and any necessary compaction happen on a **disposable preparation copy**, using the normal configured summarizer. Oversized recovered history does not have to fit the active prompt before it can be summarized. The target is idle and its visible source has been reconciled, so the staged compaction may summarize its completed newest user-led turn; original raw messages are retained. Incomplete summaries/fallback markers, non-full-fit assembly, invalid coverage or budget changes refuse publication.
- The visible source is checked again before publication. The live transaction is synchronous: no provider/network calls or async yields while it is open. It compares the target's exact original scoped state, rebases newly allocated integer message IDs around unrelated writes, and publishes only repair-owned additions and the replacement target frontier. Any failure rolls back that transaction.
- Existing raw messages, message parts, summary DAG evidence, original gap markers and transcript cursor history are preserved. Once-only chronological coverage, indexes and foreign keys are checked. Retained asynchronous compaction candidates still undergo their existing source-fingerprint stale checks before publication.
- `conversation_gap_recovery_audit` records an append-only `exact-host-visible-span-recovered` disposition, source/before/after digests, original gap IDs and backup reference. The exact approved plan/source packet is retained as owner-only `plan.json` alongside that backup. Original marker counts are historical claims, not unique current missing-message counts; doctor shows separately how many marker spans have a verified online disposition. Offline developer-tool dispositions remain separate. Hidden history, alias collisions, partial spans and missing anchors remain unresolved.

The scanner is bounded to 256 pages, 100,000 projected entries and 64 MiB, with at most 16 MiB for an individual page. Generation changes, repeated cursors, ambiguous identities/order, mismatched boundary payloads and unavailable projections refuse rather than guessing. These are draft limits, not a claim that every historical gap is recoverable. Provider errors and transcript fragments are never echoed into command replies. Backups/preparation data stay in protected local storage, not Git or CI artifacts.

This command has no online undo: the synchronous publication is atomic, and subsequent target writes make simplistic reversal unsafe. The separate offline tool's scoped undo contract below does not apply to the online recovery audit. No installation, production invocation, live-host acceptance or deployment readiness is claimed by isolated tests.

## Developer-only offline tool


The separate operator-only CLI is **not the normal user workflow or a live repair endpoint**. It introduces no new
OpenClaw host API or minimum host-version requirement. It does not pause rooms,
drain turns, stop a Gateway, or authenticate a public-history export. Do not
install or use it on a running deployment based only on these unit tests.

## Maintenance ownership

All file-backed connections opened by the patched Lossless connection factory
hold a shared lifetime lease in `<canonical database>.maintenance.sqlite`.
The repair CLI requires an exclusive lifetime lease before it opens the database;
apply/undo refuse ordinary or raw SQLite handles. The sidecar uses DELETE journal
mode, so SQLite's OS locks exclude shared/exclusive owners across processes and
are released on process death. There is no force-unlock or expiry override.
Canonical paths share a lease; hard-linked databases are rejected.

**Participation is mandatory:** old plugin generations, raw SQLite tools, other
plugins, file replacement/unlinking, and hostile same-account processes are not
fenced. Existing uninstrumented handles cannot be discovered by this mechanism.
A deployment needs independently verified shutdown/drain of all old owners, then
fresh engine lifetimes using the patched factory. Closing a lease-bearing database
must make retained engines unusable; do not resume an old engine with cached state.
Never remove/replace a sidecar while any owner may exist. OS/filesystem locking
semantics must be qualified on the actual host/storage (not assumed for NFS).

## Evidence and commands

Use a private directory on durable storage with capacity for a verified backup,
working copy, WAL, and validation. All packets contain transcript data. Do not
commit them, send them to CI, or feed untrusted model-generated packets to this CLI.
Inputs must be reviewed operator-authored exports of authorized **public** history.
Hashes detect changes, not authenticity. Independently re-fetch every source and
both boundary identities through supported host APIs immediately before approval.
No direct host session-database reads, hidden-history recovery, text-only identity
matching, or mixing host sequence spaces are supported.

```
lcm-gap-repair plan  /private/isolated.db /private/evidence.json /private/new-plan.json
lcm-gap-repair apply /private/isolated.db /private/new-plan.json /private/new-receipt.json
lcm-gap-repair undo  /private/isolated.db <plan-id> /private/new-undo.json
```

All paths are explicit; the CLI refuses a missing database, never migrates it,
reserves a new owner-only output, and emits no transcript data on stdout/stderr.
A committed apply with a failed receipt write remains recoverable from its audit;
repeat the same plan with a new output path. Do not blindly retry unknown failures.
The separate binary keeps this maintenance surface out of ordinary diagnostic CLI.

Evidence schema:

```json
{
  "conversationId": 42,
  "tokenBudget": 128000,
  "groups": [{
    "gapId": 7,
    "messages": [{"role":"user","content":"example","timestamp":"2026-01-01T00:00:00Z","__openclaw":{"id":"missing"}}],
    "sha256": ["sha256-of-JSON.stringify-exact-returned-message"],
    "sourceOrder": {
      "namespace":"gateway-public-seq",
      "before":{"id":"stored-left","seq":100},
      "entries":[{"id":"missing","seq":101}],
      "after":{"id":"stored-right","seq":102}
    }
  }]
}
```

Sequences above belong **only** to the public export's verified namespace, not LCM
positions. Arrays must be complete ordered spans between the verified anchors;
the CLI verifies monotonicity, identities, endpoints, counts and hashes but cannot
prove that the exporter supplied all eligible intermediate messages. Partial gaps,
alias collisions, absent timestamps, stale generation/state, overlapping boundaries,
incomplete active coverage and invalid summary graphs fail closed. No alias,
supersession, unknown/hidden entry, or accepted-unrecoverable policy is implemented.
The explicit token budget must be the current host allowance or smaller, not an
inferred model capacity. Apply rolls back unless native assembly reports full-fit.
No summarizer/model is called.

## Preservation, disposition, and undo

Apply inserts via native conversion/parts/sender/stable-key/trust/index stores,
records user replay identity, and shifts LCM positions chronologically. It expands
only crossing active summaries into their existing evidence. Original messages,
parts, summaries, DAG links and transcript cursors remain; no old summary is claimed
to cover newly recovered data. Planning binds original scoped state and all sources;
apply revalidates inside its transaction. Other writers are excluded for the entire
connection lifetime, not merely the transaction.

`transcript_gap_repair_audit` is an append-only operator journal: apply preserves
full original markers, state, source hashes and plan plus exact poststate; undo adds
another event. A successful apply is a separate **exact-public-span-recovered**
disposition, not deletion of a marker or proof of complete history. Diagnostic gap
counts deliberately continue to include the original immutable markers; UI/status
integration is not implemented in this experimental branch. An undo negates that
repair disposition without erasing its audit. Never clear markers to suppress warnings.

Exact same-plan replay returns the prior receipt only while poststate still matches.
After undo, make a newly nonced plan. Undo checks all recorded affected-conversation
raw/frontier/parts/summary/trust/replay/cursor state and refuses if it has changed.
It restores preexisting replay records even when their raw rows were absent. It
preserves unrelated-conversation writes and allocator high-water marks. It is **not**
a post-resumption rebase: affected-conversation append/compaction requires fresh
reconciliation. A whole-file backup restore must never erase later writes.

## Qualification boundary

Tests exercise transactional failures, stale generations, identity/hash/order
refusal, summary preservation, replay evidence, explicit-budget rejection, surgical
undo, other-conversation writes, cross-process exclusion and owner crash. These are
not proof of a deployed OpenClaw current-turn/maintenance/retained-work lifecycle.
Before any live pilot: qualify exact installed-release packaging/backport, real
host drain/admission/append/resync/prompt delivery, current evidence, backup capacity,
and rollback, then obtain explicit deployment/live-mutation approval. Never promote
an experimental recovery database. Upstream review or a green CI alone is not that
approval.

Source/package evidence for the redesigned command is recorded in
[Cross-session recovery qualification](gap-chat-recovery-evidence.md).
