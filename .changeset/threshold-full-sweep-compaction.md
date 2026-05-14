---
"@martian-engineering/lossless-claw": patch
---

Switch automatic compaction to threshold-triggered full sweeps and retire cache-aware incremental scheduling while keeping the existing 20k default leaf chunk size. Adds `sweepMaxDepth` as the preferred depth knob, keeps `incrementalMaxDepth` as a deprecated alias, and adds `summaryPrefixTargetTokens` so pressure sweeps can condense deeper when summarized context remains too large.
