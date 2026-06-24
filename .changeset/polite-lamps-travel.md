---
"@martian-engineering/lossless-claw": patch
---

Preserve the decorated live current turn across channels while collapsing only the matching current-turn store duplicates. A same-turn structural supersede is now accounted separately from budget eviction, so an already-budgeted prompt-recall cue is no longer dropped when the current turn is superseded.
