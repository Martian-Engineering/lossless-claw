---
"@martian-engineering/lossless-claw": patch
---

Persist the resolved compaction summarization model on summary records instead of
always showing `unknown`.

Existing `summaries` rows keep the `unknown` fallback through an additive
migration, while newly created summaries now record the actual model configured
for compaction.
