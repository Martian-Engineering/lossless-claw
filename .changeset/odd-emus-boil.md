---
"@martian-engineering/lossless-claw": patch
---

Fix a session-queue cleanup race that could leak per-session queue entries during
overlapping ingest or compaction operations.
