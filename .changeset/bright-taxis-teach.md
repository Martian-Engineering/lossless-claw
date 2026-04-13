---
"@martian-engineering/lossless-claw": patch
---

Add `/lcm backup` and `/lcm rotate` plugin commands so users can snapshot the SQLite database on demand and split oversized active LCM conversations without changing their live OpenClaw session identity. Rotation now checkpoints the current transcript frontier so the fresh row starts from now forward instead of replaying older transcript history.
