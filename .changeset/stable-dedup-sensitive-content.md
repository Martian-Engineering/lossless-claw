---
"@martian-engineering/lossless-claw": patch
---

Normalize sensitive field names in dedup identity comparisons so that messages that differ only in redaction state (e.g. `token` vs `***` applied by host `beforeMessageWrite` hooks) are correctly deduplicated during `afterTurn` replay detection. Without this normalization, redacted and unredacted copies of the same message produce non-matching identities, causing full re-ingestion and duplicate `toolCallId` entries that break `sanitizeToolUseResultPairing` transcript repair.
