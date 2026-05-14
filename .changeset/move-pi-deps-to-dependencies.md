---
"@martian-engineering/lossless-claw": patch
---

Move the PI runtime packages to the new `@earendil-works/*` scope and install `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-coding-agent` as runtime `dependencies`. The plugin's bundled `dist/index.js` imports these unconditionally (build externalizes the PI scope), so absence becomes a hard `ERR_MODULE_NOT_FOUND` at module load. Treating them as runtime dependencies makes the plugin self-contained on `npm install` and removes the host-symlink workaround currently required on fresh OpenClaw installs.

Fixes #636.
