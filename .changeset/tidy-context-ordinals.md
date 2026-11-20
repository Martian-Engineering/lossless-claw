---
"@martian-engineering/lossless-claw": patch
---

Keep context ordinals consecutive after session pruning so pending compaction can continue. Repair existing gaps once at startup, preserving context order and stored history while invalidating pending plans that reference the old positions.
