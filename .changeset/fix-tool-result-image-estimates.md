---
"@martian-engineering/lossless-claw": patch
---

Use the existing opaque-binary token allowance when estimating structured tool results, including nested image data. This prevents base64 image bytes from overriding the full-message estimate and producing inflated context pressure. Preserve text estimates, including literal data URLs in text blocks, per-image accounting, and the tool-result safety margin.
