---
"@martian-engineering/lossless-claw": patch
---

Reduce bootstrap reconciliation work without changing transcript-anchor checks: avoid token accounting for identity-only comparisons and skip adoption attempts on rows that already have transcript IDs.
