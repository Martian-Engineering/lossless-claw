---
"@martian-engineering/lossless-claw": patch
---

Deferred maintenance and post-turn compaction evaluation now use the host's current `runtimeSettings.limits.promptTokenBudget` when one is supplied, instead of the 128,000-token fallback or a budget recorded for an earlier model. When a direct budget is also present, the smaller value wins. `maxAssemblyTokenBudget` still acts as a ceiling, and hosts that supply no budget keep the conservative behavior.
