---
"@martian-engineering/lossless-claw": patch
---

Fix `openai-codex` summarization for modern Codex model ids that are not present in the local `pi-ai` model catalog.

Lossless now resolves native Codex transport defaults for these models and treats explicit provider error responses as provider failures, allowing configured fallback models to run instead of retrying as an empty summary and falling back to truncation.
