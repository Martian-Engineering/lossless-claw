---
"@martian-engineering/lossless-claw": patch
---

Add guided `/lossless restore` support for `rotate-latest` and timestamped SQLite backups. The restore output now shows exact offline shell commands that archive the current database plus stale WAL/SHM sidecars before copying the chosen snapshot back into place, and bootstrap now treats a guided restore as authoritative so newer transcript history is not replayed into the restored conversation.
