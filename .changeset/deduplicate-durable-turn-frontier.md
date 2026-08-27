---
"@martian-engineering/lossless-claw": patch
---

Deduplicate host-accepted turn messages against the covered transcript frontier before recording a durable advancement, preventing native runtimes from storing a second copy when transcript projection ingestion wins the race while preserving unflushed suffixes and ambiguous data.
