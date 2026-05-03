---
"@martian-engineering/lossless-claw": patch
---

Two bootstrap-side followups to v0.9.3:

- PR #510 replaced bulk-insert with per-message `ingestSingle` to enable externalization on first import; that's correct for sessions whose transcripts contain interceptor-triggering content, but slow for the common case.  Pre-scan now restores the bulk-insert fast path when (a) no message would trigger any interceptor AND (b) no message carries a structural block (tool calls/results, reasoning/thinking, function calls, images) that requires `message_parts` rows.  Otherwise the per-message ingest path runs inside the existing `withTransaction`, yielding a macrotask boundary every K=100 messages (`await new Promise(setImmediate)`) so timer/IO callbacks can still run on long bootstraps.
- PR #512's `recentBootstrapImportsByConversation` had no time-based expiry, so stale "7 imports" tags trailed conversations indefinitely.  Add a 30-minute TTL gated in `formatOverflowDiagnosticsForLog` so operator log lines reflect recent activity only.
