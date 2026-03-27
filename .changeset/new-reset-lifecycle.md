---
"@martian-engineering/lossless-claw": minor
---

Add explicit `/new` and `/reset` lifecycle handling for OpenClaw sessions.

`/new` now prunes fresh context from the active conversation while preserving retained summaries by configured depth, and `/reset` now archives the current conversation before starting a fresh active conversation for the same stable session key.
