---
"@martian-engineering/lossless-claw": patch
---

Keep `lcm_grep` searches and `/lossless doctor clean` from stalling the Gateway on large databases. Searches run on a worker thread with their own read-only connection, and `full_text` results are ranked from new `created_at` indexes rather than by reading every matching row. Regex and substring searches scan newest-first within a fixed row and time budget, and report when they hit it. The doctor cleaner scan, backup, deletes and integrity check also run on a worker thread, and `/lossless backup` and the backups taken before doctor repairs write `VACUUM INTO` from a worker thread too. Deletes now commit in short batches, and new indexes on the foreign-key columns of `context_items`, `pending_summary_nodes` and `conversation_transcript_gaps` stop each deleted message from scanning those tables. On large databases, the first start after upgrading builds the new indexes once, which can take about a minute.
