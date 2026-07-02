---
"@martian-engineering/lossless-claw": patch
---

Delegate ignored-session compaction to OpenClaw's runtime compaction path when the host exposes it, so sessions excluded from LCM can still recover from raw transcript pressure.
