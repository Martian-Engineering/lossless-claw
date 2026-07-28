---
"@martian-engineering/lossless-claw": patch
---

Fix duplicate ingestion of the same message when the transcript is
redacted by `logging.redactPatterns` and the live `afterTurn` batch is
not. A new `messages.stable_event_key` column + partial unique index
plus an event-key short-circuit in `ingestSingle` (and a final-pass
filter in `BatchDeduplicator`) prevent the two representations from
being stored as separate rows.
