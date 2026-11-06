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

This is source/package qualification, **not production acceptance**. No installed
plugin, live database, host routing/configuration, service, provider-backed pilot,
Gateway restart or deployment was changed or exercised by this revision. Synthetic
model output validates mechanics, not the factual fidelity of generated summaries.
The tested real-engine lifecycle is a synthetic host fixture, not a live channel.
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
