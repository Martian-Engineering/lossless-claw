---
"@martian-engineering/lossless-claw": patch
---

Skip afterTurn messages whose content is already covered by an auto-compaction summary, preventing safeguard-mode summary re-injection from duplicating user instructions in LCM context.
