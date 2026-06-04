---
"@martian-engineering/lossless-claw": patch
---

Fix the #639 Mode 2 deferred-compaction wedge: treat terminal compaction exhaustion as non-retryable instead of pinning the conversation in a permanent retry loop.

When a threshold sweep takes no action and does not fail (no eligible leaf/condensed candidates remain) while the conversation is still over target, compaction can never make progress — it shrinks STORED leaves but cannot reduce the host's OBSERVED live tokens. Previously this returned `ok=false`/`reason="live context still exceeds target"`, so the deferred-debt drain kept the maintenance row `pending=1`, climbed `retry_attempts`, opened summary-spend backoff, and thrashed the assemble degraded-fallback every turn.

`executeCompactionCore` now flags this terminal state as `exhausted` (while still returning `ok=false` so overflow recovery and #15 keep the honest still-over-target signal), and `consumeDeferredCompactionDebt` treats an exhausted result as a completed no-op: it clears the debt (`keepPending=false`, no failure summary) instead of retrying forever. Emergency assemble drains still return bounded degraded live context for the current over-budget turn when exhaustion is discovered inline. Adds deterministic regressions that reproduce the wedge (matches the production `conversation_compaction_maintenance.last_failure_summary="live context still exceeds target"`).

Addresses the deferred-compaction-loop half of #639 (the residual that #621/#681 did not cover). Based on @Grynn's exhaustion-handling proposal in the #639 thread.
