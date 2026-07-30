---
"@martian-engineering/lossless-claw": patch
---

Fix duplicate ingestion of the same message when the transcript is
redacted by `logging.redactPatterns` and the live `afterTurn` batch is
not. Stable assistant response and unambiguous tool-call identities are
persisted in a new `messages.stable_event_key` column, checked before
ingest side effects, and protected by a partial unique index. Messages
without an unambiguous stable identity retain the existing
content-based and redaction-aware deduplication behavior.
