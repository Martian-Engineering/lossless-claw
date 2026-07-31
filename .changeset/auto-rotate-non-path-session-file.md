---
"@martian-engineering/lossless-claw": patch
---

Skip auto-rotation when the host passes an opaque sessionFile locator (a valid `sqlite:<agentId>:<sessionId>:<storePath>` session-store marker, or a missing sessionFile equal to the bare session key / session id) instead of warn-logging `session-file-stat-failed` ENOENT on every turn. JSONL auto-rotation only applies to real transcript files; hosts with SQLite-backed session stores now get a routine info-level `action=skip reason=session-file-not-rotatable` decision in the plugin log instead of a per-heartbeat warning from a guard that could never fire. Path-like values -- absolute or relative -- keep the existing stat behavior unchanged.
