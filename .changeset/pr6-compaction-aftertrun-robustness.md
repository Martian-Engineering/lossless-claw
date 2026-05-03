---
"@martian-engineering/lossless-claw": patch
---

Harden three afterTurn-lane robustness gaps in v0.9.3:

- `scheduleDeferredCompactionDebtDrain` no longer silently skips when `compactionTelemetry` lacks provider/model — CLI-backend sessions (#472) accumulated debt forever.  Now drains anyway when telemetry is missing (let the inner cache-aware gate decide), keeping silent debt off the floor.
- `messageContentCoveredBySummary` (PR #551) replaces bare substring match with anchored-or-quoted matching — a 24+ char user instruction coincidentally appearing inside a long narrative summary is no longer silently dropped.
- `reconcileTranscriptTailForAfterTurn` (PR #551) slow path no longer blindly re-reads the full session file when checkpoint is missing or path mismatched — refresh checkpoint and switch to incremental reads, with a one-shot warn for visibility.
