---
"@anthropic/lossless-claw": minor
---

feat(engine): add `budgetHeadroomRatio` to defer incremental compaction when under budget

New opt-in config parameter `budgetHeadroomRatio` (env: `LCM_BUDGET_HEADROOM_RATIO`, default `0`) defers incremental leaf compaction while the current token count stays below `tokenBudget × (1 - ratio)`, regardless of cache state. Useful for non-Anthropic providers where cache telemetry is never reported and for large-context-window models. The hot-cache-specific `hotCacheBudgetHeadroomRatio` takes precedence when cache state is hot.
