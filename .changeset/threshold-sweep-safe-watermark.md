---
"@martian-engineering/lossless-claw": patch
---

Clear deferred compaction debt when a threshold sweep made progress, then stalled above the ideal target, and both the stored context and observed prompt projection fit the token budget. Keep recoverable debt pending when a sweep stops at a work limit or is still reducing context. Sweeps without a usable observed prompt count retain the strict threshold verdict.
