---
"@martian-engineering/lossless-claw": patch
---

Refresh the bootstrap checkpoint after normal `afterTurn()` ingestion so persistent sessions can keep using the append-only bootstrap fast path after real conversation turns.
