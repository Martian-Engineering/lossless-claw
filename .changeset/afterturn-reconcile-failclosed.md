---
"@martian-engineering/lossless-claw": patch
---

`afterTurn` now fails closed when the transcript reconcile throws. The catch handler previously left the initialized in-sync default (`hasOverlap: true`) in place, so a thrown reconcile persisted the live batch AND refreshed the checkpoint to EOF — silently advancing past transcript history that was never reconciled into the DB. The catch now reports the turn as not covered, skipping batch persistence and checkpoint refresh for that turn; nothing is lost because the transcript retains the turn and the next successful reconcile imports it.
