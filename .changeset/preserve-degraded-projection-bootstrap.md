---
"@martian-engineering/lossless-claw": patch
---

Preserve stable `thread_bootstrap` projection metadata when a managed conversation uses bounded or degraded live fallback, preventing persistent Codex threads from appending the reconstructed transcript again on every turn while compaction maintenance is pending.
