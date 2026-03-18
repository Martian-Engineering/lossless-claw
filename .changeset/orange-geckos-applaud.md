---
"@martian-engineering/lossless-claw": patch
---

Restore stable conversation continuity across OpenClaw session UUID recycling
by resolving sessions through `sessionKey` for both writes and read-only
lookups, and keep compaction/ingest serialization aligned with that stable
identity.
