---
"@martian-engineering/lossless-claw": patch
---

Track the actual provider/model used for compaction instead of the configured model. When fallback providers activate, the efficiency tracker now records which model actually produced the summary, making per-model cost breakdowns accurate.
