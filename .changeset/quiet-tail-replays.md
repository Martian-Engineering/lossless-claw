---
"@martian-engineering/lossless-claw": patch
---

Prevent replayed Bedrock transcript tails from being reingested after compaction by matching against the actual stored message tail and treating fully matched suffixes as already stored.
