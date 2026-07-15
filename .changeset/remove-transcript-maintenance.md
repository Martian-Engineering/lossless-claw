---
"@martian-engineering/lossless-claw": major
---

Remove Lossless-owned transcript GC and session-file rotation surfaces for the SQLite-backed OpenClaw runtime. Active transcript storage is now owned by OpenClaw; Lossless no longer exposes `/lossless rotate`, transcript GC config, or automatic session-file rotation config. Existing plugin configs must remove `transcriptGcEnabled` and `autoRotateSessionFiles` before upgrading because OpenClaw's manifest validation rejects removed config keys.
