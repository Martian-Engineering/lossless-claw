---
"@martian-engineering/lossless-claw": patch
---

Bound prompt-assembly work when internal events require trimming history. Evict the oldest eligible history groups instead of repeatedly comparing every candidate projection. Keep tool exchanges with their initiating user, preserve protected recent and live inputs, and report when those inputs exceed the budget. Stored messages and parts are unchanged.
