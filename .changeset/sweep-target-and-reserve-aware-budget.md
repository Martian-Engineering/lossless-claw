---
"@martian-engineering/lossless-claw": minor
---

Layered four-band compaction pressure architecture, plus reserve-aware budget alignment so percentages mean what they say.

**Three new capabilities:**

1. **`sweepTriggerThreshold`** (default `0.91`) — separate from `contextThreshold`, controls when dispatched compaction switches into deep SWEEP mode. Below this, dispatched compaction targets `contextThreshold` (gentle, doesn't overshoot). At or above this, dispatches run unlimited passes targeting `sweepTargetThreshold`. Decouples the trigger ("when can sweep start") from the activation point ("when does sweep ACTUALLY fire") — without this, sweep would run on every threshold-mode dispatch (i.e. at 60% trigger), which is too aggressive.

2. **`pressureTiers`** (default `[{ratio:0.70,maxPasses:2},{ratio:0.80,maxPasses:3}]`) — pressure-tiered pass cap ladder for dispatched compaction below sweep mode. Each entry caps passes-per-dispatch when current pressure crosses `ratio`. Multi-pass amortizes prefix-cache invalidation: every pass in a single dispatch invalidates the SAME cache prefix, so doing 3 passes/dispatch costs the same cache-wise as 1 but reduces 3× as many tokens.

3. **`sweepTargetThreshold`** (default `0.50`) — fraction of token budget that SWEEP targets when it fires. Decouples sweep stopping point from `contextThreshold`. With default sweep target at 0.50 and trigger at 0.91, when sweep fires it creates ~40% headroom (~5+ turns of runway) before the next trigger.

**Plus reserve-aware budget alignment:** LCM now reads `runtimeContext.reserveTokens` (or the legacy `reserveTokensFloor` key) and subtracts it from the resolved `tokenBudget` before computing percentages. This way every threshold computes against the EFFECTIVE prompt budget — the same number the runtime actually overflows at — instead of the raw context window. Plugins/runtimes that don't pass a reserve get the legacy behavior unchanged.

**Behavior change:** `contextThreshold` default lowered from `0.75` → `0.60`. The lower trigger gives the cache-aware deferral system more room to operate (defer when cache hot, fire when cold) and feeds the new pressure-tier ladder cleanly. Operators wanting the legacy `0.75` trigger can set it explicitly.

**New env overrides:** `LCM_SWEEP_TARGET_THRESHOLD`, `LCM_SWEEP_TRIGGER_THRESHOLD`, `LCM_PRESSURE_TIERS` (JSON array). New manifest entries + uiHints + configSchema for all three new fields. README gains a new "Compaction pressure architecture" section with a layered ASCII diagram, pressure-band table, cache-invalidation efficiency math, and scenario walkthrough using real session data showing 6 emergency truncations → 0.

**Recommended companion:** [PR #557](https://github.com/Martian-Engineering/lossless-claw/pull/557) (cache-aware deferral gate fixes). PR #557's `criticalBudgetPressureRatio` default `0.70` lines up with this PR's tier-1 ratio so dispatched work fires reliably the moment the system enters tier-1 instead of being cache-throttled.
