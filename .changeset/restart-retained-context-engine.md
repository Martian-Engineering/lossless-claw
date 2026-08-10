---
"@martian-engineering/lossless-claw": patch
---

Reopen the SQLite-backed context engine when OpenClaw starts a new gateway lifecycle from a cached plugin registry, preventing fallback to the legacy engine after in-process restarts.
