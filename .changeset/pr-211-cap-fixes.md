---
"@martian-engineering/lossless-claw": patch
---

Fix compaction cap handling so capped summaries stay within the configured token limit and direct compaction APIs respect `maxAssemblyTokenBudget`.
