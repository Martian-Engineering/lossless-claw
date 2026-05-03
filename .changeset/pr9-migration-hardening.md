---
"@martian-engineering/lossless-claw": patch
---

DB transaction hardening — two related fixes:

- Add a `setImmediate`-interleaved regression test for `ConversationStore.withTransaction()` so the per-connection async mutex (already wired through `withDatabaseTransaction`) stays load-bearing under multi-bridge concurrency. Closes #474, the long-standing `cannot start a transaction within a transaction` race report.
- Split the bulk `db.exec()` in `runLcmMigrations` into per-statement calls so a SQL error throws instead of silently aborting mid-block. PR #482 added a belt-and-suspenders guard for `message_parts`; this addresses the root cause for every other table in the bulk exec (still inside the existing `BEGIN EXCLUSIVE` from #455).
