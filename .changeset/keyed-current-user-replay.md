---
"@martian-engineering/lossless-claw": patch
---

Preserve host-injected context and avoid replaying the current user twice on eager loop calls when a unique host idempotency key proves the retained transcript occurrence. Keep historical rows intact across repeated prompts, transcript catch-up, retries, and engine restarts. Calls without occurrence identity and separate pre-prompt delivery retain their existing behavior.
