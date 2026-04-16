---
"@martian-engineering/lossless-claw": patch
---

Wrap SQLite migrations in a single exclusive transaction so concurrent startup agents serialize migration work instead of racing on per-statement autocommit writes.
