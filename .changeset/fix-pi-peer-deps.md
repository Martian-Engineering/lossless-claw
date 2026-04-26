---
"@martian-engineering/lossless-claw": patch
---

Move `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, and `@mariozechner/pi-coding-agent` from `dependencies` to optional `peerDependencies` so the plugin always resolves them from the host OpenClaw runtime instead of a pinned local copy.

Previously these packages were pinned as `dependencies` (fixed at `0.66.1`), which caused npm to install a snapshot in the plugin's own `node_modules/`. That snapshot's internal path references (e.g. `provider.runtime-BlZSfz5M.js`) became stale whenever OpenClaw shipped a new build that bumped `pi-*`, breaking plugin registration on `openclaw ≥ 2026.4.20`.

By declaring them as optional peer dependencies:
- No local copy is installed (npm v7+ skips optional peer deps when they are not required by the consumer), so the host-provided versions are resolved via normal Node.js module lookup.
- The build already marks `@mariozechner/*` as external (`--external:"@mariozechner/*"`), so the runtime was always intended to supply these modules.
- `devDependencies` retains the pinned `0.66.1` versions so local builds and tests continue to work without needing a live OpenClaw installation.
