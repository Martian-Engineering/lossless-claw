---
"@martian-engineering/lossless-claw": patch
---

Run LCM migrations during engine startup and only advertise `ownsCompaction`
when the database schema is operational, while preserving runtime compaction
settings and accurate token accounting for structured tool results.
