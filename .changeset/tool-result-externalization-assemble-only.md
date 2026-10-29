---
"@martian-engineering/lossless-claw": minor
---

Externalize oversized one-shot tool results in the live assemble pre-flight only — never at ingest — so a payload is moved to disk lazily, when assembly actually needs the space, and the persisted row keeps its full text.

`toolResultExternalizationTokenThreshold` now defaults to 4000, measured rather than arbitrary: the stub is ~460 tokens, so at 4000 it is ~11% of what it replaces (~9x cheaper). Below that the pointer starts eating the budget it is meant to save.

In production the previous 25k threshold never fired at all — the largest tool result ever stored is 23,867 tokens — so the legacy ingest intercept was dead code.
