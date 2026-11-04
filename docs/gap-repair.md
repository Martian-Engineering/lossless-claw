# Historical transcript-gap repair (experimental, offline only)

This operator-only CLI is **not a live repair endpoint**. It introduces no new
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
