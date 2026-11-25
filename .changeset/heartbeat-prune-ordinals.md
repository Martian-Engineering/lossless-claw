---
"@martian-engineering/lossless-claw": patch
---

Keep context ordinals consecutive after heartbeat pruning (`pruneHeartbeatOk`) so pending compaction can keep publishing. Pruning now runs in one transaction and marks pending plans that reference the old positions as stale.
