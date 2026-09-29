---
"@martian-engineering/lossless-claw": patch
---

Reuse the last successful assembly budget for durable `commitTurn` compaction evaluation when the host does not supply a runtime prompt budget. Previously a conversation whose commit path had no direct budget fell back to a hardcoded `128_000`, so on large-context models the compaction target became `contextThreshold × 128000` and triggered spurious, never-satisfied compaction (`compacted_but_still_over_target`, degraded `lcm health`). Fixes #1171.
