---
"@martian-engineering/lossless-claw": patch
---

Skip already-completed backfill migrations on startup

Three migration backfill functions (`backfillSummaryDepths`, `backfillSummaryMetadata`, `backfillToolCallColumns`) ran unconditionally on every gateway startup. On large databases (2K+ conversations, 70K+ messages), these O(conversations × summaries) operations took minutes, held SQLite write locks, and caused the gateway to fail health checks. If the process was killed mid-backfill, it restarted and ran the same expensive operations again — creating a startup death spiral.

This change adds cheap sentinel queries before each backfill: if no rows need updating, the backfill is skipped entirely with an info log. Startup on an already-migrated DB drops from minutes to milliseconds.
