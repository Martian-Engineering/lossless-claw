---
"@martian-engineering/lossless-claw": patch
---

Avoid treating omitted LCM summarizer reasoning settings like reasoning-disabled requests for reasoning-capable models by applying a low default only when the resolved model supports reasoning.
