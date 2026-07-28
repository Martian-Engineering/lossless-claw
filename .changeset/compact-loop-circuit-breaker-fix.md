---
"@martian-engineering/lossless-claw": patch
---

Add a durable compaction-loop circuit breaker to prevent CPU/I/O runaway when the deferred compaction drain hits repeated backoff-worthy failures (ENOENT, non-auth provider errors, etc.).

The breaker uses the maintenance-store `retryAttempts` counter (persisted in SQLite and incremented by `markProactiveCompactionFinished` on each backoff-worthy failure) so it survives restarts. When `retryAttempts` reaches the configurable `compactionLoopMaxConsecutiveFailures` threshold (default 10, env `LCM_COMPACTION_LOOP_MAX_CONSECUTIVE_FAILURES`, set to 0 to disable), the assemble-time emergency drain force-exhausts the compact loop. After the exponential-backoff cooldown period elapses, the breaker auto-resets the counter so the drain can try again — if the underlying issue persists the counter climbs back and the breaker trips again with a fresh backoff.

Includes regression test coverage for the durable breaker and cooldown recovery, config validation (non-negative integer), and documentation in `openclaw.plugin.json`, `docs/configuration.md`, and `skills/lossless-claw/references/config.md`.
