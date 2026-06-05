---
"@martian-engineering/lossless-claw": minor
---

Add `enableSummaryThinking` config option to control whether summarization calls request a low reasoning budget from the model. Defaults to `true` (preserves current behavior). Set to `false` to disable reasoning and keep summarization output concise when reasoning is not needed for faithful summaries.
