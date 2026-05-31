---
"@martian-engineering/lossless-claw": patch
---

Restrict delegated sub-agent retrieval tools to the conversation IDs in their expansion grant. Sub-agents can no longer use `allConversations=true` or an explicit foreign `conversationId` to bypass the grant scope in `lcm_grep`, `lcm_describe`, `lcm_expand`, or `lcm_expand_query`.
