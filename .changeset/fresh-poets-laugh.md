---
"@martian-engineering/lossless-claw": patch
---

Improve the `session_id` fallback conversation lookup by adding the matching composite index so SQLite can satisfy the latest-conversation query without a scan and temp sort.
