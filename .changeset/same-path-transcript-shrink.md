---
"@martian-engineering/lossless-claw": patch
---

Recover bounded transcript epochs when OpenClaw rewrites a session JSONL in place and the stored bootstrap checkpoint points past the new file end. LCM now treats same-path transcript shrink as an epoch rollover instead of accepting an empty append-only read as fully covered.
