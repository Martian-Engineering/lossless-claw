---
"@martian-engineering/lossless-claw": patch
---

Stop rerunning startup summary and tool-call backfills after they complete successfully, while still retrying the same backfill version cleanly if startup fails before the completion marker is written.
