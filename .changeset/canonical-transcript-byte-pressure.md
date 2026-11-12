---
"@martian-engineering/lossless-claw": patch
---

Delegate canonical transcript byte-pressure compaction to OpenClaw's native runtime so its active transcript can shrink without deleting history. Keep token-pressure and ordinary manual summarization with LCM, and report required native compaction as unavailable rather than silently succeeding when the host delegate is missing.
