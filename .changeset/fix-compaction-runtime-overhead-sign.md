---
"@martian-engineering/lossless-claw": patch
---

Fix LCM compaction `observedRuntimeOverhead` to preserve the sign of the LCM-vs-host methodology gap instead of silently truncating negative values to zero. Previously `Math.max(0, compactableObservedTokens - decisionStoredTokens)` hid the case where LCM's stored-side counter exceeds the host-observed prompt token count (e.g. cache hits shrinking the visible prompt below LCM's JSON-length estimate); the runtime-adjusted sweep target stayed unset and sessions wedged on "compacted but still over target". The fix keeps the downstream `> 0` guard intact so positive overhead still arms the sweep target, and adds a debug log line that surfaces the discrepancy when overhead is negative.