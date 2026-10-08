---
"@martian-engineering/lossless-claw": patch
---

Restore raw user replay identity during `assemble` from replay keys recorded at transcript ingestion, instead of reading the whole visible transcript on every turn where live user messages carry an `idempotencyKey`. Rows stored before replay keys were recorded are filled from one full visible read, then served from storage.
