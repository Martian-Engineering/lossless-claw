---
"@martian-engineering/lossless-claw": patch
---

Fix conversation integrity regressions by pruning heartbeat-shaped ACK turns before compaction, avoiding synthetic compaction telemetry in canonical transcript history, and deduplicating replayed history using stable session key continuity during afterTurn processing.
