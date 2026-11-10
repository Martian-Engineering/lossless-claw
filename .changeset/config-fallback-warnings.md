---
"@martian-engineering/lossless-claw": patch
---

Report config values that lossless-claw cannot use as written (for example a non-numeric env var or a boolean typo) as config warnings in `/lossless status`, `/lossless doctor`, and the startup log, while keeping the existing fallback behavior unchanged.
