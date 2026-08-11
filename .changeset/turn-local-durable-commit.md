---
"@martian-engineering/lossless-claw": patch
---

Accept the turn-local durable `commitTurn` payload defined by [OpenClaw PR 122149](https://github.com/openclaw/openclaw/pull/122149), and preserve idempotent retries for beta.1 receipts after the host removes `prePromptMessageCount`.
