---
"@martian-engineering/lossless-claw": patch
---

Avoid premature threshold compaction by treating raw messages outside the fresh tail as diagnostic and preparation data instead of adding them again to prompt pressure already represented by stored and observed token counts.
