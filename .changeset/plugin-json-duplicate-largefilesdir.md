---
"@martian-engineering/lossless-claw": patch
---

Remove duplicate `largeFilesDir` declarations from `openclaw.plugin.json`. The surviving entries describe the default as relative to `OPENCLAW_STATE_DIR`, consistent with the runtime resolver and configuration reference. A regression test now guards against duplicate keys and stale default descriptions.
