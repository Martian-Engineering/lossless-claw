---
"@martian-engineering/lossless-claw": patch
---

Surface terminal compaction exhaustion as an explicit transcript-reset verdict.

When a threshold sweep finds no eligible candidates while host-observed
pressure keeps the session over target, the host is rebuilding prompts from
live transcript state the engine cannot shrink — retrying stored compaction
can never converge. This terminal state previously reported the generic
"live context still exceeds target", which hosts answer with misleading
reserve-tuning advice. compact() now returns "stored compaction exhausted but
live context still exceeds target; transcript reset required" (alongside the
existing exhausted flag that clears deferred debt). The verdict requires an
explicit host-observed token count and never fires on budget-stopped sweeps,
so estimator gaps or interrupted sweeps cannot condemn recoverable sessions.
Telemetry: a "[lcm] compact: transcript wedge detected" warn line with
stored/observed/overhead counts.
