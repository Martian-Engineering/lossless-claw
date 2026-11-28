---
"@martian-engineering/lossless-claw": patch
---

Prepare message identities once when reconciling live inputs with assembled history, avoiding repeated parsing and token estimation that can block the Gateway event loop when multiple subagent completion events are present. Coverage, message ordering, and stored data are unchanged.
