---
"@martian-engineering/lossless-claw": patch
---

Honor `cacheAwareCompaction.enabled: false` at the deferred-compaction dispatch gate, and add a critical-pressure escape so deferred compaction fires regardless of prompt-cache state when `currentTokenCount >= criticalBudgetPressureRatio * tokenBudget` (default 0.70). Previously, mutation-sensitive providers (Anthropic, Codex, Copilot) could livelock the dispatcher in high-velocity sessions: each turn refreshed `lastCacheTouchAt`, the cache TTL never expired, deferred work never fired, and the runtime emergency overflow handler was left to do all the work. The new escape preserves cache-aware throttling in the 0–70% headroom band while ensuring compaction always fires before overflow.
