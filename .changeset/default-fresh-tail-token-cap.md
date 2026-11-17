---
"@martian-engineering/lossless-claw": patch
---

Give the protected fresh tail a default token cap. When `freshTailMaxTokens` is unset, routine compaction, pending summary preparation and assembly now cap the fresh tail at 25% of the token budget while always keeping the newest 8 messages and the newest user turn. Previously the tail was bounded only by `freshTailCount` (64 messages), which in tool-heavy sessions could cover most of the history and leave compaction with nothing to summarize ("no pending summary nodes planned"). An explicit `freshTailMaxTokens` keeps its existing behavior.
