---
"@martian-engineering/lossless-claw": patch
---

Avoid scanning unrelated message history when resolving summary source ranges. This prevents repeated synchronous database scans from stalling context assembly on large databases while preserving summary coverage and generated context.
