---
"@martian-engineering/lossless-claw": patch
---

Preserve the conversation on a /new soft reset. The host archives the old transcript by renaming it to `${file}.reset.<ts>` and mints a fresh session id, so the next-turn rollover detector saw a stale session key whose tracked transcript had vanished and destructively archived the pruned conversation, stranding the retained summary band it was documented to carry forward. The rollover detector now probes for an archived sibling transcript before judging, preserves the conversation on a deliberate /new (debug log), keeps the foreign reused-key identity-overlap case at warn, and rebinds once the first turn of the new session lands.
