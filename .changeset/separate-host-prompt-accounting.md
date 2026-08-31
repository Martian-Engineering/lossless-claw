---
"@martian-engineering/lossless-claw": patch
---

Separate host-owned prompt framing from Lossless-owned context during threshold compaction. Typed OpenClaw runtime ownership metadata now survives host-parameter projection and follows foreground, maintenance, and deferred compaction paths so uncompactable system, tool, or native-thread history cannot make convergence impossible.
