---
"@martian-engineering/lossless-claw": patch
---

Fix summarizer auth-error detection so real provider auth envelopes nested under `data` or `body` still trigger handling, while successful summary payloads in `message` or `response` no longer cause false-positive auth failures.
