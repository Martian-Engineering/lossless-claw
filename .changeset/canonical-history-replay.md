---
"@martian-engineering/lossless-claw": patch
---

Preserve canonical user metadata and attached runtime context when OpenClaw's recent-history window advances. On hosts exposing the bounded transcript replay reader, LCM restores retained raw users by transcript entry ID while preserving summaries, externalized content, and assembly budgets. Supported hosts without the reader retain the existing replay path and minimum version; operational read failures still use the existing logged assembly-error behavior.
