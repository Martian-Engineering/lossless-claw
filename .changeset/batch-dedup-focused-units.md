---
"@martian-engineering/lossless-claw": patch
---

Add focused unit tests for `BatchDeduplicator` in `test/batch-dedup.test.ts`. The new file covers `deduplicateAfterTurnBatch` and `alignRuntimeBatchAgainstCoveredFrontier` directly, including empty batch, empty conversation, full stored-transcript trim, tail-only replay, decorated-face collapse, and fail-closed overlap behavior. This complements the existing integration-level replay proof in `engine-after-turn.test.ts`.
