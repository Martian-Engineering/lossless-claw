---
"@martian-engineering/lossless-claw": patch
---

Verify complete persisted message payloads before matching a rewritten transcript suffix. Reused tool-call ids with different arguments or structure no longer restamp an unrelated historical row and hide the new payload. Preserve retained history and ordered adoption of equivalent messages.
