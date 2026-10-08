---
"@martian-engineering/lossless-claw": minor
---

Ingest the OpenClaw transcript through a persisted per-conversation visible-delta cursor instead of re-reading and reconciling the whole transcript on every `bootstrap` and `afterTurn`. Steady-state turns now read only new transcript entries. `commitTurn`, `afterTurn`, `ingest` and `ingestBatch` no longer persist runtime message arrays for transcript-backed sessions, so every stored row carries its transcript entry id. Host cursor resets resync in bulk, rewritten entries are restamped instead of duplicated, a `/reset` conversation no longer imports pre-reset history, and existing conversations migrate to cursor mode once on first use.
