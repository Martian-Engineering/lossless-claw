---
"@martian-engineering/lossless-claw": patch
---

Fix prompt-aware context eviction so blank or otherwise unsearchable prompts fall back to the existing chronological behavior instead of entering the relevance-scoring path.
