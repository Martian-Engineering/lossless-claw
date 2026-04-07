---
"@martian-engineering/lossless-claw": patch
---

Make incremental leaf compaction cache-aware by deferring extra passes while prompt caching is hot, allowing bounded catch-up when the cache goes cold, and adding `cacheAwareCompaction` config controls for the behavior.
