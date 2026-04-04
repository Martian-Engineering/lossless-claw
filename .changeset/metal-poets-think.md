---
"@martian-engineering/lossless-claw": patch
---

Fix forced timeout-recovery compaction so live budget overflows use the capped `compactUntilUnder()` path instead of no-oping through a stored-context full sweep.
