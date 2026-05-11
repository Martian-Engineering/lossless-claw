---
"@martian-engineering/lossless-claw": minor
---

Add opt-in `respectThresholdAsHardFloor` config flag (default `false`). When enabled, `evaluateIncrementalCompaction` short-circuits with `reason="below-context-threshold-floor"` whenever `currentTokenCount < contextThreshold * tokenBudget`, regardless of cache state, leaf trigger, or activity band. Prevents cold-cache catch-up passes from compacting context away during idle gaps for users who want a strict "never compact below X%" policy. Configurable via env var `LCM_RESPECT_THRESHOLD_AS_HARD_FLOOR=true`.
