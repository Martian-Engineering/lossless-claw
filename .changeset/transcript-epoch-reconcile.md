---
"@martian-engineering/lossless-claw": patch
---

Preserve continuity when OpenClaw switches to a new transcript file for an existing session key. LCM now treats a bounded, path-mismatched transcript with no old anchor as a new transcript epoch, imports its recoverable messages, and avoids advancing checkpoints for no-anchor reads that imported nothing.
