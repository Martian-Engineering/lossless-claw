---
"@martian-engineering/lossless-claw": patch
---

Preserve new `afterTurn` messages when an unaligned runtime batch only partially overlaps persisted history. Ambiguous mixed batches now ingest in full instead of repeatedly discarding genuine turns beside recurring control rows.
