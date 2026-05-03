---
"@martian-engineering/lossless-claw": patch
---

Declare `contracts.tools` in `openclaw.plugin.json` so OpenClaw 2026.5.2's stricter loader accepts the plugin's `lcm_grep`, `lcm_describe`, `lcm_expand`, and `lcm_expand_query` registrations. Without this declaration the loader emits `plugin must declare contracts.tools before registering agent tools` and the plugin fails to register, which silently disables compaction (the engine still loads but no tools are wired up).
