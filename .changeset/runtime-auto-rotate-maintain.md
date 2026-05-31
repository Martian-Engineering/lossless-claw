---
"@martian-engineering/lossless-claw": patch
---

Defer runtime auto-rotate JSONL rewrites out of `afterTurn` and `maintain` so embedded prompt-lock fences are not tripped during tool-call loops. Runtime checks now log a deferral to startup/manual rotation unless OpenClaw provides a host-owned full-transcript rewrite primitive. Transcript GC waits for host-approved background maintenance before invoking `rewriteTranscriptEntries`.
