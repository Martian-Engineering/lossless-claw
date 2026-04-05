---
"@martian-engineering/lossless-claw": patch
---

Fix bootstrap checkpoint refresh after transcript maintenance so unchanged restarts stay on the fast path, and avoid advancing the checkpoint when replay-safety import caps abort reconciliation.
