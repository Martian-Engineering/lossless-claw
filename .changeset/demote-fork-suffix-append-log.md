---
"@martian-engineering/lossless-claw": patch
---

Demote the per-assemble "appended fork-bounded live suffix" log from warn to debug on the healthy path. Thread-fork sessions append this suffix on essentially every assemble, so the line was warn-level noise in routine operation. The log stays at warn when the append evicted messages or ran over budget, the states that need operator attention. Assembly behavior is unchanged; only the log level moves.
