---
"@martian-engineering/lossless-claw": patch
---

Fix startup banner log calls to prevent --json stdout contamination

Startup banner messages (plugin-loaded, compaction-model, ignoreSessionPatterns, statelessSessionPatterns) now use log.debug() instead of log.info() to prevent contaminating stdout when OpenClaw CLI commands like `openclaw agents list --json` are run. This fixes downstream JSON.parse() errors in consumers like ClawKitchen.