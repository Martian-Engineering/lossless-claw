---
"@martian-engineering/lossless-claw": patch
---

Treat existing `cold-cache-catchup` compaction debt as legacy threshold work. Background, assemble, and host-approved maintain drains now revalidate old non-threshold debt against `contextThreshold`, run a threshold full sweep when still needed, or clear the debt when the conversation is already under threshold.
