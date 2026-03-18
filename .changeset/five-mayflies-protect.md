---
"@martian-engineering/lossless-claw": patch
---

Fix condensed summary expansion so replay walks the source summaries that were compacted into a node, and skip proactive compaction when turn ingest fails to avoid compacting a stale frontier.
