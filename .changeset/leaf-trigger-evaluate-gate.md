---
"@martian-engineering/lossless-claw": patch
---

`compaction.evaluate()` now consults the leaf trigger when the token-budget threshold has not been crossed. Conversations that stay under the context threshold but accumulate raw messages outside the protected fresh tail past `leafChunkTokens` will now correctly schedule deferred compaction with `reason: "leaf-trigger"` instead of being silently skipped on every turn. Fixes the case where conversations under the context threshold accumulated tens of thousands of raw tokens for weeks without ever being compacted.
