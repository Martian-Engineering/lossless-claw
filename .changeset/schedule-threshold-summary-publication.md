---
"@martian-engineering/lossless-claw": patch
---

Give a complete pending-summary frontier a publication-only session-queue opportunity when context crosses the compaction threshold. Publication waits for foreground work already in progress, runs before later queued foreground work, and does not call the summary model. Incomplete frontiers remain deferred for background preparation.
