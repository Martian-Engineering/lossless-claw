---
"@martian-engineering/lossless-claw": patch
---

Sync the published plugin manifest schema with the runtime-supported plugin config surface so documented config keys are accepted by OpenClaw. This also removes the undocumented `autocompactDisabled` setting from the advertised config surface because it was parsed but not wired to runtime behavior.
