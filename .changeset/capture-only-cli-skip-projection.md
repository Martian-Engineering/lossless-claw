---
"@martian-engineering/lossless-claw": patch
---

Skip the unused history projection on generic CLI turns when `hostFallbackMode` is `capture-only`. Those hosts only use Lossless Claw's memory instructions and send their own history, so assembly now returns early instead of querying and serializing the conversation. Capture, after-turn handling, and compaction are unchanged, and native embedded and Codex app-server hosts still receive full assembly.
