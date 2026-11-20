---
"@martian-engineering/lossless-claw": patch
---

Recover forced threshold compaction when a tool-heavy latest turn alone exceeds the target. Exhaust ordinary compaction and condensation first, then summarize only complete older tool-call/result groups while preserving the initiating user, recent tail, and persisted source history. Recovery stops at the target and is not triggered by provider failures, cancellation, or exhausted work limits. Routine compaction is unchanged.
