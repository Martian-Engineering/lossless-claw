---
"@martian-engineering/lossless-claw": patch
---

Retry transient ENOENT while reconciling afterTurn transcripts so plugin reload races do not preserve offset-0 checkpoints and skip durable catchup for active session files.
