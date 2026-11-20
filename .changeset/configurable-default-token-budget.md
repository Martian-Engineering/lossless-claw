---
"@martian-engineering/lossless-claw": patch
---

Add `defaultTokenBudget` / `LCM_DEFAULT_TOKEN_BUDGET` to configure the missing-allowance fallback while retaining the 128k default. Preserve explicit smaller host allowances, the assembly ceiling, and stricter recorded maintenance debt. Assembly, including its error clamp, now also respects host runtime budget settings.
