---
"@martian-engineering/lossless-claw": patch
---

Fall back to LIKE search when FTS5 returns zero results for queries containing CJK characters. The `unicode61` tokenizer cannot index Chinese/Japanese/Korean text, so CJK queries silently returned empty results even when matching content existed in the database.
