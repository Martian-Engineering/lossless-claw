---
"@martian-engineering/lossless-claw": patch
---

Skip replayed transcript entries that OpenClaw re-appends under fresh entry ids when the persisted row and new entry share the same canonical identity and full-precision inner source timestamp.
