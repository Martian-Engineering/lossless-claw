---
"@martian-engineering/lossless-claw": patch
---

Treat OpenClaw's manual `/compact` as a manual request. OpenClaw now sends `reason: "manual"` with `/compact`, and LCM applies the same manual semantics as `/lcm compact`. When a manual sweep finds nothing to compact, the reason now says why, for example that every raw message is in the protected fresh tail. Older OpenClaw hosts that send no reason keep the existing behavior.
