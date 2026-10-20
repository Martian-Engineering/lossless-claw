---
"@martian-engineering/lossless-claw": patch
---

Treat OpenClaw model-runtime reload admission rejections as host runtime lifecycle interruptions. Summarization now keeps pending summaries and compaction debt for a later drain instead of logging provider failures and persisting deterministic fallback summaries.
