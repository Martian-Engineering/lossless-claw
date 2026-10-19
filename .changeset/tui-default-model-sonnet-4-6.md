---
"@martian-engineering/lossless-claw": patch
---

`lcm-tui` repair, rewrite, and backfill now default to `claude-sonnet-4-6` when no summary model is configured. The previous default, `claude-sonnet-4-20250514`, was retired by Anthropic and returned 404 errors.
