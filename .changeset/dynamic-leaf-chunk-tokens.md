---
"@martian-engineering/lossless-claw": minor
---

Add optional dynamic leaf chunk sizing for incremental compaction, including bounded activity-based chunk growth, cold-cache max bumping, and automatic retry with smaller chunk targets when a provider rejects an oversized compaction request.
