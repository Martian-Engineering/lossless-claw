---
"@martian-engineering/lossless-claw": minor
---

feat(engine): add `compactionStartTokens` to defer optional compaction until the prompt reaches an explicit token floor

`compactionStartTokens` and `LCM_COMPACTION_START_TOKENS` let operators preserve fully raw context below an absolute current-prompt token count, while still allowing critical budget pressure to compact before overflow.
