---
"@martian-engineering/lossless-claw": patch
---

Normalize ChatCompletion-style summarizer responses from reasoning-capable providers by reading `choices[].message.content` without storing or logging reasoning/thinking fields as summary text.
