---
"@martian-engineering/lossless-claw": patch
---

Use LIKE search for full-text queries containing CJK characters. SQLite FTS5's `unicode61` tokenizer can return empty or incomplete results for Chinese/Japanese/Korean text, so CJK queries now bypass FTS and use the existing LIKE-based fallback for correct matches.
