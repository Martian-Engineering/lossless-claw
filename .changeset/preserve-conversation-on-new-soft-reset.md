---
"@martian-engineering/lossless-claw": patch
---

Preserve the conversation on a /new soft reset. The host archives the old transcript by renaming it to `${file}.reset.<ts>` and mints a fresh session id, so the next-turn rollover detector saw a stale session key whose tracked transcript had vanished and destructively archived the pruned conversation, stranding the retained summary band it was documented to carry forward. Lossless now records its own durable /new prune marker, requires that marker plus the reset archive sibling before standing down the destructive guard, keeps foreign reused-key identity-overlap cases at warn, and rebinds once the first turn of the new session lands.
