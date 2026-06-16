---
"@martian-engineering/lossless-claw": patch
---

Unify message redaction timing in afterTurn to fix duplicate message ingestion caused by inconsistent identity_hash across the transcript reconcile and live dedup paths.
