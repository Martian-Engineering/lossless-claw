---
"@martian-engineering/lossless-claw": patch
---

Keep deferred incremental compaction debt pending until oversized raw backlog is actually compacted, and let budget-triggered catch-up scale passes with prompt overage instead of forcing one pass per turn.
