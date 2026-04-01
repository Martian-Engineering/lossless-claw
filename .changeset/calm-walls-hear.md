---
"@martian-engineering/lossless-claw": patch
---

Fix compaction auth circuit breaker handling so auth failures during multi-pass sweeps still trip the breaker, while failures for one resolved summarizer no longer block unrelated providers or sessions.
