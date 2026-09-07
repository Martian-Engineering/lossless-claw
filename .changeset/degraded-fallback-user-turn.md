---
"@martian-engineering/lossless-claw": patch
---

Re-seat a user turn in the degraded live-assembly fallback so it never hands the provider a user-less context. Under sustained context pressure with an in-flight compaction, `buildDegradedLiveAssembleResult` could budget-trim every user message off a long tool loop, leaving only system/assistant/tool turns — which strict chat templates (e.g. Qwen3) reject with HTTP 400 "No user query found in messages", failing the whole agent turn. Unlike the main assemble path, this degraded fallback skipped the no-user-turns guard; it now re-seats the most recent evicted user turn after the protected prefix, mirroring `clampMessagesToSerializedBudget`.
