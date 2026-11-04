# Gap repair evidence (2026-11-04)

## Baseline and reproducibility

Separate branch from upstream `c3745b0e6ee5e23dcce8c55cca5c3f9e8ec51d62`.
No dependency upgrades or new host APIs; no changes from the default-budget PR.
Local runner: Node 24.22.2, Linux, existing lockfile-resolved dependencies.

```
npm ci
npm run typecheck
npm run build
npm test
npm pack
```

## Observed local results

- TypeScript/UI typecheck: PASS.
- All build targets including separate repair executable: PASS.
- Full TypeScript suite: **136 files, 2,157 tests PASS**.
- Repair-specific tests: 16, including a fresh native engine with synthetic
  supported-host transcript fixtures, replay/replay, and post-repair append.
- Cross-process fence exclusion and OS release after SIGKILL: PASS.
- Packaged CLI `plan/apply/apply/undo`, with native stores/assembler on a private
  historical baseline: **30 inserted, repeat idempotent, inverse restored**.
- Historical-copy native assembler: full-fit at explicit 128,000 and 320,000 budgets;
  106,350 estimated tokens, 215 raw items + 38 summaries. No model call.
- Injected seventh-insert failure: atomic rollback. Integrity and foreign keys: PASS.
- Full scoped canonical state hash restored after inverse, including preexisting
  replay keys and exact frontier timestamps. Unrelated-conversation writes are
  preserved by regression tests.
- Packed archive SHA-256: `3f857214294382cd37b2bae5399580bd6286f124158b185a3dcc71d745c0cd66`. This is local artifact evidence,
  not a claim that a GitHub build is byte-identical.

The historical-copy fixture/data is private, intentionally excluded from Git and
CI. Public CI exercises synthetic data only. No raw history, usernames, session
identifiers, credentials or database files are attached.

## Defects discovered and corrected during qualification

1. Existing package-bin assertion required the new executable in its expected map.
2. A source-order test initially expected a later duplicate rejection, but correctly
   hit the earlier source-order gate; corrected the test's evidence packet.
3. Real-data undo found replay-key rows already existed for three missing raw rows.
   Its canonical-state assertion failed, and the inverse transaction rolled back.
   Undo now restores their original bytes/timestamps; a regression covers this and
   sparse/nonzero frontier ordinals. The same historical copy then passed inverse.

## What is not proved

- No live deployment, source revalidation at execution time, production mutation,
  service reload/restart, or live-host drain/admission/current-turn/retained-work/
  final-prompt delivery proof. Synthetic host replay is not that evidence.
- The cooperative fence does not discover uninstrumented old binaries or raw
  SQLite writers. Every owner must participate after verified old-owner shutdown.
- No exact-installed-release backport/package compatibility qualification yet.
- No alias/supersession/hidden-entry recovery or generic post-resumption undo.
- Original gap markers and diagnostics are retained, not silently cleared. Audit
  dispositions remain separate from status/UI integration.
- GitHub CI status is independent of these local passes; check the exact PR head.

This is a draft engineering artifact, not permission to repair production. See
[the operator contract](gap-repair.md) for exact gates and rollback boundaries.
