---
"@martian-engineering/lossless-claw": patch
---

Verify structured payload identity before adopting a rewritten transcript suffix. Reused tool-call ids with different arguments, structure, tool names, or error flags no longer restamp an unrelated historical row and hide the new payload, including string tool results whose provenance is stored in part metadata. Require unchanged tool provenance before accepting host-redacted or externalized replay bodies. Preserve retained history and ordered adoption of equivalent messages.
