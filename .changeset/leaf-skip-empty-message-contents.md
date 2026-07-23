---
"@martian-engineering/lossless-claw": patch
---

Skip leaf compaction when selected raw messages are missing or contain no meaningful content, preventing zero-source fallback summaries and context growth. Full sweeps continue past empty-source chunks, clamp tracked token deltas at zero, and stop leaf passes once `stopAtTokens` is reached.
