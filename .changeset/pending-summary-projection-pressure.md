---
"@martian-engineering/lossless-claw": patch
---

Publish pending summaries for the longest prepared projection prefix while leaving undersized raw suffixes live, and avoid double-counting raw backlog as threshold pressure when it is already present in the active projection.
