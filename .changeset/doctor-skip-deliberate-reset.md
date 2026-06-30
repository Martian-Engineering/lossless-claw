---
"@martian-engineering/lossless-claw": patch
---

Stop the rollover-split doctor from auto-restoring conversations a user deliberately wiped with `/reset`. A new nullable `archive_cause` column records why each conversation was archived, written at the single archive funnel for both the `before_reset` and `session_end` lifecycle events a `/reset` surfaces. The doctor excludes deliberate causes (`manual-reset`) from its merge sources, so a `/reset` archive is never re-merged into the active conversation. Incidental archives (`rollover-fallback`, `cron-rotation`, `session-end`, idle/daily/compaction) and legacy NULL-cause rows stay merge-eligible, so genuine crash and rollover splits are still recovered.
