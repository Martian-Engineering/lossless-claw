---
"@martian-engineering/lossless-claw": patch
---

Deferred maintenance drains no longer honour a persisted context-threshold override that current config can no longer produce: the persisted value is kept only while a plausibly-matching override rule still carries the same threshold and recorded sizing, and a persisted global threshold that diverges from the configured global is superseded, so stale rows from removed or reverted threshold experiments cannot wedge compaction.
