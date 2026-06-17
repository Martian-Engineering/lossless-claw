---
"@martian-engineering/lossless-claw": patch
---

Clean up `/lossless` status output by using the last runtime maintenance budget when no explicit assembly cap is configured, renaming the frontier token metric, removing repair-source pressure from default status reasons, and shortening maintenance details to actionable state. Also tighten `/lossless doctor apply` safety output to show scoped repair targets, repair input tokens, and deduplicated repair target source tokens instead of whole-conversation message-count or compressed-source proxies.
