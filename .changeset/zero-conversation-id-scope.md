---
"@martian-engineering/lossless-claw": patch
---

Treat a non-positive `conversationId` (e.g. `0` from models that zero-fill optional tool parameters) as "not provided" in LCM retrieval tool scope resolution, so `allConversations: true` and session-family fallback work as documented instead of silently searching a conversation that cannot exist. The `conversationId` schemas for `lcm_grep`, `lcm_expand`, `lcm_expand_query`, and `lcm_describe` now declare `minimum: 1`.
