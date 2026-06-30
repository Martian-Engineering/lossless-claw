---
"@martian-engineering/lossless-claw": patch
---

Tighten the structural same-turn supersede so it only collapses a runtime or live copy onto a bare persisted row when the bare body is carried under a channel timestamp, rather than whenever the content merely contains the substring "(untrusted metadata)" or ends with a line equal to the bare body. Structured metadata blocks remain untrusted user-facing text until OpenClaw provides a trusted marker, so metadata-only copies are preserved rather than risk silently superseding an earlier user turn. The guard now covers both the store after-turn path and the assembly supersede path.
