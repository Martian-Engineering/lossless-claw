---
"@martian-engineering/lossless-claw": patch
---

Restrict the missed-`/reset` bootstrap fallback to confirmed missing transcript paths so transient `stat()` failures do not rotate a live conversation.
