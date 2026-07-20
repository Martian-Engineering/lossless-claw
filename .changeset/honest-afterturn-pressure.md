---
"@martian-engineering/lossless-claw": patch
---

Avoid unnecessary after-turn compaction when OpenClaw does not provide a live prompt token count by evaluating the stored context without double-counting its raw prefix.
