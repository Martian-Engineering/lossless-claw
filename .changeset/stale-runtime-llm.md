---
"@martian-engineering/lossless-claw": patch
---

Report summarization interrupted by host runtime retirement ("Plugin inventory has retired", "Async work scope is closed") as a single warning instead of two error lines; pending summaries and compaction debt stay queued for the next drain.
