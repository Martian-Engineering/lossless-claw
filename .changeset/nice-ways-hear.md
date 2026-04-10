---
"@martian-engineering/lossless-claw": patch
---

Fix bootstrap recovery when a session rotates to a new transcript file so stale summaries and checkpoints are cleared before re-importing the replacement session history.
