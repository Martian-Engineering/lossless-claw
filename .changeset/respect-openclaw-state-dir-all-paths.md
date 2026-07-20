---
"@martian-engineering/lossless-claw": patch
---

Respect `OPENCLAW_STATE_DIR` in all code paths. The `tui`, `stub-tier-live-watcher`, and `stub-tier-assemble-bench` scripts now honor the `OPENCLAW_STATE_DIR` environment variable instead of hardcoding `~/.openclaw`. A `resolveOpenclawStateDir` helper was extracted for `tui/data.go` matching the existing pattern in `src/db/config.ts`.
