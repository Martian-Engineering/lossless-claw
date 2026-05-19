---
"@martian-engineering/lossless-claw": patch
---

Bound `compactFullSweep` so a single compaction cannot hang the agent turn. The leaf/condensed pass loop now stops at a hard iteration cap (`maxSweepIterations`, default 12) and a wall-clock deadline (`sweepDeadlineMs`, default 120000), returning the consistent partial result instead of running unbounded passes. The sweep also yields the Node event loop between its synchronous `node:sqlite` scans so a long sweep cannot freeze the gateway for its whole duration. Both limits are configurable via plugin config or `LCM_MAX_SWEEP_ITERATIONS` / `LCM_SWEEP_DEADLINE_MS`.
