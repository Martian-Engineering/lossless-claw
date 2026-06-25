---
"@martian-engineering/lossless-claw": patch
---

Treat OpenClaw SQLite transcript storage as authoritative during afterTurn hooks. When the host marks `runtimeContext.transcriptStorage.kind` as `sqlite`, Lossless now persists the runtime turn batch directly through normal ingest instead of reconciling stale JSONL transcript locators.
