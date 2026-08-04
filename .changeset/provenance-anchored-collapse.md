---
"@martian-engineering/lossless-claw": patch
---

Collapse the decorated end-of-turn face of an inbound message onto its bare
transcript row when that row was ingested by the same turn's own reconcile,
removing the per-turn double-write on decorated channels. Rows from earlier
turns, however recent, and provenance-less rows never anchor a collapse.
