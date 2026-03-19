---
"@martian-engineering/lossless-claw": patch
---

Add 60-second timeout protection to summarizer LLM calls. Previously, a slow or unresponsive model provider could block the `deps.complete()` call indefinitely, starving the Node.js event loop and causing downstream failures such as Telegram polling disconnects. Both the initial and retry summarization calls are now wrapped with a timeout that rejects cleanly and falls through to the existing deterministic fallback.
