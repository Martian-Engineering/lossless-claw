---
"@martian-engineering/lossless-claw": patch
---

Preserve explicit timezone offsets when parsing stored timestamps while still treating bare SQLite `datetime('now')` values as UTC.
