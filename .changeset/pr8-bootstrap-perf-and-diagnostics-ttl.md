---
"@martian-engineering/lossless-claw": patch
---

Two bootstrap-side followups to v0.9.3:

- PR #510 replaced bulk-insert with per-message `ingestSingle` to enable externalization on first import; that's correct for sessions whose transcripts contain interceptor-triggering content, but slow for the common case.  Pre-scan now restores the bulk-insert fast path when no message would trigger any interceptor; otherwise chunk into K=100 transactions instead of one mega-transaction.
- PR #512's `recentBootstrapImportsByConversation` had no time-based expiry, so stale "7 imports" tags trailed conversations indefinitely.  Add a 30-minute TTL gated in `formatOverflowDiagnosticsForLog` so operator log lines reflect recent activity only.
