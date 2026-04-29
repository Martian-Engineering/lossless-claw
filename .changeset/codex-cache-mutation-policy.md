---
"@martian-engineering/lossless-claw": patch
---

Treat Codex prompt-cache writes and recent cache touches as mutation-sensitive so deferred compaction does not rewrite hot cached prompts before the cache TTL expires.
