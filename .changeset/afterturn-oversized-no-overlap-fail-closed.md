---
"@martian-engineering/lossless-claw": patch
---

Fail closed when oversized afterTurn dedup batches have no overlap with the stored LCM tail, preventing short stale runtime snapshots from being imported as fresh duplicate rows.
