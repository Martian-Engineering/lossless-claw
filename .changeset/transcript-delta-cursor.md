---
"@martian-engineering/lossless-claw": minor
---

Ingest the OpenClaw transcript through a persisted per-conversation visible-delta cursor instead of re-reading and reconciling the whole transcript on every `bootstrap` and `afterTurn`. Steady-state turns now read only new transcript entries (about 2–5 ms with no main-thread SQLite work, down from 0.3–28.5 s on large sessions).

- `commitTurn`, `afterTurn`, `ingest` and `ingestBatch` no longer persist runtime message arrays for transcript-backed sessions, so every new row carries its transcript entry id. `commitTurn` records its idempotency receipt in the same transaction as the drained rows.
- When OpenClaw invalidates a cursor, lossless-claw resyncs in bulk and restamps re-issued entries onto their existing rows instead of importing duplicates.
- Existing conversations migrate to cursor mode once, on first use, with the same bulk resync. Migration never deletes rows or clears transcript entry ids, and never imports history before the last stored entry that is still visible.
- A conversation created by `/reset` no longer imports pre-reset history (#1199).
- A host without OpenClaw's visible-delta reader now gets a logged capability error instead of the full-transcript reconcile. Every supported OpenClaw release ships the reader. The legacy reconcile code is now unreachable and will be removed in a follow-up release.
