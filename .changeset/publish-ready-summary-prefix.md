---
"@martian-engineering/lossless-claw": patch
---

Allow compaction to atomically publish a contiguous ready summary prefix while remaining chunks or condensation are unfinished, including during summarization cooldown. Preserve pending suffix work, canonical lineage, original messages, and the protected fresh tail; report remaining preparation after partial publication.
