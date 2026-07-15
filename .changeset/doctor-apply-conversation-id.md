---
"@martian-engineering/lossless-claw": minor
---

`/lossless doctor apply` can now repair a specific conversation with `doctor apply <conversation-id> confirm-offline`. Targeted repair is limited to authorized OpenClaw command senders and requires the explicit offline confirmation after the target's active channel path is isolated. The existing current-conversation behavior is unchanged when no id is provided.
