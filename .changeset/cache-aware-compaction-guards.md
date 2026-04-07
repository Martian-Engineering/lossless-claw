---
"@martian-engineering/lossless-claw": minor
---

Cache-aware leaf compaction guards with budget-pressure override. Prevents unnecessary prompt-cache invalidation by skipping compaction when token reduction is negligible or budget headroom is ample. Adds `leafSkipReductionThreshold` and `leafBudgetHeadroomFactor` config fields.
