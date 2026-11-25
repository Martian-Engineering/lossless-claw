---
"@martian-engineering/lossless-claw": patch
---

Report compaction progress to OpenClaw and honor its abort signal. Each committed summary pass now refreshes the host's compaction idle timeout, so multi-round overflow recovery no longer fails with "Compaction timed out" while it is still making progress. When the host aborts, the sweep stops before starting another pass and keeps the summaries it already committed.
