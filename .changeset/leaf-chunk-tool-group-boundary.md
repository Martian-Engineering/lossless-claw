---
"@martian-engineering/lossless-claw": patch
---

Routine leaf compaction and pending-summary planning no longer end a chunk between an assistant tool call and its results, so a call is summarized together with its results instead of leaving the results as orphans.
