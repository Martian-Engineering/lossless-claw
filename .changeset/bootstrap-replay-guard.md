---
"@martian-engineering/lossless-claw": patch
---

Prevent existing-conversation bootstrap from replaying prior transcript rows as fresh LCM messages. Bootstrap append/reconcile now filters replay-shaped tails, message writes reject same-timestamp prior-content floods, and ingest batches run transactionally.
