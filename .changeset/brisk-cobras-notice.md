---
"@martian-engineering/lossless-claw": patch
---

Restore automatic post-turn compaction when OpenClaw omits the top-level
`tokenBudget`, by resolving fallback budget inputs consistently before using
the default compaction budget.
