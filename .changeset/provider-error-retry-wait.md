---
"@martian-engineering/lossless-claw": patch
---

Wait out a short host cooldown before giving up on a summary. When the last summary model fails with a provider error, Lossless now waits 35 seconds and tries once more, instead of retrying at once and storing a truncation fallback. OpenClaw refuses a model for 30 seconds after one failed call, so the immediate retry was always refused. Only calls that the host can cancel wait: `compact()` and pending-summary preparation with a host `abortSignal`. An abort ends the wait at once. Foreground calls without a signal still fail fast.
