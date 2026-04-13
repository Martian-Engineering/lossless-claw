---
"@martian-engineering/lossless-claw": patch
---

Increase the SQLite busy timeout to 30 seconds to better tolerate concurrent writer contention without spurious `SQLITE_BUSY` failures.
