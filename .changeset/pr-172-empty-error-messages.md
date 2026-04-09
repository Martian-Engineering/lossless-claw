---
"@martian-engineering/lossless-claw": patch
---

Skip ingesting empty assistant messages from errored or aborted provider responses so they do not accumulate in assembled context and trigger retry loops.
