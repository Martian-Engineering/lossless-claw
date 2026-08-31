---
"@martian-engineering/lossless-claw": patch
---

Accept the retired `transcriptGcEnabled` and `autoRotateSessionFiles` settings so upgrades from 0.15 continue to load. Lossless ignores both settings and logs a startup warning that asks operators to remove them.
