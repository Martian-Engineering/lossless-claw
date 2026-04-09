---
"@martian-engineering/lossless-claw": patch
---

Harden malformed FTS migration recovery so stale trigram tables are cleaned up before other FTS schema probes and startup migrations no longer skip recovery by reusing a cached FTS5 capability check.
