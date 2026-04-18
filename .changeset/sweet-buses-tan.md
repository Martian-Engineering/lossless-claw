---
"@martian-engineering/lossless-claw": patch
---

Fix `lcm-tui` OAuth-backed Claude rewrites, repairs, and doctor apply runs so large prompts stream over stdin instead of overflowing the CLI argument limit.
