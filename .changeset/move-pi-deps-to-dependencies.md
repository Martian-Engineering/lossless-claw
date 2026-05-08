---
"@martian-engineering/lossless-claw": patch
---

Move `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, and `@mariozechner/pi-coding-agent` from `peerDependencies` (with `peerDependenciesMeta.optional: true`) to runtime `dependencies`. The plugin's bundled `dist/index.js` imports these unconditionally (build externalizes `@mariozechner/*`), so absence becomes a hard `ERR_MODULE_NOT_FOUND` at module load — `optional: true` was not honored at runtime. Treating them as runtime dependencies makes the plugin self-contained on `npm install` and removes the host-symlink workaround currently required on fresh OpenClaw installs.

Fixes #636.
