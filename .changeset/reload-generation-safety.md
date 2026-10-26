---
"@martian-engineering/lossless-claw": patch
---

Keep lossless-claw consistent when OpenClaw reloads the plugin during a running turn. Delegated expansion grants are now stored in the LCM database, so a delegated `lcm_expand` child no longer fails with "Delegated expansion requires a valid grant" after a reload. Runtime-authored user turns, such as OpenClaw's continuation prompt, keep their `internal_system` provenance and `display: false` flag instead of being stored as messages the user typed. On OpenClaw 2026.9.5 or later, disposing the plugin instance also closes its database, so the next plugin generation does not reuse the retired engine.
