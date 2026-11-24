---
"@martian-engineering/lossless-claw": patch
---

Keep stored OpenAI Responses reasoning as canonical `thinking` blocks during context assembly instead of unwrapping it into raw `reasoning` items, so switching a resumed Responses session to another provider no longer crashes the next turn.
