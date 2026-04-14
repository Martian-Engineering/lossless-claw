---
"@martian-engineering/lossless-claw": patch
---

Fix the built-in API-family fallback for `ollama` providers so summarization can use OpenAI-compatible Ollama models without requiring an explicit `models.providers.ollama.api` setting.
