---
"@martian-engineering/lossless-claw": patch
---

Keep the provider prompt cache warm when assembly falls back to the bounded live transcript. Pressure estimates no longer count host-only message fields or opaque replay signatures such as encrypted reasoning, which made tool-heavy sessions look up to twice their real size and triggered the degraded fallback early. When the live window must be bounded, its first message now stays fixed across tool-loop requests until the window no longer fits, and a moved window is trimmed to 60% of the budget, instead of dropping the oldest messages on almost every request.
