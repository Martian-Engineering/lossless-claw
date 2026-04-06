---
"@martian-engineering/lossless-claw": patch
---

Route all LCM startup diagnostics to stderr so `--json` CLI output stays machine-readable, while keeping debug-only migration details behind the host logger's debug gating.
