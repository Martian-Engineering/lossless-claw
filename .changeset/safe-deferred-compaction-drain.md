---
"@martian-engineering/lossless-claw": patch
---

Drain deferred compaction debt only after foreground after-turn maintenance finishes so background work cannot race bootstrap refreshes or hot prompt-cache paths.
