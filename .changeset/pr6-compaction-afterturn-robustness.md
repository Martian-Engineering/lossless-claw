---
"@martian-engineering/lossless-claw": patch
---

Harden the afterTurn-lane robustness:

- `scheduleDeferredCompactionDebtDrain` no longer silently skips when `compactionTelemetry` lacks provider/model — CLI-backend sessions (#472) accumulated debt forever.  Now drains anyway when telemetry is missing (let the inner cache-aware gate decide), keeping silent debt off the floor.  The visibility log is deduped to once per conversation per process so long-running CLI sessions don't spam every afterTurn.
- `messageContentCoveredBySummary` (PR #551) replaces bare substring match with anchored-or-quoted matching — a 24+ char user instruction coincidentally appearing inside a long narrative summary is no longer silently dropped.  The quote-span scan is also more resilient: an unmatched opening quote skips past instead of aborting the entire scan, so later well-formed quoted spans still get checked.
- `reconcileTranscriptTailForAfterTurn` (PR #551) slow path no longer blindly re-reads the full session file when checkpoint is missing or path mismatched — refresh checkpoint and switch to incremental reads, with a one-shot warn for visibility.  The dedupe set is bounded with FIFO eviction at 4096 entries so hosts churning through many sessions don't accumulate it indefinitely.  The empty-`historicalMessages` branch now distinguishes "actually empty file" (size 0 → refresh checkpoint) from "non-empty file but parser failure" (size > 0 → emit warn, skip checkpoint refresh, keep the next afterTurn eligible to retry).
