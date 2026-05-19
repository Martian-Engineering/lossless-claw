---
"@martian-engineering/lossless-claw": patch
---

Bound `compactFullSweep` so a single compaction cannot hang the agent turn. The leaf/condensed pass loop now stops at a hard iteration cap (`maxSweepIterations`, default 12) and a wall-clock deadline (`sweepDeadlineMs`, default 120000), returning the consistent partial result instead of running unbounded passes. The sweep also yields the Node event loop between its synchronous `node:sqlite` scans so a long sweep cannot freeze the gateway for its whole duration. Both limits are configurable via plugin config or `LCM_MAX_SWEEP_ITERATIONS` / `LCM_SWEEP_DEADLINE_MS`.

Also bound the whole `compactUntilUnder` overflow-recovery operation. It runs up to `maxRounds` sweeps, and each sweep re-arms its own `sweepDeadlineMs`, so without an operation-wide budget the worst case was `maxRounds × sweepDeadlineMs` (~20 minutes at the defaults). `compactUntilUnder` now computes one wall-clock deadline (`compactUntilUnderDeadlineMs`, default 300000), shares it into every round's sweep so a sweep stops at whichever deadline is sooner, and checks it before starting the next round — returning the consistent partial result on expiry. Configurable via plugin config or `LCM_COMPACT_UNTIL_UNDER_DEADLINE_MS`.
