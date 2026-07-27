---
"@martian-engineering/lossless-claw": patch
---

Guard SQLite-backed session file paths (`sqlite:`) against filesystem stat/read/write operations in auto-rotate, rollover detection, transcript reconciliation, and bootstrap checkpoint refresh. OpenClaw 7.2+ sessions stored in SQLite use `sqlite:` prefixed paths that were passed through to `fs.stat`, `fs.createReadStream`, and `fs.open`, causing ENOENT errors on every agent turn. SQLite sessions now skip file-based rotation, rollover stat checks, and transcript I/O.
