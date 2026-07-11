---
"@martian-engineering/lossless-claw": patch
---

Fix the ambiguous-rollover identity-scope wedge on rapid same-day /new resets. `messageIdentity` compares role+content only, unscoped by session generation, so a lane whose first post-reset turn happened to repeat trivial content (e.g. a literal "ping" health check) collided with the prior generation's persisted history and the freshness gate froze the lane instead of rotating it, re-warning on every subsequent bootstrap/afterTurn call. Identity overlap on trivial, low-entropy content no longer blocks rotation when the rollover is independently proven deliberate (a durable /new marker plus its archive sibling); substantial overlapping content still fails closed exactly as before, so a foreign session reusing a stale sessionKey is still rejected. A genuine freeze now warns once per session generation instead of on every turn.
