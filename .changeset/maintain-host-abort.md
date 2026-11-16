---
"@martian-engineering/lossless-claw": patch
---

Honor OpenClaw's cancellation of background maintenance. OpenClaw only passes `abortSignal` to `maintain()` when the engine lists it in `acceptedHostParams`, so Lossless never saw the signal. It now accepts it and checks it before each pending-summary step, after the last step, right before publishing (also when the session queue is already held), and before the legacy fallback sweep. Lossless does not interrupt a model call that is already in flight; the host cancels that call. After an abort, prepared summaries stay durable and `maintain()` rejects with the host's abort reason. A legacy sweep cut short by the abort leaves the compaction debt pending with its retry count, backoff and last failure unchanged; real failures are still recorded. `compact()` stops its pending-summary steps the same way.
