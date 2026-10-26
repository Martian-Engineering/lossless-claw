---
"@martian-engineering/lossless-claw": patch
---

Bound the forced overflow-recovery raw tail by tokens when `freshTailMaxTokens` is unset. Recovery now caps the protected suffix at 25% of its target, so a default 64-message tail full of large tool results no longer blocks recovery with `no_compaction_progress`. Routine compaction is unchanged.
