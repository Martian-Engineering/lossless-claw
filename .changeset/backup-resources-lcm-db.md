---
"@martian-engineering/lossless-claw": patch
---

Declare `lcm.db` and `lcm-files` as durable plugin backup resources. On OpenClaw 2026.9.5 and later, `openclaw backup create` now captures `lcm.db` with a verified online SQLite snapshot instead of copying the live database and its WAL/SHM sidecars, so archives no longer depend on catching the database between writes. Older supported hosts accept the declaration and keep the previous byte-copy behavior.
