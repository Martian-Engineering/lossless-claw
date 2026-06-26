---
"@martian-engineering/lossless-claw": patch
---

Preserve the decorated live current turn across channels by recognizing it structurally and appending it when the stored transcript only has the bare body. Ambiguous same-body stored rows are kept until a stable turn identity exists, so live-current-turn recovery remains lossless.
