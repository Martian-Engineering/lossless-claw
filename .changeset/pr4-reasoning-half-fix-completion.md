---
"@martian-engineering/lossless-claw": patch
---

Complete the thinking/reasoning half-fix from PR #503 in v0.9.3.  #503 sanitized summarizer **input** at `CompactionEngine.leafPass`; this PR closes the two remaining gaps that were in scope:

- **Output side**: when the summary provider response would persist a reasoning-shaped payload (text wrapped in `<think>…</think>` / `<thinking>…</thinking>` / `<reasoning>…</reasoning>`, or opened with a `[thinking]` / `[reasoning]` label) as the summary body, log and treat the summary as empty so the existing envelope → retry → deterministic-fallback chain runs instead of silently storing reasoning text.  Mitigates the silent-persist failure mode reported by #471 (vLLM+Qwen3) and #542 (Kimi K2.6).
- **Non-leaf passes**: `extractMeaningfulMessageText` is now applied at every summarizer entry point — `leafPass` (already covered by #503), the condensed/merge pass that re-summarizes leaf summaries, and the prior-summary-context resolver.  Summaries built from already-sanitized leaves can no longer reintroduce raw thinking/reasoning blocks at higher levels, including from legacy data persisted before #503.

Doctor remediation for legacy assistant rows that contain only thinking blocks (sub-fix F8 from the issue) is deferred — the existing doctor cleaner architecture operates on conversation-level deletion, not message-row remediation, and adding a backup-table pattern would significantly expand the surface area of this PR.  Tracked separately.
