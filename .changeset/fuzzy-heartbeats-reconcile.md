---
"@martian-engineering/lossless-claw": patch
---

Skip synthetic OpenClaw heartbeat transcript rows during bootstrap/reconcile imports so heartbeat-only tails cannot trip replay-flood quarantine.
