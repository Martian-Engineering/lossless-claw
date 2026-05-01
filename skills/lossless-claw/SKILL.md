---
name: lossless-claw
description: Configure, diagnose, and use lossless-claw effectively in OpenClaw, including temporal recall when lcm_recent is available, summary health, session lifecycle, and evidence retrieval tools.
---

# Lossless Claw

Use this skill when the task is about operating, tuning, or debugging the `lossless-claw` OpenClaw plugin.

Start here:

1. Confirm whether the user needs configuration help, diagnostics, temporal recall, evidence retrieval, or session-lifecycle guidance.
2. For quick health checks, tell them to run `/lossless` (`/lcm` is the shorter alias).
3. For suspected summary corruption or truncation, use `/lossless doctor`.
4. For high-confidence junk/session cleanup guidance, use `/lossless doctor clean` before recommending any deletes.
5. If they ask how `/new`, `/reset`, or `/lossless rotate` interacts with LCM, read the session-lifecycle reference before answering.
6. For clearly time-bounded questions like "what happened yesterday/this week," load `references/recall-tools.md`. Use `lcm_recent` only when that tool exists in the current runtime.
7. If `lcm_recent` is unavailable, including before the temporal-memory PR stack is merged and deployed, start with `lcm_grep` plus bounded expansion and say temporal coverage is approximate.
8. For event-bounded questions like "after the restart," first anchor the event time/window if it is unknown, then use the available time-window path, then verify exact claims with `lcm_describe` or `lcm_expand_query`.
9. Load the relevant reference file instead of improvising details from memory.

Reference map:

- Configuration (complete config surface on current main): `references/config.md`
- Internal model and data flow: `references/architecture.md`
- Diagnostics and summary-health workflow: `references/diagnostics.md`
- Recall tools and when to use them, including availability-gated `lcm_recent` guidance: `references/recall-tools.md`
- `/new`, `/reset`, and `/lossless rotate` behavior with current lossless-claw session mapping: `references/session-lifecycle.md`

Working rules:

- Prioritize explaining why a setting matters, not just what it does.
- Prefer the native plugin command surface for MVP workflows (`/lossless`, with `/lcm` as alias).
- Do not assume the Go TUI is installed.
- Do not recommend advanced rewrite/backfill/transplant/dissolve flows unless the user explicitly asks for non-MVP internals.
- For exact evidence retrieval from compacted history, guide the user toward recall tools instead of guessing from summaries.
- For known timeline windows, start with `lcm_recent` only when it exists in the current runtime; otherwise use `lcm_grep` with bounded expansion and call out the approximation.
- Use `lcm_grep` for keyword/event discovery, `lcm_describe` for cheap source inspection, and `lcm_expand_query` for exact proof after narrowing.
- Treat `lcm_recent` as recap/entry, not proof: verify exact commands, paths, timestamps, root causes, or shipped/decided claims with `lcm_describe` or `lcm_expand_query` before asserting them.
- When users compare `/lossless` to `/status`, explain that they report different layers: `/lossless` shows LCM-side frontier/summary metrics, while `/status` shows the last assembled runtime prompt snapshot.
