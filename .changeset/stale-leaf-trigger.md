---
"@martian-engineering/lossless-claw": patch
---

Use live observed token counts consistently in leaf and threshold compaction workers so stale persisted counts do not suppress needed compaction, and fix the Sonnet 4.6 tuning guide to match the documented 1M context window.
