---
"@martian-engineering/lossless-claw": patch
---

Switch automatic compaction to threshold-triggered full sweeps, retire cache-aware incremental scheduling, and raise the default leaf chunk size to 40k tokens. Adds `sweepMaxDepth` as the preferred depth knob, keeps `incrementalMaxDepth` as a deprecated alias, and adds `summaryPrefixTargetTokens` so pressure sweeps can condense deeper when summarized context remains too large.
