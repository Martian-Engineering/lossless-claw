---
"@martian-engineering/lossless-claw": patch
---

Skip restart and shutdown `session_end` hooks before acquiring the context engine, preventing closed-database errors after `gateway_stop`.
