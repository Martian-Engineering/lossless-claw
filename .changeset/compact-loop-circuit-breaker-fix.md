---
"@martian-engineering/lossless-claw": patch
---

Replace the process-local compact-loop circuit breaker with the durable maintenance-store `retryAttempts` counter, so the breaker survives restarts. The previous `consecutiveCompactAttemptsByConversation` Map was reset on every process restart, letting broken compaction loops resume from zero. Now `retryAttempts` (managed by `markProactiveCompactionFinished`) persists in SQLite, and the new `compactionLoopMaxConsecutiveFailures` config option (default 10, env `LCM_COMPACTION_LOOP_MAX_CONSECUTIVE_FAILURES`) controls the threshold. Adds regression test coverage for the durable breaker.
