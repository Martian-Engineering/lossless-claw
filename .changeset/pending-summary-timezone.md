---
"@martian-engineering/lossless-claw": patch
---

Deferred compaction now stamps leaf source messages in the configured `timezone`, matching the synchronous pass, instead of always using UTC ISO strings.
