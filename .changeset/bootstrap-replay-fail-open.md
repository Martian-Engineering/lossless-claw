---
"@martian-engineering/lossless-claw": patch
---

Make context-engine **bootstrap fail open** when the replay-flood guard trips, instead of taking the whole engine down.

A conversation whose persisted history contains a same-second burst of identical `user` messages (a bulk transcript import, or a historical sub-agent flood folded into a durable session) trips `assertNoReplayTimestampFlood` when bootstrap re-imports its tail. `user` messages are never exempted by `filterBootstrapReplayMessages` (only `assistant`/`tool` count as bootstrap replay candidates), so the guard throws `refused replay-like message batch` straight out of `bootstrap()`.

The host treats a bootstrap throw as fatal: it quarantines the entire `lossless-claw` context engine for the process and falls back to the legacy engine for **every** session — so a single bad conversation silently disables lossless context management host-wide (observed in production: one `agent:*:main` conversation with hundreds of identical user rows at one `created_at` second quarantined LCM on every gateway restart).

`bootstrap()` now catches the (newly typed, exported) `ReplayTimestampFloodError` and skips just the offending conversation (`reason: "replay-flood guard tripped at bootstrap; conversation skipped"`). The guard still blocks the replay — the transaction rolls back and nothing new is persisted — it just no longer escalates to an engine-wide quarantine.

Fixes the dedup-fail-closed half of #639. Sibling to #755 (role-aware thresholds), independent of it.
