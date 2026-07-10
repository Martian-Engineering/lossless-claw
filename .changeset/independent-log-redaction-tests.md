---
"@martian-engineering/lossless-claw": patch
---

Make independent log file redaction tests deterministic when the optional OpenClaw host redactor is present in the test environment. The `independentLogFile` config surface is already declared in the manifest and accepted by the runtime; these tests now isolate the fallback redactor path so they do not flake when `openclaw` is installed locally.
