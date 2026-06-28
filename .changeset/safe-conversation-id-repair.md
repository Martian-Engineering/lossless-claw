---
"@martian-engineering/lossless-claw": patch
---

Repair legacy SQLite databases whose `conversation_id` values exceed JavaScript's safe integer range before migration, startup recovery, or recall tools read those rows.
