---
"@martian-engineering/lossless-claw": patch
---

Limit first-time fork bootstrap imports so new conversations only inherit the newest slice of raw parent history instead of loading the entire parent transcript into lossless memory.
