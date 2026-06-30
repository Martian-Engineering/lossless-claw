---
"@martian-engineering/lossless-claw": patch
---

Allow isolated cron sessions with a matching durable sessionKey to recover from a checkpoint-missing reconciliation state even when the conversation's sessionId has been overwritten by a newer cron run.
