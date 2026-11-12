# Cross-session recovery qualification

This replaces the offline CLI as the proposed **normal user workflow**. The CLI
remains a separate developer tool with its own ownership/undo contract.

## Exercised on disposable synthetic fixtures only

- Native command preview and exact-token apply from a separate session; success,
  retained verified backup, immutable markers and append-only online disposition.
- Same key, same runtime ID, unauthorized/unidentifiable sender, missing capability
  or host budget, malformed input and `confirm-offline` substitution refuse.
- One-use expiring previews bound to sender, invoking session, target, ordered
  exact source hashes and scoped database state; altered/absent anchors and
  changed payloads, generation resets and final source changes refuse.
- Gate waits for an admitted turn; new assembly cannot jump the pending writer;
  other sessions run; timeout/failure releases admission. A real engine fixture
  drains its lifecycle then assembles the recovered message after unlocking.
- Native smaller runtime-settings budgets win over larger direct/configured
  allowances. Allowance changes refuse rather than widening the approved plan.
- Participating lifetime-owner exclusion while online recovery runs; extra local
  handles refuse. Existing tests cover OS-release and cross-process exclusion.
- The dedicated built worker performs backup/integrity/staging; model requests
  return through the parent capability. A deliberately oversized missing span
  invokes a synthetic summarizer while live message/summary counts stay unchanged,
  then publishes a full-fit frontier with the raw missing content retained.
- Synchronous publication rebases repair-owned IDs around unrelated writes and
  preserves unrelated rows. Original evidence modification and publication errors
  roll back. Provider/error text is not echoed to command replies.
- Existing offline repair, replay/idempotency, scoped inverse, cursor, DAG,
  native command, migration-order and database-connection regressions remain in
  the full suite. The release worker is included by the normal build/package
  surface and the Node 22/24 repair CI jobs verify its packaging.

## Limits

The original November 4 evidence above used synthetic host fixtures and synthetic
model output only. The November 12 checks below extend it to an isolated actual
Gateway, **not production acceptance**. No production installed plugin, database,
host routing/configuration, service, Gateway restart or deployment was changed.
Synthetic model output validates mechanics, not the factual fidelity of generated
summaries or acceptance on a production messaging channel.
CI status must be reported from the exact pushed commit, not assumed from local
results or a previous PR head. The PR remains draft.

The system coordinates participating patched owners only; it cannot exclude raw
SQLite tools or old uninstrumented binaries. Online recovery is not available
with multiple participating database handles/process owners. Host delivery and
provider cancellation remain host-owned. Preparation can refuse for busy/stale
state, scan/storage limits, insufficient allowance or summary failure. A retained
checkpoint must never be restored over later unrelated writes. There is no online
undo or automatic live repair. See [the workflow](gap-repair.md) for the complete
user and safety contract.

## November 12: cancellation settlement correction (local working tree)

An isolated actual OpenClaw 2026.10.10 / Node 24.22.2 Gateway exposed a missing
terminal path: caller cancellation could bypass commit/after-turn, leaving the
shared gate's admitted-turn flag set until the repair's 30-second busy timeout.
No recovery was published by that failed check.

The correction assigns an opaque admission owner to each host-created engine
wrapper. Wrapper disposal settles only that owner's admissions. In-flight
operations still drain; repeated or stale finalizers cannot clear a successor
or another conversation. Work queued by a disposed wrapper refuses admission.
The shared singleton database remains open.

Local qualification of the correction, based on PR head `4c10658`:

- Typecheck, complete build and package creation passed.
- Full TypeScript suite: **2,182 tests / 137 files passed**.
- Focused scope, registration, repair and plugin-generation suites: **93 tests /
  4 files passed**. They cover terminal cleanup, delayed end callbacks, stale
  disposal, unrelated owners, in-flight operations and disposed queued work.
- Published Lossless 1.2.0 + the separately qualified default-budget patch + this
  gap-repair branch, with the same correction: typecheck/build and **209 tests /
  7 files passed**. This is local backport evidence, not upstream CI.
- The packaged candidate on an isolated actual Gateway passed caller cancellation
  while another conversation's doctor apply waited. An unrelated chat completed
  during the wait; the repair settled about **1.3 seconds** after abort rather
  than timing out busy. The recovered raw payload appeared exactly once, the gap
  marker remained and the target accepted a subsequent normal turn.
- A distinct terminal provider-400 path also passed: after the host ended the
  failed run, doctor preview/apply recovered the known gap, and a subsequent
  normal target turn completed. Both cases passed integrity and foreign-key
  checks and delivered the invoking command's final result.

Actual-host fixtures contained invented known text and used a controlled local
provider. A separate earlier real-model summary pilot does not establish the
invoking command's host-owned LLM capability scope for this working-tree change.
Retained-work/reload and real-command summarizer-scope qualification remain
separate requirements before any production repair. No new GitHub CI or deployment
claim is made by these local results.
