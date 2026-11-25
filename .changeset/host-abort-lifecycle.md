---
"@martian-engineering/lossless-claw": patch
---

Treat a host-canceled `runtime.llm.complete` call as a retryable lifecycle refusal instead of a provider failure. OpenClaw cancels context-engine model calls when it stops the surrounding operation, for example when background maintenance yields to a foreground turn or a user stops a compaction. Lossless never passes its own signal to that call, so a thrown top-level `AbortError` and a result with `stopReason: "aborted"` are now classified like the other host lifecycle refusals: pending summary work is kept for a later pass instead of being replaced by a deterministic truncation fallback summary, and partial text from a canceled request is never used as a summary.
