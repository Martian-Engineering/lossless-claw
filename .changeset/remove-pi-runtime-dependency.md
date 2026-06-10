---
"@martian-engineering/lossless-claw": patch
---

Remove the runtime dependency on @earendil-works/pi-coding-agent: rotate and transcript-GC entry-id mapping now use the plugin's own read-only leaf-path parser instead of SessionManager.open, which migrated and rewrote v1/v2 or empty session files as a side effect and no longer tracks OpenClaw's in-tree transcript format. The pi packages remain as devDependencies for test fixtures.
