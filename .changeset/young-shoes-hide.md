---
"@martian-engineering/lossless-claw": patch
---

Keep deferred Anthropic leaf compaction moving once the prompt-cache TTL has gone stale, even if cache-aware cold-observation smoothing still treats the session as effectively hot for routing-noise protection.
