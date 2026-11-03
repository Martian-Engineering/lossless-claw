---
"@martian-engineering/lossless-claw": patch
---

Report rollover split lanes whose conversations share a `stable_event_key` as needing manual review, instead of classing them as safe and failing the repair on the `messages_stable_event_key_unique` constraint.
