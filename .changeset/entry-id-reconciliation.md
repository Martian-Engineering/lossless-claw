---
"@martian-engineering/lossless-claw": minor
---

Rebuild transcript reconciliation around the stable JSONL envelope ids that OpenClaw already writes. Transcript imports are now idempotent by construction (`messages.transcript_entry_id` with a partial unique index), the afterTurn runtime batch is reconciled by exact alignment against the covered transcript frontier instead of heuristic dedup, rewritten/rotated transcripts are recognized as declared epoch rollovers via the session header id instead of path/size heuristics, and flush-lagged runtime rows are healed in place by adopting the catch-up entry's id rather than duplicated. Entry-id anchoring also survives post-ingest content rewriting (externalized tool results), which previously could freeze conversations. The content-identity machinery remains as the fallback for transcripts without envelope ids. Design: specs/transcript-reconciliation-by-entry-id.md.
