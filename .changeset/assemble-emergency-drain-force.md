---
"@martian-engineering/lossless-claw": patch
---

Skip deferred compaction retry backoff in assemble emergency drain when token pressure exceeds budget. The emergency drain now passes `force: true` to `consumeDeferredCompactionDebt`, bypassing the `nextAttemptAfter` backoff check so compaction can retry immediately instead of waiting for the backoff timer. Normal deferred drain paths (`drainDeferredCompactionDebtIfIdle`, `maintain`) continue to respect backoff. To prevent infinite retries when compaction persistently fails, `force: true` is only applied when `retryAttempts < 3`.
