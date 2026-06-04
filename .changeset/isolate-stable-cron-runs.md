---
"@martian-engineering/lossless-claw": patch
---

Isolate cron scheduler runs that reuse a stable session key so prior run transcripts do not enter the new run's LCM context.
