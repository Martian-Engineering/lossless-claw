---
"@martian-engineering/lossless-claw": patch
---

Skip `session_end` rollover when either the current or next session key is ignored or stateless, and avoid reusing archived conversations by `sessionId` alone when no `sessionKey` is available.
