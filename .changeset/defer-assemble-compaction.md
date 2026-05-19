---
"@martian-engineering/lossless-claw": patch
---

Keep deferred threshold compaction off the normal next-turn assemble path.

Pending deferred compaction debt is now left for the after-turn background drain
or host-approved maintenance while the live prompt is still within the active
token budget. `assemble()` only drains pending debt synchronously when the live
prompt estimate is already over budget, preserving the emergency safety path
without turning ordinary threshold debt into foreground latency.
