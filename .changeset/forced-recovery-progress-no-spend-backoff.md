---
"@martian-engineering/lossless-claw": patch
---

Stop opening the summary spend backoff when forced overflow recovery makes real progress but cannot reach its target because of the protected tail. Partial recovery no longer blocks foreground compaction on later assembles with `deferred compaction backoff active`. A forced pass that spends summarizer calls without reducing context still opens the backoff.
