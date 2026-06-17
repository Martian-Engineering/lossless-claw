---
"@martian-engineering/lossless-claw": patch
---

Preserve conversation ids during fresh transcript rollover by rebinding the existing LCM conversation to the new runtime session instead of archiving it and creating an empty replacement.
