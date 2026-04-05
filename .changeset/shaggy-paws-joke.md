---
"@martian-engineering/lossless-claw": patch
---

Fix LCM summarization for runtime-managed OAuth providers like `openai-codex` by preserving first-pass credential resolution and skipping the incompatible direct-credential retry path. Also add configurable summarizer timeouts via `summaryTimeoutMs` and `LCM_SUMMARY_TIMEOUT_MS`.
