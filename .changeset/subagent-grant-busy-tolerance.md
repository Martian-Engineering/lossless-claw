---
"@martian-engineering/lossless-claw": patch
---

Keep a busy or locked database during sub-agent spawn or cleanup from getting Lossless Claw quarantined by the OpenClaw host. A busy grant write at spawn now starts the sub-agent without a delegated expansion grant, so its LCM retrieval tools refuse rather than gaining access. A busy revocation or unbinding when a sub-agent ends or a spawn rolls back is logged and retried on the next sub-agent hook; the grant still expires at its TTL.
