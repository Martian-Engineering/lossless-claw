---
name: lossless-claw
description: Configure, diagnose, and use lossless-claw effectively in OpenClaw, with emphasis on key settings, summary health, and recall-tool usage.
---

# Lossless Claw

Use this skill when the task is about operating, tuning, or debugging the `lossless-claw` OpenClaw plugin.

Start here:

1. Confirm whether the user needs configuration help, diagnostics, recall-tool guidance, or session-lifecycle guidance.
2. If they need a quick health check, tell them to run `/lossless` (`/lcm` is the shorter alias).
3. If they suspect summary corruption or truncation, use `/lossless doctor`.
4. If they want high-confidence junk/session cleanup guidance, use `/lossless doctor clean` before recommending any deletes.
5. If they ask how `/new`, `/reset`, or `/lossless rotate` interacts with LCM, read the session-lifecycle reference before answering.
6. Load the relevant reference file instead of improvising details from memory.

Reference map:

- Configuration (complete config surface on current main): `references/config.md`
- Internal model and data flow: `references/architecture.md`
- Diagnostics and summary-health workflow: `references/diagnostics.md`
- Recall tools and when to use them: `references/recall-tools.md`
- `/new`, `/reset`, and `/lossless rotate` behavior with current lossless-claw session mapping: `references/session-lifecycle.md`

Working rules:

- Prioritize explaining why a setting matters, not just what it does.
- Prefer the native plugin command surface for MVP workflows (`/lossless`, with `/lcm` as alias).
- Do not assume the Go TUI is installed.
- Do not recommend advanced rewrite/backfill/transplant/dissolve flows unless the user explicitly asks for non-MVP internals.
- For exact evidence retrieval from compacted history, guide the user toward recall tools instead of guessing from summaries.
- When users compare `/lossless` to `/status`, explain that they report different layers: `/lossless` shows LCM-side frontier/summary metrics, while `/status` shows the last assembled runtime prompt snapshot.
