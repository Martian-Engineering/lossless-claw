---
"@martian-engineering/lossless-claw": patch
---

Harden defensive handling for non-string database path and timestamp values so malformed runtime data does not trigger `.trim()` crashes or silently skew stored chronology.
